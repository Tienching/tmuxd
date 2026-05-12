import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { DEFAULT_NAMESPACE } from '@tmuxd/shared'
import { createAuthRoutes } from './auth.js'
import { verifyJwt } from '../auth.js'

const TEST_SECRET = new TextEncoder().encode('test-secret-of-at-least-32-bytes-long-OK')

function postJson(app: Hono, path: string, body: unknown): Promise<Response> {
    return app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    })
}

function makeApp() {
    const app = new Hono()
    app.route(
        '/api',
        createAuthRoutes({ token: 'team-secret-xyz', jwtSecret: TEST_SECRET })
    )
    return app
}

describe('auth route', () => {
    it('issues a JWT with the namespace from <token>:<ns>', async () => {
        const res = await postJson(makeApp(), '/api/auth', { token: 'team-secret-xyz:alice' })
        assert.equal(res.status, 200)
        const body = (await res.json()) as { token: string }
        const decoded = await verifyJwt(TEST_SECRET, body.token)
        assert.ok(decoded)
        assert.equal(decoded!.ns, 'alice')
    })

    it('issues different namespaces to different users', async () => {
        const aliceRes = await postJson(makeApp(), '/api/auth', { token: 'team-secret-xyz:alice' })
        const bobRes = await postJson(makeApp(), '/api/auth', { token: 'team-secret-xyz:bob' })
        const a = (await aliceRes.json()) as { token: string }
        const b = (await bobRes.json()) as { token: string }
        const aDec = await verifyJwt(TEST_SECRET, a.token)
        const bDec = await verifyJwt(TEST_SECRET, b.token)
        assert.equal(aDec!.ns, 'alice')
        assert.equal(bDec!.ns, 'bob')
    })

    it('falls back to DEFAULT_NAMESPACE when no `:` is present (single-user form)', async () => {
        // The single-user UX is just a token with no `:namespace` suffix.
        // parseAccessToken yields `{ baseToken: secret, ns: default }`.
        const res = await postJson(makeApp(), '/api/auth', { token: 'team-secret-xyz' })
        assert.equal(res.status, 200)
        const body = (await res.json()) as { token: string }
        const decoded = await verifyJwt(TEST_SECRET, body.token)
        assert.equal(decoded!.ns, DEFAULT_NAMESPACE)
    })

    it('rejects wrong token with 401', async () => {
        const res = await postJson(makeApp(), '/api/auth', { token: 'wrong-secret:alice' })
        assert.equal(res.status, 401)
    })

    it('rejects malformed token (empty namespace)', async () => {
        const res = await postJson(makeApp(), '/api/auth', { token: 'team-secret-xyz:' })
        assert.equal(res.status, 401)
    })

    it('rejects malformed token (invalid namespace charset)', async () => {
        const res = await postJson(makeApp(), '/api/auth', { token: 'team-secret-xyz:has space' })
        assert.equal(res.status, 401)
    })

    it('rejects when body is missing the token field', async () => {
        const res = await postJson(makeApp(), '/api/auth', { password: 'team-secret-xyz' })
        assert.equal(res.status, 400)
    })

    it('rate-limits after 5 bad tokens from the same client IP (returns 429)', async () => {
        // Use a unique ip header per test so the module-level bucket
        // doesn't collide with other test cases. The route reads the
        // first `x-forwarded-for` entry (or `x-real-ip`) as the client
        // key, so seeding a fresh value isolates this run.
        const ip = `198.51.100.${Math.floor(Math.random() * 250) + 2}`
        const headers = { 'content-type': 'application/json', 'x-real-ip': ip }
        const app = makeApp()
        // 5 failing attempts → still 401 each time, but bucket fills up.
        for (let i = 0; i < 5; i++) {
            const r = await app.request('/api/auth', {
                method: 'POST',
                headers,
                body: JSON.stringify({ token: 'wrong-base:alice' })
            })
            assert.equal(r.status, 401, `attempt ${i + 1} expected 401`)
        }
        // 6th attempt — even with the CORRECT token — must be locked out
        // because the lock is on the client IP, not the credential.
        const locked = await app.request('/api/auth', {
            method: 'POST',
            headers,
            body: JSON.stringify({ token: 'team-secret-xyz:alice' })
        })
        assert.equal(locked.status, 429, 'rate-limited request should return 429')
        const body = (await locked.json()) as { error: string }
        assert.equal(body.error, 'rate_limited')
    })

    it('clears the failure bucket on successful login', async () => {
        const ip = `203.0.113.${Math.floor(Math.random() * 250) + 2}`
        const headers = { 'content-type': 'application/json', 'x-real-ip': ip }
        const app = makeApp()
        // 3 fails, then a success → bucket should reset.
        for (let i = 0; i < 3; i++) {
            const r = await app.request('/api/auth', {
                method: 'POST',
                headers,
                body: JSON.stringify({ token: 'wrong-base:alice' })
            })
            assert.equal(r.status, 401)
        }
        const ok = await app.request('/api/auth', {
            method: 'POST',
            headers,
            body: JSON.stringify({ token: 'team-secret-xyz:alice' })
        })
        assert.equal(ok.status, 200, 'correct token should succeed')
        // Now we can fail another 3 times without being locked out.
        for (let i = 0; i < 3; i++) {
            const r = await app.request('/api/auth', {
                method: 'POST',
                headers,
                body: JSON.stringify({ token: 'wrong-base:alice' })
            })
            assert.equal(r.status, 401, `post-success attempt ${i + 1} expected 401, not 429`)
        }
    })
})
