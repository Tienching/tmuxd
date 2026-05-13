/**
 * Unit tests for `cliAttach.ts`. Drives `runAttach` against a mock
 * `AttachWireFactory` so we don't need a real WebSocket — the matrix
 * we want to pin (detach key, frames, exit codes, no-TTY refusal) is
 * pure logic that doesn't benefit from end-to-end ws coverage. The
 * e2e suite (scripts/e2e-cli.mjs) exercises the real wire.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { Buffer } from 'node:buffer'
import { EventEmitter } from 'node:events'
import { __testing, runAttach, DEFAULT_DETACH_KEY, type AttachStreams, type AttachWireFactory } from './cliAttach.js'

const { DetachMatcher, DETACH } = __testing

const noopCred = {
    tmuxdUrl: 'http://127.0.0.1:1',
    jwt: 'jwt',
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    namespace: 'ns',
    serverToken: 'st',
    userToken: 'ut'
}

/**
 * Make a fake AttachWireFactory backed by a controllable EventEmitter,
 * so each test can step through the protocol manually:
 *
 *   ctrl.openWs(...)         → returns a WsLike that the test owns
 *   ctrl.emit('open')        → fires the runAttach 'open' handler
 *   ctrl.emit('message', s)  → fires a server frame
 *   ctrl.emit('close', ...)  → fires the close handler (resolves runAttach)
 *   ctrl.sent                → array of strings the SUT sent
 */
function makeMockWire(): {
    wire: AttachWireFactory
    ctrl: EventEmitter & { sent: string[]; readyState: number; OPEN: number; closed: boolean }
    issuedTickets: number
    nextIssueResult: () => Promise<{ ticket: string; expiresAt: number }>
    setIssueRejection(err: Error & { status?: number }): void
} {
    const ctrl = new EventEmitter() as EventEmitter & {
        sent: string[]
        readyState: number
        OPEN: number
        closed: boolean
    }
    ctrl.sent = []
    ctrl.readyState = 1 // WebSocket.OPEN
    ctrl.OPEN = 1
    ctrl.closed = false
    let issueErr: (Error & { status?: number }) | null = null
    let issuedTickets = 0
    const wire: AttachWireFactory = {
        async issueTicket() {
            issuedTickets++
            if (issueErr) throw issueErr
            return { ticket: 'mock-ticket', expiresAt: Math.floor(Date.now() / 1000) + 30 }
        },
        openWs() {
            return {
                on: (event, cb) => {
                    ctrl.on(event, cb as (...args: unknown[]) => void)
                },
                send: (data) => {
                    ctrl.sent.push(data)
                },
                close: () => {
                    ctrl.closed = true
                    ctrl.readyState = 3 // CLOSED
                    setImmediate(() => ctrl.emit('close', 1000, 'cli_detach'))
                },
                get readyState() {
                    return ctrl.readyState
                },
                get OPEN() {
                    return ctrl.OPEN
                }
            }
        }
    }
    return {
        wire,
        ctrl,
        get issuedTickets() {
            return issuedTickets
        },
        nextIssueResult: () => Promise.resolve({ ticket: 'mock-ticket', expiresAt: 0 }),
        setIssueRejection(err) {
            issueErr = err
        }
    } as ReturnType<typeof makeMockWire>
}

/**
 * Make a fake AttachStreams. stdin is a passthrough EventEmitter we
 * push bytes into; stdout collects writes. setupTty just records its
 * dimensions and stores the resize callback so the test can fire SIGWINCH
 * synthetically.
 */
function makeStreams(opts: { isTTY?: boolean } = {}): {
    streams: AttachStreams
    pushStdin(chunk: Buffer): void
    endStdin(): void
    stdoutChunks: Buffer[]
    triggerResize(cols: number, rows: number): void
    teardownCalled: boolean
} {
    const stdin = new EventEmitter() as NodeJS.ReadStream & {
        isTTY?: boolean
        setRawMode?: (enable: boolean) => NodeJS.ReadStream
        resume?: () => NodeJS.ReadStream
        pause?: () => NodeJS.ReadStream
    }
    stdin.isTTY = opts.isTTY !== false
    stdin.resume = () => stdin
    stdin.pause = () => stdin
    stdin.setRawMode = () => stdin
    const stdoutChunks: Buffer[] = []
    const stdout = {
        write: (chunk: string | Buffer) => {
            stdoutChunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk)
            return true
        },
        columns: 100,
        rows: 30,
        isTTY: true
    } as unknown as NodeJS.WriteStream
    const stderr = {
        write: () => true,
        isTTY: false
    } as unknown as NodeJS.WriteStream
    let resizeFn: ((cols: number, rows: number) => void) | null = null
    let teardownCalled = false
    const streams: AttachStreams = {
        stdin,
        stdout,
        stderr,
        setupTty(_cols, _rows, onResize) {
            resizeFn = onResize
            return () => {
                teardownCalled = true
            }
        }
    }
    return {
        streams,
        pushStdin(chunk: Buffer) {
            stdin.emit('data', chunk)
        },
        endStdin() {
            stdin.emit('end')
        },
        stdoutChunks,
        triggerResize(cols: number, rows: number) {
            resizeFn?.(cols, rows)
        },
        get teardownCalled() {
            return teardownCalled
        }
    }
}

