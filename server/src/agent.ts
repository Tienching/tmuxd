#!/usr/bin/env node
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { config as loadDotenv } from 'dotenv'
import WebSocket from 'ws'
import { attachTmuxPty, type PtyBridge } from './ptyManager.js'
import { captureSession, createSession, killSession, listSessions } from './tmux.js'
import type { AgentServerMessage } from './agentProtocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: join(__dirname, '..', '..', '.env') })
loadDotenv()

const VERSION = '0.1.0'
const DEFAULT_NAME = 'agent'
const CAPABILITIES = ['list', 'create', 'kill', 'capture', 'attach']

interface StreamState {
    bridge: PtyBridge
    dataSub: { dispose(): void }
    exitSub: { dispose(): void }
}

function parseArgs(argv: string[]): Record<string, string> {
    const out: Record<string, string> = {}
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
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

function readConfig() {
    const args = parseArgs(process.argv.slice(2))
    return {
        hubUrl: requireValue('--hub or TMUXD_HUB_URL', args.hub || process.env.TMUXD_HUB_URL),
        token: requireValue('--token or TMUXD_AGENT_TOKEN', args.token || process.env.TMUXD_AGENT_TOKEN),
        name: (args.name || process.env.TMUXD_AGENT_NAME || DEFAULT_NAME).trim() || DEFAULT_NAME,
        id: (args.id || process.env.TMUXD_AGENT_ID || '').trim() || undefined
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
                capabilities: CAPABILITIES
            })
        })

        ws.on('message', (raw) => {
            const msg = parseHubMessage(raw)
            if (!msg) return
            if (msg.type === 'hello_ack') {
                console.log(`[agent] connected as ${msg.hostId}`)
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
        ws.on('close', () => {
            cleanup()
            if (!settled) {
                settled = true
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
        const value = JSON.parse(raw.toString()) as Partial<AgentServerMessage>
        if (!value || typeof value.type !== 'string') return null
        return value as AgentServerMessage
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
    process.exit(1)
})
