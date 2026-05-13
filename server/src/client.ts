#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { config as loadDotenv } from 'dotenv'
import WebSocket from 'ws'
import { attachTmuxPty, type PtyBridge } from './ptyManager.js'
import { capturePane, captureSession, createSession, killSession, listPanes, listSessions, sendKeysToTarget, sendTextToTarget } from './tmux.js'
import { serverToClientMessageSchema, type ServerToClientMessage } from './clientProtocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: join(__dirname, '..', '..', '.env') })
loadDotenv()

const VERSION = '0.1.0'
const DEFAULT_NAME = 'client'
const CAPABILITIES = ['list', 'create', 'kill', 'capture', 'attach', 'panes', 'input']

interface StreamState {
    bridge: PtyBridge
    dataSub: { dispose(): void }
    exitSub: { dispose(): void }
}

function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        if (arg === '-h') {
            out.help = '1'
            continue
        }
        if (!arg.startsWith('--')) continue
        const key = arg.slice(2)
        const next = argv[i + 1]
        if (next && !next.startsWith('--')) {
            out[key] = next
            i++
        } else {
            out[key] = '1'
        }
    }
    return out
}

function requireValue(name: string, value: string | undefined): string {
    if (!value?.trim()) throw new Error(`Missing ${name}`)
    return value.trim()
}

