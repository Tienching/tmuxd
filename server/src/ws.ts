import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, WebSocket } from 'ws'
import { verifyJwt } from './auth.js'
import { isLocalHost } from './hosts.js'
import { attachTmuxPty, type PtyBridge } from './ptyManager.js'
import { consumeWsTicket } from './wsTickets.js'
import { clientWsMessageSchema, LOCAL_HOST_ID, type ServerWsMessage } from '@tmuxd/shared'
import type { AgentRegistry } from './agentRegistry.js'

export interface WsDeps {
    jwtSecret: Uint8Array
    agentRegistry?: AgentRegistry
}

const MAX_PAYLOAD = 64 * 1024 // 64KB cap on inbound WS frames
const HIGH_WATER = 1 * 1024 * 1024 // 1MB — pause PTY above this
const LOW_WATER = 128 * 1024 // 128KB — resume PTY below this
const MAX_WS_CLIENTS = 32
const MAX_WS_CLIENTS_PER_SESSION = 4
const IDLE_TIMEOUT_MS = 30 * 60 * 1000

interface BrowserWsContext {
    hostId: string
    session: string
    cols: number
    rows: number
}

interface TerminalBridge {
    session: string
    cols: number
    rows: number
    onData(cb: (payload: string) => void): { dispose(): void }
    onExit(cb: (event: { exitCode: number | null; signal: string | null }) => void): { dispose(): void }
    onError(cb: (message: string) => void): { dispose(): void }
    writePayload(payload: string): void
    resize(cols: number, rows: number): void
    pause?(): void
    resume?(): void
    dispose(): void
}

