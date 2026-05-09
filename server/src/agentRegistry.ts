import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import { WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import {
    LOCAL_HOST_ID,
    hostIdSchema,
    sessionNameSchema,
    sessionTargetNameSchema,
    tmuxKeySchema,
    tmuxPaneTargetSchema,
    type HostCapability,
    type HostInfo,
    type TargetSession,
    type TmuxPane,
    type TmuxPaneCapture,
    type TmuxSession
} from '@tmuxd/shared'
import { agentClientMessageSchema, type AgentClientMessage, type AgentHelloMessage, type AgentServerMessage } from './agentProtocol.js'
import type { TmuxCapture } from './tmux.js'

const VERSION = '0.1.0'
const HEARTBEAT_MS = 15_000
const HELLO_TIMEOUT_MS = 5_000
const REQUEST_TIMEOUT_MS = 10_000
const STREAM_READY_TIMEOUT_MS = 10_000
const MAX_AGENT_PAYLOAD = 24 * 1024 * 1024
const MAX_REMOTE_SESSION_CAPTURE_BYTES = 16 * 1024 * 1024
const MAX_REMOTE_PANE_CAPTURE_BYTES = 384 * 1024
const MAX_REMOTE_PANES = 1024
const MAX_REMOTE_STRING = 4096
const DEFAULT_CAPABILITIES: HostCapability[] = ['list', 'create', 'kill', 'capture', 'attach', 'panes', 'input']
const tmuxResultStringSchema = z.string().min(1).max(2048)
const tmuxOptionalStringSchema = z.string().max(MAX_REMOTE_STRING)
const remoteSessionCaptureTextSchema = z.string().refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_REMOTE_SESSION_CAPTURE_BYTES,
    'capture text too large'
)
const remotePaneCaptureTextSchema = z.string().refine(
    (value) => Buffer.byteLength(value, 'utf8') <= MAX_REMOTE_PANE_CAPTURE_BYTES,
    'pane capture text too large'
)

export interface AgentTokenBinding {
    /**
     * When present, this token can only register the matching hostId.
     * A null hostId is the legacy shared-token mode.
     */
    hostId: string | null
    token: string
}

const tmuxSessionSchema = z
    .object({
        name: tmuxResultStringSchema,
        windows: z.number().int().min(0),
        attached: z.boolean(),
        attachedClients: z.number().int().min(0).optional(),
        created: z.number().int().min(0),
        activity: z.number().int().min(0)
    })
    .transform((session) => ({
        ...session,
        attachedClients: session.attachedClients ?? (session.attached ? 1 : 0)
    }))
const listSessionsResultSchema = z.object({ sessions: z.array(tmuxSessionSchema).max(MAX_REMOTE_PANES) })
const tmuxPaneSchema = z
    .object({
        target: tmuxResultStringSchema,
        sessionName: tmuxResultStringSchema,
        windowIndex: z.number().int().min(0),
        windowName: tmuxOptionalStringSchema,
        windowActive: z.boolean(),
        paneIndex: z.number().int().min(0),
        paneId: tmuxResultStringSchema.max(32),
        paneActive: z.boolean(),
        paneDead: z.boolean(),
        currentCommand: tmuxOptionalStringSchema,
        currentPath: tmuxOptionalStringSchema,
        title: tmuxOptionalStringSchema,
        width: z.number().int().min(0),
        height: z.number().int().min(0),
        paneInMode: z.boolean(),
        scrollPosition: z.number().int().min(0),
        historySize: z.number().int().min(0),
        sessionAttached: z.boolean().optional().default(false),
        sessionAttachedClients: z.number().int().min(0).optional(),
        sessionActivity: z.number().int().min(0).optional().default(0),
        windowActivity: z.number().int().min(0).optional().default(0)
    })
    .transform((pane) => ({
        ...pane,
        sessionAttachedClients: pane.sessionAttachedClients ?? (pane.sessionAttached ? 1 : 0)
    }))
const listPanesResultSchema = z.object({ panes: z.array(tmuxPaneSchema).max(MAX_REMOTE_PANES) })
const captureResultSchema = z.object({
    text: remoteSessionCaptureTextSchema,
    paneInMode: z.boolean(),
    scrollPosition: z.number().int().min(0),
    historySize: z.number().int().min(0),
    paneHeight: z.number().int().min(0)
})
const paneCaptureResultSchema = captureResultSchema.extend({
    text: remotePaneCaptureTextSchema,
    target: tmuxPaneTargetSchema,
    truncated: z.boolean(),
    maxBytes: z.number().int().min(1024).max(MAX_REMOTE_PANE_CAPTURE_BYTES)
})

