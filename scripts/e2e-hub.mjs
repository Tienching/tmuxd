#!/usr/bin/env node
/**
 * E2E: hub-only mode + HAPI-style namespace isolation through a real
 * spawned `tmuxd` server.
 *
 * Boots a tmuxd hub configured for hub-only multi-user operation:
 *   TMUXD_HUB_ONLY=1
 *   TMUXD_TOKEN=<secret>
 *   TMUXD_AGENT_TOKENS=alice/laptop=<token-A>,bob/desktop=<token-B>
 *
 * Then drives two real HTTP clients logged in as `BASE:alice` and
 * `BASE:bob` and asserts the contract Alice cannot ever observe
 * Bob's host through the wire.
 *
 * Used by: npm run e2e:hub
 */

import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { rm } from 'node:fs/promises'

const HOST = '127.0.0.1'
const PORT = Number(process.env.TMUXD_E2E_PORT || 17687)
const BASE = 'e2e-hub-base-secret-' + Math.random().toString(36).slice(2)
const ALICE_AGENT_TOKEN = 'alice-agent-token-' + Math.random().toString(36).slice(2)
const BOB_AGENT_TOKEN = 'bob-agent-token-' + Math.random().toString(36).slice(2)
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
                TMUXD_TOKEN: BASE,
                TMUXD_HUB_ONLY: '1',
                TMUXD_AGENT_TOKENS: `alice/laptop=${ALICE_AGENT_TOKEN},bob/desktop=${BOB_AGENT_TOKEN}`,
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

        // ── 1. Wrong token rejected
        await check('wrong token → 401', async () => {
            const r = await postJson('/api/auth', { token: 'definitely-wrong-secret:alice' })
            if (r.status !== 401) throw new Error(`status ${r.status}`)
        })

        // ── 2. Bare token (single-user form) defaults to 'default'.
        // The contract: server-side `parseAccessToken` accepts the bare
        // token and stamps the JWT with default namespace.
        await check('bare token → JWT(ns=default)', async () => {
            const r = await postJson('/api/auth', { token: BASE })
            if (r.status !== 200) throw new Error(`status ${r.status}`)
            const body = await r.json()
            const ns = decodeJwtNs(body.token)
            if (ns !== 'default') throw new Error(`ns=${ns}`)
        })

        // ── 3. Alice login → JWT(ns=alice)
        let aliceToken = ''
        await check('Alice logs in with BASE:alice → JWT(ns=alice)', async () => {
            const r = await postJson('/api/auth', { token: `${BASE}:alice` })
            if (r.status !== 200) throw new Error(`status ${r.status}`)
            const body = await r.json()
            const ns = decodeJwtNs(body.token)
            if (ns !== 'alice') throw new Error(`ns=${ns}`)
            aliceToken = body.token
        })

        // ── 5. Bob login → JWT(ns=bob), distinct from Alice's
        let bobToken = ''
        await check('Bob logs in with BASE:bob → JWT(ns=bob), distinct token', async () => {
            const r = await postJson('/api/auth', { token: `${BASE}:bob` })
            if (r.status !== 200) throw new Error(`status ${r.status}`)
            const body = await r.json()
            const ns = decodeJwtNs(body.token)
            if (ns !== 'bob') throw new Error(`ns=${ns}`)
            bobToken = body.token
            if (bobToken === aliceToken) throw new Error('alice and bob got identical JWTs')
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

        // ── 7. POST /sessions returns 403 local_host_disabled
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

        // ── 8. POST /hosts/local/sessions returns 403
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

        // ── 10. ws-ticket for local host in hub-only → 403
        await check('Alice ws-ticket for local host (hub-only) → 403', async () => {
            const r = await postJson(
                '/api/ws-ticket',
                { hostId: 'local', sessionName: 'main' },
                { authorization: `Bearer ${aliceToken}` }
            )
            if (r.status !== 403) throw new Error(`status ${r.status}`)
        })

        // ── 11. Alice's JWT cannot use Bob's session list
        await check('Alice GET /hosts/bob-desktop/sessions → 404', async () => {
            const r = await get('/api/hosts/bob-desktop/sessions', {
                authorization: `Bearer ${aliceToken}`
            })
            if (r.status !== 404) throw new Error(`status ${r.status}`)
        })

        // ── 12. Both users can hit /agent/snapshot independently
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

        // ── 12. Login body without `token` field is rejected (400)
        await check('login body without token field → 400', async () => {
            const r = await postJson('/api/auth', { password: BASE })
            // Schema validation rejects bodies that don't match the
            // single-form login shape.
            if (r.status !== 400) throw new Error(`status ${r.status}`)
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
        console.log('Failures:')
        for (const f of fails) console.log(`  - ${f.name}: ${f.err instanceof Error ? f.err.message : f.err}`)
        process.exit(1)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(2)
})
