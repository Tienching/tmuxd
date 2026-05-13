/**
 * `tmuxd attach-session` — full-screen, in-CLI attach to a remote tmux
 * session over WebSocket. The shape mirrors `tmux attach-session` for a
 * user who already lives in tmux: stdin → pane, pane → stdout, raw mode,
 * SIGWINCH propagation, ping/pong keep-alive, and a tmux-style detach
 * key.
 *
 * Wire path is the same the web UI uses:
 *
 *   POST /api/ws-ticket  body { hostId, sessionName }   → { ticket }
 *   WS   /ws/<host>/<session>?ticket=<t>&cols=N&rows=N
 *     → server frames: { type: 'ready' | 'data' | 'exit' | 'error' | 'pong' }
 *     → client frames: { type: 'input' | 'resize' | 'ping' }
 *
 * Detach key: by default `Ctrl-B d` (the literal byte sequence \x02 \x64),
 * matching tmux. Configurable via `--detach-key`. The first byte of the
 * sequence is consumed by the CLI; if the user wanted to literally send
 * the prefix to the inner tmux running on the remote pane, they need to
 * double-tap (the inner tmux uses the prefix once, this attach swallows
 * one prefix turning it into "send prefix once" — same friction as
 * nested-tmux, well-understood by tmux power users).
 *
 * No-TTY refusal: stdin must be a TTY (otherwise raw mode + SIGWINCH
 * are meaningless and the user almost certainly wanted `capture-pane` /
 * `send-text` instead). The CLI prints a one-line hint pointing at the
 * non-interactive verbs and exits 1.
 *
 * Exit codes:
 *   0   detach key pressed, server closed cleanly, or pane exited
 *   1   wire error / no creds / not-a-tty / no-such-host (UsageError-ish)
 *   2   auth error (401, 403); user should `tmuxd login` again
 *   3   session not found (404 from /api/ws-ticket)
 */
import { WebSocket } from 'ws'
import { Buffer } from 'node:buffer'
import type { SavedCred } from './cliCredentials.js'

/** Opaque "the user pressed detach" sentinel raised by handleStdinChunk. */
const DETACH = Symbol('detach')

export interface AttachOptions {
    cred: SavedCred
    hostId: string
    sessionName: string
    /**
     * The byte sequence (literal bytes, not key names) the user must
     * type to detach. Default `Ctrl-B d` = `\x02d`. Anything from one
     * byte up; `\x00` is forbidden.
     */
    detachKey?: Uint8Array
}

export interface AttachStreams {
    stdin: NodeJS.ReadStream
    stdout: NodeJS.WriteStream
    stderr: NodeJS.WriteStream
    /**
     * `process.kill(0)`-style hook for tests. The runtime calls this
     * with the cumulative process state we need to set up (raw mode +
     * SIGWINCH listener) and gets back a teardown function. Tests pass
     * a mock; production uses `applyTty()` below.
     */
    setupTty(initialCols: number, initialRows: number, onResize: (cols: number, rows: number) => void): () => void
}

export interface AttachResult {
    /** 0 / 1 / 2 / 3 — see top-of-file comment. */
    exitCode: number
    /** Reason a human can read; goes to stderr. */
    reason: string
}

/**
 * Default detach key: `Ctrl-B` (0x02), then `d` (0x64). Matches tmux.
 * We check the literal sequence; the user can pass any sequence via
 * --detach-key (parsed in cli.ts and converted to bytes there).
 */
export const DEFAULT_DETACH_KEY = Uint8Array.from([0x02, 0x64])

/**
 * The detach-key state machine. Holds an in-progress prefix-match
 * cursor: each incoming byte either matches the next expected detach
 * byte (advance), or doesn't (flush whatever we'd buffered + the new
 * byte as raw input). When the cursor reaches the end, raise DETACH.
 *
 * This shape lets us match arbitrary-length detach sequences without
 * losing input bytes when the prefix matches partially. e.g. with
 * detach=`\x02d`, typing `Ctrl-B x` should send literal `\x02 x` to
 * the remote, not `x`.
 */
