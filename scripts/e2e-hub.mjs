#!/usr/bin/env node
/**
 * E2E: hub-only mode + trust-model namespace isolation through a real
 * spawned `tmuxd` server.
 *
 * Boots a tmuxd hub configured for hub-only multi-user operation:
 *   TMUXD_HUB_ONLY=1
 *   TMUXD_SERVER_TOKEN=<secret>
 *
 * Then drives two real HTTP clients logged in with distinct user
 * tokens and asserts:
 *   - The server token is required.
 *   - sha256(userToken) → namespace; same userToken → same namespace.
 *   - Different userTokens → distinct, isolated namespaces.
 *   - Hub-only refuses local routes.
 *
 * Used by: npm run e2e:hub
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'

/**
 * Mirror of `shared/src/identity.ts#computeNamespace` for use in plain
 * `.mjs` scripts (we can't import the TS module — `shared/` has no
 * compiled emit, only typecheck). Keep the implementation in lockstep
 * with the production version: sha256(userToken), 16 lowercase hex
 * chars. The shared module's unit tests pin that contract.
 */
function computeNamespace(userToken) {
    const trimmed = String(userToken).trim()
    if (!trimmed) throw new Error('userToken must not be empty')
    return createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 16)
}

const HOST = '127.0.0.1'
const PORT = Number(process.env.TMUXD_E2E_PORT || 17687)
const SERVER_TOKEN = 'e2e-hub-server-token-' + Math.random().toString(36).slice(2)
const ALICE_USER_TOKEN = 'alice-user-token-' + Math.random().toString(36).slice(2)
const BOB_USER_TOKEN = 'bob-user-token-' + Math.random().toString(36).slice(2)
const TMUXD_HOME = `/tmp/tmuxd-e2e-hub-${process.pid}`

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

