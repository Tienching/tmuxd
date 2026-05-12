import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { computeNamespace, generateUserToken } from '@tmuxd/shared'
import { issueToken, verifyJwt } from './auth.js'

describe('auth', () => {
    it('jwt round trip', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const ns = await computeNamespace('user-token-aaaaaaaaaaaaaa')
        const { token, expiresAt } = await issueToken(secret, ns, 60)
        assert.ok(token.length > 20)
        const payload = await verifyJwt(secret, token)
        assert.ok(payload)
        assert.equal(payload!.sub, 'web')
        assert.equal(payload!.ns, ns)
        assert.ok(Math.abs(payload!.exp - expiresAt) < 2)
    })

    it('jwt rejects wrong secret', async () => {
        const s1 = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        const s2 = new TextEncoder().encode('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        const ns = await computeNamespace('user-token')
        const { token } = await issueToken(s1, ns, 60)
        assert.equal(await verifyJwt(s2, token), null)
    })

    it('issueToken rejects invalid namespace', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        // namespaces must be 16 hex chars; anything else is rejected.
        await assert.rejects(() => issueToken(secret, 'has-space-not-hex', 60), /Invalid namespace/)
        await assert.rejects(() => issueToken(secret, '', 60), /Invalid namespace/)
        await assert.rejects(() => issueToken(secret, 'TOOSHORT', 60), /Invalid namespace/)
        await assert.rejects(() => issueToken(secret, 'a'.repeat(17), 60), /Invalid namespace/)
    })

    it('verifyJwt rejects non-string ns claim', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const { SignJWT } = await import('jose')
        const now = Math.floor(Date.now() / 1000)
        const bad = await new SignJWT({ ns: 123 as unknown as string })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject('web')
            .setIssuedAt(now)
            .setExpirationTime(now + 60)
            .sign(secret)
        assert.equal(await verifyJwt(secret, bad), null)
    })

    it('verifyJwt rejects invalid-shape ns claim', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const { SignJWT } = await import('jose')
        const now = Math.floor(Date.now() / 1000)
        const bad = await new SignJWT({ ns: 'alice' }) // not 16-hex
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject('web')
            .setIssuedAt(now)
            .setExpirationTime(now + 60)
            .sign(secret)
        assert.equal(await verifyJwt(secret, bad), null)
    })

    it('verifyJwt rejects ns-less tokens', async () => {
        // Old tokens without ns are no longer accepted; the new model
        // ALWAYS stamps namespace at issuance from a hashed user token.
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const { SignJWT } = await import('jose')
        const now = Math.floor(Date.now() / 1000)
        const legacy = await new SignJWT({})
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject('web')
            .setIssuedAt(now)
            .setExpirationTime(now + 60)
            .sign(secret)
        assert.equal(await verifyJwt(secret, legacy), null)
    })
})

describe('computeNamespace', () => {
    it('returns 16 lowercase hex chars', async () => {
        const ns = await computeNamespace('hello')
        assert.match(ns, /^[a-f0-9]{16}$/)
    })

    it('is deterministic for the same user-token', async () => {
        const a = await computeNamespace('alice-secret')
        const b = await computeNamespace('alice-secret')
        assert.equal(a, b)
    })

    it('different inputs → different namespaces', async () => {
        const a = await computeNamespace('alice')
        const b = await computeNamespace('bob')
        assert.notEqual(a, b)
    })

    it('trims whitespace before hashing', async () => {
        const a = await computeNamespace('alice')
        const b = await computeNamespace('  alice  ')
        assert.equal(a, b)
    })

    it('rejects empty input', async () => {
        await assert.rejects(() => computeNamespace(''), /must not be empty/)
        await assert.rejects(() => computeNamespace('   '), /must not be empty/)
    })

    it('rejects non-string input', async () => {
        await assert.rejects(
            () => computeNamespace(123 as unknown as string),
            /must be a string/
        )
    })
})

describe('generateUserToken', () => {
    it('returns 64 hex chars (32 bytes)', () => {
        const t = generateUserToken()
        assert.match(t, /^[a-f0-9]{64}$/)
    })

    it('returns different tokens each call', () => {
        const a = generateUserToken()
        const b = generateUserToken()
        assert.notEqual(a, b)
    })
})
