#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { config as loadDotenv } from 'dotenv'
import WebSocket from 'ws'
import { attachTmuxPty, type PtyBridge } from './ptyManager.js'
import { capturePane, captureSession, createSession, killSession, listPanes, listSessions, sendKeysToTarget, sendTextToTarget } from './tmux.js'
import { agentServerMessageSchema, type AgentServerMessage } from './agentProtocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: join(__dirname, '..', '..', '.env') })
loadDotenv()

const VERSION = '0.1.0'
const DEFAULT_NAME = 'agent'
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
        // Map the short -h to --help so the help printer below catches it.
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

function makeAgentUrl(hubUrl: string): string {
    const url = new URL('/agent/connect', hubUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return url.toString()
}

function printHelpAndExit(): never {
    // Operator-facing usage. Don't dump environment or token values; those
    // are deploy-secret-class. Do enumerate every flag + env var so an
    // operator with /etc/systemd/system/tmuxd-agent.service in front of
    // them can write a complete unit.
    const text = `tmuxd agent — outbound WebSocket connection to a tmuxd hub

Usage:
  tmuxd agent [flags]
  TMUXD_* env vars are equivalent (env-only deploys are supported).

Required:
  --hub <url>          Hub base URL, e.g. https://tmuxd.example.com
                       (env: TMUXD_HUB_URL)
  --token <secret>     Raw agent token from the hub's TMUXD_AGENT_TOKENS
                       binding. Sent as Authorization: Bearer.
                       (env: TMUXD_AGENT_TOKEN)

Optional:
  --id <hostId>        Stable host ID. Must match the hostId pinned in the
                       hub binding (e.g. \`alice/laptop=...\` → --id laptop).
                       Defaults to the slug of --name. (env: TMUXD_AGENT_ID)
  --name <display>     Human-readable name shown in the web UI.
                       (env: TMUXD_AGENT_NAME, default: "agent")
  --namespace <ns>     Multi-user hub: the namespace this agent registers
                       under. Must match the namespace pinned in the hub
                       binding (\`alice/laptop=...\` → --namespace alice).
                       Mismatch → hub closes WS with code 4401 and the
                       agent exits with status 2.
                       (env: TMUXD_AGENT_NAMESPACE, default: "default")
  --help, -h           Print this message and exit.

Exit codes:
  0   Clean shutdown (e.g. SIGTERM)
  1   Fatal startup error (missing flags, etc.)
  2   Hub rejected configuration (namespace mismatch, host_id_token_mismatch)

Examples:
  tmuxd agent --hub http://hub.example:7681 --token \${ALICE_TOKEN} \\
              --namespace alice --id laptop --name "Alice Laptop"

  TMUXD_HUB_URL=http://hub.example:7681 \\
  TMUXD_AGENT_TOKEN=\${ALICE_TOKEN} \\
  TMUXD_AGENT_NAMESPACE=alice \\
  TMUXD_AGENT_ID=laptop \\
  TMUXD_AGENT_NAME="Alice Laptop" \\
    tmuxd agent

See docs/hub-mode.md in the repo for the full multi-user deployment guide.
`
    process.stdout.write(text)
    process.exit(0)
}

function readConfig() {
    const args = parseArgs(process.argv.slice(2))
    if (args.help || args.h) printHelpAndExit()
    const namespace = (args.namespace || process.env.TMUXD_AGENT_NAMESPACE || '').trim() || undefined
    return {
        hubUrl: requireValue('--hub or TMUXD_HUB_URL', args.hub || process.env.TMUXD_HUB_URL),
        token: requireValue('--token or TMUXD_AGENT_TOKEN', args.token || process.env.TMUXD_AGENT_TOKEN),
        name: (args.name || process.env.TMUXD_AGENT_NAME || DEFAULT_NAME).trim() || DEFAULT_NAME,
        id: (args.id || process.env.TMUXD_AGENT_ID || '').trim() || undefined,
        namespace
    }
}

/**
 * Thrown when the hub rejects the agent for a configuration reason that
 * retrying cannot fix (e.g. namespace mismatch). The agent main loop
 * catches it, prints a clear instruction, and exits with code 2 instead
 * of looping forever on backoff.
 */
class FatalConfigError extends Error {
    constructor(message: string, public readonly hint: string) {
        super(message)
        this.name = 'FatalConfigError'
    }
}

async function main() {
    const config = readConfig()
    if (!config.namespace) {
        // Best-effort warning. The server's binding may or may not require
        // a namespace; if it does and we omit, the close-handler below will
        // turn the hub's 4401 reject into a hard exit.
        console.warn('[agent] --namespace not set; defaulting to "default". Set --namespace or TMUXD_AGENT_NAMESPACE if your hub binding pins one.')
    }
    let attempt = 0
    for (;;) {
        try {
            await connectOnce(config)
            attempt = 0
        } catch (err) {
            if (err instanceof FatalConfigError) {
                console.error(`[agent] ${err.message}`)
                console.error(`[agent] hint: ${err.hint}`)
                process.exit(2)
            }
            console.error(`[agent] ${err instanceof Error ? err.message : String(err)}`)
        }
        attempt = Math.min(attempt + 1, 6)
        const delay = Math.min(30_000, 500 * 2 ** attempt)
        await sleep(delay)
    }
}

function connectOnce(config: ReturnType<typeof readConfig>): Promise<void> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(makeAgentUrl(config.hubUrl), {
            headers: { authorization: `Bearer ${config.token}` }
        })
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
                id: config.id,
                name: config.name,
                version: VERSION,
                capabilities: CAPABILITIES,
                ...(config.namespace ? { namespace: config.namespace } : {})
            })
        })

        ws.on('message', (raw) => {
            const msg = parseHubMessage(raw)
            if (!msg) return
            if (msg.type === 'hello_ack') {
                // Include the namespace the agent registered under so the
                // operator can correlate this log line with the hub's
                // `agent_register` audit event without guessing.
                const ns = config.namespace ?? 'default'
                console.log(`[agent] connected as ${msg.hostId} (namespace=${ns})`)
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
                reject(new Error(`hub rejected agent websocket: HTTP ${res.statusCode}`))
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
                if (code === 4401 && reason.startsWith('agent_namespace_mismatch')) {
                    reject(
                        new FatalConfigError(
                            `hub rejected hello: ${reason}`,
                            'set --namespace (or TMUXD_AGENT_NAMESPACE) to match the namespace pinned in TMUXD_AGENT_TOKENS on the hub.'
                        )
                    )
                    return
                }
                resolve()
            }
        })
    })
}

async function handleMessage(ws: WebSocket, streams: Map<string, StreamState>, msg: AgentServerMessage): Promise<void> {
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

function parseHubMessage(raw: WebSocket.RawData): AgentServerMessage | null {
    try {
        const parsed = agentServerMessageSchema.safeParse(JSON.parse(raw.toString()))
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
    console.error('Run `tmuxd agent --help` for usage.')
    process.exit(1)
})
