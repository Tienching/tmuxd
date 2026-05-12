#!/usr/bin/env node
/**
 * E2E: real `tmuxd` CLI driving a hub + agent through the actual subcommands
 * (login, list-hosts, list-sessions, new-session, capture-pane, send-text,
 * pane-status, kill-session, logout) under the new two-token trust model.
 * Plus a cross-namespace probe so the namespace isolation gate is exercised
 * end-to-end through the CLI.
 *
 * Topology (mirrors e2e-hub-agents.mjs):
 *   Alice agent ──► hub ◄── tmuxd CLI as Alice (ns = sha256(ALICE_USER_TOKEN))
 *   Bob   agent ──►     ◄── tmuxd CLI as Bob   (ns = sha256(BOB_USER_TOKEN))
 *
 * Mandatory: this script runs everything with TMUX_TMPDIR pointed at a
 * scratch directory so the spawned agents and their tmux servers cannot
 * pollute the operator's real default tmux socket.
 *
 * Used by: npm run e2e:cli
 */
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { chmod, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const execFileP = promisify(execFile)

const HOST = '127.0.0.1'
const PORT = Number(process.env.TMUXD_E2E_PORT || 17690)
const SERVER_TOKEN = 'cli-e2e-server-token-' + Math.random().toString(36).slice(2)
const ALICE_USER_TOKEN = 'cli-e2e-alice-user-' + Math.random().toString(36).slice(2)
const BOB_USER_TOKEN = 'cli-e2e-bob-user-' + Math.random().toString(36).slice(2)
const TMUXD_HOME = `/tmp/tmuxd-e2e-cli-${process.pid}`
const TMUX_TMPDIR = `/tmp/tmuxd-e2e-cli-tmux-${process.pid}`
// Use a separate cli credentials home so we don't trample the operator's
// real ~/.tmuxd/cli/credentials.json.
const FAKE_HOME = `/tmp/tmuxd-e2e-cli-home-${process.pid}`
const HUB_URL = `http://${HOST}:${PORT}`

/** Mirror of shared/src/identity.ts#computeNamespace — see e2e-hub.mjs. */
function computeNamespace(userToken) {
    const trimmed = String(userToken).trim()
    if (!trimmed) throw new Error('userToken must not be empty')
    return createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 16)
}

const ALICE_NS = computeNamespace(ALICE_USER_TOKEN)
const BOB_NS = computeNamespace(BOB_USER_TOKEN)

const passes = []
const fails = []

function pass(name) {
    passes.push(name)
    console.log(`  PASS  ${name}`)
}

function fail(name, err) {
    fails.push({ name, err })
    console.error(`  FAIL  ${name}: ${err instanceof Error ? err.message : err}`)
}

async function check(name, fn) {
    try {
        await fn()
        pass(name)
    } catch (err) {
        fail(name, err)
    }
}

async function waitUp(port, maxMs = 10000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://${HOST}:${port}/health`)
            if (r.ok) return
        } catch {}
        await sleep(150)
    }
    throw new Error(`hub did not boot in ${maxMs}ms`)
}

async function waitForHostId(jwt, hostId, maxMs = 5000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        const r = await fetch(`${HUB_URL}/api/hosts`, { headers: { authorization: `Bearer ${jwt}` } })
        if (r.ok) {
            const body = await r.json()
            if (body.hosts.some((h) => h.id === hostId)) return
        }
        await sleep(100)
    }
    throw new Error(`hostId ${hostId} did not appear within ${maxMs}ms`)
}

