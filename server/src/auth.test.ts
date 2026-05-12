import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_NAMESPACE } from '@tmuxd/shared'
import { issueToken, parseAccessToken, verifyJwt } from './auth.js'

describe('auth', () => {
    it('jwt round trip (default namespace)', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const { token, expiresAt } = await issueToken(secret, 60)
        assert.ok(token.length > 20)
        const payload = await verifyJwt(secret, token)
        assert.ok(payload)
        assert.equal(payload!.sub, 'web')
        assert.equal(payload!.ns, DEFAULT_NAMESPACE)
        assert.ok(Math.abs(payload!.exp - expiresAt) < 2)
    })
    it('jwt round trip with explicit namespace', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const { token } = await issueToken(secret, 60, 'alice')
        const payload = await verifyJwt(secret, token)
        assert.ok(payload)
        assert.equal(payload!.ns, 'alice')
    })
    it('jwt rejects wrong secret', async () => {
        const s1 = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        const s2 = new TextEncoder().encode('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        const { token } = await issueToken(s1, 60)
        assert.equal(await verifyJwt(s2, token), null)
    })
    it('issueToken rejects invalid namespace', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        await assert.rejects(() => issueToken(secret, 60, 'has a space'), /Invalid namespace/)
        await assert.rejects(() => issueToken(secret, 60, ''), /Invalid namespace/)
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
    it('verifyJwt rejects invalid-charset ns claim', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const { SignJWT } = await import('jose')
        const now = Math.floor(Date.now() / 1000)
        const bad = await new SignJWT({ ns: 'has space' })
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject('web')
            .setIssuedAt(now)
            .setExpirationTime(now + 60)
            .sign(secret)
        assert.equal(await verifyJwt(secret, bad), null)
    })
    it('verifyJwt accepts legacy ns-less tokens as default', async () => {
        // Simulate a pre-upgrade token by signing without the ns claim.
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const { SignJWT } = await import('jose')
        const now = Math.floor(Date.now() / 1000)
        const legacy = await new SignJWT({})
            .setProtectedHeader({ alg: 'HS256' })
            .setSubject('web')
            .setIssuedAt(now)
            .setExpirationTime(now + 60)
            .sign(secret)
        const payload = await verifyJwt(secret, legacy)
        assert.ok(payload)
        assert.equal(payload!.ns, DEFAULT_NAMESPACE)
    })
})

describe('parseAccessToken', () => {
    it('parses base:namespace', () => {
        assert.deepEqual(parseAccessToken('secret:alice'), { baseToken: 'secret', namespace: 'alice' })
    })
    it('defaults to DEFAULT_NAMESPACE when no colon', () => {
        assert.deepEqual(parseAccessToken('secret'), { baseToken: 'secret', namespace: DEFAULT_NAMESPACE })
    })
    it('splits on LAST colon (last-wins, like HAPI)', () => {
        // Base token may contain `:`; only the final `:` separates namespace.
        assert.deepEqual(
            parseAccessToken('prefix:middle:suffix:alice'),
            { baseToken: 'prefix:middle:suffix', namespace: 'alice' }
        )
    })
    it('rejects empty input', () => {
        assert.equal(parseAccessToken(''), null)
    })
    it('rejects whitespace-only input', () => {
        assert.equal(parseAccessToken('   '), null)
    })
    it('rejects surrounding whitespace', () => {
        // Strict: the caller must trim before passing. Avoids accidentally
        // accepting token values that were mis-copied with stray whitespace.
        assert.equal(parseAccessToken(' secret:alice'), null)
        assert.equal(parseAccessToken('secret:alice '), null)
    })
    it('rejects empty base token before colon', () => {
        assert.equal(parseAccessToken(':alice'), null)
    })
    it('rejects empty namespace after colon', () => {
        assert.equal(parseAccessToken('secret:'), null)
    })
    it('rejects namespace with invalid charset', () => {
        assert.equal(parseAccessToken('secret:has space'), null)
        assert.equal(parseAccessToken('secret:has/slash'), null)
        assert.equal(parseAccessToken('secret:has!bang'), null)
    })
    it('inner colons go to the base token, not the namespace', () => {
        // `lastIndexOf(':')` wins: `secret:has:colon` → base=`secret:has`, ns=`colon`.
        assert.deepEqual(
            parseAccessToken('secret:has:colon'),
            { baseToken: 'secret:has', namespace: 'colon' }
        )
    })
    it('accepts valid namespace charset variations', () => {
        assert.deepEqual(parseAccessToken('secret:alice.bob'), { baseToken: 'secret', namespace: 'alice.bob' })
        assert.deepEqual(parseAccessToken('secret:team-1'), { baseToken: 'secret', namespace: 'team-1' })
        assert.deepEqual(parseAccessToken('secret:team_1'), { baseToken: 'secret', namespace: 'team_1' })
        assert.deepEqual(parseAccessToken('secret:A1'), { baseToken: 'secret', namespace: 'A1' })
    })
    it('rejects namespace longer than 64 chars', () => {
        const ns = 'a'.repeat(65)
        assert.equal(parseAccessToken(`secret:${ns}`), null)
    })
    it('rejects non-string input', () => {
        assert.equal(parseAccessToken(undefined as unknown as string), null)
        assert.equal(parseAccessToken(null as unknown as string), null)
        assert.equal(parseAccessToken(123 as unknown as string), null)
    })
})
