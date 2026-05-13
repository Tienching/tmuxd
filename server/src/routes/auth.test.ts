import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { computeNamespace } from '@tmuxd/shared'
import { createAuthRoutes } from './auth.js'
import { verifyJwt } from '../auth.js'

const TEST_SECRET = new TextEncoder().encode('test-secret-of-at-least-32-bytes-long-OK')
const SERVER_TOKEN = 'team-secret-xyz'

function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
    return app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    })
}

function makeApp() {
    const app = new Hono()
    app.route('/api', createAuthRoutes({ serverToken: SERVER_TOKEN, jwtSecret: TEST_SECRET }))
    return app
}

describe('auth route', () => {
    it('issues a JWT with namespace = sha256(userToken)', async () => {
        const res = await postJson(makeApp(), '/api/auth', {
            serverToken: SERVER_TOKEN,
            userToken: 'alice-personal-token'
        })
        assert.equal(res.status, 200)
        const body = (await res.json()) as { token: string; namespace: string }
        const expectedNs = await computeNamespace('alice-personal-token')
        assert.equal(body.namespace, expectedNs)
        const decoded = await verifyJwt(TEST_SECRET, body.token)
        assert.ok(decoded)
        assert.equal(decoded!.ns, expectedNs)
    })

    it('different users get different namespaces', async () => {
        const aliceRes = await postJson(makeApp(), '/api/auth', {
            serverToken: SERVER_TOKEN,
            userToken: 'alice-token'
        })
        const bobRes = await postJson(makeApp(), '/api/auth', {
            serverToken: SERVER_TOKEN,
            userToken: 'bob-token'
        })
        const a = (await aliceRes.json()) as { namespace: string }
        const b = (await bobRes.json()) as { namespace: string }
        assert.notEqual(a.namespace, b.namespace)
    })

    it('same user-token always lands in the same namespace', async () => {
        const r1 = await postJson(makeApp(), '/api/auth', {
            serverToken: SERVER_TOKEN,
            userToken: 'alice-token'
        })
        const r2 = await postJson(makeApp(), '/api/auth', {
            serverToken: SERVER_TOKEN,
            userToken: 'alice-token'
        })
        const a = (await r1.json()) as { namespace: string }
        const b = (await r2.json()) as { namespace: string }
        assert.equal(a.namespace, b.namespace)
    })

    it('rejects wrong serverToken with 401', async () => {
        const res = await postJson(makeApp(), '/api/auth', {
            serverToken: 'WRONG',
            userToken: 'alice'
        })
        assert.equal(res.status, 401)
    })

    it('rejects when body is missing the userToken field', async () => {
        const res = await postJson(makeApp(), '/api/auth', { serverToken: SERVER_TOKEN })
        assert.equal(res.status, 400)
    })

    it('rejects when body is missing the serverToken field', async () => {
        const res = await postJson(makeApp(), '/api/auth', { userToken: 'alice' })
        assert.equal(res.status, 400)
    })

    it('rejects when body sends old { token } shape', async () => {
        const res = await postJson(makeApp(), '/api/auth', { token: SERVER_TOKEN })
        assert.equal(res.status, 400)
    })

    it('rejects when body mixes old + new shapes (loginSchema is .strict())', async () => {
        // A buggy migration that left a stale `token` field alongside the
        // correct `{serverToken, userToken}` would silently work without
        // .strict() — and break later once the legacy field gets sanitized.
        // .strict() makes that breakage immediate and obvious.
        const res = await postJson(makeApp(), '/api/auth', {
            token: SERVER_TOKEN,
            serverToken: SERVER_TOKEN,
            userToken: 'alice-token'
        })
        assert.equal(res.status, 400)
    })

    it('rejects unknown extra fields in the body', async () => {
        const res = await postJson(makeApp(), '/api/auth', {
            serverToken: SERVER_TOKEN,
            userToken: 'alice-token',
            namespace: 'aaaaaaaaaaaaaaaa' // attacker tries to self-declare ns
        })
        assert.equal(
            res.status,
            400,
            'extra ns field must be rejected — namespace is server-derived only'
        )
    })

    it('rate-limits after 5 bad serverTokens from the same client IP (returns 429)', async () => {
        const ip = `198.51.100.${Math.floor(Math.random() * 250) + 2}`
        const headers = { 'content-type': 'application/json', 'x-real-ip': ip }
        const app = makeApp()
        for (let i = 0; i < 5; i++) {
            const r = await app.request('/api/auth', {
                method: 'POST',
                headers,
                body: JSON.stringify({ serverToken: 'WRONG', userToken: 'alice' })
            })
            assert.equal(r.status, 401, `attempt ${i + 1} expected 401`)
        }
        // 6th attempt — even with the CORRECT serverToken — must be locked
        // out because the lock is on the client IP, not the credential.
        const locked = await app.request('/api/auth', {
            method: 'POST',
            headers,
            body: JSON.stringify({ serverToken: SERVER_TOKEN, userToken: 'alice' })
        })
        assert.equal(locked.status, 429, 'rate-limited request should return 429')
        const body = (await locked.json()) as { error: string }
        assert.equal(body.error, 'rate_limited')
    })

    it('clears the failure bucket on successful login', async () => {
        const ip = `203.0.113.${Math.floor(Math.random() * 250) + 2}`
        const headers = { 'content-type': 'application/json', 'x-real-ip': ip }
        const app = makeApp()
        for (let i = 0; i < 3; i++) {
            const r = await app.request('/api/auth', {
                method: 'POST',
                headers,
                body: JSON.stringify({ serverToken: 'WRONG', userToken: 'alice' })
            })
            assert.equal(r.status, 401)
        }
        const ok = await app.request('/api/auth', {
            method: 'POST',
            headers,
            body: JSON.stringify({ serverToken: SERVER_TOKEN, userToken: 'alice' })
        })
        assert.equal(ok.status, 200, 'correct serverToken should succeed')
        for (let i = 0; i < 3; i++) {
            const r = await app.request('/api/auth', {
                method: 'POST',
                headers,
                body: JSON.stringify({ serverToken: 'WRONG', userToken: 'alice' })
            })
            assert.equal(r.status, 401, `post-success attempt ${i + 1} expected 401, not 429`)
        }
    })
})