async function login(userToken, hubUrl = HUB_URL, serverToken = SERVER_TOKEN) {
    const r = await fetch(`${hubUrl}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ serverToken, userToken })
    })
    if (r.status !== 200) throw new Error(`login failed: ${r.status}`)
    const body = await r.json()
    return body.token
}

function spawnHub() {
    return spawn('node', ['node_modules/.bin/tsx', 'server/src/index.ts'], {
        env: {
            ...process.env,
            TMUXD_SERVER_TOKEN: SERVER_TOKEN,
            TMUXD_HUB_ONLY: '1',
            TMUXD_HOME,
            TMUXD_AUDIT_DISABLE: '1',
            HOST,
            PORT: String(PORT),
            TMUX_TMPDIR
        },
        stdio: ['ignore', 'inherit', 'inherit']
    })
}

function spawnAgent({ userToken, hostId, hostName }) {
    return spawn('node', ['node_modules/.bin/tsx', 'server/src/agent.ts'], {
        env: {
            ...process.env,
            TMUXD_HUB_URL: HUB_URL,
            TMUXD_SERVER_TOKEN: SERVER_TOKEN,
            TMUXD_USER_TOKEN: userToken,
            TMUXD_HOST_ID: hostId,
            TMUXD_HOST_NAME: hostName,
            TMUXD_AUDIT_DISABLE: '1',
            TMUXD_HOME: `${TMUXD_HOME}-agent-${hostId}`,
            TMUX_TMPDIR
        },
        stdio: ['ignore', 'pipe', 'pipe']
    })
}

/**
 * Run the CLI as user `who` (sets HOME to the per-user scratch so
 * each user has an isolated credentials.json; sets TMUX_TMPDIR so any
 * tmux ops the CLI provokes go into the scratch socket dir).
 */
async function cli(who, ...args) {
    const home = `${FAKE_HOME}-${who}`
    const result = await execFileP('node', ['node_modules/.bin/tsx', 'server/src/cli.ts', ...args], {
        env: {
            ...process.env,
            HOME: home,
            // Defang env-var fallbacks: cli.ts will pick up TMUXD_USER_TOKEN
            // / TMUXD_SERVER_TOKEN from process.env as a fallback to flags.
            // The test scripts deliberately set them on `npm run e2e` (so the
            // server boots), so unless we strip them here a misconfigured
            // login flag would silently succeed via the env. Force every
            // login test to spell out --server-token / --user-token.
            TMUXD_SERVER_TOKEN: '',
            TMUXD_USER_TOKEN: '',
            TMUX_TMPDIR
        },
        encoding: 'utf8',
        // Some subcommands intentionally exit non-zero (logout-when-empty, expired); capture both.
    }).catch((err) => {
        return {
            stdout: err.stdout ?? '',
            stderr: err.stderr ?? '',
            code: typeof err.code === 'number' ? err.code : 1,
            failed: true
        }
    })
    if (result.failed) return result
    return { ...result, code: 0, failed: false }
}

async function main() {
    await rm(TMUXD_HOME, { recursive: true, force: true }).catch(() => {})
    await rm(TMUX_TMPDIR, { recursive: true, force: true }).catch(() => {})
    await rm(`${FAKE_HOME}-alice`, { recursive: true, force: true }).catch(() => {})
    await rm(`${FAKE_HOME}-bob`, { recursive: true, force: true }).catch(() => {})
    await rm(`${FAKE_HOME}-mallory`, { recursive: true, force: true }).catch(() => {})
    await mkdir(TMUX_TMPDIR, { recursive: true })

    const hub = spawnHub()
    const agents = []

    try {
        await waitUp(PORT)

        // Spawn Alice's agent
        const aliceAgent = spawnAgent({
            userToken: ALICE_USER_TOKEN,
            hostId: 'laptop',
            hostName: 'Alice Laptop'
        })
        agents.push(aliceAgent)

        // Spawn Bob's agent
        const bobAgent = spawnAgent({
            userToken: BOB_USER_TOKEN,
            hostId: 'desktop',
            hostName: 'Bob Desktop'
        })
        agents.push(bobAgent)

        const aliceJwt = await login(ALICE_USER_TOKEN)
        const bobJwt = await login(BOB_USER_TOKEN)
        await waitForHostId(aliceJwt, 'laptop')
        await waitForHostId(bobJwt, 'desktop')

        // Create a real tmux session on Alice's "laptop" via the isolated socket.
        // The agent listens on the same TMUX_TMPDIR, so it'll see the session.
        await execFileP('tmux', ['new-session', '-d', '-s', 'cli-e2e-pre', 'sleep 600'], {
            env: { ...process.env, TMUX_TMPDIR }
        })

        // ─── 1. login as alice via the CLI (two-token form)
        await check('cli login --server-token --user-token → 0', async () => {
            const r = await cli(
                'alice',
                'login',
                '--hub',
                HUB_URL,
                '--server-token',
                SERVER_TOKEN,
                '--user-token',
                ALICE_USER_TOKEN
            )
            if (r.failed) throw new Error(`login exited ${r.code}: ${r.stderr}`)
            if (!r.stdout.includes(`namespace=${ALICE_NS}`)) {
                throw new Error(`expected namespace=${ALICE_NS} in stdout, got: ${r.stdout}`)
            }
        })

        // ─── 2. credentials file exists with mode 0600
        await check('cli login wrote credentials.json with mode 0600', async () => {
            const path = join(`${FAKE_HOME}-alice`, '.tmuxd', 'cli', 'credentials.json')
            const st = await stat(path)
            const mode = st.mode & 0o777
            if (mode !== 0o600) throw new Error(`expected mode 0600, got ${mode.toString(8)}`)
        })

        // ─── 3. whoami prints alice's hashed namespace + ttl
        await check("cli whoami shows alice's hashed namespace", async () => {
            const r = await cli('alice', 'whoami')
            if (r.failed) throw new Error(`whoami exited ${r.code}: ${r.stderr}`)
            if (!r.stdout.includes(`namespace:  ${ALICE_NS}`)) {
                throw new Error(`whoami missing namespace=${ALICE_NS}; got: ${r.stdout}`)
            }
            if (!r.stdout.includes(HUB_URL)) throw new Error('whoami missing hub URL')
        })

        // ─── 4. list-hosts shows only Alice's laptop, not Bob's desktop
        await check('cli list-hosts shows only alice/laptop (no bob)', async () => {
            const r = await cli('alice', 'list-hosts', '--json')
            if (r.failed) throw new Error(`list-hosts exited ${r.code}: ${r.stderr}`)
            const hosts = JSON.parse(r.stdout)
            const ids = hosts.map((h) => h.id).sort()
            if (!ids.includes('laptop')) throw new Error(`expected laptop in ${JSON.stringify(ids)}`)
            if (ids.includes('desktop')) throw new Error(`leaked Bob's desktop: ${JSON.stringify(ids)}`)
        })

        // ─── 5. list-sessions -t laptop sees the pre-created session
        await check('cli list-sessions -t laptop sees the test session', async () => {
            const r = await cli('alice', 'list-sessions', '-t', 'laptop', '--json')
            if (r.failed) throw new Error(`list-sessions exited ${r.code}: ${r.stderr}`)
            const sessions = JSON.parse(r.stdout)
            if (!sessions.some((s) => s.name === 'cli-e2e-pre')) {
                throw new Error(`cli-e2e-pre missing from ${JSON.stringify(sessions.map((s) => s.name))}`)
            }
        })

        // ─── 6. new-session creates a fresh one
        await check('cli new-session -t laptop -s cli-e2e-spawn', async () => {
            const r = await cli('alice', 'new-session', '-t', 'laptop', '-s', 'cli-e2e-spawn')
            if (r.failed) throw new Error(`new-session exited ${r.code}: ${r.stderr}`)
        })

        await check('after new-session, list-sessions includes it', async () => {
            const r = await cli('alice', 'list-sessions', '-t', 'laptop', '--json')
            const sessions = JSON.parse(r.stdout)
            if (!sessions.some((s) => s.name === 'cli-e2e-spawn')) {
                throw new Error(`cli-e2e-spawn missing from sessions list`)
            }
        })

        // ─── 6b. new-session on an already-taken name returns 409
        await check('cli new-session on duplicate name → exit 1 + actionable hint', async () => {
            const r = await cli('alice', 'new-session', '-t', 'laptop', '-s', 'cli-e2e-spawn')
            if (!r.failed) throw new Error('expected non-zero exit on duplicate session')
            if (r.code !== 1) {
                throw new Error(`expected exit 1 (ApiError), got ${r.code}: ${r.stderr}`)
            }
            if (!/already exists/i.test(r.stderr)) {
                throw new Error(`stderr missing "already exists"; got: ${r.stderr}`)
            }
            if (!/kill-session.*cli-e2e-spawn/i.test(r.stderr)) {
                throw new Error(`stderr missing kill-session hint; got: ${r.stderr}`)
            }
        })

        // ─── 7. list-panes -t laptop:cli-e2e-spawn returns ≥1 pane
        await check('cli list-panes -t laptop:cli-e2e-spawn → ≥1 pane', async () => {
            const r = await cli('alice', 'list-panes', '-t', 'laptop:cli-e2e-spawn', '--json')
            if (r.failed) throw new Error(`list-panes exited ${r.code}: ${r.stderr}`)
            const panes = JSON.parse(r.stdout)
            if (panes.length < 1) throw new Error(`expected ≥1 pane, got ${panes.length}`)
        })

        // ─── 8. send-text + capture-pane round trip
        await check('cli send-text + capture-pane sees the marker', async () => {
            const send = await cli(
                'alice',
                'send-text',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                '--enter',
                'echo cli-e2e-marker-12345'
            )
            if (send.failed) throw new Error(`send-text exited ${send.code}: ${send.stderr}`)
            const deadline = Date.now() + 5000
            let lastStdout = ''
            while (Date.now() < deadline) {
                const cap = await cli('alice', 'capture-pane', '-t', 'laptop:cli-e2e-spawn:0.0', '--lines', '50')
                if (cap.failed) throw new Error(`capture-pane exited ${cap.code}: ${cap.stderr}`)
                lastStdout = cap.stdout
                if (lastStdout.includes('cli-e2e-marker-12345')) return
                await sleep(200)
            }
            throw new Error(`capture missing marker after 5s; last stdout tail: ${lastStdout.slice(-200)}`)
        })

        // ─── 8b. --lines actually constrains the captured line count
        await check('capture-pane --lines constrains history depth', async () => {
            const SENTINEL = 'cli-e2e-history-FLOOR'
            const r0 = await cli(
                'alice',
                'send-text',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                '--enter',
                `echo ${SENTINEL}`
            )
            if (r0.failed) throw new Error(`floor-marker send failed: ${r0.stderr}`)

            const r1 = await cli(
                'alice',
                'send-text',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                '--enter',
                'for i in $(seq 1 120); do echo cli-e2e-spam-$i; done'
            )
            if (r1.failed) throw new Error(`spam-loop send failed: ${r1.stderr}`)

            const deadline = Date.now() + 8000
            let allFlushed = false
            while (Date.now() < deadline) {
                const r = await cli(
                    'alice',
                    'capture-pane',
                    '-t',
                    'laptop:cli-e2e-spawn:0.0',
                    '--lines',
                    '500'
                )
                if (r.failed) throw new Error(`pre-flight capture failed: ${r.stderr}`)
                if (r.stdout.includes('cli-e2e-spam-120')) {
                    allFlushed = true
                    break
                }
                await sleep(200)
            }
            if (!allFlushed) throw new Error('spam loop did not flush within 8s')

            const wide = await cli(
                'alice',
                'capture-pane',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                '--lines',
                '500'
            )
            if (wide.failed) throw new Error(`wide capture failed: ${wide.stderr}`)
            if (!wide.stdout.includes(SENTINEL)) {
                throw new Error(
                    `--lines 500 missing floor marker (expected deep history); ` +
                        `tail: ${wide.stdout.slice(-200)}`
                )
            }

            const thin = await cli(
                'alice',
                'capture-pane',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                '--lines',
                '1'
            )
            if (thin.failed) throw new Error(`thin capture failed: ${thin.stderr}`)
            if (thin.stdout.includes(SENTINEL)) {
                throw new Error(
                    `--lines 1 leaked floor marker — flag may have been silently dropped; ` +
                        `capture: ${thin.stdout.slice(0, 300)}`
                )
            }
        })

        // ─── 8c. --max-bytes propagates to the wire as `maxBytes` query
        await check('capture-pane --max-bytes round-trips to wire', async () => {
            const r = await cli(
                'alice',
                'capture-pane',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                '-B',
                '2048',
                '--json'
            )
            if (r.failed) throw new Error(`capture-pane --json -B 2048 failed: ${r.stderr}`)
            const cap = JSON.parse(r.stdout)
            if (cap.maxBytes !== 2048) {
                throw new Error(`expected maxBytes=2048 echoed back, got ${cap.maxBytes}`)
            }
        })

        // ─── 9. pane-status returns a status with a light field
        await check('cli pane-status -t laptop:cli-e2e-spawn:0.0 → has light', async () => {
            const r = await cli('alice', 'pane-status', '-t', 'laptop:cli-e2e-spawn:0.0', '--json')
            if (r.failed) throw new Error(`pane-status exited ${r.code}: ${r.stderr}`)
            const status = JSON.parse(r.stdout)
            if (!status.activity || !status.activity.light) {
                throw new Error(`status missing activity.light: ${JSON.stringify(status)}`)
            }
            if (!['gray', 'green', 'yellow', 'red'].includes(status.activity.light)) {
                throw new Error(`invalid light value: ${status.activity.light}`)
            }
        })

        // ─── 9a. send-keys — distinct from send-text.
        await check('cli send-keys Enter executes a queued send-text line', async () => {
            const sendText = await cli(
                'alice',
                'send-text',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                'echo cli-e2e-keys-7777'
            )
            if (sendText.failed) throw new Error(`send-text failed: ${sendText.stderr}`)
            const sendKeys = await cli('alice', 'send-keys', '-t', 'laptop:cli-e2e-spawn:0.0', 'Enter')
            if (sendKeys.failed) throw new Error(`send-keys failed: ${sendKeys.stderr}`)
            const deadline = Date.now() + 5000
            let lastStdout = ''
            while (Date.now() < deadline) {
                const cap = await cli(
                    'alice',
                    'capture-pane',
                    '-t',
                    'laptop:cli-e2e-spawn:0.0',
                    '--lines',
                    '50'
                )
                if (cap.failed) throw new Error(`capture-pane failed: ${cap.stderr}`)
                lastStdout = cap.stdout
                if (lastStdout.includes('cli-e2e-keys-7777')) return
                await sleep(200)
            }
            throw new Error(`send-keys marker missing after 5s; tail: ${lastStdout.slice(-200)}`)
        })

        // ─── 9b. `display-message` deprecated alias
        await check('display-message alias still works + warns', async () => {
            const r = await cli('alice', 'display-message', '-t', 'laptop:cli-e2e-spawn:0.0', '--json')
            if (r.failed) throw new Error(`display-message alias exited ${r.code}: ${r.stderr}`)
            const status = JSON.parse(r.stdout)
            if (!status.activity?.light) {
                throw new Error('alias did not produce equivalent output')
            }
            if (!/deprecated alias for `pane-status`/i.test(r.stderr)) {
                throw new Error(`stderr missing deprecation warning; got: ${r.stderr}`)
            }
        })

        // ─── 9c. snapshot — wraps /api/agent/snapshot.
        await check('cli snapshot returns alice-scoped hosts and sessions', async () => {
            const r = await cli('alice', 'snapshot')
            if (r.failed) throw new Error(`snapshot exited ${r.code}: ${r.stderr}`)
            const snap = JSON.parse(r.stdout)
            if (!Array.isArray(snap.hosts) || !snap.hosts.some((h) => h.id === 'laptop')) {
                throw new Error(`snapshot.hosts missing laptop: ${JSON.stringify(snap.hosts)}`)
            }
            if (snap.hosts.some((h) => h.id === 'desktop')) {
                throw new Error(`snapshot leaked bob's desktop: ${JSON.stringify(snap.hosts)}`)
            }
            if (!Array.isArray(snap.sessions) || !snap.sessions.some((s) => s.name === 'cli-e2e-spawn')) {
                throw new Error(`snapshot.sessions missing cli-e2e-spawn: ${JSON.stringify(snap.sessions)}`)
            }
            if (!Array.isArray(snap.panes) || snap.panes.length === 0) {
                throw new Error(`snapshot.panes empty: ${JSON.stringify(snap)}`)
            }
            if (typeof snap.generatedAt !== 'number') {
                throw new Error(`snapshot.generatedAt missing/non-number: ${snap.generatedAt}`)
            }
        })

        // ─── 9d. snapshot --capture --limit 2
        await check('cli snapshot --capture --limit returns at least one capture', async () => {
            const r = await cli('alice', 'snapshot', '--capture', '--limit', '2')
            if (r.failed) throw new Error(`snapshot --capture exited ${r.code}: ${r.stderr}`)
            const snap = JSON.parse(r.stdout)
            if (!Array.isArray(snap.statuses) || snap.statuses.length === 0) {
                throw new Error(`snapshot.statuses empty with --capture: ${JSON.stringify(snap.statuses)}`)
            }
            const withCap = snap.statuses.filter((s) => s.capture && typeof s.capture.text === 'string')
            if (withCap.length === 0) {
                throw new Error(
                    `--capture produced no capture blocks; statuses: ${JSON.stringify(snap.statuses)}`
                )
            }
            if (withCap.length > 2) {
                throw new Error(`--limit 2 produced ${withCap.length} captures (expected ≤2)`)
            }
        })

        // ─── 10. kill-session removes it
        await check('cli kill-session -t laptop:cli-e2e-spawn', async () => {
            const r = await cli('alice', 'kill-session', '-t', 'laptop:cli-e2e-spawn')
            if (r.failed) throw new Error(`kill-session exited ${r.code}: ${r.stderr}`)
        })

        await check('attach-session prints web UI deep-link URL', async () => {
            const r = await cli('alice', 'attach-session', '-t', 'laptop:cli-e2e-pre')
            if (r.failed) throw new Error(`attach-session exited ${r.code}: ${r.stderr}`)
            const url = r.stdout.trim()
            if (!url.startsWith(HUB_URL + '/attach/laptop/cli-e2e-pre')) {
                throw new Error(`expected URL prefix ${HUB_URL}/attach/laptop/cli-e2e-pre, got: ${url}`)
            }
            if (!/not yet implemented/i.test(r.stderr)) {
                throw new Error(`stderr missing 'not yet implemented' notice: ${r.stderr}`)
            }
        })

        await check('attach-session --json emits structured payload', async () => {
            const r = await cli('alice', 'attach-session', '-t', 'laptop:cli-e2e-pre', '--json')
            if (r.failed) throw new Error(`attach-session --json exited ${r.code}: ${r.stderr}`)
            const body = JSON.parse(r.stdout)
            if (body.hostId !== 'laptop' || body.sessionName !== 'cli-e2e-pre') {
                throw new Error(`unexpected JSON payload: ${JSON.stringify(body)}`)
            }
            if (!body.attachUrl?.startsWith(HUB_URL)) {
                throw new Error(`attachUrl missing hub prefix: ${body.attachUrl}`)
            }
        })

        // ─── 10b. NotFoundError exit-3 paths
        await check('kill-session on a missing session → exit 3', async () => {
            const r = await cli('alice', 'kill-session', '-t', 'laptop:cli-e2e-spawn')
            if (!r.failed) throw new Error('expected non-zero exit on missing session')
            if (r.code !== 3) {
                throw new Error(`expected exit 3 (NotFoundError), got ${r.code}: ${r.stderr}`)
            }
        })

        await check('capture-pane on a missing target → exit 3', async () => {
            const r = await cli(
                'alice',
                'capture-pane',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                '--lines',
                '10'
            )
            if (!r.failed) throw new Error('expected non-zero exit on missing pane')
            if (r.code !== 3) {
                throw new Error(`expected exit 3 (NotFoundError), got ${r.code}: ${r.stderr}`)
            }
        })

        await check('pane-status on a missing target → exit 3', async () => {
            const r = await cli('alice', 'pane-status', '-t', 'laptop:cli-e2e-spawn:0.0')
            if (!r.failed) throw new Error('expected non-zero exit on missing pane')
            if (r.code !== 3) {
                throw new Error(`expected exit 3 (NotFoundError), got ${r.code}: ${r.stderr}`)
            }
        })

        await check('send-text on a missing pane → exit 3', async () => {
            const r = await cli(
                'alice',
                'send-text',
                '-t',
                'laptop:cli-e2e-spawn:0.0',
                'echo',
                'noop'
            )
            if (!r.failed) throw new Error('expected non-zero exit on missing pane')
            if (r.code !== 3) {
                throw new Error(`expected exit 3 (NotFoundError), got ${r.code}: ${r.stderr}`)
            }
        })

        await check('after kill-session, sessions list omits it', async () => {
            const r = await cli('alice', 'list-sessions', '-t', 'laptop', '--json')
            const sessions = JSON.parse(r.stdout)
            if (sessions.some((s) => s.name === 'cli-e2e-spawn')) {
                throw new Error('cli-e2e-spawn still present after kill')
            }
        })

        // ─── 11. cross-namespace probe: bob logs in via CLI, cannot see Alice's laptop
        await check('cli login as bob (different user-token → different namespace)', async () => {
            const r = await cli(
                'bob',
                'login',
                '--hub',
                HUB_URL,
                '--server-token',
                SERVER_TOKEN,
                '--user-token',
                BOB_USER_TOKEN
            )
            if (r.failed) throw new Error(`bob login exited ${r.code}: ${r.stderr}`)
            if (!r.stdout.includes(`namespace=${BOB_NS}`)) {
                throw new Error(`expected namespace=${BOB_NS}; got: ${r.stdout}`)
            }
        })

        await check('bob list-hosts shows only desktop, not laptop', async () => {
            const r = await cli('bob', 'list-hosts', '--json')
            const hosts = JSON.parse(r.stdout)
            const ids = hosts.map((h) => h.id).sort()
            if (ids.includes('laptop')) throw new Error(`bob saw alice's laptop: ${JSON.stringify(ids)}`)
            if (!ids.includes('desktop')) throw new Error(`bob missing his desktop: ${JSON.stringify(ids)}`)
        })

        await check('bob list-sessions -t laptop → exit 3 (NotFoundError)', async () => {
            const r = await cli('bob', 'list-sessions', '-t', 'laptop', '--json')
            if (!r.failed) throw new Error('expected non-zero exit when bob queries alice host')
            if (r.code !== 3) throw new Error(`expected exit 3 (NotFoundError), got ${r.code}: ${r.stderr}`)
        })

        // ─── 12. logout clears credentials
        await check('cli logout clears credentials', async () => {
            const r = await cli('alice', 'logout')
            if (r.failed) throw new Error(`logout exited ${r.code}: ${r.stderr}`)
        })

        await check('after logout, list-hosts → exit 2 (AuthError)', async () => {
            const r = await cli('alice', 'list-hosts')
            if (!r.failed) throw new Error('expected non-zero exit when no creds')
            if (r.code !== 2) throw new Error(`expected exit 2 (AuthError), got ${r.code}: ${r.stderr}`)
        })

        // ─── 13. --user-token-generate works for first-time setup.
        // Login with a fresh, randomly generated user token. The CLI should
        // print the generated token to stderr (so the operator can save it),
        // and the resulting JWT should land in a fresh namespace distinct
        // from alice/bob.
        await check('cli login --user-token-generate succeeds + prints token', async () => {
            const r = await cli(
                'mallory',
                'login',
                '--hub',
                HUB_URL,
                '--server-token',
                SERVER_TOKEN,
                '--user-token-generate'
            )
            if (r.failed) throw new Error(`generate-login exited ${r.code}: ${r.stderr}`)
            if (!/generated user token/i.test(r.stderr)) {
                throw new Error(`stderr missing 'generated user token' announcement: ${r.stderr}`)
            }
            // Pull the generated token out of stderr so we can verify the
            // namespace it landed in matches sha256(token).slice(16).
            const m = r.stderr.match(/^\s+([a-f0-9]{64})\s*$/m)
            if (!m) throw new Error(`could not extract generated token from stderr:\n${r.stderr}`)
            const generated = m[1]
            const expectedNs = computeNamespace(generated)
            if (!r.stdout.includes(`namespace=${expectedNs}`)) {
                throw new Error(
                    `expected namespace=${expectedNs} (= sha256(generated)[:16]); got: ${r.stdout}`
                )
            }
            if (expectedNs === ALICE_NS || expectedNs === BOB_NS) {
                throw new Error(`generated namespace collided with alice/bob — broken entropy?`)
            }
        })

        // ─── 14. World-readable credentials file is refused
        await check('CLI refuses to load a 0644 credentials file', async () => {
            const credsPath = join(`${FAKE_HOME}-mallory`, '.tmuxd', 'cli', 'credentials.json')
            await chmod(credsPath, 0o644)
            try {
                const r = await cli('mallory', 'whoami')
                if (!r.failed) throw new Error('expected refusal on 0644 creds, got success')
                if (r.code !== 1) {
                    throw new Error(`expected exit 1 on 0644 creds, got ${r.code}: ${r.stderr}`)
                }
                if (!/mode is 644/i.test(r.stderr) || !/chmod 600/i.test(r.stderr)) {
                    throw new Error(`stderr missing 0644 hint; got: ${r.stderr}`)
                }
            } finally {
                await chmod(credsPath, 0o600).catch(() => {})
            }
        })

        // ─── 14b. --server-token-file mode-hardening
        // The file form keeps the master secret out of `ps`. If the file
        // itself is readable by other users on a shared box, we've moved
        // the leak to a different surface — refuse it.
        await check('--server-token-file refuses mode 0644', async () => {
            const tokenFile = join(`${FAKE_HOME}-mallory`, 'srv-token-leaky.txt')
            await mkdir(`${FAKE_HOME}-mallory`, { recursive: true, mode: 0o700 }).catch(() => {})
            await writeFile(tokenFile, SERVER_TOKEN, { mode: 0o644 })
            try {
                const r = await cli(
                    'mallory',
                    'login',
                    '--hub',
                    HUB_URL,
                    '--server-token-file',
                    tokenFile,
                    '--user-token',
                    'mallory-' + Math.random().toString(36).slice(2)
                )
                if (!r.failed) throw new Error('expected refusal on 0644 token file, got success')
                if (r.code !== 1) {
                    throw new Error(`expected exit 1 on 0644 token file, got ${r.code}: ${r.stderr}`)
                }
                if (!/mode is 644/i.test(r.stderr) || !/chmod 600/i.test(r.stderr)) {
                    throw new Error(`stderr missing 0644 chmod hint; got: ${r.stderr}`)
                }
            } finally {
                await rm(tokenFile, { force: true }).catch(() => {})
            }
        })

        // ─── 14c. --user-token-file mode-hardening — same gate, opposite slot.
        // If --server-token-file checks file permissions but --user-token-file
        // doesn't, half of the operator's chmod story is broken. Pin both.
        await check('--user-token-file refuses mode 0644', async () => {
            const tokenFile = join(`${FAKE_HOME}-mallory`, 'usr-token-leaky.txt')
            await mkdir(`${FAKE_HOME}-mallory`, { recursive: true, mode: 0o700 }).catch(() => {})
            await writeFile(tokenFile, 'usr-' + Math.random().toString(36).slice(2), { mode: 0o644 })
            try {
                const r = await cli(
                    'mallory',
                    'login',
                    '--hub',
                    HUB_URL,
                    '--server-token',
                    SERVER_TOKEN,
                    '--user-token-file',
                    tokenFile
                )
                if (!r.failed) throw new Error('expected refusal on 0644 user-token file, got success')
                if (r.code !== 1) {
                    throw new Error(`expected exit 1 on 0644 user-token file, got ${r.code}: ${r.stderr}`)
                }
                if (!/mode is 644/i.test(r.stderr) || !/chmod 600/i.test(r.stderr)) {
                    throw new Error(`stderr missing 0644 chmod hint; got: ${r.stderr}`)
                }
            } finally {
                await rm(tokenFile, { force: true }).catch(() => {})
            }
        })

        // ─── 14d. Both files at mode 0600 → success, lands in expected namespace
        await check('both --*-token-file mode 0600 logs in successfully', async () => {
            const srvFile = join(`${FAKE_HOME}-mallory`, 'srv-token.txt')
            const usrToken = 'mallory-secure-' + Math.random().toString(36).slice(2)
            const usrFile = join(`${FAKE_HOME}-mallory`, 'usr-token.txt')
            await mkdir(`${FAKE_HOME}-mallory`, { recursive: true, mode: 0o700 }).catch(() => {})
            await writeFile(srvFile, SERVER_TOKEN, { mode: 0o600 })
            await writeFile(usrFile, usrToken, { mode: 0o600 })
            try {
                const r = await cli(
                    'mallory',
                    'login',
                    '--hub',
                    HUB_URL,
                    '--server-token-file',
                    srvFile,
                    '--user-token-file',
                    usrFile
                )
                if (r.failed) {
                    throw new Error(`expected 0600 token-file login to succeed, got ${r.code}: ${r.stderr}`)
                }
                const expectedNs = computeNamespace(usrToken)
                const r2 = await cli('mallory', 'whoami', '--json')
                if (r2.failed) throw new Error(`whoami failed: ${r2.stderr}`)
                const j = JSON.parse(r2.stdout)
                if (j.namespace !== expectedNs) {
                    throw new Error(`expected ns=${expectedNs}, got ${j.namespace}`)
                }
            } finally {
                await rm(srvFile, { force: true }).catch(() => {})
                await rm(usrFile, { force: true }).catch(() => {})
                await cli('mallory', 'logout').catch(() => {})
            }
        })

        // ─── 15. login without --server-token → exit 1 UsageError
        await check('cli login without --server-token → exit 1 UsageError', async () => {
            const r = await cli(
                'mallory',
                'login',
                '--hub',
                HUB_URL,
                '--user-token',
                'whatever'
            )
            if (!r.failed) throw new Error('expected refusal without --server-token')
            if (r.code !== 1) {
                throw new Error(`expected exit 1 (UsageError), got ${r.code}: ${r.stderr}`)
            }
            if (!/server-token/i.test(r.stderr)) {
                throw new Error(`stderr missing --server-token mention; got: ${r.stderr}`)
            }
        })

        // ─── 15b. login without --user-token → exit 1 UsageError
        await check('cli login without --user-token → exit 1 UsageError', async () => {
            const r = await cli(
                'mallory',
                'login',
                '--hub',
                HUB_URL,
                '--server-token',
                SERVER_TOKEN
            )
            if (!r.failed) throw new Error('expected refusal without --user-token')
            if (r.code !== 1) {
                throw new Error(`expected exit 1 (UsageError), got ${r.code}: ${r.stderr}`)
            }
            if (!/user-token/i.test(r.stderr)) {
                throw new Error(`stderr missing --user-token mention; got: ${r.stderr}`)
            }
        })

        // ─── 15c. wrong server-token → 401 → AuthError → exit 2
        await check('cli login with wrong --server-token → exit 2 AuthError', async () => {
            const r = await cli(
                'mallory',
                'login',
                '--hub',
                HUB_URL,
                '--server-token',
                'this-is-not-the-server-token',
                '--user-token',
                'whatever-user-token'
            )
            if (!r.failed) throw new Error('expected refusal with wrong server-token')
            if (r.code !== 2) {
                throw new Error(`expected exit 2 (AuthError), got ${r.code}: ${r.stderr}`)
            }
            if (!/rejected the tokens/i.test(r.stderr)) {
                throw new Error(`stderr missing 'rejected the tokens' message; got: ${r.stderr}`)
            }
        })

        // ─── 16. http:// to a real hostname triggers the JWT-cleartext warning
        await check('http://hub.example warns about cleartext JWT', async () => {
            const r = await cli(
                'mallory',
                'login',
                '--hub',
                'http://nonresolvable-hub.example.invalid',
                '--server-token',
                SERVER_TOKEN,
                '--user-token',
                'whatever'
            )
            if (!r.stderr.includes('plain http://')) {
                throw new Error(`stderr missing http-warning; got: ${r.stderr}`)
            }
        })

        // ─── 17. Expired JWT path
        const TTL_PORT = 17691
        const TTL_HUB = `http://${HOST}:${TTL_PORT}`
        const TTL_SERVER_TOKEN = 'ttl-test-server-' + Math.random().toString(36).slice(2)
        const TTL_USER_TOKEN = 'ttl-test-user-' + Math.random().toString(36).slice(2)
        const ttlHub = spawn('node', ['node_modules/.bin/tsx', 'server/src/index.ts'], {
            env: {
                ...process.env,
                TMUXD_SERVER_TOKEN: TTL_SERVER_TOKEN,
                TMUXD_HUB_ONLY: '1',
                TMUXD_HOME: `${TMUXD_HOME}-ttl`,
                TMUXD_AUDIT_DISABLE: '1',
                TMUXD_JWT_TTL_SECONDS_FOR_TEST: '2',
                HOST,
                PORT: String(TTL_PORT),
                TMUX_TMPDIR
            },
            stdio: ['ignore', 'inherit', 'inherit']
        })
        try {
            const ttlDeadline = Date.now() + 8000
            while (Date.now() < ttlDeadline) {
                try {
                    const r = await fetch(`${TTL_HUB}/health`)
                    if (r.ok) break
                } catch {}
                await sleep(150)
            }
            await check('expired-JWT: login succeeds initially', async () => {
                const r = await cli(
                    'mallory',
                    'login',
                    '--hub',
                    TTL_HUB,
                    '--server-token',
                    TTL_SERVER_TOKEN,
                    '--user-token',
                    TTL_USER_TOKEN
                )
                if (r.failed) throw new Error(`expired-JWT login exited ${r.code}: ${r.stderr}`)
            })
            // Wait long enough for the JWT (TTL=2s) to expire. Add a margin.
            await sleep(3500)
            await check('expired-JWT: whoami exits 2 with re-login hint', async () => {
                const r = await cli('mallory', 'whoami', '--hub', TTL_HUB)
                if (!r.failed) throw new Error('expected non-zero exit on expired JWT')
                if (r.code !== 2) throw new Error(`expected exit 2 (AuthError), got ${r.code}: ${r.stderr}`)
                if (!/expired/i.test(r.stderr) || !/tmuxd login/i.test(r.stderr)) {
                    throw new Error(`stderr missing expired/re-login hint; got: ${r.stderr}`)
                }
            })
            await check('expired-JWT: list-hosts exits 2 with re-login hint', async () => {
                const r = await cli('mallory', 'list-hosts', '--hub', TTL_HUB)
                if (!r.failed) throw new Error('expected non-zero exit on expired JWT')
                if (r.code !== 2) throw new Error(`expected exit 2 (AuthError), got ${r.code}: ${r.stderr}`)
                if (!/expired/i.test(r.stderr) || !/tmuxd login/i.test(r.stderr)) {
                    throw new Error(`stderr missing expired/re-login hint; got: ${r.stderr}`)
                }
            })
        } finally {
            ttlHub.kill('SIGTERM')
            await sleep(200)
            await rm(`${TMUXD_HOME}-ttl`, { recursive: true, force: true }).catch(() => {})
        }

        // ─── 18. Multi-hub credentials
        const ALT_PORT = 17692
        const ALT_HUB = `http://${HOST}:${ALT_PORT}`
        const ALT_SERVER_TOKEN = 'alt-hub-server-' + Math.random().toString(36).slice(2)
        const altHub = spawn('node', ['node_modules/.bin/tsx', 'server/src/index.ts'], {
            env: {
                ...process.env,
                TMUXD_SERVER_TOKEN: ALT_SERVER_TOKEN,
                TMUXD_HUB_ONLY: '1',
                TMUXD_HOME: `${TMUXD_HOME}-alt`,
                TMUXD_AUDIT_DISABLE: '1',
                HOST,
                PORT: String(ALT_PORT),
                TMUX_TMPDIR
            },
            stdio: ['ignore', 'inherit', 'inherit']
        })
        const CAROL_HUB_A_USER = 'carol-hub-a-' + Math.random().toString(36).slice(2)
        const CAROL_HUB_B_USER = 'carol-hub-b-' + Math.random().toString(36).slice(2)
        const CAROL_HUB_A_NS = computeNamespace(CAROL_HUB_A_USER)
        const CAROL_HUB_B_NS = computeNamespace(CAROL_HUB_B_USER)
        try {
            const altDeadline = Date.now() + 8000
            while (Date.now() < altDeadline) {
                try {
                    const r = await fetch(`${ALT_HUB}/health`)
                    if (r.ok) break
                } catch {}
                await sleep(150)
            }

            // Use a fresh persona "carol" so we don't collide with alice/bob/mallory.
            await check('multi-hub: carol logs into HUB-A', async () => {
                const r = await cli(
                    'carol',
                    'login',
                    '--hub',
                    HUB_URL,
                    '--server-token',
                    SERVER_TOKEN,
                    '--user-token',
                    CAROL_HUB_A_USER
                )
                if (r.failed) throw new Error(`HUB-A login failed: ${r.stderr}`)
            })

            await check('multi-hub: carol logs into HUB-B with different user-token', async () => {
                const r = await cli(
                    'carol',
                    'login',
                    '--hub',
                    ALT_HUB,
                    '--server-token',
                    ALT_SERVER_TOKEN,
                    '--user-token',
                    CAROL_HUB_B_USER
                )
                if (r.failed) throw new Error(`HUB-B login failed: ${r.stderr}`)
            })

            await check('multi-hub: whoami --hub HUB-A → HUB-A namespace', async () => {
                const r = await cli('carol', 'whoami', '--hub', HUB_URL, '--json')
                if (r.failed) throw new Error(`whoami HUB-A failed: ${r.stderr}`)
                const j = JSON.parse(r.stdout)
                if (j.namespace !== CAROL_HUB_A_NS) {
                    throw new Error(`expected ns=${CAROL_HUB_A_NS}, got ${j.namespace}`)
                }
                if (j.hubUrl !== HUB_URL) throw new Error(`expected hubUrl=${HUB_URL}, got ${j.hubUrl}`)
            })

            await check('multi-hub: whoami --hub HUB-B → HUB-B namespace', async () => {
                const r = await cli('carol', 'whoami', '--hub', ALT_HUB, '--json')
                if (r.failed) throw new Error(`whoami HUB-B failed: ${r.stderr}`)
                const j = JSON.parse(r.stdout)
                if (j.namespace !== CAROL_HUB_B_NS) {
                    throw new Error(`expected ns=${CAROL_HUB_B_NS}, got ${j.namespace}`)
                }
                if (j.hubUrl !== ALT_HUB) throw new Error(`expected hubUrl=${ALT_HUB}, got ${j.hubUrl}`)
            })

            // Bare `whoami` (no --hub) returns the most-recently-saved hub
            // (HUB-B), since saveCredentials() promotes its hub to default.
            await check('multi-hub: whoami (no --hub) → defaults to most-recent', async () => {
                const r = await cli('carol', 'whoami', '--json')
                if (r.failed) throw new Error(`whoami default failed: ${r.stderr}`)
                const j = JSON.parse(r.stdout)
                if (j.hubUrl !== ALT_HUB) {
                    throw new Error(`expected default hubUrl=${ALT_HUB}, got ${j.hubUrl}`)
                }
            })

            await check('multi-hub: logout --hub HUB-A leaves HUB-B intact', async () => {
                const r = await cli('carol', 'logout', '--hub', HUB_URL)
                if (r.failed) throw new Error(`logout HUB-A failed: ${r.stderr}`)
                const r2 = await cli('carol', 'whoami', '--hub', ALT_HUB, '--json')
                if (r2.failed) throw new Error(`HUB-B whoami after HUB-A logout failed: ${r2.stderr}`)
                const j = JSON.parse(r2.stdout)
                if (j.namespace !== CAROL_HUB_B_NS) {
                    throw new Error(`expected HUB-B intact ns=${CAROL_HUB_B_NS}, got ${j.namespace}`)
                }
                const r3 = await cli('carol', 'whoami', '--hub', HUB_URL)
                if (!r3.failed || r3.code !== 2) {
                    throw new Error(`expected HUB-A whoami exit 2 after logout, got ${r3.code}: ${r3.stderr}`)
                }
            })

            await check('multi-hub: logout --hub HUB-B empties the file', async () => {
                const r = await cli('carol', 'logout', '--hub', ALT_HUB)
                if (r.failed) throw new Error(`logout HUB-B failed: ${r.stderr}`)
                const r2 = await cli('carol', 'whoami')
                if (!r2.failed || r2.code !== 2) {
                    throw new Error(`expected whoami exit 2 after both logouts, got ${r2.code}: ${r2.stderr}`)
                }
            })
        } finally {
            altHub.kill('SIGTERM')
            await sleep(200)
            await rm(`${TMUXD_HOME}-alt`, { recursive: true, force: true }).catch(() => {})
            await rm(`${FAKE_HOME}-carol`, { recursive: true, force: true }).catch(() => {})
        }

        // Cleanup the pre-created session so we don't leak into shutdown
        await execFileP('tmux', ['kill-session', '-t', 'cli-e2e-pre'], {
            env: { ...process.env, TMUX_TMPDIR }
        }).catch(() => {})
    } finally {
        for (const a of agents) a.kill('SIGTERM')
        hub.kill('SIGTERM')
        await sleep(200)
        await execFileP('tmux', ['kill-server'], { env: { ...process.env, TMUX_TMPDIR } }).catch(() => {})
        await rm(TMUXD_HOME, { recursive: true, force: true }).catch(() => {})
        await rm(TMUX_TMPDIR, { recursive: true, force: true }).catch(() => {})
        await rm(`${FAKE_HOME}-alice`, { recursive: true, force: true }).catch(() => {})
        await rm(`${FAKE_HOME}-bob`, { recursive: true, force: true }).catch(() => {})
        await rm(`${FAKE_HOME}-mallory`, { recursive: true, force: true }).catch(() => {})
    }

    console.log(`\n---\nPASS: ${passes.length}   FAIL: ${fails.length}\n`)
    if (fails.length > 0) {
        for (const f of fails) {
            console.error(`  ${f.name}: ${f.err instanceof Error ? f.err.message : f.err}`)
        }
        process.exit(1)
    }
}

main().catch((err) => {
    console.error('fatal:', err)
    process.exit(2)
})