function makeAgentUrl(tmuxdUrl: string, serverToken: string, userToken: string): string {
    const url = new URL('/client/connect', tmuxdUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.searchParams.set('serverToken', serverToken)
    url.searchParams.set('userToken', userToken)
    return url.toString()
}

function printHelpAndExit(): never {
    const text = `tmuxd client — outbound WebSocket connection to a tmuxd server

Usage:
  tmuxd client [flags]
  TMUXD_* env vars are equivalent (env-only deploys are supported).

Required:
  --hub <url>             Server base URL, e.g. https://tmuxd.example.com
                          (env: TMUXD_URL)
  --server-token <secret> Shared trust-circle token. Same value the
                          server has in TMUXD_SERVER_TOKEN.
                          (env: TMUXD_SERVER_TOKEN)
  --user-token <secret>   Personal token of the user this client belongs
                          to. The server derives namespace = sha256(this).
                          You can re-use the same TMUXD_USER_TOKEN your
                          'tmuxd login' uses.
                          (env: TMUXD_USER_TOKEN)

Optional:
  --host-id <id>          Stable host ID. Defaults to a slug of --name.
                          (env: TMUXD_HOST_ID)
  --host-name <display>   Human-readable name shown in the web UI.
                          (env: TMUXD_HOST_NAME, default: "client")
  --help, -h              Print this message and exit.

Exit codes:
  0   Clean shutdown (e.g. SIGTERM)
  1   Fatal startup error (missing flags, etc.)
  2   Server rejected configuration

Examples:
  tmuxd client --hub http://tmuxd.example:7681 \\
               --server-token \${TMUXD_SERVER_TOKEN} \\
               --user-token  \${ALICE_USER_TOKEN} \\
               --host-id laptop --host-name "Alice Laptop"

  TMUXD_URL=http://tmuxd.example:7681 \\
  TMUXD_SERVER_TOKEN=\${TMUXD_SERVER_TOKEN} \\
  TMUXD_USER_TOKEN=\${ALICE_USER_TOKEN} \\
  TMUXD_HOST_ID=laptop \\
  TMUXD_HOST_NAME="Alice Laptop" \\
    tmuxd client

See docs/identity-model.md for the trust model rationale.
`
    process.stdout.write(text)
    process.exit(0)
}

interface ClientConfig {
    tmuxdUrl: string
    serverToken: string
    userToken: string
    hostName: string
    hostId: string | undefined
}

function readConfig(): ClientConfig {
    const args = parseArgs(process.argv.slice(2))
    if (args.help || args.h) printHelpAndExit()
    return {
        tmuxdUrl: requireValue('--hub or TMUXD_URL', args.hub || process.env.TMUXD_URL),
        serverToken: requireValue(
            '--server-token or TMUXD_SERVER_TOKEN',
            args['server-token'] || process.env.TMUXD_SERVER_TOKEN
        ),
        userToken: requireValue(
            '--user-token or TMUXD_USER_TOKEN',
            args['user-token'] || process.env.TMUXD_USER_TOKEN
        ),
        hostName: (args['host-name'] || process.env.TMUXD_HOST_NAME || DEFAULT_NAME).trim() || DEFAULT_NAME,
        hostId: (args['host-id'] || process.env.TMUXD_HOST_ID || '').trim() || undefined
    }
}

/**
 * Thrown when the server rejects the client for a configuration reason
 * that retrying cannot fix. The client main loop catches it, prints a
 * clear instruction, and exits with code 2 instead of looping forever
 * on backoff.
 */
class FatalConfigError extends Error {
    constructor(message: string, public readonly hint: string) {
        super(message)
        this.name = 'FatalConfigError'
    }
}

async function main() {
    const config = readConfig()
    let attempt = 0
    for (;;) {
        try {
            await connectOnce(config)
            attempt = 0
        } catch (err) {
            if (err instanceof FatalConfigError) {
                console.error(`[client] ${err.message}`)
                console.error(`[client] hint: ${err.hint}`)
                process.exit(2)
            }
            console.error(`[client] ${err instanceof Error ? err.message : String(err)}`)
        }
        attempt = Math.min(attempt + 1, 6)
        const delay = Math.min(30_000, 500 * 2 ** attempt)
        await sleep(delay)
    }
}

function connectOnce(config: ClientConfig): Promise<void> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(makeAgentUrl(config.tmuxdUrl, config.serverToken, config.userToken))
        const streams = new Map<string, StreamState>()
        let settled = false

        const cleanup = () => {
            for (const stream of streams.values()) {
                try {
                    stream.dataSub.dispose()
                    stream.exitSub.dispose()
                    stream.bridge.dispose()
                } catch {
                    /* ignore */
                }
            }
            streams.clear()
        }

        ws.on('open', () => {
            send(ws, {
                type: 'hello',
                id: config.hostId,
                name: config.hostName,
                version: VERSION,
                capabilities: CAPABILITIES
            })
        })

        ws.on('message', (raw) => {
            const msg = parseHubMessage(raw)
            if (!msg) return
            if (msg.type === 'hello_ack') {
                console.log(`[client] connected as ${msg.hostId}`)
                return
            }
            if (msg.type === 'ping') {
                send(ws, { type: 'pong' })
                return
            }
            void handleMessage(ws, streams, msg)
        })

        ws.on('unexpected-response', (_req, res) => {
            cleanup()
            if (!settled) {
                settled = true
                if (res.statusCode === 401) {
                    reject(
                        new FatalConfigError(
                            `server rejected client websocket: HTTP 401`,
                            'verify TMUXD_SERVER_TOKEN matches the server, and that TMUXD_USER_TOKEN is non-empty.'
                        )
                    )
                    return
                }
                reject(new Error(`server rejected client websocket: HTTP ${res.statusCode}`))
            }
        })
        ws.on('error', (err) => {
            if (!settled && ws.readyState !== ws.OPEN) {
                settled = true
                cleanup()
                reject(err)
            }
        })
        ws.on('close', (code, reasonBuf) => {
            cleanup()
            const reason = reasonBuf?.toString('utf8') || ''
            if (!settled) {
                settled = true
                if (code === 1008 && reason === 'host_already_connected') {
                    // The server already has a connection registered under our
                    // (namespace, hostId). This is NOT a fatal config error
                    // even though it looks like one: a previous instance of
                    // this same client may have died abruptly (hard kill,
                    // network drop, machine sleep) and the server takes up to
                    // HEARTBEAT_MS × 3 = 45s to reap the stale entry. If we
                    // exit 2 here, a transient network blip permanently
                    // kills the client process — systemd / docker-restart
                    // can't help because the exit code is 2 (config error
                    // by convention), not a generic crash.
                    //
                    // The right move is to log clearly and let the main
                    // loop's backoff (capped at 30s) retry. Most cases
                    // self-heal within one heartbeat window. If the user
                    // ACTUALLY ran two clients with the same host id, the
                    // log line tells them what to do; they can stop the
                    // other one and this loop will succeed on the next
                    // attempt.
                    console.error(
                        `[client] server rejected hello: another client is already connected with this host id. ` +
                            `If a previous instance just died, the server will reap it within ~45s and we will retry. ` +
                            `If you are intentionally running two clients on the same server, give them distinct ` +
                            `--host-id values.`
                    )
                    resolve()
                    return
                }
                resolve()
            }
        })
    })
}