export interface RemoteStreamBridge {
    session: string
    cols: number
    rows: number
    onData(cb: (payload: string) => void): { dispose(): void }
    onExit(cb: (event: { exitCode: number | null; signal: string | null }) => void): { dispose(): void }
    onError(cb: (message: string) => void): { dispose(): void }
    writeBase64Payload(payload: string): void
    resize(cols: number, rows: number): void
    dispose(): void
}

export class AgentRegistry {
    private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_AGENT_PAYLOAD })
    private readonly agents = new Map<string, RemoteHostConnection>()
    private readonly authenticatedHostIds = new WeakMap<WebSocket, string | null>()
    private readonly agentTokens: AgentTokenBinding[]

    constructor(agentTokens: AgentTokenBinding[] | string | null) {
        this.agentTokens = normalizeAgentTokens(agentTokens)
        this.wss.on('connection', (ws, request) => this.acceptAgent(ws, request))
    }

    get webSocketServer(): WebSocketServer {
        return this.wss
    }

    async tryHandleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
        const url = new URL(request.url || '', 'http://localhost')
        if (url.pathname !== '/agent/connect') return false

        if (this.agentTokens.length === 0) {
            writeHttp(socket, 404, 'Not Found')
            return true
        }

        const auth = this.matchToken(readBearerToken(request) || '')
        if (!auth) {
            writeHttp(socket, 401, 'Unauthorized')
            return true
        }

        this.wss.handleUpgrade(request, socket, head, (ws) => {
            this.authenticatedHostIds.set(ws, auth.hostId)
            this.wss.emit('connection', ws, request)
        })
        return true
    }

    listHosts(): HostInfo[] {
        return [...this.agents.values()].map((agent) => agent.hostInfo())
    }

    hasHost(hostId: string): boolean {
        return this.agents.has(hostId)
    }

    async listSessions(hostId: string): Promise<TargetSession[]> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('list')
        const body = await agent.request('list_sessions', {})
        const parsed = listSessionsResultSchema.parse(body)
        const host = agent.hostInfo()
        return parsed.sessions.map((session) => toTargetSession(session, host))
    }

    async createSession(hostId: string, name: string): Promise<void> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('create')
        const safe = sessionNameSchema.parse(name)
        await agent.request('create_session', { name: safe })
    }

    async killSession(hostId: string, name: string): Promise<void> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('kill')
        const safe = sessionTargetNameSchema.parse(name)
        await agent.request('kill_session', { name: safe })
    }

    async captureSession(hostId: string, name: string): Promise<TmuxCapture> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('capture')
        const safe = sessionTargetNameSchema.parse(name)
        const body = await agent.request('capture_session', { name: safe })
        return captureResultSchema.parse(body)
    }

    async listPanes(hostId: string, session?: string): Promise<TmuxPane[]> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('panes')
        const safeSession = session ? sessionTargetNameSchema.parse(session) : undefined
        const body = await agent.request('list_panes', safeSession ? { session: safeSession } : {})
        return listPanesResultSchema.parse(body).panes
    }

    async capturePane(hostId: string, target: string, lines?: number, maxBytes?: number): Promise<TmuxPaneCapture> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('panes')
        const safe = tmuxPaneTargetSchema.parse(target)
        const body = await agent.request('capture_pane', {
            target: safe,
            ...(lines ? { lines } : {}),
            ...(maxBytes ? { maxBytes } : {})
        })
        return paneCaptureResultSchema.parse(body)
    }

    async sendText(hostId: string, target: string, text: string, enter?: boolean): Promise<void> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('input')
        const safe = tmuxPaneTargetSchema.parse(target)
        await agent.request('send_text', { target: safe, text, enter })
    }

    async sendKeys(hostId: string, target: string, keys: string[]): Promise<void> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('input')
        const safe = tmuxPaneTargetSchema.parse(target)
        const safeKeys = keys.map((key) => tmuxKeySchema.parse(key))
        await agent.request('send_keys', { target: safe, keys: safeKeys })
    }

    async attach(hostId: string, session: string, cols: number, rows: number): Promise<RemoteStreamBridge> {
        const agent = this.requireAgent(hostId)
        agent.requireCapability('attach')
        const safe = sessionTargetNameSchema.parse(session)
        return agent.attach(safe, cols, rows)
    }

    close(): void {
        for (const agent of this.agents.values()) agent.close(1001, 'server_shutdown')
        this.agents.clear()
        this.wss.close()
    }

    private acceptAgent(ws: WebSocket, _request: IncomingMessage): void {
        let accepted: RemoteHostConnection | null = null
        const timer = setTimeout(() => {
            if (!accepted) ws.close(1008, 'missing_hello')
        }, HELLO_TIMEOUT_MS)

        const onFirstMessage = (raw: Buffer) => {
            const msg = parseAgentMessage(raw)
            if (!msg || msg.type !== 'hello') {
                ws.close(1008, 'invalid_hello')
                return
            }
            clearTimeout(timer)
            try {
                const boundHostId = this.authenticatedHostIds.get(ws) ?? null
                this.authenticatedHostIds.delete(ws)
                const hostId = resolveHostId(msg, boundHostId)
                const existing = this.agents.get(hostId)
                if (existing) throw new AgentError('host_already_connected')

                const conn = new RemoteHostConnection(ws, msg, hostId, () => {
                    if (this.agents.get(hostId) === conn) this.agents.delete(hostId)
                })
                this.agents.set(hostId, conn)
                accepted = conn
                ws.off('message', onFirstMessage)
                conn.start()
            } catch (err) {
                ws.close(1008, err instanceof Error ? err.message : 'invalid_hello')
            }
        }

        ws.on('message', onFirstMessage)
        ws.on('close', () => clearTimeout(timer))
        ws.on('error', () => clearTimeout(timer))
    }

    private requireAgent(hostId: string): RemoteHostConnection {
        const agent = this.agents.get(hostId)
        if (!agent) throw new AgentError('host_not_found')
        return agent
    }

    private matchToken(token: string): AgentTokenBinding | null {
        if (!token) return null
        for (const binding of this.agentTokens) {
            if (sameSecret(token, binding.token)) return binding
        }
        return null
    }
}