async function postJson(path, body, headers = {}) {
    return fetch(`http://${HOST}:${PORT}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    })
}

async function get(path, headers = {}) {
    return fetch(`http://${HOST}:${PORT}${path}`, { headers })
}

function decodeJwtNs(token) {
    const parts = token.split('.')
    if (parts.length !== 3) throw new Error(`malformed JWT: ${parts.length} segments`)
    const padded = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const json = Buffer.from(padded + '==='.slice(0, (4 - (padded.length % 4)) % 4), 'base64').toString('utf8')
    const obj = JSON.parse(json)
    if (typeof obj.ns !== 'string') throw new Error(`JWT missing ns claim: ${json}`)
    return obj.ns
}

async function main() {
    await rm(TMUXD_HOME, { recursive: true, force: true }).catch(() => {})

    const server = spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/index.ts'],
        {
            env: {
                ...process.env,
                TMUXD_SERVER_TOKEN: SERVER_TOKEN,
                TMUXD_HUB_ONLY: '1',
                TMUXD_HOME,
                TMUXD_AUDIT_DISABLE: '1', // keep test stderr clean
                HOST,
                PORT: String(PORT)
            },
            stdio: ['ignore', 'inherit', 'inherit']
        }
    )

    try {
        await waitUp(PORT)

        const aliceNs = computeNamespace(ALICE_USER_TOKEN)
        const bobNs = computeNamespace(BOB_USER_TOKEN)

        // ── 1. Wrong server token rejected
        await check('wrong serverToken → 401', async () => {
            const r = await postJson('/api/auth', {
                serverToken: 'definitely-wrong-secret',
                userToken: ALICE_USER_TOKEN
            })
            if (r.status !== 401) throw new Error(`status ${r.status}`)
        })

        // ── 2. Both fields required
        await check('login without userToken → 400', async () => {
            const r = await postJson('/api/auth', { serverToken: SERVER_TOKEN })
            if (r.status !== 400) throw new Error(`status ${r.status}`)
        })
        await check('login without serverToken → 400', async () => {
            const r = await postJson('/api/auth', { userToken: ALICE_USER_TOKEN })
            if (r.status !== 400) throw new Error(`status ${r.status}`)
        })
        await check('login with old { token } shape → 400', async () => {
            const r = await postJson('/api/auth', { token: SERVER_TOKEN })
            if (r.status !== 400) throw new Error(`status ${r.status}`)
        })

        // ── 3. Alice login → JWT(ns=sha256(ALICE_USER_TOKEN))
        let aliceToken = ''
        await check('Alice logs in → JWT carries her hashed namespace', async () => {
            const r = await postJson('/api/auth', {
                serverToken: SERVER_TOKEN,
                userToken: ALICE_USER_TOKEN
            })
            if (r.status !== 200) throw new Error(`status ${r.status}`)
            const body = await r.json()
            if (body.namespace !== aliceNs) {
                throw new Error(`server returned ns=${body.namespace}, expected ${aliceNs}`)
            }
            const ns = decodeJwtNs(body.token)
            if (ns !== aliceNs) throw new Error(`JWT ns=${ns}, expected ${aliceNs}`)
            aliceToken = body.token
        })

        // ── 4. Bob login → JWT(ns=sha256(BOB_USER_TOKEN)), distinct from Alice
        let bobToken = ''
        await check('Bob logs in → JWT distinct from Alice', async () => {
            const r = await postJson('/api/auth', {
                serverToken: SERVER_TOKEN,
                userToken: BOB_USER_TOKEN
            })
            if (r.status !== 200) throw new Error(`status ${r.status}`)
            const body = await r.json()
            if (body.namespace !== bobNs) throw new Error(`ns=${body.namespace}, expected ${bobNs}`)
            const ns = decodeJwtNs(body.token)
            if (ns !== bobNs) throw new Error(`JWT ns=${ns}`)
            bobToken = body.token
            if (bobToken === aliceToken) throw new Error('alice and bob got identical JWTs')
            if (aliceNs === bobNs) throw new Error('hashed namespaces collided unexpectedly')
        })

        // ── 5. Same userToken → same namespace (deterministic hash)
        await check('Same userToken twice → same namespace', async () => {
            const r1 = await postJson('/api/auth', {
                serverToken: SERVER_TOKEN,
                userToken: ALICE_USER_TOKEN
            })
            const r2 = await postJson('/api/auth', {
                serverToken: SERVER_TOKEN,
                userToken: ALICE_USER_TOKEN
            })
            const b1 = await r1.json()
            const b2 = await r2.json()
            if (b1.namespace !== b2.namespace) {
                throw new Error(`namespace not deterministic: ${b1.namespace} vs ${b2.namespace}`)
            }
        })

        // ── 6. /api/hosts shows zero hosts when no agents connected
        await check('Alice GET /hosts (hub-only, no agents) → empty list', async () => {
            const r = await get('/api/hosts', { authorization: `Bearer ${aliceToken}` })
            if (r.status !== 200) throw new Error(`status ${r.status}`)
            const body = await r.json()
            if (!Array.isArray(body.hosts)) throw new Error('hosts not an array')
            const localPresent = body.hosts.some((h) => h.id === 'local')
            if (localPresent) throw new Error('local host should be hidden in hub-only mode')
        })

        // ── 7. Hub-only: POST /sessions returns 403 local_host_disabled
        await check('POST /sessions → 403 local_host_disabled (hub-only)', async () => {
            const r = await postJson(
                '/api/sessions',
                { name: 'evil-session' },
                { authorization: `Bearer ${aliceToken}` }
            )
            if (r.status !== 403) throw new Error(`status ${r.status}`)
            const body = await r.json()
            if (body.error !== 'local_host_disabled') throw new Error(`error=${body.error}`)
        })

        // ── 8. Hub-only: POST /hosts/local/sessions returns 403
        await check('POST /hosts/local/sessions → 403 local_host_disabled', async () => {
            const r = await postJson(
                '/api/hosts/local/sessions',
                { name: 'still-evil' },
                { authorization: `Bearer ${aliceToken}` }
            )
            if (r.status !== 403) throw new Error(`status ${r.status}`)
        })

        // ── 9. ws-ticket for nonexistent remote host → 404
        await check('Alice ws-ticket for nonexistent host → 404', async () => {
            const r = await postJson(
                '/api/ws-ticket',
                { hostId: 'bob-desktop', sessionName: 'main' },
                { authorization: `Bearer ${aliceToken}` }
            )
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })

        // ── 10. Alice cannot list any host that doesn't live in her ns
        await check('Alice GET /hosts/bob-desktop/sessions → 404', async () => {
            const r = await get('/api/hosts/bob-desktop/sessions', {
                authorization: `Bearer ${aliceToken}`
            })
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })

        // ── 11. Both users can hit /agent/snapshot independently
        await check('Alice and Bob each get an /agent/snapshot', async () => {
            const ar = await get('/api/agent/snapshot', { authorization: `Bearer ${aliceToken}` })
            const br = await get('/api/agent/snapshot', { authorization: `Bearer ${bobToken}` })
            if (ar.status !== 200 || br.status !== 200) {
                throw new Error(`alice=${ar.status} bob=${br.status}`)
            }
            const aBody = await ar.json()
            const bBody = await br.json()
            // No agents have connected, no local host in hub-only mode → both
            // see zero hosts.
            if (aBody.hosts.length !== 0 || bBody.hosts.length !== 0) {
                throw new Error(`expected zero hosts, alice=${aBody.hosts.length} bob=${bBody.hosts.length}`)
            }
        })
    } finally {
        server.kill('SIGTERM')
        await new Promise((r) => {
            const t = setTimeout(() => {
                try {
                    server.kill('SIGKILL')
                } catch {}
                r()
            }, 3000)
            server.on('exit', () => {
                clearTimeout(t)
                r()
            })
        })
        await rm(TMUXD_HOME, { recursive: true, force: true }).catch(() => {})
    }

    console.log('\n---')
    console.log(`PASS: ${passes.length}   FAIL: ${fails.length}`)
    if (fails.length) {
        process.exit(1)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(2)
})