describe('DetachMatcher', () => {
    test('matches the default Ctrl-B d sequence at chunk boundary', () => {
        const m = new DetachMatcher(DEFAULT_DETACH_KEY)
        assert.deepEqual(m.feed(Uint8Array.from([0x02, 0x64])), DETACH)
    })

    test('matches across separate feeds (chunked)', () => {
        const m = new DetachMatcher(DEFAULT_DETACH_KEY)
        const r1 = m.feed(Uint8Array.from([0x02]))
        // Mid-prefix: nothing forwarded yet (we hold the byte back).
        assert.notEqual(r1, DETACH)
        assert.deepEqual(r1 as Uint8Array, Uint8Array.from([]))
        const r2 = m.feed(Uint8Array.from([0x64]))
        assert.deepEqual(r2, DETACH)
    })

    test('non-matching prefix is flushed back to the input stream', () => {
        // detach=`Ctrl-B d`, user types `Ctrl-B x`. Expected forwarded
        // bytes: `\x02 x` (the failed prefix byte + the disrupting byte).
        const m = new DetachMatcher(DEFAULT_DETACH_KEY)
        const r = m.feed(Uint8Array.from([0x02, 0x78]))
        assert.deepEqual(r as Uint8Array, Uint8Array.from([0x02, 0x78]))
    })

    test('overlapping match start is detected (prefix=AB, input=AAB)', () => {
        // Edge case: if the first byte fails to extend the match but
        // happens to match the START of the prefix, we should re-anchor.
        const m = new DetachMatcher(Uint8Array.from([0x41, 0x42]))
        const r = m.feed(Uint8Array.from([0x41, 0x41, 0x42]))
        assert.deepEqual(r, DETACH)
    })

    test('plain bytes pass through unchanged when no detach prefix appears', () => {
        const m = new DetachMatcher(DEFAULT_DETACH_KEY)
        const r = m.feed(Uint8Array.from([0x68, 0x69, 0x0a]))
        assert.deepEqual(r as Uint8Array, Uint8Array.from([0x68, 0x69, 0x0a]))
    })

    test('rejects empty detach key at construction time', () => {
        assert.throws(() => new DetachMatcher(new Uint8Array()), /at least 1 byte/)
    })
})

