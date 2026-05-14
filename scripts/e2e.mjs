#!/usr/bin/env node
/**
 * End-to-end validation for tmuxd.
 *
 * Exercises:
 *   HTTP:  health, login (wrong/right), sessions list (auth/no-auth),
 *          create, duplicate-create, kill, bad-name rejection, unknown-route.
 *   WS:    bad token → 401
 *          valid token + tmux session → attach, resize, input echo, ping/pong,
 *          UTF-8 multi-byte roundtrip, reconnect on close,
 *          wrong Origin rejected when allowlist configured.
 *   SHUTDOWN: SIGTERM ends cleanly, even with a live WS.
 *
 * NOTE: this script does NOT spawn its own server — the caller must provide
 * one. When invoked via `npm run e2e` (scripts/e2e-all.mjs), the umbrella
 * sets TMUX_TMPDIR to a per-run scratch dir, which both this script and the
 * client subprocess inherit. When invoked standalone (`npm run e2e:api`)
 * the operator is responsible for providing both the server *and* an
 * isolated TMUX_TMPDIR — otherwise the spawned client and any direct tmux
 * calls land in /tmp/tmux-<uid>/ alongside the user's interactive sessions.
 *
 * Exits non-zero on first failure. Prints a summary.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { readdir, rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const execFileP = promisify(execFile)

const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 17683)
const SERVER_TOKEN = process.env.TMUXD_SERVER_TOKEN ?? 'e2e-test-token-123'
// Anyone with the server token plus their own user token is "in".
// e2e uses a fixed user token so we can re-auth deterministically.
const USER_TOKEN = process.env.TMUXD_USER_TOKEN ?? 'e2e-test-user-token'
// In the trust-model design there's no static binding — agents just
// self-declare. We keep the CLIENT_HOST_BOUND flag because it gates the
// e2e block that spawns a real outbound agent, which only runs when the
// caller signals "we set up an agent fixture". Set TMUXD_E2E_CLIENT_HOST_BOUND=1.
const CLIENT_HOST_BOUND = process.env.TMUXD_E2E_CLIENT_HOST_BOUND === '1'
const ORIGIN = `http://${HOST}:${PORT}`
const BASE = ORIGIN

let failed = 0
let passed = 0

function log(name, ok, extra = '') {
    const tag = ok ? '\x1b[32m PASS\x1b[0m' : '\x1b[31m FAIL\x1b[0m'
    console.log(`${tag}  ${name}${extra ? ' — ' + extra : ''}`)
    if (ok) passed++
    else failed++
}

async function check(name, fn) {
    try {
        const r = await fn()
        if (r === false) log(name, false, 'assertion returned false')
        else log(name, true)
    } catch (err) {
        log(name, false, err?.message ?? String(err))
    }
}

async function http(path, init = {}) {
    const res = await fetch(BASE + path, init)
    const text = await res.text()
    let body = null
    if (text) {
        try {
            body = JSON.parse(text)
        } catch {
            body = text
        }
    }
    return { status: res.status, body }
}

async function waitUp(maxMs = 10000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        try {
            const r = await fetch(BASE + '/health')
            if (r.ok) return true
        } catch {
            /* still booting */
        }
        await sleep(150)
    }
    throw new Error('server did not come up in time')
}

async function tmuxHasSession(name) {
    try {
        await execFileP('tmux', ['has-session', '-t', name])
        return true
    } catch {
        return false
    }
}

async function tmuxPanePath(name) {
    const { stdout } = await execFileP('tmux', ['display-message', '-p', '-t', name, '#{pane_current_path}'])
    return stdout.trim()
}

async function killIfPresent(name) {
    try {
        await execFileP('tmux', ['kill-session', '-t', name])
    } catch {
        /* ignore */
    }
}

function wsConnect(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(url, opts)
        const frames = []
        let opened = false
        const to = setTimeout(() => {
            if (!opened) {
                ws.close()
                reject(new Error('ws open timeout'))
            }
        }, 5000)
        ws.on('open', () => {
            opened = true
            clearTimeout(to)
            resolve({ ws, frames })
        })
        ws.on('message', (raw) => {
            try {
                frames.push(JSON.parse(raw.toString('utf8')))
            } catch {
                frames.push({ raw: raw.toString('utf8') })
            }
        })
        ws.on('unexpected-response', (_req, res) => {
            reject(new Error('ws http ' + res.statusCode))
        })
        ws.on('error', (err) => {
            if (!opened) reject(err)
        })
    })
}

async function waitForFrame(frames, predicate, maxMs = 5000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        const idx = frames.findIndex(predicate)
        if (idx >= 0) return frames.splice(idx, 1)[0]
        await sleep(50)
    }
    throw new Error('timeout waiting for frame')
}

function waitForClose(ws, maxMs = 5000) {
    return new Promise((resolve, reject) => {
        const to = setTimeout(() => {
            ws.close()
            reject(new Error('timeout waiting for close'))
        }, maxMs)
        ws.once('close', (code, reason) => {
            clearTimeout(to)
            resolve({ code, reason: reason.toString('utf8') })
        })
        ws.once('error', (err) => {
            clearTimeout(to)
            reject(err)
        })
    })
}


async function waitForHost(hostId, token, maxMs = 10000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        const r = await http('/api/hosts', { headers: { authorization: `Bearer ${token}` } })
        if (r.status === 200 && r.body?.hosts?.some((h) => h.id === hostId && h.status === 'online')) return true
        await sleep(150)
    }
    throw new Error(`host ${hostId} did not connect in time`)
}

async function waitForHostGone(hostId, token, maxMs = 5000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        const r = await http('/api/hosts', { headers: { authorization: `Bearer ${token}` } })
        if (r.status === 200 && !r.body?.hosts?.some((h) => h.id === hostId)) return true
        await sleep(100)
    }
    throw new Error(`host ${hostId} did not disconnect in time`)
}