export class AgentError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'AgentError'
    }
}

class RemoteHostConnection {
    private readonly pending = new Map<string, PendingRequest>()
    private readonly streams = new Map<string, RemoteStream>()
    private readonly heartbeat: NodeJS.Timeout
    private lastSeenAt = Date.now()
    private requestCounter = 0
    private closed = false
    private readonly host: HostInfo

    constructor(
        private readonly ws: WebSocket,
        hello: AgentHelloMessage,
        hostId: string,
        private readonly onClose: () => void
    ) {
        this.host = {
            id: hostId,
            name: hello.name.trim(),
            status: 'online',
            isLocal: false,
            version: hello.version || VERSION,
            lastSeenAt: this.lastSeenAt,
            capabilities: hello.capabilities?.length ? [...hello.capabilities] : [...DEFAULT_CAPABILITIES]
        }
        this.heartbeat = setInterval(() => this.tickHeartbeat(), HEARTBEAT_MS)
        this.heartbeat.unref?.()
    }

    start(): void {
        this.send({ type: 'hello_ack', hostId: this.host.id, heartbeatMs: HEARTBEAT_MS })
        this.ws.on('message', (raw: Buffer) => this.handleMessage(raw))
        this.ws.on('close', () => this.cleanup('agent_disconnected'))
        this.ws.on('error', () => this.cleanup('agent_error'))
    }

    hostInfo(): HostInfo {
        return { ...this.host, lastSeenAt: this.lastSeenAt }
    }

    requireCapability(capability: HostCapability): void {
        if (!this.host.capabilities.includes(capability)) throw new AgentError('capability_not_supported')
    }