export function createWsServer(deps: WsDeps): WebSocketServer {
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD })
    const sessionCounts = new Map<string, number>()

    wss.on('connection', (ws: WebSocket, _request: IncomingMessage, context: BrowserWsContext) => {
        const sessionKey = `${context.hostId}/${context.session}`
        let bridge: TerminalBridge | null = null
        let paused = false
        let cleaned = false
        let counted = false
        let dataSub: { dispose(): void } | null = null
        let exitSub: { dispose(): void } | null = null
        let errorSub: { dispose(): void } | null = null
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
            try {
                errorSub?.dispose()
            } catch {
                /* ignore */
            }
            bridge?.dispose()
            bridge = null
            if (counted) {
                const next = Math.max(0, (sessionCounts.get(sessionKey) ?? 1) - 1)
                if (next) sessionCounts.set(sessionKey, next)
                else sessionCounts.delete(sessionKey)
            }
        }
        ws.on('close', cleanup)
        ws.on('error', cleanup)

        if (wss.clients.size > MAX_WS_CLIENTS || (sessionCounts.get(sessionKey) ?? 0) >= MAX_WS_CLIENTS_PER_SESSION) {
            sendJson(ws, { type: 'error', message: 'too_many_connections' })
            ws.close(1013, 'too_many_connections')
            return
        }

        sessionCounts.set(sessionKey, (sessionCounts.get(sessionKey) ?? 0) + 1)
        counted = true

        void startBridge().catch((err) => {
            sendJson(ws, { type: 'error', message: errMsg(err) })
            try {
                ws.close(1011, 'attach_failed')
            } catch {
                /* ignore */
            }
        })

        async function startBridge() {
            try {
                bridge = await attachTarget(context, deps.agentRegistry)
            } catch (err) {
                sendJson(ws, { type: 'error', message: errMsg(err) })
                try {
                    ws.close(1011, 'attach_failed')
                } catch {
                    /* ignore */
                }
                return
            }
            if (cleaned) {
                bridge.dispose()
                bridge = null
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
                hostId: context.hostId,
                session: bridge.session,
                cols: bridge.cols,
                rows: bridge.rows
            })

            dataSub = bridge.onData((payload) => {
                lastActivity = Date.now()
                sendJson(ws, { type: 'data', payload })

                // Backpressure: local node-pty supports pause/resume. Remote agents
                // currently keep streaming best-effort over their single control socket.
                if (!paused && bridge?.pause && ws.bufferedAmount > HIGH_WATER) {
                    paused = true
                    try {
                        bridge.pause()
                    } catch {
                        /* older bridge without pause — fall back to best-effort */
                    }
                    const drain = setInterval(() => {
                        if (ws.readyState !== ws.OPEN) {
                            clearInterval(drain)
                            return
                        }
                        if (ws.bufferedAmount <= LOW_WATER) {
                            paused = false
                            try {
                                bridge?.resume?.()
                            } catch {
                                /* ignore */
                            }
                            clearInterval(drain)
                        }
                    }, 100)
                }
            })

            exitSub = bridge.onExit(({ exitCode, signal }) => {
                sendJson(ws, { type: 'exit', code: exitCode, signal })
                try {
                    ws.close(1000, 'pty_exited')
                } catch {
                    /* ignore */
                }
            })

            errorSub = bridge.onError((message) => {
                sendJson(ws, { type: 'error', message })
            })
        }

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
                try {
                    bridge.writePayload(msg.data.payload)
                } catch {
                    /* PTY gone — cleanup will run from exit/error */
                }
            } else if (msg.data.type === 'resize') {
                bridge.cols = msg.data.cols
                bridge.rows = msg.data.rows
                try {
                    bridge.resize(msg.data.cols, msg.data.rows)
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

async function attachTarget(context: BrowserWsContext, agentRegistry?: AgentRegistry): Promise<TerminalBridge> {
    if (isLocalHost(context.hostId)) {
        return wrapLocalBridge(attachTmuxPty(context.session, context.cols, context.rows))
    }
    if (!agentRegistry) throw new Error('host_not_found')
    const remote = await agentRegistry.attach(context.hostId, context.session, context.cols, context.rows)
    return {
        session: remote.session,
        cols: remote.cols,
        rows: remote.rows,
        onData: (cb) => remote.onData(cb),
        onExit: (cb) => remote.onExit(cb),
        onError: (cb) => remote.onError(cb),
        writePayload: (payload) => remote.writeBase64Payload(payload),
        resize(cols, rows) {
            remote.cols = cols
            remote.rows = rows
            remote.resize(cols, rows)
        },
        dispose: () => remote.dispose()
    }
}

function wrapLocalBridge(bridge: PtyBridge): TerminalBridge {
    return {
        session: bridge.session,
        cols: bridge.cols,
        rows: bridge.rows,
        onData(cb) {
            return bridge.proc.onData((chunk) => cb(Buffer.from(chunk, 'utf8').toString('base64')))
        },
        onExit(cb) {
            return bridge.proc.onExit(({ exitCode, signal }) => cb({ exitCode: exitCode ?? null, signal: signal ? String(signal) : null }))
        },
        onError() {
            return { dispose() {} }
        },
        writePayload(payload) {
            const buf = Buffer.from(payload, 'base64').toString('utf8')
            bridge.proc.write(buf)
        },
        resize(cols, rows) {
            bridge.cols = cols
            bridge.rows = rows
            bridge.proc.resize(cols, rows)
        },
        pause() {
            bridge.proc.pause?.()
        },
        resume() {
            bridge.proc.resume?.()
        },
        dispose() {
            bridge.dispose()
        }
    }
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
    opts?: { allowedOrigins?: string[]; agentRegistry?: AgentRegistry }
): Promise<boolean> {
    const urlStr = request.url || ''
    const url = new URL(urlStr, 'http://localhost')
    const target = parseWsTarget(url.pathname)
    if (!target) return false
    const { hostId, session } = target
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

    if (!isLocalHost(hostId) && !opts?.agentRegistry?.hasHost(hostId)) {
        socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return true
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request, { hostId, session, cols, rows })
    })
    return true
}

function parseWsTarget(pathname: string): { hostId: string; session: string } | null {
    const local = /^\/ws\/([^/?]+)$/.exec(pathname)
    if (local) return { hostId: LOCAL_HOST_ID, session: decodeURIComponent(local[1]) }

    const hostAware = /^\/ws\/([^/?]+)\/([^/?]+)$/.exec(pathname)
    if (hostAware) {
        return {
            hostId: decodeURIComponent(hostAware[1]),
            session: decodeURIComponent(hostAware[2])
        }
    }

    return null
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