async function handleMessage(ws: WebSocket, streams: Map<string, StreamState>, msg: ServerToClientMessage): Promise<void> {
    if (msg.type === 'list_sessions') {
        await reply(ws, msg.id, async () => ({ sessions: await listSessions() }))
    } else if (msg.type === 'create_session') {
        await reply(ws, msg.id, async () => {
            await createSession(msg.name)
            return { ok: true }
        })
    } else if (msg.type === 'kill_session') {
        await reply(ws, msg.id, async () => {
            await killSession(msg.name)
            return { ok: true }
        })
    } else if (msg.type === 'capture_session') {
        await reply(ws, msg.id, async () => captureSession(msg.name))
    } else if (msg.type === 'list_panes') {
        await reply(ws, msg.id, async () => ({ panes: await listPanes(msg.session) }))
    } else if (msg.type === 'capture_pane') {
        await reply(ws, msg.id, async () => capturePane(msg.target, { lines: msg.lines, maxBytes: msg.maxBytes }))
    } else if (msg.type === 'send_text') {
        await reply(ws, msg.id, async () => {
            await sendTextToTarget(msg.target, msg.text, msg.enter)
            return { ok: true }
        })
    } else if (msg.type === 'send_keys') {
        await reply(ws, msg.id, async () => {
            await sendKeysToTarget(msg.target, msg.keys)
            return { ok: true }
        })
    } else if (msg.type === 'attach') {
        attachStream(ws, streams, msg.streamId, msg.session, msg.cols, msg.rows)
    } else if (msg.type === 'input') {
        const stream = streams.get(msg.streamId)
        if (!stream) return
        try {
            stream.bridge.proc.write(Buffer.from(msg.payload, 'base64').toString('utf8'))
        } catch {
            send(ws, { type: 'stream_error', streamId: msg.streamId, message: 'write_failed' })
        }
    } else if (msg.type === 'resize') {
        const stream = streams.get(msg.streamId)
        if (!stream) return
        try {
            stream.bridge.cols = msg.cols
            stream.bridge.rows = msg.rows
            stream.bridge.proc.resize(msg.cols, msg.rows)
        } catch {
            /* ignore resize races */
        }
    } else if (msg.type === 'detach') {
        disposeStream(streams, msg.streamId)
    }
}

async function reply(ws: WebSocket, id: string, fn: () => Promise<unknown>): Promise<void> {
    try {
        const body = await fn()
        send(ws, { type: 'result', id, ok: true, body })
    } catch (err) {
        send(ws, { type: 'result', id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
}

function attachStream(ws: WebSocket, streams: Map<string, StreamState>, streamId: string, session: string, cols: number, rows: number): void {
    try {
        disposeStream(streams, streamId)
        const bridge = attachTmuxPty(session, cols, rows)
        const dataSub = bridge.proc.onData((chunk) => {
            send(ws, { type: 'stream_data', streamId, payload: Buffer.from(chunk, 'utf8').toString('base64') })
        })
        const exitSub = bridge.proc.onExit(({ exitCode, signal }) => {
            send(ws, { type: 'stream_exit', streamId, code: exitCode ?? null, signal: signal ? String(signal) : null })
            streams.delete(streamId)
        })
        streams.set(streamId, { bridge, dataSub, exitSub })
        send(ws, { type: 'stream_ready', streamId, session: bridge.session, cols: bridge.cols, rows: bridge.rows })
    } catch (err) {
        send(ws, { type: 'stream_error', streamId, message: err instanceof Error ? err.message : String(err) })
    }
}

function disposeStream(streams: Map<string, StreamState>, streamId: string): void {
    const stream = streams.get(streamId)
    if (!stream) return
    streams.delete(streamId)
    try {
        stream.dataSub.dispose()
        stream.exitSub.dispose()
        stream.bridge.dispose()
    } catch {
        /* ignore */
    }
}

function parseHubMessage(raw: WebSocket.RawData): ServerToClientMessage | null {
    try {
        const parsed = serverToClientMessageSchema.safeParse(JSON.parse(raw.toString()))
        return parsed.success ? parsed.data : null
    } catch {
        return null
    }
}

function send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState !== ws.OPEN) return
    try {
        ws.send(JSON.stringify(msg))
    } catch {
        /* socket closing */
    }
}

main().catch((err) => {
    console.error('fatal:', err instanceof Error ? err.message : err)
    console.error('Run `tmuxd client --help` for usage.')
    process.exit(1)
})
