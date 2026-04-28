import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { verifyJwt } from './auth.js'
import { attachTmuxPty, type PtyBridge } from './ptyManager.js'
import { consumeWsTicket } from './wsTickets.js'
import { clientWsMessageSchema, type ServerWsMessage } from '@tmuxd/shared'

export interface WsDeps {
    jwtSecret: Uint8Array
}

const MAX_PAYLOAD = 64 * 1024 // 64KB cap on inbound WS frames
const HIGH_WATER = 1 * 1024 * 1024 // 1MB — pause PTY above this
const LOW_WATER = 128 * 1024 // 128KB — resume PTY below this
const MAX_WS_CLIENTS = 32
const MAX_WS_CLIENTS_PER_SESSION = 4
const IDLE_TIMEOUT_MS = 30 * 60 * 1000

export function createWsServer(_deps: WsDeps): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
    const sessionCounts = new Map<string, number>()

    wss.on('connection', (ws: WebSocket, _request: IncomingMessage, context: { session: string; cols: number; rows: number }) => {
        let bridge: PtyBridge | null = null
        let paused = false
        let cleaned = false
        let counted = false
        let dataSub: { dispose(): void } | null = null
        let exitSub: { dispose(): void } | null = null
        let lastActivity = Date.now()
        let idleTimer: NodeJS.Timeout | null = null

        const cleanup = () => {
            if (cleaned) return
            cleaned = true
            if (idleTimer) clearInterval(idleTimer)
            try {
                dataSub?.dispose()
            } catch {
                /* ignore */
            }
            try {
                exitSub?.dispose()
            } catch {
                /* ignore */
            }
            bridge?.dispose()
            bridge = null
            if (counted) {
                const next = Math.max(0, (sessionCounts.get(context.session) ?? 1) - 1)
                if (next) sessionCounts.set(context.session, next)
                else sessionCounts.delete(context.session)
            }
        }
        ws.on('close', cleanup)
        ws.on('error', cleanup)

        if (wss.clients.size > MAX_WS_CLIENTS || (sessionCounts.get(context.session) ?? 0) >= MAX_WS_CLIENTS_PER_SESSION) {
            sendJson(ws, { type: 'error', message: 'too_many_connections' })
            ws.close(1013, 'too_many_connections')
            return
        }

        sessionCounts.set(context.session, (sessionCounts.get(context.session) ?? 0) + 1)
        counted = true

        try {
            bridge = attachTmuxPty(context.session, context.cols, context.rows)
        } catch (err) {
            sendJson(ws, { type: 'error', message: errMsg(err) })
            try {
                ws.close(1011, 'attach_failed')
            } catch {
                /* ignore */
            }
            return
        }

        idleTimer = setInterval(() => {
            if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
                sendJson(ws, { type: 'error', message: 'idle_timeout' })
                ws.close(1001, 'idle_timeout')
            }
        }, 60_000)

        sendJson(ws, {
            type: 'ready',
            session: bridge.session,
            cols: bridge.cols,
            rows: bridge.rows
        })

        dataSub = bridge.proc.onData((chunk) => {
            lastActivity = Date.now()
            const payload = Buffer.from(chunk, 'utf8').toString('base64')
            sendJson(ws, { type: 'data', payload })

            // Backpressure: if the socket buffer grows past the high water mark,
            // pause the PTY. `ws` does not emit 'drain', so poll the buffered
            // amount on a timer — cheap (every 100ms while paused).
            if (!paused && ws.bufferedAmount > HIGH_WATER) {
                paused = true
                try {
                    // `node-pty` ≥1.0 supports pause/resume for flow control.
                    bridge?.proc.pause?.()
                } catch {
                    /* older node-pty without pause — fall back to best-effort */
                }
                const drain = setInterval(() => {
                    if (ws.readyState !== ws.OPEN) {
                        clearInterval(drain)
                        return
                    }
                    if (ws.bufferedAmount <= LOW_WATER) {
                        paused = false
                        try {
                            bridge?.proc.resume?.()
                        } catch {
                            /* ignore */
                        }
                        clearInterval(drain)
                    }
                }, 100)
            }
        })

        exitSub = bridge.proc.onExit(({ exitCode, signal }) => {
            sendJson(ws, { type: 'exit', code: exitCode ?? null, signal: signal ? String(signal) : null })
            try {
                ws.close(1000, 'pty_exited')
            } catch {
                /* ignore */
            }
        })

        ws.on('message', (raw: Buffer) => {
            if (!bridge) return
            lastActivity = Date.now()
            let parsed: unknown
            try {
                parsed = JSON.parse(raw.toString('utf8'))
            } catch {
                return
            }
            const msg = clientWsMessageSchema.safeParse(parsed)
            if (!msg.success) return
            if (msg.data.type === 'input') {
                let buf: string
                try {
                    buf = Buffer.from(msg.data.payload, 'base64').toString('utf8')
                } catch {
                    return
                }
                try {
                    bridge.proc.write(buf)
                } catch {
                    /* PTY gone — cleanup will run from exit/error */
                }
            } else if (msg.data.type === 'resize') {
                bridge.cols = msg.data.cols
                bridge.rows = msg.data.rows
                try {
                    bridge.proc.resize(msg.data.cols, msg.data.rows)
                } catch {
                    /* ignore */
                }
            } else if (msg.data.type === 'ping') {
                sendJson(ws, { type: 'pong' })
            }
        })

    })

    return wss
}

function sendJson(ws: WebSocket, msg: ServerWsMessage): void {
    if (ws.readyState !== ws.OPEN) return
    try {
        ws.send(JSON.stringify(msg))
    } catch {
        // Socket likely mid-close; the 'close' handler will clean up.
    }
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

/** Called by HTTP server `upgrade` handler. Validates URL, origin, token. */
export async function tryHandleUpgrade(
    wss: WebSocketServer,
    jwtSecret: Uint8Array,
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    opts?: { allowedOrigins?: string[] }
): Promise<boolean> {
    const urlStr = request.url || ''
    const url = new URL(urlStr, 'http://localhost')
    const m = /^\/ws\/([^/?]+)$/.exec(url.pathname)
    if (!m) return false
    const session = decodeURIComponent(m[1])
    const token = url.searchParams.get('token') || ''
    const ticket = url.searchParams.get('ticket') || ''
    const cols = Number.parseInt(url.searchParams.get('cols') || '80', 10)
    const rows = Number.parseInt(url.searchParams.get('rows') || '24', 10)

    // Origin allowlist (same-origin from served UI). In dev mode Vite proxies,
    // so the origin matches the hub origin.
    const origin = request.headers.origin
    if (origin) {
        const allowed = opts?.allowedOrigins?.length
            ? opts.allowedOrigins.includes(origin)
            : isSameHostOrigin(origin, request.headers.host)
        if (!allowed) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n')
            socket.destroy()
            return true
        }
    }

    const authorized = ticket ? consumeWsTicket(ticket) : !!(await verifyJwt(jwtSecret, token))
    if (!authorized) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return true
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, { session, cols, rows })
    })
    return true
}

function isSameHostOrigin(origin: string, host: string | undefined): boolean {
    if (!host) return false
    try {
        const url = new URL(origin)
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
        return url.host === host || (isLoopbackHost(url.hostname) && isLoopbackHost(host.split(':')[0]))
    } catch {
        return false
    }
}

function isLoopbackHost(host: string): boolean {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]'
}
