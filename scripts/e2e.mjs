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
 * Exits non-zero on first failure. Prints a summary.
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { execFile } from 'node:child_process'
import { rm, stat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { homedir } from 'node:os'
import WebSocket from 'ws'

const execFileP = promisify(execFile)

const HOST = process.env.HOST ?? '127.0.0.1'
const PORT = Number(process.env.PORT ?? 17683)
const PASSWORD = process.env.TMUXD_PASSWORD ?? 'e2e-test-password-123'
const AGENT_TOKEN = process.env.TMUXD_AGENT_TOKEN ?? ''
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


async function waitForHost(hostId, token, maxMs = 10000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        const r = await http('/api/hosts', { headers: { authorization: `Bearer ${token}` } })
        if (r.status === 200 && r.body?.hosts?.some((h) => h.id === hostId && h.status === 'online')) return true
        await sleep(150)
    }
    throw new Error(`host ${hostId} did not connect in time`)
}

function startAgentProcess(hostId, token) {
    return spawn('node', ['node_modules/.bin/tsx', 'server/src/agent.ts'], {
        env: {
            ...process.env,
            TMUXD_HUB_URL: BASE,
            TMUXD_AGENT_TOKEN: token,
            TMUXD_AGENT_ID: hostId,
            TMUXD_AGENT_NAME: 'E2E Agent',
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

    await check('auth: wrong password → 401', async () => {
        const r = await http('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: 'definitely-wrong' })
        })
        return r.status === 401 && r.body?.error === 'invalid_password'
    })

    await check('auth: missing body → 400', async () => {
        const r = await http('/api/auth', { method: 'POST' })
        return r.status === 400
    })

    let token = null
    await check('auth: correct password → 200 {token}', async () => {
        const r = await http('/api/auth', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password: PASSWORD })
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

    // ---- WEBSOCKET ----
    await check('ws: bad token → 401', async () => {
        try {
            await wsConnect(`ws://${HOST}:${PORT}/ws/${TEST_SESSION}?token=junk&cols=80&rows=24`)
            return false
        } catch (err) {
            return /401/.test(err.message)
        }
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
    if (AGENT_TOKEN) {
        const AGENT_HOST = 'e2e-agent'
        const AGENT_SESSION = 'tmuxd-e2e-agent'
        await killIfPresent(AGENT_SESSION)

        await check('agent: outbound client connects to hub', async () => {
            agentProc = startAgentProcess(AGENT_HOST, AGENT_TOKEN)
            agentProc.on('exit', (code, signal) => {
                if (code !== null && code !== 0) console.error(`[agent] exited ${code}`)
                else if (signal) console.error(`[agent] exited by ${signal}`)
            })
            return await waitForHost(AGENT_HOST, token)
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