    async request(type: AgentServerMessage['type'], payload: Record<string, unknown>): Promise<unknown> {
        if (this.closed || this.ws.readyState !== this.ws.OPEN) throw new AgentError('host_not_found')
        const id = `${Date.now().toString(36)}-${++this.requestCounter}`
        const msg = { type, id, ...payload } as AgentServerMessage
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id)
                reject(new AgentError('agent_timeout'))
            }, REQUEST_TIMEOUT_MS)
            this.pending.set(id, { resolve, reject, timer })
            try {
                this.send(msg)
            } catch (err) {
                clearTimeout(timer)
                this.pending.delete(id)
                reject(err)
            }
        })
    }

    async attach(session: string, cols: number, rows: number): Promise<RemoteStreamBridge> {
        if (this.closed || this.ws.readyState !== this.ws.OPEN) throw new AgentError('host_not_found')
        const safe = sessionTargetNameSchema.parse(session)
        const streamId = randomUUID()
        const stream = new RemoteStream(this, streamId, safe, cols, rows)
        this.streams.set(streamId, stream)
        try {
            this.send({ type: 'attach', streamId, session: safe, cols, rows })
            await stream.waitReady(STREAM_READY_TIMEOUT_MS)
            return stream
        } catch (err) {
            stream.dispose()
            throw err
        }
    }

    sendStreamInput(streamId: string, payload: string): void {
        this.send({ type: 'input', streamId, payload })
    }

    resizeStream(streamId: string, cols: number, rows: number): void {
        this.send({ type: 'resize', streamId, cols, rows })
    }

    unregisterStream(streamId: string, sendDetach: boolean): void {
        this.streams.delete(streamId)
        if (sendDetach && !this.closed && this.ws.readyState === this.ws.OPEN) {
            this.send({ type: 'detach', streamId })
        }
    }

    close(code: number, reason: string): void {
        if (this.closed) return
        try {
            this.ws.close(code, reason)
        } catch {
            /* ignore */
        }
        this.cleanup(reason)
    }

    private handleMessage(raw: Buffer): void {
        const msg = parseAgentMessage(raw)
        if (!msg) return
        this.lastSeenAt = Date.now()

        if (msg.type === 'hello') return
        if (msg.type === 'pong') return

        if (msg.type === 'result') {
            const pending = this.pending.get(msg.id)
            if (!pending) return
            clearTimeout(pending.timer)
            this.pending.delete(msg.id)
            if (msg.ok) pending.resolve(msg.body)
            else pending.reject(new AgentError(msg.error))
            return
        }

        const stream = this.streams.get(msg.streamId)
        if (!stream) return
        if (msg.type === 'stream_ready') stream.markReady(msg.session, msg.cols, msg.rows)
        else if (msg.type === 'stream_data') stream.emitData(msg.payload)
        else if (msg.type === 'stream_exit') {
            stream.emitExit(msg.code, msg.signal)
            this.streams.delete(msg.streamId)
        } else if (msg.type === 'stream_error') {
            stream.emitError(msg.message)
        }
    }

    private send(msg: AgentServerMessage): void {
        if (this.ws.readyState !== this.ws.OPEN) throw new AgentError('host_not_found')
        this.ws.send(JSON.stringify(msg))
    }

    private tickHeartbeat(): void {
        if (this.closed) return
        if (Date.now() - this.lastSeenAt > HEARTBEAT_MS * 3) {
            this.close(1001, 'agent_timeout')
            return
        }
        try {
            this.send({ type: 'ping' })
        } catch {
            this.cleanup('agent_disconnected')
        }
    }

    private cleanup(reason: string): void {
        if (this.closed) return
        this.closed = true
        clearInterval(this.heartbeat)
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer)
            pending.reject(new AgentError(reason))
        }
        this.pending.clear()
        for (const stream of this.streams.values()) {
            stream.failFromConnection(reason)
        }
        this.streams.clear()
        this.onClose()
    }
}

class RemoteStream implements RemoteStreamBridge {
    session: string
    cols: number
    rows: number
    private readonly dataHandlers = new Set<(payload: string) => void>()
    private readonly exitHandlers = new Set<(event: { exitCode: number | null; signal: string | null }) => void>()
    private readonly errorHandlers = new Set<(message: string) => void>()
    private ready = false
    private disposed = false
    private readyTimer: NodeJS.Timeout | null = null
    private readyResolve: (() => void) | null = null
    private readyReject: ((err: Error) => void) | null = null

    constructor(
        private readonly conn: RemoteHostConnection,
        private readonly streamId: string,
        session: string,
        cols: number,
        rows: number
    ) {
        this.session = session
        this.cols = cols
        this.rows = rows
    }

    waitReady(timeoutMs: number): Promise<void> {
        if (this.ready) return Promise.resolve()
        return new Promise((resolve, reject) => {
            this.readyResolve = resolve
            this.readyReject = reject
            this.readyTimer = setTimeout(() => {
                this.readyReject = null
                this.readyResolve = null
                reject(new AgentError('attach_timeout'))
            }, timeoutMs)
        })
    }

    markReady(session: string, cols: number, rows: number): void {
        if (this.disposed) return
        this.session = session
        this.cols = cols
        this.rows = rows
        this.ready = true
        if (this.readyTimer) clearTimeout(this.readyTimer)
        this.readyTimer = null
        this.readyResolve?.()
        this.readyResolve = null
        this.readyReject = null
    }