class DetachMatcher {
    private cursor = 0
    constructor(private readonly key: Uint8Array) {
        if (key.length === 0) throw new Error('detach key must be at least 1 byte')
    }
    /**
     * Feed one chunk; return either the bytes that should be forwarded
     * to the remote (with detach-prefix-match progress preserved across
     * calls), or DETACH if the full sequence was matched mid-chunk.
     */
    feed(chunk: Uint8Array): Uint8Array | typeof DETACH {
        const out: number[] = []
        for (let i = 0; i < chunk.length; i++) {
            const byte = chunk[i]
            if (byte === this.key[this.cursor]) {
                this.cursor++
                if (this.cursor === this.key.length) {
                    return DETACH
                }
            } else {
                // Mismatch: flush all the bytes we'd been holding back
                // (they were a prefix that didn't pan out) plus this byte.
                for (let j = 0; j < this.cursor; j++) out.push(this.key[j])
                this.cursor = 0
                // Re-check the current byte against position 0 — covers
                // detach=`AB` and input `AAB`, where the second A is a
                // fresh match start.
                if (byte === this.key[0]) {
                    this.cursor = 1
                } else {
                    out.push(byte)
                }
            }
        }
        return Uint8Array.from(out)
    }
}

/** Apply raw mode + register SIGWINCH; return a teardown fn. */
export function applyTty(
    stdin: NodeJS.ReadStream,
    stdout: NodeJS.WriteStream,
    onResize: (cols: number, rows: number) => void
): () => void {
    const wasRaw = stdin.isRaw === true
    if (typeof stdin.setRawMode === 'function') stdin.setRawMode(true)
    stdin.resume()
    const sigwinch = () => {
        const cols = stdout.columns ?? 80
        const rows = stdout.rows ?? 24
        onResize(cols, rows)
    }
    process.on('SIGWINCH', sigwinch)
    return () => {
        process.off('SIGWINCH', sigwinch)
        if (typeof stdin.setRawMode === 'function') {
            try {
                stdin.setRawMode(wasRaw)
            } catch {
                /* stdin already closed */
            }
        }
        stdin.pause()
    }
}

interface WsLike {
    on(event: string, cb: (...args: unknown[]) => void): void
    send(data: string): void
    close(code?: number, reason?: string): void
    readyState: number
    readonly OPEN: number
}

export interface AttachWireFactory {
    /**
     * Build the WS URL (already including ?ticket=&cols=&rows=) and
     * open the WebSocket. Pulled out so unit tests can swap in a
     * fake WS without `ws` library knowledge.
     */
    issueTicket(opts: { tmuxdUrl: string; jwt: string; hostId: string; sessionName: string }): Promise<{
        ticket: string
        expiresAt: number
    }>
    openWs(url: string): WsLike
}

/**
 * Default factory: real fetch + real `ws` package. Tests inject a
 * mock factory and skip both.
 */