describe('runAttach — wire & exit codes', () => {
    test('refuses with exit 1 when stdin is not a TTY', async () => {
        const { wire } = makeMockWire()
        const s = makeStreams({ isTTY: false })
        const result = await runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        assert.equal(result.exitCode, 1)
        assert.match(result.reason, /TTY/i)
    })

    test('exit 2 on 401 from /api/ws-ticket', async () => {
        const m = makeMockWire()
        const err = new Error('invalid_jwt') as Error & { status?: number }
        err.status = 401
        m.setIssueRejection(err)
        const s = makeStreams()
        const result = await runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            m.wire
        )
        assert.equal(result.exitCode, 2)
        assert.match(result.reason, /tmuxd login/)
    })

    test('exit 3 on 404 from /api/ws-ticket', async () => {
        const m = makeMockWire()
        const err = new Error('host_not_found') as Error & { status?: number }
        err.status = 404
        m.setIssueRejection(err)
        const s = makeStreams()
        const result = await runAttach(
            { cred: noopCred, hostId: 'ghost', sessionName: 'main' },
            s.streams,
            m.wire
        )
        assert.equal(result.exitCode, 3)
        assert.match(result.reason, /not found/i)
    })

    test('forwards stdin bytes as base64 input frames', async () => {
        const { wire, ctrl } = makeMockWire()
        const s = makeStreams()
        const promise = runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        // Wait one tick so runAttach hooks 'open' before we fire it.
        await new Promise((r) => setImmediate(r))
        ctrl.emit('open')
        await new Promise((r) => setImmediate(r))
        s.pushStdin(Buffer.from('hi'))
        await new Promise((r) => setImmediate(r))
        // Find the 'input' frame the SUT sent.
        const input = ctrl.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'input')
        assert.ok(input)
        assert.equal(Buffer.from(input.payload as string, 'base64').toString('utf8'), 'hi')
        // Trigger detach to terminate the test.
        s.pushStdin(Buffer.from([0x02, 0x64]))
        await new Promise((r) => setImmediate(r))
        ctrl.readyState = 3
        ctrl.emit('close', 1000, 'cli_detach')
        const result = await promise
        assert.equal(result.exitCode, 0)
    })

    test('decodes server data frames to stdout (base64 round-trip)', async () => {
        const { wire, ctrl } = makeMockWire()
        const s = makeStreams()
        const promise = runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        await new Promise((r) => setImmediate(r))
        ctrl.emit('open')
        await new Promise((r) => setImmediate(r))
        const payload = Buffer.from('hello world\n', 'utf8').toString('base64')
        ctrl.emit('message', JSON.stringify({ type: 'data', payload }))
        await new Promise((r) => setImmediate(r))
        const out = Buffer.concat(s.stdoutChunks).toString('utf8')
        assert.match(out, /hello world/)
        // Clean shutdown.
        ctrl.readyState = 3
        ctrl.emit('close', 1000, 'cli_detach')
        await promise
    })

    test('detach key triggers exit 0 with reason="detached (Ctrl-B d)"', async () => {
        const { wire, ctrl } = makeMockWire()
        const s = makeStreams()
        const promise = runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        await new Promise((r) => setImmediate(r))
        ctrl.emit('open')
        await new Promise((r) => setImmediate(r))
        s.pushStdin(Buffer.from([0x02, 0x64]))
        await new Promise((r) => setImmediate(r))
        // Some hosts queue the close from runAttach's finish() helper;
        // simulate the 'close' event the WS would emit synchronously.
        ctrl.readyState = 3
        ctrl.emit('close', 1000, 'cli_detach')
        const result = await promise
        assert.equal(result.exitCode, 0)
        assert.match(result.reason, /Ctrl-B d/)
    })

    test('SIGWINCH-style resize is sent over the wire', async () => {
        const { wire, ctrl } = makeMockWire()
        const s = makeStreams()
        const promise = runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        await new Promise((r) => setImmediate(r))
        ctrl.emit('open')
        await new Promise((r) => setImmediate(r))
        s.triggerResize(120, 40)
        await new Promise((r) => setImmediate(r))
        const resize = ctrl.sent.map((s) => JSON.parse(s)).find((f) => f.type === 'resize' && f.cols === 120)
        assert.ok(resize, `expected a resize frame with cols=120 in ${ctrl.sent.join('|')}`)
        // Cleanup.
        ctrl.readyState = 3
        ctrl.emit('close', 1000, 'shutdown')
        await promise
    })

    test('idle_timeout server-error frame is exit 0 (clean detach)', async () => {
        const { wire, ctrl } = makeMockWire()
        const s = makeStreams()
        const promise = runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        await new Promise((r) => setImmediate(r))
        ctrl.emit('open')
        await new Promise((r) => setImmediate(r))
        ctrl.emit('message', JSON.stringify({ type: 'error', message: 'idle_timeout' }))
        await new Promise((r) => setImmediate(r))
        ctrl.readyState = 3
        ctrl.emit('close', 1001, 'idle_timeout')
        const result = await promise
        assert.equal(result.exitCode, 0)
        assert.match(result.reason, /idle/i)
    })

    test('too_many_connections error frame is exit 1', async () => {
        const { wire, ctrl } = makeMockWire()
        const s = makeStreams()
        const promise = runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        await new Promise((r) => setImmediate(r))
        ctrl.emit('open')
        await new Promise((r) => setImmediate(r))
        ctrl.emit('message', JSON.stringify({ type: 'error', message: 'too_many_connections' }))
        ctrl.readyState = 3
        ctrl.emit('close', 1011, 'too_many_connections')
        const result = await promise
        assert.equal(result.exitCode, 1)
        assert.match(result.reason, /too_many/)
    })

    test('pane exit frame ends the attach with exit 0', async () => {
        const { wire, ctrl } = makeMockWire()
        const s = makeStreams()
        const promise = runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        await new Promise((r) => setImmediate(r))
        ctrl.emit('open')
        await new Promise((r) => setImmediate(r))
        ctrl.emit('message', JSON.stringify({ type: 'exit', code: 0, signal: null }))
        ctrl.readyState = 3
        ctrl.emit('close', 1000, 'pty_exited')
        const result = await promise
        assert.equal(result.exitCode, 0)
        assert.match(result.reason, /pane exited/)
    })

    test('TTY teardown runs even on auth failure', async () => {
        // Regression guard: if issueTicket fails with a 4xx, we should
        // never have set up the TTY and there's nothing to tear down.
        // But if we did set it up (open path), teardown must run.
        const { wire, ctrl } = makeMockWire()
        const s = makeStreams()
        const promise = runAttach(
            { cred: noopCred, hostId: 'h', sessionName: 'main' },
            s.streams,
            wire
        )
        await new Promise((r) => setImmediate(r))
        ctrl.emit('open')
        await new Promise((r) => setImmediate(r))
        // Server hands us an error mid-flight.
        ctrl.emit('message', JSON.stringify({ type: 'error', message: 'something' }))
        ctrl.readyState = 3
        ctrl.emit('close', 1011, 'something')
        await promise
        assert.equal(s.teardownCalled, true)
    })
})