    emitData(payload: string): void {
        if (this.disposed) return
        for (const cb of this.dataHandlers) cb(payload)
    }

    emitExit(exitCode: number | null, signal: string | null): void {
        if (this.disposed) return
        for (const cb of this.exitHandlers) cb({ exitCode, signal })
        this.disposed = true
        this.clearReadyTimer()
    }

    emitError(message: string): void {
        if (this.disposed) return
        if (!this.ready && this.readyReject) {
            this.clearReadyTimer()
            this.readyReject(new AgentError(message))
            this.readyReject = null
            this.readyResolve = null
        }
        for (const cb of this.errorHandlers) cb(message)
    }

    failFromConnection(message: string): void {
        if (this.disposed) return
        this.emitError(message)
        for (const cb of this.exitHandlers) cb({ exitCode: null, signal: null })
        this.disposed = true
        this.clearReadyTimer()
    }

    onData(cb: (payload: string) => void): { dispose(): void } {
        this.dataHandlers.add(cb)
        return { dispose: () => this.dataHandlers.delete(cb) }
    }

    onExit(cb: (event: { exitCode: number | null; signal: string | null }) => void): { dispose(): void } {
        this.exitHandlers.add(cb)
        return { dispose: () => this.exitHandlers.delete(cb) }
    }

    onError(cb: (message: string) => void): { dispose(): void } {
        this.errorHandlers.add(cb)
        return { dispose: () => this.errorHandlers.delete(cb) }
    }

    writeBase64Payload(payload: string): void {
        if (!this.disposed) this.conn.sendStreamInput(this.streamId, payload)
    }

    resize(cols: number, rows: number): void {
        if (this.disposed) return
        this.cols = cols
        this.rows = rows
        this.conn.resizeStream(this.streamId, cols, rows)
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        this.clearReadyTimer()
        this.dataHandlers.clear()
        this.exitHandlers.clear()
        this.errorHandlers.clear()
        this.conn.unregisterStream(this.streamId, true)
    }

    private clearReadyTimer(): void {
        if (this.readyTimer) clearTimeout(this.readyTimer)
        this.readyTimer = null
    }
}

interface PendingRequest {
    resolve: (body: unknown) => void
    reject: (err: Error) => void
    timer: NodeJS.Timeout
}

function parseAgentMessage(raw: Buffer): AgentClientMessage | null {
    try {
        const parsed = agentClientMessageSchema.safeParse(JSON.parse(raw.toString('utf8')))
        return parsed.success ? parsed.data : null
    } catch {
        return null
    }
}

function resolveHostId(hello: AgentHelloMessage, boundHostId: string | null): string {
    if (boundHostId) {
        if (hello.id && hello.id !== boundHostId) throw new Error('host_id_token_mismatch')
        return boundHostId
    }
    const candidate = hello.id ?? slugHostId(hello.name)
    const parsed = hostIdSchema.safeParse(candidate)
    if (!parsed.success || parsed.data === LOCAL_HOST_ID) throw new Error('invalid_host_id')
    return parsed.data
}

function slugHostId(name: string): string {
    const cleaned = name
        .trim()
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64)
    return cleaned || 'agent'
}

function readBearerToken(request: IncomingMessage): string | null {
    const header = request.headers.authorization || ''
    const value = Array.isArray(header) ? header[0] : header
    const match = /^Bearer\s+(.+)$/i.exec(value)
    return match ? match[1] : null
}

function sameSecret(a: string, b: string): boolean {
    const left = Buffer.from(a)
    const right = Buffer.from(b)
    return left.length === right.length && timingSafeEqual(left, right)
}

function normalizeAgentTokens(agentTokens: AgentTokenBinding[] | string | null): AgentTokenBinding[] {
    if (!agentTokens) return []
    if (typeof agentTokens === 'string') {
        const token = agentTokens.trim()
        return token ? [{ hostId: null, token }] : []
    }
    const out: AgentTokenBinding[] = []
    for (const binding of agentTokens) {
        const token = binding.token.trim()
        if (!token) continue
        const hostId = binding.hostId === null ? null : hostIdSchema.parse(binding.hostId)
        if (hostId === LOCAL_HOST_ID) throw new Error('invalid_agent_token_host_id')
        out.push({ hostId, token })
    }
    return out
}

function writeHttp(socket: Duplex, status: number, text: string): void {
    socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
    socket.destroy()
}

function toTargetSession(session: TmuxSession, host: HostInfo): TargetSession {
    return { ...session, hostId: host.id, hostName: host.name }
}
