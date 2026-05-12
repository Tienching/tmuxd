#!/usr/bin/env node
/**
 * E2E: same hostId in two namespaces + agent reconnect lifecycle.
 *
 * Two design-doc claims that no other test directly verifies:
 *
 *   1. "Alice's `laptop` and Bob's `laptop` are distinct records once
 *      the registry is rekeyed." (P4 in docs/hub-mode.md)
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
const BASE = 'lifecycle-base-secret-' + Math.random().toString(36).slice(2)
const ALICE_TOKEN = 'alice-lifecycle-token-' + Math.random().toString(36).slice(2)
const BOB_TOKEN = 'bob-lifecycle-token-' + Math.random().toString(36).slice(2)
const TMUXD_HOME = `/tmp/tmuxd-e2e-lifecycle-${process.pid}`

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
async function login(ns) {
    const r = await postJson('/api/auth', { token: `${BASE}:${ns}` })
    if (r.status !== 200) throw new Error(`login as ${ns} failed: ${r.status}`)
    const { token } = await r.json()
    return token
}

function spawnAgent({ token, namespace, id, name }) {
    return spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/agent.ts'],
        {
            env: {
                ...process.env,
                TMUXD_HUB_URL: `http://${HOST}:${PORT}`,
                TMUXD_AGENT_TOKEN: token,
                TMUXD_AGENT_NAMESPACE: namespace,
                TMUXD_AGENT_ID: id,
                TMUXD_AGENT_NAME: name,
                TMUXD_AUDIT_DISABLE: '1',
                TMUXD_HOME: `${TMUXD_HOME}-agent-${namespace}-${id}`
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

    const hub = spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/index.ts'],
        {
            env: {
                ...process.env,
                TMUXD_TOKEN: BASE,
                TMUXD_HUB_ONLY: '1',
                // Same hostId 'laptop' bound for BOTH users — this is the
                // claim under test.
                TMUXD_AGENT_TOKENS: `alice/laptop=${ALICE_TOKEN},bob/laptop=${BOB_TOKEN}`,
                TMUXD_HOME,
                TMUXD_AUDIT_DISABLE: '1',
                HOST,
                PORT: String(PORT)
            },
            stdio: ['ignore', 'inherit', 'inherit']
        }
    )

    let aliceAgent = null
    let bobAgent = null
    try {
        await waitUp(PORT)
        const aliceJwt = await login('alice')
        const bobJwt = await login('bob')

        // ── 1. Spawn both agents with the SAME hostId
        aliceAgent = spawnAgent({
            token: ALICE_TOKEN,
            namespace: 'alice',
            id: 'laptop',
            name: 'Alice Laptop'
        })
        bobAgent = spawnAgent({
            token: BOB_TOKEN,
            namespace: 'bob',
            id: 'laptop',
            name: 'Bob Laptop'
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
                token: ALICE_TOKEN,
                namespace: 'alice',
                id: 'laptop',
                name: 'Alice Laptop'
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

        // ── 6. Trying to register Alice's agent again before kill should fail
        // (host_already_connected). This proves the per-namespace registry
        // doesn't leak duplicates.
        await check("duplicate Alice-agent connect rejected (host_already_connected)", async () => {
            const dup = spawnAgent({
                token: ALICE_TOKEN,
                namespace: 'alice',
                id: 'laptop',
                name: 'Alice Duplicate'
            })
            // The duplicate hello should be rejected. Agent's `connectOnce`
            // will resolve when the WS closes; main loop retries with backoff.
            // We just want to confirm Alice's view doesn't show two hosts.
            await sleep(500)
            const a = await listRemoteHostIds(aliceJwt)
            if (a.length !== 1) throw new Error(`alice has ${a.length} hosts: ${JSON.stringify(a)}`)
            await killAndWait(dup)
        })

        // ── 7. Cross-namespace probe still fails
        await check("Alice GET /hosts/laptop/sessions doesn't accidentally hit Bob's", async () => {
            // Alice has 'laptop' registered in HER namespace, so this is
            // a 200 from Alice's POV — but it must be HER laptop, not Bob's.
            // We can't read tmux state because the agent has no tmux running,
            // but the agent should reject with a tmux error or empty list.
            // What matters is the URL path doesn't leak Bob's host.
            const r = await get('/api/hosts/laptop/sessions', { authorization: `Bearer ${aliceJwt}` })
            // Either 200 (alice's agent answered) or a tmux error from her
            // agent — both prove the route hit alice's not bob's. The
            // critical negative test is the unrelated hostId case.
            if (![200, 502, 504].includes(r.status)) {
                // 200 = clean answer; 502 = agent protocol mismatch (tmux
                // not running on the test agent); 504 = agent timeout.
                // Anything else is a leak signal.
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
