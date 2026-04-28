import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { checkPassword, issueToken, verifyJwt } from './auth.js'

describe('auth', () => {
    it('checkPassword matches same password', () => {
        assert.equal(checkPassword('hello', 'hello'), true)
    })
    it('checkPassword rejects wrong password', () => {
        assert.equal(checkPassword('hello', 'world'), false)
    })
    it('checkPassword rejects different length', () => {
        assert.equal(checkPassword('hello', 'hell'), false)
    })
    it('jwt round trip', async () => {
        const secret = new TextEncoder().encode('some-very-secret-value-of-enough-bytes-32')
        const { token, expiresAt } = await issueToken(secret, 60)
        assert.ok(token.length > 20)
        const payload = await verifyJwt(secret, token)
        assert.ok(payload)
        assert.equal(payload!.sub, 'web')
        assert.ok(Math.abs(payload!.exp - expiresAt) < 2)
    })
    it('jwt rejects wrong secret', async () => {
        const s1 = new TextEncoder().encode('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
        const s2 = new TextEncoder().encode('bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
        const { token } = await issueToken(s1, 60)
        assert.equal(await verifyJwt(s2, token), null)
    })
})