function agentHelloOnce(hostId, userToken) {
    return new Promise((resolve, reject) => {
        const url =
            `ws://${HOST}:${PORT}/client/connect` +
            `?serverToken=${encodeURIComponent(SERVER_TOKEN)}` +
            `&userToken=${encodeURIComponent(userToken)}`
        const ws = new WebSocket(url)
        const to = setTimeout(() => {
            ws.close()
            reject(new Error('agent hello timeout'))
        }, 5000)
        ws.on('open', () => {
            ws.send(
                JSON.stringify({
                    type: 'hello',
                    id: hostId,
                    name: 'Duplicate E2E Agent',
                    capabilities: ['list']
                })
            )
        })
        ws.on('close', (code, reason) => {
            clearTimeout(to)
            resolve({ code, reason: reason.toString('utf8') })
        })
        ws.on('unexpected-response', (_req, res) => {
            clearTimeout(to)
            reject(new Error('agent ws http ' + res.statusCode))
        })
        ws.on('error', (err) => {
            clearTimeout(to)
            reject(err)
        })
    })
}

function connectLegacyAgent(hostId, userToken) {
    return new Promise((resolve, reject) => {
        const url =
            `ws://${HOST}:${PORT}/client/connect` +
            `?serverToken=${encodeURIComponent(SERVER_TOKEN)}` +
            `&userToken=${encodeURIComponent(userToken)}`
        const ws = new WebSocket(url)
        const to = setTimeout(() => {
            ws.close()
            reject(new Error('legacy agent hello timeout'))
        }, 5000)
        ws.on('open', () => {
            ws.send(
                JSON.stringify({
                    type: 'hello',
                    id: hostId,
                    name: 'Legacy E2E Agent'
                    // No capabilities field: this simulates a pre-pane-API agent.
                })
            )
        })
        ws.on('message', (raw) => {
            const msg = JSON.parse(raw.toString('utf8'))
            if (msg.type === 'hello_ack') {
                clearTimeout(to)
                resolve(ws)
            }
        })
        ws.on('unexpected-response', (_req, res) => {
            clearTimeout(to)
            reject(new Error('legacy agent ws http ' + res.statusCode))
        })
        ws.on('error', (err) => {
            clearTimeout(to)
            reject(err)
        })
    })
}

function startAgentProcess(hostId, userToken) {
    return spawn('node', ['node_modules/.bin/tsx', 'server/src/client.ts'], {
        env: {
            ...process.env,
            TMUXD_URL: BASE,
            TMUXD_SERVER_TOKEN: SERVER_TOKEN,
            TMUXD_USER_TOKEN: userToken,
            TMUXD_HOST_ID: hostId,
            TMUXD_HOST_NAME: 'E2E Agent',
            TMUXD_HOME: '/tmp/tmuxd-e2e-agent'
        },
        stdio: ['ignore', 'inherit', 'inherit']
    })
}

async function stopProcess(proc) {
    if (!proc || proc.exitCode !== null) return
    proc.kill('SIGTERM')
    await Promise.race([
        new Promise((resolve) => proc.once('exit', resolve)),
        sleep(3000).then(() => {
            if (proc.exitCode === null) proc.kill('SIGKILL')
        })
    ])
}

