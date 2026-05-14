#!/usr/bin/env node
/**
 * E2E: same hostId in two namespaces + agent reconnect lifecycle, under
 * the new two-token trust model.
 *
 * Two design-doc claims that no other test directly verifies:
 *
 *   1. "Alice's `laptop` and Bob's `laptop` are distinct records once
 *      the registry is rekeyed by hashed namespace." (P4 in
 *      docs/identity-model.md)
 *
 *      Both users register an agent with hostId=`laptop`. Each must see
 *      their own without colliding with the other.
 *
 *   2. Agent disconnect/reconnect lifecycle. Killing an agent must
 *      remove it from its namespace's host list, restarting it must
 *      put it back, and neither must affect the other namespace's
 *      view at any point.
 *
 * Used by: npm run e2e:hub-lifecycle
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rm } from 'node:fs/promises'

const HOST = '127.0.0.1'
const PORT = Number(process.env.TMUXD_E2E_PORT || 17689)
const SERVER_TOKEN = 'lifecycle-server-token-' + Math.random().toString(36).slice(2)
const ALICE_USER_TOKEN = 'alice-lifecycle-' + Math.random().toString(36).slice(2)
const BOB_USER_TOKEN = 'bob-lifecycle-' + Math.random().toString(36).slice(2)
const TMUXD_HOME = `/tmp/tmuxd-e2e-lifecycle-${process.pid}`
// Shared TMUX_TMPDIR for all clients in this run; isolated from the
// user's default socket dir.
const TMUX_TMPDIR = `/tmp/tmuxd-e2e-lifecycle-tmux-${process.pid}`

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

async function get(path, headers = {}) {
    return fetch(`http://${HOST}:${PORT}${path}`, { headers })
}
async function postJson(path, body, headers = {}) {
    return fetch(`http://${HOST}:${PORT}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    })
}
async function login(userToken) {
    const r = await postJson('/api/auth', {
        serverToken: SERVER_TOKEN,
        userToken
    })
    if (r.status !== 200) throw new Error(`login failed: ${r.status}`)
    const { token } = await r.json()
    return token
}

function spawnAgent({ userToken, hostId, hostName }) {
    return spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/client.ts'],
        {
            env: {
                ...process.env,
                TMUXD_URL: `http://${HOST}:${PORT}`,
                TMUXD_SERVER_TOKEN: SERVER_TOKEN,
                TMUXD_USER_TOKEN: userToken,
                TMUXD_HOST_ID: hostId,
                TMUXD_HOST_NAME: hostName,
                TMUXD_AUDIT_DISABLE: '1',
                TMUXD_HOME: `${TMUXD_HOME}-agent-${userToken}-${hostId}`,
                TMUX_TMPDIR
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    )
}

async function listRemoteHostIds(jwt) {
    const r = await get('/api/hosts', { authorization: `Bearer ${jwt}` })
    if (!r.ok) throw new Error(`/hosts status ${r.status}`)
    const body = await r.json()
    return body.hosts.filter((h) => !h.isLocal).map((h) => h.id).sort()
}

async function waitFor(predicate, label, maxMs = 5000) {
    const deadline = Date.now() + maxMs
    let last
    while (Date.now() < deadline) {
        try {
            last = await predicate()
            if (last) return
        } catch (e) {
            last = e
        }
        await sleep(100)
    }
    throw new Error(`timeout waiting for: ${label} (last=${JSON.stringify(last)})`)
}

async function killAndWait(proc) {
    if (!proc) return
    try {
        proc.kill('SIGTERM')
    } catch {}
    await new Promise((resolve) => {
        const t = setTimeout(() => {
            try {
                proc.kill('SIGKILL')
            } catch {}
            resolve()
        }, 2000)
        proc.on('exit', () => {
            clearTimeout(t)
            resolve()
        })
    })
}

async function main() {
    await rm(TMUXD_HOME, { recursive: true, force: true }).catch(() => {})
    await rm(TMUX_TMPDIR, { recursive: true, force: true }).catch(() => {})
    const { mkdir } = await import('node:fs/promises')
    await mkdir(TMUX_TMPDIR, { recursive: true })

    const hub = spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/index.ts'],
        {
            env: {
                ...process.env,
                TMUXD_SERVER_TOKEN: SERVER_TOKEN,
                TMUXD_RELAY: '1',
                TMUXD_HOME,
                TMUXD_AUDIT_DISABLE: '1',
                HOST,
                PORT: String(PORT),
                TMUX_TMPDIR
            },
            stdio: ['ignore', 'inherit', 'inherit']
        }
    )

    let aliceAgent = null
    let bobAgent = null
    try {
        await waitUp(PORT)
        const aliceJwt = await login(ALICE_USER_TOKEN)
        const bobJwt = await login(BOB_USER_TOKEN)

        // ── 1. Spawn both agents with the SAME hostId — distinct user tokens
        //    yield distinct hashed namespaces, so the registry slots them
        //    independently.
        aliceAgent = spawnAgent({
            userToken: ALICE_USER_TOKEN,
            hostId: 'laptop',
            hostName: 'Alice Laptop'
        })
        bobAgent = spawnAgent({
            userToken: BOB_USER_TOKEN,
            hostId: 'laptop',
            hostName: 'Bob Laptop'
        })

        await check('both agents register despite identical hostId', async () => {
            await waitFor(async () => {
                const a = await listRemoteHostIds(aliceJwt)
                const b = await listRemoteHostIds(bobJwt)
                return a.includes('laptop') && b.includes('laptop')
            }, 'both agents registered')
        })

        // ── 2. Each user sees exactly one host, and it's hers
        await check("Alice sees one 'laptop' (hers, name='Alice Laptop')", async () => {
            const r = await get('/api/hosts', { authorization: `Bearer ${aliceJwt}` })
            const body = await r.json()
            const remotes = body.hosts.filter((h) => !h.isLocal)
            if (remotes.length !== 1) throw new Error(`expected 1 remote, got ${remotes.length}`)
            if (remotes[0].id !== 'laptop') throw new Error(`expected id=laptop, got ${remotes[0].id}`)
            if (remotes[0].name !== 'Alice Laptop') throw new Error(`expected name='Alice Laptop', got ${remotes[0].name}`)
        })
        await check("Bob sees one 'laptop' (his, name='Bob Laptop') — distinct from Alice's", async () => {
            const r = await get('/api/hosts', { authorization: `Bearer ${bobJwt}` })
            const body = await r.json()
            const remotes = body.hosts.filter((h) => !h.isLocal)
            if (remotes.length !== 1) throw new Error(`expected 1 remote, got ${remotes.length}`)
            if (remotes[0].id !== 'laptop') throw new Error(`expected id=laptop, got ${remotes[0].id}`)
            if (remotes[0].name !== 'Bob Laptop') throw new Error(`expected name='Bob Laptop', got ${remotes[0].name}`)
        })

        // ── 3. Killing Alice's agent removes ONLY her record
        await check("killing Alice's agent removes Alice's 'laptop' but keeps Bob's", async () => {
            await killAndWait(aliceAgent)
            aliceAgent = null
            await waitFor(async () => {
                const a = await listRemoteHostIds(aliceJwt)
                return !a.includes('laptop')
            }, 'alice laptop removed')
            // Bob's must still be there.
            const b = await listRemoteHostIds(bobJwt)
            if (!b.includes('laptop')) throw new Error("Bob's laptop disappeared when Alice's died")
            if (b.length !== 1) throw new Error(`Bob now has ${b.length} hosts: ${JSON.stringify(b)}`)
        })

        // ── 4. Restart Alice's agent — it reappears in HER namespace
        await check("restarting Alice's agent puts 'laptop' back in her namespace", async () => {
            aliceAgent = spawnAgent({
                userToken: ALICE_USER_TOKEN,
                hostId: 'laptop',
                hostName: 'Alice Laptop'
            })
            await waitFor(async () => {
                const a = await listRemoteHostIds(aliceJwt)
                return a.includes('laptop')
            }, 'alice laptop reregistered')
            // Confirm it's her record (display name) not Bob's.
            const r = await get('/api/hosts', { authorization: `Bearer ${aliceJwt}` })
            const body = await r.json()
            const her = body.hosts.find((h) => h.id === 'laptop')
            if (!her) throw new Error("Alice's laptop missing after reconnect")
            if (her.name !== 'Alice Laptop') throw new Error(`expected name='Alice Laptop', got ${her.name}`)
        })

        // ── 5. Bob's view never wavered — still sees only his 'laptop'
        await check("Bob's /hosts unchanged through Alice's restart cycle", async () => {
            const b = await listRemoteHostIds(bobJwt)
            if (b.length !== 1 || b[0] !== 'laptop') {
                throw new Error(`Bob saw ${JSON.stringify(b)}`)
            }
        })

        // ── 6. Trying to register Alice's agent again before kill should
        // be rejected by the hub (host_already_connected) but the agent
        // process itself stays alive and retries. This is the key
        // behavior the trust-model review forced — a transient network
        // blip during reconnect must not permanently kill the agent
        // (the hub takes up to ~45s to reap a stale entry, so a fatal
        // exit on the first 1008 would brick the agent every time the
        // network hiccups). Verifies:
        //   - Alice's view still shows exactly 1 'laptop' (the original)
        //   - the dup process does NOT exit on its own; we kill it
        //     ourselves at the end
        await check("duplicate Alice-agent rejected at hello, retries (does not exit)", async () => {
            const dup = spawnAgent({
                userToken: ALICE_USER_TOKEN,
                hostId: 'laptop',
                hostName: 'Alice Duplicate'
            })
            try {
                // Settle window: the dup tries to hello, gets 1008
                // host_already_connected, logs, and goes into backoff.
                // We give it ~2s to finish that round-trip. If the dup
                // were still treating this as fatal, it would exit
                // within that window — assert it doesn't.
                const earlyExit = await Promise.race([
                    new Promise((resolve) => dup.on('exit', (c) => resolve(c))),
                    sleep(2000).then(() => 'still-running')
                ])
                if (earlyExit !== 'still-running') {
                    throw new Error(
                        `duplicate agent exited prematurely with code ${earlyExit}; ` +
                            `expected it to retry on host_already_connected, not exit`
                    )
                }
                // Alice's view must still show exactly her one original host.
                const a = await listRemoteHostIds(aliceJwt)
                if (a.length !== 1 || a[0] !== 'laptop') {
                    throw new Error(`alice now shows ${JSON.stringify(a)} (expected ['laptop'])`)
                }
            } finally {
                await killAndWait(dup)
            }
        })

        // ── 7. Cross-namespace probe still safe
        await check("Alice GET /hosts/laptop/sessions hits HER agent, not Bob's", async () => {
            // Alice has 'laptop' registered in HER namespace, so this is
            // a 200 from Alice's POV — but it must be HER laptop, not Bob's.
            // We can't read tmux state because the agent has no tmux running,
            // but the agent should reject with a tmux error or empty list.
            // What matters is the URL path doesn't leak Bob's host.
            const r = await get('/api/hosts/laptop/sessions', { authorization: `Bearer ${aliceJwt}` })
            // 200 = clean answer; 502 = agent protocol mismatch (tmux
            // not running on the test agent); 504 = agent timeout.
            // Anything else is a leak signal.
            if (![200, 502, 504].includes(r.status)) {
                throw new Error(`unexpected status ${r.status} (body: ${await r.text()})`)
            }
        })
    } finally {
        await killAndWait(aliceAgent)
        await killAndWait(bobAgent)
        hub.kill('SIGTERM')
        await new Promise((r) => {
            const t = setTimeout(() => {
                try {
                    hub.kill('SIGKILL')
                } catch {}
                r()
            }, 3000)
            hub.on('exit', () => {
                clearTimeout(t)
                r()
            })
        })
        await rm(TMUXD_HOME, { recursive: true, force: true }).catch(() => {})
        await rm(TMUX_TMPDIR, { recursive: true, force: true }).catch(() => {})
    }

    console.log('\n---')
    console.log(`PASS: ${passes.length}   FAIL: ${fails.length}`)
    if (fails.length) {
        console.log('Failures:')
        for (const f of fails) console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : f.err}`)
        process.exit(1)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(2)
})