export const realAttachWire: AttachWireFactory = {
    async issueTicket({ tmuxdUrl, jwt, hostId, sessionName }) {
        const res = await fetch(`${tmuxdUrl.replace(/\/+$/, '')}/api/ws-ticket`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${jwt}` },
            body: JSON.stringify({ hostId, sessionName })
        })
        const text = await res.text()
        let parsed: unknown = null
        try {
            parsed = text ? JSON.parse(text) : null
        } catch {
            /* keep parsed null; fall through to error path */
        }
        if (!res.ok) {
            const err =
                (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)
                    ? String((parsed as { error: unknown }).error)
                    : `http_${res.status}`)
            const e = new Error(err) as Error & { status?: number }
            e.status = res.status
            throw e
        }
        if (!parsed || typeof parsed !== 'object' || typeof (parsed as Record<string, unknown>).ticket !== 'string') {
            throw new Error('ws-ticket response missing `ticket` field')
        }
        return parsed as { ticket: string; expiresAt: number }
    },
    openWs(url) {
        return new WebSocket(url) as unknown as WsLike
    }
}

/**
 * Run an attach session against `cred.tmuxdUrl`. Resolves with an
 * `AttachResult` once the session ends (detach key, server close,
 * pane exit, transport error). Pure — pulls all I/O through
 * `streams` + `wire`, so tests can drive it deterministically.
 */
export async function runAttach(
    opts: AttachOptions,
    streams: AttachStreams,
    wire: AttachWireFactory = realAttachWire
): Promise<AttachResult> {
    const { cred, hostId, sessionName } = opts
    const detachKey = opts.detachKey ?? DEFAULT_DETACH_KEY

    if (!streams.stdin.isTTY) {
        return {
            exitCode: 1,
            reason:
                'attach-session requires a TTY on stdin. For non-interactive use, prefer ' +
                '`tmuxd send-text` / `tmuxd send-keys` (write) and `tmuxd capture-pane` (read), ' +
                'or pass `--print-url` to get the web-UI deep-link.'
        }
    }

    // Issue a ticket. Surface 401/403/404 with the same exit-code
    // contract the rest of the CLI uses.
    let ticket: string
    try {
        const issued = await wire.issueTicket({
            tmuxdUrl: cred.tmuxdUrl,
            jwt: cred.jwt,
            hostId,
            sessionName
        })
        ticket = issued.ticket
    } catch (err) {
        const e = err as Error & { status?: number }
        if (e.status === 401 || e.status === 403) {
            return {
                exitCode: 2,
                reason: `auth rejected (${e.message}). Run \`tmuxd login --server ${cred.tmuxdUrl} ...\` again.`
            }
        }
        if (e.status === 404) {
            return {
                exitCode: 3,
                reason: `target not found: ${hostId}:${sessionName}. Check \`tmuxd list-sessions -t ${hostId}\`.`
            }
        }
        return { exitCode: 1, reason: `failed to obtain ws-ticket: ${e.message}` }
    }

    // Build the WS URL. Loopback + same host as `tmuxdUrl`. Origin is
    // not set by `ws` for ws:// scheme, so the server's same-origin
    // check sees no Origin header and accepts.
    const wsUrl = (() => {
        const u = new URL(cred.tmuxdUrl)
        u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
        u.pathname = `/ws/${encodeURIComponent(hostId)}/${encodeURIComponent(sessionName)}`
        const initialCols = streams.stdout.columns ?? 80
        const initialRows = streams.stdout.rows ?? 24
        u.search = ''
        u.searchParams.set('ticket', ticket)
        u.searchParams.set('cols', String(initialCols))
        u.searchParams.set('rows', String(initialRows))
        return u.toString()
    })()

    const ws = wire.openWs(wsUrl)
    const matcher = new DetachMatcher(detachKey)
    let teardownTty: (() => void) | null = null
    let pingInterval: NodeJS.Timeout | null = null
    let result: AttachResult | null = null

    const finish = (r: AttachResult) => {
        if (result) return
        result = r
        if (pingInterval) clearInterval(pingInterval)
        if (teardownTty) teardownTty()
        try {
            if (ws.readyState === ws.OPEN) ws.close(1000, 'cli_detach')
        } catch {
            /* ignore */
        }
    }

    const sendInput = (chunk: Uint8Array) => {
        if (chunk.length === 0) return
        if (ws.readyState !== ws.OPEN) return
        const payload = Buffer.from(chunk).toString('base64')
        try {
            ws.send(JSON.stringify({ type: 'input', payload }))
        } catch {
            /* close handler will clean up */
        }
    }

    const sendResize = (cols: number, rows: number) => {
        if (ws.readyState !== ws.OPEN) return
        try {
            ws.send(JSON.stringify({ type: 'resize', cols, rows }))
        } catch {
            /* ignore */
        }
    }

    return new Promise<AttachResult>((resolve) => {
        ws.on('open', () => {
            // Hook stdin only AFTER the WS is open — otherwise the user's
            // first keystroke before the connect completes ends up as
            // `sendInput` against a CONNECTING socket and gets dropped.
            const initialCols = streams.stdout.columns ?? 80
            const initialRows = streams.stdout.rows ?? 24
            teardownTty = streams.setupTty(initialCols, initialRows, sendResize)
            // A 25s ping keeps idle attaches alive past the server's
            // 30-min idle timeout (the server resets `lastActivity` on
            // any frame, including pong responses to our pings).
            pingInterval = setInterval(() => {
                if (ws.readyState !== ws.OPEN) return
                try {
                    ws.send(JSON.stringify({ type: 'ping' }))
                } catch {
                    /* ignore */
                }
            }, 25_000)
            streams.stdin.on('data', (chunk: Buffer) => {
                const fed = matcher.feed(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
                if (fed === DETACH) {
                    finish({ exitCode: 0, reason: 'detached (Ctrl-B d)' })
                    return
                }
                sendInput(fed)
            })
            streams.stdin.on('end', () => {
                // stdin closed (e.g. ssh dropped). No more input — we
                // could keep the WS open as a one-way viewer, but the
                // canonical move is to detach.
                finish({ exitCode: 0, reason: 'stdin closed' })
            })
        })

        ws.on('message', (raw: unknown) => {
            // `ws` emits a Buffer for text frames; coerce defensively.
            let text: string
            if (typeof raw === 'string') {
                text = raw
            } else if (raw instanceof Buffer) {
                text = raw.toString('utf8')
            } else if (raw instanceof Uint8Array) {
                text = Buffer.from(raw).toString('utf8')
            } else {
                return
            }
            let frame: Record<string, unknown>
            try {
                frame = JSON.parse(text) as Record<string, unknown>
            } catch {
                return
            }
            switch (frame.type) {
                case 'ready':
                    // Server has accepted us. Nothing to do — the user's
                    // keystrokes will start flowing through the matcher
                    // as soon as setupTty unpaused stdin.
                    break
                case 'data': {
                    const payload = frame.payload
                    if (typeof payload !== 'string') return
                    const buf = Buffer.from(payload, 'base64')
                    streams.stdout.write(buf)
                    break
                }
                case 'exit':
                    finish({
                        exitCode: 0,
                        reason: `pane exited (code=${frame.code ?? 'null'}, signal=${frame.signal ?? 'null'})`
                    })
                    break
                case 'error': {
                    const message = typeof frame.message === 'string' ? frame.message : 'unknown'
                    // Auth-style errors at the WS layer (e.g. expired ticket)
                    // come through as 'error' frames. 'idle_timeout' is the
                    // server's own quit signal — exit 0, not an error.
                    if (message === 'idle_timeout') {
                        finish({ exitCode: 0, reason: 'detached (idle timeout)' })
                    } else if (message === 'too_many_connections') {
                        finish({ exitCode: 1, reason: 'too_many_connections' })
                    } else {
                        finish({ exitCode: 1, reason: `server error: ${message}` })
                    }
                    break
                }
                case 'pong':
                    // Keepalive response. We don't measure latency for now.
                    break
            }
        })

        ws.on('close', (...args: unknown[]) => {
            // If we already finished (detach key), don't overwrite the
            // detach reason with a "ws closed" one.
            const code = typeof args[0] === 'number' ? (args[0] as number) : null
            const reasonBuf = args[1]
            const reason =
                typeof reasonBuf === 'string'
                    ? reasonBuf
                    : reasonBuf instanceof Buffer
                    ? reasonBuf.toString('utf8')
                    : ''
            finish({
                exitCode: 0,
                reason: reason || (code !== null ? `connection closed (code=${code})` : 'connection closed')
            })
            resolve(result ?? { exitCode: 0, reason: 'closed' })
        })

        ws.on('error', (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err)
            finish({ exitCode: 1, reason: `ws error: ${message}` })
            resolve(result ?? { exitCode: 1, reason: message })
        })
    })
}

/** Test-only export of internals. */
export const __testing = { DetachMatcher, DETACH }