async function main() {
    console.log(`[e2e] connecting to ${BASE}`)
    await waitUp()

    // ---- HTTP ----
    await check('health: GET /health → 200 {ok:true}', async () => {
        const r = await http('/health')
        return r.status === 200 && r.body?.ok === true
    })

    await check('auth: wrong server token → 401', async () => {
        const r = await http('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serverToken: 'definitely-wrong', userToken: USER_TOKEN })
        })
        return r.status === 401 && r.body?.error === 'invalid_token'
    })

    await check('auth: missing body → 400', async () => {
        const r = await http('/api/auth', { method: 'POST' })
        return r.status === 400
    })

    let token = null
    await check('auth: correct tokens → 200 {token}', async () => {
        const r = await http('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serverToken: SERVER_TOKEN, userToken: USER_TOKEN })
        })
        if (r.status !== 200) return false
        if (typeof r.body?.token !== 'string' || r.body.token.length < 32) return false
        token = r.body.token
        return true
    })

    await check('sessions: no auth → 401', async () => {
        const r = await http('/api/sessions')
        return r.status === 401
    })

    await check('sessions: bad bearer → 401', async () => {
        const r = await http('/api/sessions', { headers: { authorization: 'Bearer junk' } })
        return r.status === 401
    })

    await check('sessions: list with token → 200 [array]', async () => {
        const r = await http('/api/sessions', { headers: { authorization: `Bearer ${token}` } })
        return r.status === 200 && Array.isArray(r.body?.sessions)
    })

    await check('hosts: list includes local host', async () => {
        const r = await http('/api/hosts', { headers: { authorization: `Bearer ${token}` } })
        return r.status === 200 && r.body?.hosts?.some((h) => h.id === 'local' && h.status === 'online')
    })

    const TEST_SESSION = 'tmuxd-e2e'
    await killIfPresent(TEST_SESSION)

    await check('create: POST /api/sessions → 201 + tmux has-session ok', async () => {
        const r = await http('/api/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: TEST_SESSION })
        })
        if (r.status !== 201) return false
        return await tmuxHasSession(TEST_SESSION)
    })

    await check('create: new tmux session starts in home directory', async () => {
        return (await tmuxPanePath(TEST_SESSION)) === homedir()
    })

    await check('create: duplicate → 409', async () => {
        const r = await http('/api/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: TEST_SESSION })
        })
        return r.status === 409
    })

    await check('create: bad name → 400', async () => {
        const r = await http('/api/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: 'has space' })
        })
        return r.status === 400
    })

    await check('create: empty name → 400', async () => {
        const r = await http('/api/sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ name: '' })
        })
        return r.status === 400
    })

    await check('sessions: list contains the new one', async () => {
        const r = await http('/api/sessions', { headers: { authorization: `Bearer ${token}` } })
        if (r.status !== 200) return false
        return r.body.sessions.some((s) => s.name === TEST_SESSION)
    })

    await check('hosts: local sessions include host metadata', async () => {
        const r = await http('/api/hosts/local/sessions', { headers: { authorization: `Bearer ${token}` } })
        if (r.status !== 200) return false
        return r.body.sessions.some((s) => s.name === TEST_SESSION && s.hostId === 'local' && s.hostName === 'Local')
    })

    await check('hosts: unknown host sessions → 404', async () => {
        const r = await http('/api/hosts/missing/sessions', { headers: { authorization: `Bearer ${token}` } })
        return r.status === 404 && r.body?.error === 'host_not_found'
    })

    await check('uploads: clipboard image saves a local file', async () => {
        const form = new FormData()
        form.set('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'paste.png')
        const r = await http('/api/uploads/clipboard-image', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: form
        })
        if (r.status !== 201 || typeof r.body?.path !== 'string') return false
        const expectedPrefix = `${homedir()}/.tmuxd/uploads/`
        if (!r.body.path.startsWith(expectedPrefix) || !r.body.name.endsWith('.png')) return false
        const info = await stat(r.body.path)
        await rm(r.body.path, { force: true })
        return info.size === 4 && r.body.type === 'image/png'
    })

    await check('uploads: session image upload pastes path into tmux', async () => {
        const form = new FormData()
        form.set('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'pane-paste.png')
        const r = await http(`/api/sessions/${encodeURIComponent(TEST_SESSION)}/uploads/clipboard-image`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: form
        })
        if (r.status !== 201 || typeof r.body?.path !== 'string') return false
        await sleep(200)
        const capture = await execFileP('tmux', ['capture-pane', '-p', '-t', TEST_SESSION, '-S', '-50'])
        await execFileP('tmux', ['send-keys', '-t', TEST_SESSION, 'C-u'])
        await rm(r.body.path, { force: true })
        // tmux capture-pane includes visual line wraps, so long upload paths can be split across rows.
        return capture.stdout.includes(r.body.path) || capture.stdout.replace(/\r?\n/g, '').includes(r.body.path)
    })

    await check('uploads: failed session image upload cleans saved file', async () => {
        const uploadDir = `${homedir()}/.tmuxd/uploads`
        const before = new Set(await readdir(uploadDir).catch(() => []))
        const form = new FormData()
        form.set('file', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'orphan.png')
        const r = await http('/api/sessions/not-a-real-tmuxd-session/uploads/clipboard-image', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: form
        })
        const after = await readdir(uploadDir).catch(() => [])
        return r.status === 400 && after.every((name) => before.has(name))
    })

    // ---- WEBSOCKET ----
    await check('ws: bad token → 401', async () => {
        try {
            await wsConnect(`ws://${HOST}:${PORT}/ws/${TEST_SESSION}?token=junk&cols=80&rows=24`)
            return false
        } catch (err) {
            return /401/.test(err.message)
        }
    })

    await check('ws: missing session attach does not create an empty tmux session', async () => {
        const missing = `tmuxd-e2e-missing-${Date.now()}`
        await killIfPresent(missing)
        const handle = await wsConnect(`ws://${HOST}:${PORT}/ws/${missing}?token=${encodeURIComponent(token)}&cols=80&rows=24`)
        const closed = await waitForClose(handle.ws)
        return closed.code === 1011 && closed.reason === 'attach_failed' && !(await tmuxHasSession(missing))
    })

    await check('ws-ticket: missing target → 400', async () => {
        const r = await http('/api/ws-ticket', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({})
        })
        return r.status === 400
    })

    await check('ws-ticket: target mismatch is rejected and consumes ticket', async () => {
        const r = await http('/api/ws-ticket', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ hostId: 'local', sessionName: TEST_SESSION })
        })
        if (r.status !== 200 || typeof r.body?.ticket !== 'string') return false
        try {
            await wsConnect(`ws://${HOST}:${PORT}/ws/local/not-a-real-session?ticket=${encodeURIComponent(r.body.ticket)}&cols=80&rows=24`)
            return false
        } catch (err) {
            if (!/401/.test(err.message)) return false
        }
        try {
            await wsConnect(`ws://${HOST}:${PORT}/ws/local/${TEST_SESSION}?ticket=${encodeURIComponent(r.body.ticket)}&cols=80&rows=24`)
            return false
        } catch (err) {
            return /401/.test(err.message)
        }
    })

    await check('ws-ticket: matching target opens websocket', async () => {
        const r = await http('/api/ws-ticket', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ hostId: 'local', sessionName: TEST_SESSION })
        })
        if (r.status !== 200 || typeof r.body?.ticket !== 'string') return false
        const handle = await wsConnect(`ws://${HOST}:${PORT}/ws/local/${TEST_SESSION}?ticket=${encodeURIComponent(r.body.ticket)}&cols=80&rows=24`)
        const ready = await waitForFrame(handle.frames, (f) => f.type === 'ready', 3000)
        handle.ws.close(1000, 'test')
        return ready.session === TEST_SESSION && ready.hostId === 'local'
    })

    let ws, frames
    await check('ws: valid token → opens + ready frame', async () => {
        const url = `ws://${HOST}:${PORT}/ws/${TEST_SESSION}?token=${encodeURIComponent(
            token
        )}&cols=100&rows=30`
        const handle = await wsConnect(url)
        ws = handle.ws
        frames = handle.frames
        const ready = await waitForFrame(frames, (f) => f.type === 'ready', 3000)
        return ready.session === TEST_SESSION && ready.cols >= 1 && ready.rows >= 1
    })

    await check('ws: ping → pong', async () => {
        ws.send(JSON.stringify({ type: 'ping' }))
        const pong = await waitForFrame(frames, (f) => f.type === 'pong', 2000)
        return pong.type === 'pong'
    })

    await check('ws: receives data frames from tmux', async () => {
        // tmux sends an initial screen redraw; wait up to 3s.
        const d = await waitForFrame(frames, (f) => f.type === 'data', 3000)
        return typeof d.payload === 'string' && d.payload.length > 0
    })

    await check('ws: input roundtrip (echo)', async () => {
        // Send a simple command inside the tmux pane. The pane is running
        // the user's default shell inside tmux; `printf "X\n"` is portable.
        const cmd = 'printf "tmuxd-roundtrip-ok\\n"\n'
        const bytes = Buffer.from(cmd, 'utf8').toString('base64')
        ws.send(JSON.stringify({ type: 'input', payload: bytes }))
        // Look for the substring in any subsequent data frame within 4s.
        const deadline = Date.now() + 4000
        while (Date.now() < deadline) {
            const idx = frames.findIndex(
                (f) =>
                    f.type === 'data' &&
                    Buffer.from(f.payload, 'base64').toString('utf8').includes('tmuxd-roundtrip-ok')
            )
            if (idx >= 0) return true
            await sleep(75)
        }
        return false
    })

    await check('sessions: capture returns pane scrollback', async () => {
        const r = await http(`/api/sessions/${encodeURIComponent(TEST_SESSION)}/capture`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return (
            r.status === 200 &&
            typeof r.body?.text === 'string' &&
            r.body.text.includes('tmuxd-roundtrip-ok') &&
            typeof r.body?.scrollPosition === 'number' &&
            typeof r.body?.paneHeight === 'number'
        )
    })

    await check('hosts: local capture returns pane scrollback', async () => {
        const r = await http(`/api/hosts/local/sessions/${encodeURIComponent(TEST_SESSION)}/capture`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return r.status === 200 && typeof r.body?.text === 'string' && r.body.text.includes('tmuxd-roundtrip-ok')
    })

    let localPaneId = null
    await check('agent-api: local pane list includes host metadata', async () => {
        const r = await http(`/api/hosts/local/panes?session=${encodeURIComponent(TEST_SESSION)}`, {
            headers: { authorization: `Bearer ${token}` }
        })
        if (r.status !== 200) return false
        const pane = r.body?.panes?.find((p) => p.sessionName === TEST_SESSION && p.hostId === 'local' && p.target === `${TEST_SESSION}:0.0`)
        localPaneId = pane?.paneId ?? null
        return typeof localPaneId === 'string' && /^%[0-9]+$/.test(localPaneId)
    })

    await check('agent-api: local session pane helper works', async () => {
        const r = await http(`/api/sessions/${encodeURIComponent(TEST_SESSION)}/panes`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return r.status === 200 && r.body?.panes?.some((p) => p.sessionName === TEST_SESSION)
    })

    await check('agent-api: host-aware local session pane helper matches local helper', async () => {
        const r = await http(`/api/hosts/local/sessions/${encodeURIComponent(TEST_SESSION)}/panes`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return r.status === 200 && r.body?.panes?.some((p) => p.sessionName === TEST_SESSION && p.hostId === 'local')
    })

    await check('agent-api: unknown local pane session returns 404', async () => {
        const r = await http('/api/hosts/local/panes?session=tmuxd-e2e-missing-session', {
            headers: { authorization: `Bearer ${token}` }
        })
        return r.status === 404 && r.body?.error === 'session_not_found'
    })

    await check('agent-api: local pane-id target capture works', async () => {
        if (!localPaneId) return false
        const r = await http(`/api/hosts/local/panes/${encodeURIComponent(localPaneId)}/capture?lines=40`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return r.status === 200 && r.body?.target === localPaneId && typeof r.body?.text === 'string'
    })

    await check('agent-api: local input endpoint writes to pane', async () => {
        const marker = 'tmuxd-agent-api-input-ok'
        const r = await http(`/api/hosts/local/panes/${encodeURIComponent(TEST_SESSION)}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: `printf "${marker}\\n"`, enter: true })
        })
        if (r.status !== 200 || r.body?.ok !== true) return false
        await sleep(300)
        const capture = await http(`/api/hosts/local/panes/${encodeURIComponent(`${TEST_SESSION}:0.0`)}/capture?lines=80`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return capture.status === 200 && capture.body?.text?.includes(marker)
    })

    await check('agent-api: key endpoint rejects option-like keys', async () => {
        const r = await http(`/api/hosts/local/panes/${encodeURIComponent(TEST_SESSION)}/keys`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ keys: ['-t', 'other', 'Enter'] })
        })
        return r.status === 400 && r.body?.error === 'invalid_body'
    })

    await check('agent-api: pane status marks content changes between polls', async () => {
        const target = `${TEST_SESSION}:0.0`
        const first = await http(`/api/hosts/local/panes/${encodeURIComponent(target)}/status?lines=80&maxBytes=4096`, {
            headers: { authorization: `Bearer ${token}` }
        })
        if (first.status !== 200 || typeof first.body?.activity?.seq !== 'number' || first.body?.activity?.light !== 'green') return false
        const marker = `tmuxd-pane-activity-${Date.now()}`
        const write = await http(`/api/hosts/local/panes/${encodeURIComponent(TEST_SESSION)}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: `printf "${marker}\\n"`, enter: true })
        })
        if (write.status !== 200) return false
        await sleep(300)
        const second = await http(`/api/hosts/local/panes/${encodeURIComponent(target)}/status?lines=80&maxBytes=4096`, {
            headers: { authorization: `Bearer ${token}` }
        })
        if (second.status !== 200 || second.body?.activity?.unread !== true || second.body?.activity?.light !== 'yellow') return false
        const read = await http(`/api/hosts/local/panes/${encodeURIComponent(target)}/activity/read`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` }
        })
        return (
            second.body?.activity?.seq > (first.body?.activity?.seq ?? -1) &&
            second.body?.activity?.reason === 'output' &&
            read.status === 200 &&
            read.body?.activity?.unread === false &&
            read.body?.activity?.light === 'green'
        )
    })

    await check('agent-api: pane status auto-settles to green once content stabilizes without an explicit read', async () => {
        const target = `${TEST_SESSION}:0.0`
        const marker = `tmuxd-auto-settle-${Date.now()}`
        const write = await http(`/api/hosts/local/panes/${encodeURIComponent(TEST_SESSION)}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: `printf "${marker}\\n"`, enter: true })
        })
        if (write.status !== 200) return false
        await sleep(300)
        const afterChange = await http(`/api/hosts/local/panes/${encodeURIComponent(target)}/status?lines=80&maxBytes=4096`, {
            headers: { authorization: `Bearer ${token}` }
        })
        if (afterChange.status !== 200 || afterChange.body?.activity?.light !== 'yellow') return false
        // Wait past the AUTO_SETTLE_MS threshold (7s) without issuing any
        // further input. A subsequent poll that observes an unchanged hash
        // must advance the observed baseline and return green.
        await sleep(7_500)
        const settled = await http(`/api/hosts/local/panes/${encodeURIComponent(target)}/status?lines=80&maxBytes=4096`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return (
            settled.status === 200 &&
            settled.body?.activity?.light === 'green' &&
            settled.body?.activity?.unread === false &&
            settled.body?.activity?.seq === afterChange.body?.activity?.seq
        )
    })

    await check('agent-api: pane capture reports UTF-8-safe truncation', async () => {
        const marker = 'tmuxd-long-output'
        const write = await http(`/api/hosts/local/panes/${encodeURIComponent(TEST_SESSION)}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: `printf "${marker}-%05000d\\n" 0`, enter: true })
        })
        if (write.status !== 200) return false
        await sleep(300)
        const capture = await http(`/api/hosts/local/panes/${encodeURIComponent(`${TEST_SESSION}:0.0`)}/capture?lines=80&maxBytes=1024`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return (
            capture.status === 200 &&
            capture.body?.truncated === true &&
            capture.body?.maxBytes === 1024 &&
            Buffer.byteLength(capture.body?.text ?? '', 'utf8') <= 1024
        )
    })

    await check('agent-api: pane status detects permission prompt', async () => {
        const write = await http(`/api/hosts/local/panes/${encodeURIComponent(TEST_SESSION)}/input`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ text: 'printf "Do you want to proceed? Yes/No\\n"', enter: true })
        })
        if (write.status !== 200) return false
        await sleep(300)
        const status = await http(`/api/hosts/local/panes/${encodeURIComponent(`${TEST_SESSION}:0.0`)}/status?lines=80&maxBytes=4096`, {
            headers: { authorization: `Bearer ${token}` }
        })
        return status.status === 200 && status.body?.state === 'permission_prompt' && status.body?.signals?.includes('yes_no_prompt')
    })

    await check('agent-api: snapshot aggregates hosts, sessions, panes, and optional status', async () => {
        const r = await http('/api/client/snapshot?capture=1&captureLimit=1&lines=40&maxBytes=4096', {
            headers: { authorization: `Bearer ${token}` }
        })
        return (
            r.status === 200 &&
            r.body?.hosts?.some((h) => h.id === 'local') &&
            r.body?.sessions?.some((s) => s.name === TEST_SESSION && s.hostId === 'local') &&
            r.body?.panes?.some((p) => p.sessionName === TEST_SESSION && p.hostId === 'local') &&
            Array.isArray(r.body?.statuses) &&
            Array.isArray(r.body?.errors)
        )
    })

    let actionId = null
    await check('actions: invalid action bodies return bad request', async () => {
        const emptyLabel = await http('/api/actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ label: '', kind: 'send-text', payload: 'noop' })
        })
        const tooBig = await http('/api/actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ label: 'Too big', kind: 'send-text', payload: 'x'.repeat(64 * 1024 + 1) })
        })
        return (
            emptyLabel.status === 400 &&
            emptyLabel.body?.error === 'invalid_body' &&
            tooBig.status === 400 &&
            tooBig.body?.error === 'invalid_body'
        )
    })

    await check('actions: create/list/run/delete action against local pane', async () => {
        const marker = 'tmuxd-action-api-ok'
        const created = await http('/api/actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
            body: JSON.stringify({ label: 'E2E marker', kind: 'send-text', payload: `printf "${marker}\\n"`, enter: true })
        })
        if (created.status !== 201 || typeof created.body?.action?.id !== 'string') return false
        actionId = created.body.action.id
        const listed = await http('/api/actions', { headers: { authorization: `Bearer ${token}` } })
        if (listed.status !== 200 || !listed.body?.actions?.some((a) => a.id === actionId)) return false
        const run = await http(`/api/hosts/local/panes/${encodeURIComponent(TEST_SESSION)}/actions/${encodeURIComponent(actionId)}/run`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` }
        })
        if (run.status !== 200 || run.body?.ok !== true || typeof run.body?.runId !== 'string') return false
        await sleep(300)
        const capture = await http(`/api/hosts/local/panes/${encodeURIComponent(`${TEST_SESSION}:0.0`)}/capture?lines=120`, {
            headers: { authorization: `Bearer ${token}` }
        })
        if (capture.status !== 200 || !capture.body?.text?.includes(marker)) return false
        const history = await http('/api/actions/history?limit=20', { headers: { authorization: `Bearer ${token}` } })
        if (history.status !== 200 || !history.body?.runs?.some((run) => run.actionId === actionId && run.ok === true)) return false
        const deleted = await http(`/api/actions/${encodeURIComponent(actionId)}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` }
        })
        return deleted.status === 204
    })

    await check('ws: resize frame accepted', async () => {
        ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }))
        // No explicit ack; a successful resize means the server didn't close us.
        await sleep(200)
        return ws.readyState === WebSocket.OPEN
    })

    await check('ws: utf-8 multibyte roundtrip', async () => {
        const cmd = 'printf "你好-café-🚀\\n"\n'
        const bytes = Buffer.from(cmd, 'utf8').toString('base64')
        ws.send(JSON.stringify({ type: 'input', payload: bytes }))
        const deadline = Date.now() + 4000
        while (Date.now() < deadline) {
            const idx = frames.findIndex((f) => {
                if (f.type !== 'data') return false
                const out = Buffer.from(f.payload, 'base64').toString('utf8')
                return out.includes('你好') || out.includes('café') || out.includes('🚀')
            })
            if (idx >= 0) return true
            await sleep(75)
        }
        return false
    })

    await check('ws: malformed JSON is silently ignored (no crash)', async () => {
        ws.send('not json at all')
        ws.send(JSON.stringify({ type: 'unknown', foo: 1 }))
        await sleep(150)
        return ws.readyState === WebSocket.OPEN
    })

    await check('ws: manual close → server accepts cleanly', async () => {
        const closed = new Promise((resolve) => ws.on('close', (code) => resolve(code)))
        ws.close(1000, 'test')
        const code = await closed
        return code === 1000 || code === 1006 // some ws versions surface 1006 on local close
    })

    await check('ws: host-aware local path opens + ready hostId', async () => {
        const url = `ws://${HOST}:${PORT}/ws/local/${TEST_SESSION}?token=${encodeURIComponent(token)}&cols=80&rows=24`
        const handle = await wsConnect(url)
        const ready = await waitForFrame(handle.frames, (f) => f.type === 'ready', 3000)
        handle.ws.close(1000, 'test')
        return ready.session === TEST_SESSION && ready.hostId === 'local'
    })

    let agentProc = null
    if (CLIENT_HOST_BOUND) {
        const AGENT_HOST = 'e2e-agent'
        // Use the SAME user token as the API client. Under the trust model
        // every connection (agent WS + API client) hashes its userToken into
        // a namespace; the agent must register in the SAME namespace that the
        // client's JWT is scoped to, otherwise the API client won't see the
        // agent's host. Using two different user tokens here was the
        // pre-trust-model bug — under the static-token whitelist that
        // wasn't an issue because host-namespace bindings were configured
        // server-side, but now the agent IS its namespace.
        const AGENT_USER_TOKEN = USER_TOKEN
        const AGENT_SESSION = 'tmuxd-e2e-agent'
        await killIfPresent(AGENT_SESSION)

        await check('agent: missing tokens on /client/connect → 401', async () => {
            try {
                await wsConnect(`ws://${HOST}:${PORT}/client/connect`)
                return false
            } catch (err) {
                return /401/.test(err.message)
            }
        })

        await check('agent: legacy no-capabilities host does not claim pane APIs', async () => {
            const legacyWs = await connectLegacyAgent(AGENT_HOST, AGENT_USER_TOKEN)
            try {
                await waitForHost(AGENT_HOST, token)
                const hosts = await http('/api/hosts', { headers: { authorization: `Bearer ${token}` } })
                const host = hosts.body?.hosts?.find((h) => h.id === AGENT_HOST)
                if (!host || host.capabilities?.includes('panes') || host.capabilities?.includes('input')) return false
                const panes = await http(`/api/hosts/${AGENT_HOST}/panes`, { headers: { authorization: `Bearer ${token}` } })
                const capture = await http(`/api/hosts/${AGENT_HOST}/panes/main/capture`, { headers: { authorization: `Bearer ${token}` } })
                const status = await http(`/api/hosts/${AGENT_HOST}/panes/main/status`, { headers: { authorization: `Bearer ${token}` } })
                const input = await http(`/api/hosts/${AGENT_HOST}/panes/main/input`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                    body: JSON.stringify({ text: 'noop' })
                })
                const keys = await http(`/api/hosts/${AGENT_HOST}/panes/main/keys`, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                    body: JSON.stringify({ keys: ['Enter'] })
                })
                const action = await http('/api/actions', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                    body: JSON.stringify({ label: 'Legacy no-op', kind: 'send-text', payload: 'noop' })
                })
                const run =
                    action.status === 201
                        ? await http(`/api/hosts/${AGENT_HOST}/panes/main/actions/${encodeURIComponent(action.body.action.id)}/run`, {
                              method: 'POST',
                              headers: { authorization: `Bearer ${token}` }
                          })
                        : { status: 0, body: null }
                if (action.body?.action?.id) {
                    await http(`/api/actions/${encodeURIComponent(action.body.action.id)}`, {
                        method: 'DELETE',
                        headers: { authorization: `Bearer ${token}` }
                    })
                }
                const snapshot = await http('/api/client/snapshot?capture=1&captureLimit=8', {
                    headers: { authorization: `Bearer ${token}` }
                })
                return (
                    panes.status === 405 &&
                    capture.status === 405 &&
                    status.status === 405 &&
                    input.status === 405 &&
                    keys.status === 405 &&
                    run.status === 405 &&
                    panes.body?.error === 'capability_not_supported' &&
                    snapshot.status === 200 &&
                    snapshot.body?.errors?.some((err) => err.hostId === AGENT_HOST && err.operation === 'list_panes')
                )
            } finally {
                legacyWs.close(1000, 'test')
                await waitForHostGone(AGENT_HOST, token)
            }
        })

        await check('agent: outbound client connects to hub', async () => {
            agentProc = startAgentProcess(AGENT_HOST, AGENT_USER_TOKEN)
            agentProc.on('exit', (code, signal) => {
                if (code !== null && code !== 0) console.error(`[agent] exited ${code}`)
                else if (signal) console.error(`[agent] exited by ${signal}`)
            })
            return await waitForHost(AGENT_HOST, token)
        })

        await check('agent: duplicate host id is rejected without replacing original', async () => {
            const closed = await agentHelloOnce(AGENT_HOST, AGENT_USER_TOKEN)
            if (closed.code !== 1008 || !/host_already_connected/.test(closed.reason)) return false
            const r = await http('/api/hosts', { headers: { authorization: `Bearer ${token}` } })
            return r.status === 200 && r.body?.hosts?.some((h) => h.id === AGENT_HOST && h.status === 'online')
        })

        const WEIRD_REMOTE_SESSION = 'tmuxd e2e remote weird'
        await killIfPresent(WEIRD_REMOTE_SESSION)
        await check('agent: remote listing tolerates externally-created unconstrained tmux session names', async () => {
            try {
                await execFileP('tmux', ['new-session', '-d', '-s', WEIRD_REMOTE_SESSION])
                const sessions = await http(`/api/hosts/${AGENT_HOST}/sessions`, { headers: { authorization: `Bearer ${token}` } })
                if (sessions.status !== 200 || !sessions.body?.sessions?.some((s) => s.name === WEIRD_REMOTE_SESSION && s.hostId === AGENT_HOST)) {
                    return false
                }
                const panes = await http(`/api/hosts/${AGENT_HOST}/panes`, { headers: { authorization: `Bearer ${token}` } })
                return panes.status === 200 && panes.body?.panes?.some((p) => p.sessionName === WEIRD_REMOTE_SESSION && p.hostId === AGENT_HOST)
            } finally {
                await killIfPresent(WEIRD_REMOTE_SESSION)
            }
        })

        await check('agent: create remote session', async () => {
            const r = await http(`/api/hosts/${AGENT_HOST}/sessions`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ name: AGENT_SESSION })
            })
            return r.status === 201 && (await tmuxHasSession(AGENT_SESSION))
        })

        await check('agent: list remote sessions with host metadata', async () => {
            const r = await http(`/api/hosts/${AGENT_HOST}/sessions`, { headers: { authorization: `Bearer ${token}` } })
            if (r.status !== 200) return false
            return r.body.sessions.some((s) => s.name === AGENT_SESSION && s.hostId === AGENT_HOST && s.hostName === 'E2E Agent')
        })

        let remoteWs, remoteFrames
        await check('agent: remote websocket attach opens + ready hostId', async () => {
            const ticket = await http('/api/ws-ticket', {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ hostId: AGENT_HOST, sessionName: AGENT_SESSION })
            })
            if (ticket.status !== 200 || typeof ticket.body?.ticket !== 'string') return false
            const url = `ws://${HOST}:${PORT}/ws/${AGENT_HOST}/${AGENT_SESSION}?ticket=${encodeURIComponent(ticket.body.ticket)}&cols=90&rows=25`
            const handle = await wsConnect(url)
            remoteWs = handle.ws
            remoteFrames = handle.frames
            const ready = await waitForFrame(remoteFrames, (f) => f.type === 'ready', 3000)
            return ready.session === AGENT_SESSION && ready.hostId === AGENT_HOST
        })

        await check('agent: remote input roundtrip', async () => {
            const cmd = 'printf "tmuxd-agent-roundtrip-ok\\n"\n'
            remoteWs.send(JSON.stringify({ type: 'input', payload: Buffer.from(cmd, 'utf8').toString('base64') }))
            const deadline = Date.now() + 5000
            while (Date.now() < deadline) {
                const idx = remoteFrames.findIndex(
                    (f) =>
                        f.type === 'data' &&
                        Buffer.from(f.payload, 'base64').toString('utf8').includes('tmuxd-agent-roundtrip-ok')
                )
                if (idx >= 0) return true
                await sleep(75)
            }
            return false
        })

        await check('agent: remote capture returns scrollback', async () => {
            const r = await http(`/api/hosts/${AGENT_HOST}/sessions/${encodeURIComponent(AGENT_SESSION)}/capture`, {
                headers: { authorization: `Bearer ${token}` }
            })
            return r.status === 200 && typeof r.body?.text === 'string' && r.body.text.includes('tmuxd-agent-roundtrip-ok')
        })

        await check('agent: remote full-session capture handles payloads above old 512 KiB agent frame cap', async () => {
            remoteWs?.close(1000, 'large-capture-test')
            await execFileP('tmux', ['set-option', '-t', AGENT_SESSION, 'history-limit', '20000'])
            await execFileP('tmux', ['new-window', '-t', AGENT_SESSION, '-n', 'large-capture'])
            const command = `python3 -c 'for i in range(1800): print("remote-capture-large-" + "R"*480)'`
            await execFileP('tmux', ['send-keys', '-t', AGENT_SESSION, '-l', command])
            await execFileP('tmux', ['send-keys', '-t', AGENT_SESSION, 'Enter'])
            try {
                const deadline = Date.now() + 8000
                while (Date.now() < deadline) {
                    await sleep(300)
                    const r = await http(`/api/hosts/${AGENT_HOST}/sessions/${encodeURIComponent(AGENT_SESSION)}/capture`, {
                        headers: { authorization: `Bearer ${token}` }
                    })
                    if (r.status === 200 && typeof r.body?.text === 'string' && Buffer.byteLength(r.body.text, 'utf8') > 512 * 1024) return true
                }
                return false
            } finally {
                await execFileP('tmux', ['select-window', '-t', `${AGENT_SESSION}:0`]).catch(() => undefined)
            }
        })

        let remotePaneId = null
        await check('agent-api: remote pane list is proxied through outbound agent', async () => {
            const r = await http(`/api/hosts/${AGENT_HOST}/panes?session=${encodeURIComponent(AGENT_SESSION)}`, {
                headers: { authorization: `Bearer ${token}` }
            })
            if (r.status !== 200) return false
            const pane = r.body?.panes?.find((p) => p.sessionName === AGENT_SESSION && p.hostId === AGENT_HOST && p.target === `${AGENT_SESSION}:0.0`)
            remotePaneId = pane?.paneId ?? null
            return (
                typeof remotePaneId === 'string' &&
                /^%[0-9]+$/.test(remotePaneId) &&
                typeof pane?.sessionAttachedClients === 'number' &&
                typeof pane?.windowActivity === 'number'
            )
        })

        await check('agent-api: host-aware remote session pane helper works', async () => {
            const r = await http(`/api/hosts/${AGENT_HOST}/sessions/${encodeURIComponent(AGENT_SESSION)}/panes`, {
                headers: { authorization: `Bearer ${token}` }
            })
            return r.status === 200 && r.body?.panes?.some((p) => p.sessionName === AGENT_SESSION && p.hostId === AGENT_HOST)
        })

        await check('agent-api: remote missing pane session and target return 404', async () => {
            const missingPanes = await http(`/api/hosts/${AGENT_HOST}/panes?session=tmuxd-e2e-agent-missing`, {
                headers: { authorization: `Bearer ${token}` }
            })
            const missingCapture = await http(`/api/hosts/${AGENT_HOST}/panes/tmuxd-e2e-agent-missing/capture`, {
                headers: { authorization: `Bearer ${token}` }
            })
            const missingStatus = await http(`/api/hosts/${AGENT_HOST}/panes/tmuxd-e2e-agent-missing/status`, {
                headers: { authorization: `Bearer ${token}` }
            })
            return (
                missingPanes.status === 404 &&
                missingCapture.status === 404 &&
                missingStatus.status === 404 &&
                missingPanes.body?.error === 'session_not_found' &&
                missingCapture.body?.error === 'session_not_found' &&
                missingStatus.body?.error === 'session_not_found'
            )
        })

        await check('agent-api: remote pane-id target capture works', async () => {
            if (!remotePaneId) return false
            const r = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(remotePaneId)}/capture?lines=80`, {
                headers: { authorization: `Bearer ${token}` }
            })
            return r.status === 200 && r.body?.target === remotePaneId && typeof r.body?.text === 'string'
        })

        await check('agent-api: remote input endpoint is proxied through outbound agent', async () => {
            const marker = 'tmuxd-remote-agent-api-input-ok'
            const r = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(AGENT_SESSION)}/input`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ text: `printf "${marker}\\n"`, enter: true })
            })
            if (r.status !== 200 || r.body?.ok !== true) return false
            await sleep(300)
            const capture = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(`${AGENT_SESSION}:0.0`)}/capture?lines=120`, {
                headers: { authorization: `Bearer ${token}` }
            })
            return capture.status === 200 && capture.body?.text?.includes(marker)
        })

        await check('agent-api: remote pane status marks content changes between polls', async () => {
            const target = `${AGENT_SESSION}:0.0`
            const first = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(target)}/status?lines=120&maxBytes=4096`, {
                headers: { authorization: `Bearer ${token}` }
            })
            if (first.status !== 200 || typeof first.body?.activity?.seq !== 'number' || first.body?.activity?.light !== 'green') return false
            const marker = `tmuxd-remote-pane-activity-${Date.now()}`
            const write = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(AGENT_SESSION)}/input`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ text: `printf "${marker}\\n"`, enter: true })
            })
            if (write.status !== 200) return false
            await sleep(300)
            const second = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(target)}/status?lines=120&maxBytes=4096`, {
                headers: { authorization: `Bearer ${token}` }
            })
            if (second.status !== 200 || second.body?.activity?.unread !== true || second.body?.activity?.light !== 'yellow') return false
            const read = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(target)}/activity/read`, {
                method: 'POST',
                headers: { authorization: `Bearer ${token}` }
            })
            return (
                second.body?.activity?.seq > (first.body?.activity?.seq ?? -1) &&
                second.body?.activity?.reason === 'output' &&
                read.status === 200 &&
                read.body?.activity?.unread === false &&
                read.body?.activity?.light === 'green'
            )
        })

        await check('agent-api: remote pane status auto-settles to green once content stabilizes', async () => {
            const target = `${AGENT_SESSION}:0.0`
            const marker = `tmuxd-remote-auto-settle-${Date.now()}`
            const write = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(AGENT_SESSION)}/input`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ text: `printf "${marker}\\n"`, enter: true })
            })
            if (write.status !== 200) return false
            await sleep(300)
            const afterChange = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(target)}/status?lines=120&maxBytes=4096`, {
                headers: { authorization: `Bearer ${token}` }
            })
            if (afterChange.status !== 200 || afterChange.body?.activity?.light !== 'yellow') return false
            await sleep(7_500)
            const settled = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(target)}/status?lines=120&maxBytes=4096`, {
                headers: { authorization: `Bearer ${token}` }
            })
            return (
                settled.status === 200 &&
                settled.body?.activity?.light === 'green' &&
                settled.body?.activity?.unread === false &&
                settled.body?.activity?.seq === afterChange.body?.activity?.seq
            )
        })

        await check('agent-api: remote pane capture supports maxBytes truncation', async () => {
            const write = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(AGENT_SESSION)}/input`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ text: 'printf "remote-long-%05000d\\n" 0', enter: true })
            })
            if (write.status !== 200) return false
            await sleep(300)
            const capture = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(`${AGENT_SESSION}:0.0`)}/capture?lines=120&maxBytes=1024`, {
                headers: { authorization: `Bearer ${token}` }
            })
            return (
                capture.status === 200 &&
                capture.body?.truncated === true &&
                capture.body?.maxBytes === 1024 &&
                Buffer.byteLength(capture.body?.text ?? '', 'utf8') <= 1024
            )
        })

        await check('agent-api: remote pane status matches local classifier behavior', async () => {
            const write = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(AGENT_SESSION)}/input`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
                body: JSON.stringify({ text: 'printf "Do you want to proceed? Yes/No\\n"', enter: true })
            })
            if (write.status !== 200) return false
            await sleep(300)
            const status = await http(`/api/hosts/${AGENT_HOST}/panes/${encodeURIComponent(`${AGENT_SESSION}:0.0`)}/status?lines=120&maxBytes=4096`, {
                headers: { authorization: `Bearer ${token}` }
            })
            return status.status === 200 && status.body?.state === 'permission_prompt' && status.body?.signals?.includes('yes_no_prompt')
        })

        await check('agent-api: snapshot includes remote host sessions panes and statuses', async () => {
            const r = await http('/api/client/snapshot?capture=1&captureLimit=16&lines=80&maxBytes=4096', {
                headers: { authorization: `Bearer ${token}` }
            })
            return (
                r.status === 200 &&
                r.body?.hosts?.some((h) => h.id === AGENT_HOST) &&
                r.body?.sessions?.some((s) => s.name === AGENT_SESSION && s.hostId === AGENT_HOST) &&
                r.body?.panes?.some((p) => p.sessionName === AGENT_SESSION && p.hostId === AGENT_HOST) &&
                r.body?.statuses?.some((s) => s.pane?.hostId === AGENT_HOST || s.capture?.target === `${AGENT_SESSION}:0.0`)
            )
        })

        await check('agent: remote delete session', async () => {
            remoteWs?.close(1000, 'test')
            const r = await http(`/api/hosts/${AGENT_HOST}/sessions/${encodeURIComponent(AGENT_SESSION)}`, {
                method: 'DELETE',
                headers: { authorization: `Bearer ${token}` }
            })
            if (r.status !== 204) return false
            return !(await tmuxHasSession(AGENT_SESSION))
        })

        await stopProcess(agentProc)
        agentProc = null
    }

    // ---- KILL ----
    await check('delete: DELETE /api/sessions/:name → 204 + tmux gone', async () => {
        const r = await http(`/api/sessions/${encodeURIComponent(TEST_SESSION)}`, {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` }
        })
        if (r.status !== 204) return false
        return !(await tmuxHasSession(TEST_SESSION))
    })

    await check('delete: bad name → 400', async () => {
        const r = await http('/api/sessions/bad%20name', {
            method: 'DELETE',
            headers: { authorization: `Bearer ${token}` }
        })
        return r.status === 400
    })

    await check('api: unknown route returns JSON 404 instead of SPA HTML', async () => {
        const r = await http('/api/not-a-real-route', {
            headers: { authorization: `Bearer ${token}` }
        })
        return r.status === 404 && r.body?.error === 'not_found'
    })

    // ---- SPA fallback ----
    await check('spa: GET / serves HTML (web/dist)', async () => {
        const r = await fetch(BASE + '/')
        const txt = await r.text()
        return r.status === 200 && /<html[\s>]/i.test(txt)
    })

    await check('spa: unknown deep link serves index.html fallback', async () => {
        const r = await fetch(BASE + '/attach/anything')
        const txt = await r.text()
        return r.status === 200 && /<html[\s>]/i.test(txt)
    })

    console.log('\n---')
    console.log(`PASS: ${passed}   FAIL: ${failed}`)
    process.exit(failed > 0 ? 1 : 0)
}

main().catch((err) => {
    console.error('fatal:', err)
    process.exit(2)
})
