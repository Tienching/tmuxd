#!/usr/bin/env node
/**
 * E2E: real `tmuxd` hub + two real `tmuxd agent` processes, proving
 * cross-namespace isolation through the entire stack — actual websocket
 * frames, actual `node-pty`-free hello path, actual JWT issuance.
 *
 * Topology:
 *
 *   ┌──────────────┐       ┌──────────────┐
 *   │ alice agent  │ ◄──── │  tmuxd hub   │ ────► alice's HTTP client
 *   │ (laptop)     │       │  (port 17688)│
 *   ├──────────────┤       │              │
 *   │ bob agent    │ ◄──── │              │ ────► bob's HTTP client
 *   │ (desktop)    │       │              │
 *   └──────────────┘       └──────────────┘
 *
 * Asserts:
 *   - Alice's HTTP client sees only `alice-laptop` in /api/hosts.
 *   - Bob's HTTP client sees only `bob-desktop`.
 *   - Cross-namespace probe (Alice asking for /hosts/bob-desktop/sessions) → 404.
 *   - Spawning a third agent with Alice's token but namespace=eve fails
 *     hard with exit code 2 (hub closes WS with 4401).
 *
 * Used by: npm run e2e:hub-agents
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rm } from 'node:fs/promises'

const HOST = '127.0.0.1'
const PORT = Number(process.env.TMUXD_E2E_PORT || 17688)
const BASE = 'real-agent-base-secret-' + Math.random().toString(36).slice(2)
const ALICE_TOKEN = 'alice-real-agent-token-' + Math.random().toString(36).slice(2)
const BOB_TOKEN = 'bob-real-agent-token-' + Math.random().toString(36).slice(2)
const TMUXD_HOME = `/tmp/tmuxd-e2e-real-agents-${process.pid}`

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
    const body = await r.json()
    return body.token
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
                // No HOME-dir tmux state needed; agent only opens a WS.
                TMUXD_HOME: `${TMUXD_HOME}-agent-${id}`
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    )
}

async function waitForHostId(token, hostId, maxMs = 5000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        const r = await get('/api/hosts', { authorization: `Bearer ${token}` })
        if (r.ok) {
            const body = await r.json()
            if (body.hosts.some((h) => h.id === hostId)) return
        }
        await sleep(100)
    }
    throw new Error(`hostId ${hostId} did not appear within ${maxMs}ms`)
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
                TMUXD_AGENT_TOKENS: `alice/laptop=${ALICE_TOKEN},bob/desktop=${BOB_TOKEN}`,
                TMUXD_HOME,
                TMUXD_AUDIT_DISABLE: '1',
                HOST,
                PORT: String(PORT)
            },
            stdio: ['ignore', 'inherit', 'inherit']
        }
    )

    const agents = []
    try {
        await waitUp(PORT)

        const aliceJwt = await login('alice')
        const bobJwt = await login('bob')

        // ── 1. Spawn Alice's agent
        const aliceAgent = spawnAgent({
            token: ALICE_TOKEN,
            namespace: 'alice',
            id: 'laptop',
            name: 'Alice Laptop'
        })
        agents.push(aliceAgent)

        // ── 2. Spawn Bob's agent
        const bobAgent = spawnAgent({
            token: BOB_TOKEN,
            namespace: 'bob',
            id: 'desktop',
            name: 'Bob Desktop'
        })
        agents.push(bobAgent)

        // ── 3. Wait for both to register
        await check('Alice agent registers under namespace=alice', async () => {
            await waitForHostId(aliceJwt, 'laptop')
        })
        await check('Bob agent registers under namespace=bob', async () => {
            await waitForHostId(bobJwt, 'desktop')
        })

        // ── 4. Alice sees ONLY her own host
        await check("Alice's /hosts shows only her agent, not Bob's", async () => {
            const r = await get('/api/hosts', { authorization: `Bearer ${aliceJwt}` })
            const body = await r.json()
            const remoteIds = body.hosts.filter((h) => !h.isLocal).map((h) => h.id).sort()
            if (remoteIds.length !== 1 || remoteIds[0] !== 'laptop') {
                throw new Error(`expected ['laptop'], got ${JSON.stringify(remoteIds)}`)
            }
        })

        // ── 5. Bob sees ONLY his own host
        await check("Bob's /hosts shows only his agent, not Alice's", async () => {
            const r = await get('/api/hosts', { authorization: `Bearer ${bobJwt}` })
            const body = await r.json()
            const remoteIds = body.hosts.filter((h) => !h.isLocal).map((h) => h.id).sort()
            if (remoteIds.length !== 1 || remoteIds[0] !== 'desktop') {
                throw new Error(`expected ['desktop'], got ${JSON.stringify(remoteIds)}`)
            }
        })

        // ── 6. Same hostId in two namespaces would coexist (we'll prove
        //    this by spawning a third agent with hostId=laptop in bob's
        //    namespace and confirming it lands without conflict).
        //
        // (Alice's `laptop` is already registered. Now register Bob's
        // own `laptop` — same hostId string, distinct namespace, must
        // both exist.)
        // Skipping this for now; it would require a 3rd token binding
        // we didn't pre-configure. The unit test in agentRegistry.test.ts
        // already proves the keying via map mechanics.

        // ── 7. Alice cannot probe Bob's host
        await check("Alice cannot list Bob's host sessions (404)", async () => {
            const r = await get('/api/hosts/desktop/sessions', { authorization: `Bearer ${aliceJwt}` })
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })
        await check("Bob cannot list Alice's host sessions (404)", async () => {
            const r = await get('/api/hosts/laptop/sessions', { authorization: `Bearer ${bobJwt}` })
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })

        // ── 7b. Cross-namespace MUTATION isolation. Listing Bob's host as
        //    Alice is a read leak; sending input to Bob's pane is a code-
        //    execution boundary leak. Both must return 404 from /api/hosts.
        //    Each test below targets a different mutation vector, all
        //    under the same Alice→Bob attempt.
        await check("Alice cannot send text to Bob's pane (404)", async () => {
            const r = await postJson(
                '/api/hosts/desktop/panes/main:0.0/input',
                { text: 'rm -rf /', enter: true },
                { authorization: `Bearer ${aliceJwt}` }
            )
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })
        await check("Alice cannot send keys to Bob's pane (404)", async () => {
            const r = await postJson(
                '/api/hosts/desktop/panes/main:0.0/keys',
                { keys: ['Enter'] },
                { authorization: `Bearer ${aliceJwt}` }
            )
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })
        await check("Alice cannot kill a session on Bob's host (404)", async () => {
            const r = await fetch(`http://${HOST}:${PORT}/api/hosts/desktop/sessions/main`, {
                method: 'DELETE',
                headers: { authorization: `Bearer ${aliceJwt}` }
            })
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })
        await check("Alice cannot create a session on Bob's host (404)", async () => {
            const r = await postJson(
                '/api/hosts/desktop/sessions',
                { name: 'pwn' },
                { authorization: `Bearer ${aliceJwt}` }
            )
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })
        await check("Alice cannot mint a WS ticket for Bob's host (404)", async () => {
            const r = await postJson(
                '/api/ws-ticket',
                { hostId: 'desktop', sessionName: 'main' },
                { authorization: `Bearer ${aliceJwt}` }
            )
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })

        // ── 8. Spawn a rogue agent: Alice's token but namespace=eve.
        //    Hub must close the WS with 4401, agent must exit with code 2.
        await check('rogue agent (alice token + eve namespace) exits with code 2', async () => {
            const rogue = spawnAgent({
                token: ALICE_TOKEN,
                namespace: 'eve',
                id: 'laptop',
                name: 'Eve Disguised'
            })
            const exitCode = await new Promise((resolve) => {
                const t = setTimeout(() => {
                    rogue.kill('SIGKILL')
                    resolve('timeout')
                }, 8000)
                rogue.on('exit', (code) => {
                    clearTimeout(t)
                    resolve(code)
                })
            })
            if (exitCode !== 2) throw new Error(`expected exit code 2, got ${exitCode}`)
        })

        // ── 9. After rogue dies, alice/bob isolation still intact
        await check("after rogue probe, Alice's /hosts unchanged", async () => {
            const r = await get('/api/hosts', { authorization: `Bearer ${aliceJwt}` })
            const body = await r.json()
            const remoteIds = body.hosts.filter((h) => !h.isLocal).map((h) => h.id).sort()
            if (remoteIds.length !== 1 || remoteIds[0] !== 'laptop') {
                throw new Error(`expected ['laptop'], got ${JSON.stringify(remoteIds)}`)
            }
        })

        // ── 10. /agent/snapshot is also namespace-filtered
        await check('Alice /agent/snapshot has only her host', async () => {
            const r = await get('/api/agent/snapshot', { authorization: `Bearer ${aliceJwt}` })
            const body = await r.json()
            const remoteIds = body.hosts.filter((h) => !h.isLocal).map((h) => h.id).sort()
            if (remoteIds.length !== 1 || remoteIds[0] !== 'laptop') {
                throw new Error(`expected ['laptop'], got ${JSON.stringify(remoteIds)}`)
            }
        })
    } finally {
        for (const a of agents) {
            try {
                a.kill('SIGTERM')
            } catch {}
        }
        await sleep(200)
        for (const a of agents) {
            try {
                a.kill('SIGKILL')
            } catch {}
        }
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
