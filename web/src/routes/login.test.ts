import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { generateAndPersistUserToken, USER_TOKEN_LS_KEY } from './login'

/**
 * The behavior under test: clicking "Generate" on the login form must
 * persist the freshly-minted user token to localStorage *immediately*,
 * not wait for a successful submit. The pre-fix code wrote the token
 * to React state but only persisted on the submit-success path —
 * meaning a 401 on first login (wrong server token) silently lost the
 * generated identity. See login.tsx for the rationale.
 *
 * We exercise the pure helper rather than the whole component: this
 * web workspace runs node-test without jsdom, so React rendering is
 * out of reach. The helper is the load-bearing piece anyway; the rest
 * of <LoginPage> is wiring around it.
 */
function makeFakeStorage(): Pick<Storage, 'setItem'> & { writes: Array<[string, string]> } {
    const writes: Array<[string, string]> = []
    return {
        writes,
        setItem(key: string, value: string) {
            writes.push([key, value])
        }
    }
}

describe('generateAndPersistUserToken', () => {
    it('persists a fresh token to localStorage on every call', () => {
        const storage = makeFakeStorage()
        const t1 = generateAndPersistUserToken(storage)
        assert.equal(typeof t1, 'string')
        assert.match(t1, /^[a-f0-9]{64}$/, 'generated token should be 64 hex chars')
        assert.deepEqual(storage.writes, [[USER_TOKEN_LS_KEY, t1]])
    })

    it('produces distinct tokens across calls (entropy sanity check)', () => {
        const storage = makeFakeStorage()
        const t1 = generateAndPersistUserToken(storage)
        const t2 = generateAndPersistUserToken(storage)
        assert.notEqual(t1, t2, 'two calls must not collide')
        assert.equal(storage.writes.length, 2)
        assert.equal(storage.writes[0][1], t1)
        assert.equal(storage.writes[1][1], t2)
    })

    it('uses the canonical localStorage key the rest of the app reads from', () => {
        // Pin the key so a refactor that renames the constant in login.tsx
        // doesn't silently invalidate everyone's saved user token (the
        // initial-state hook reads `localStorage.getItem(USER_TOKEN_LS_KEY)`
        // — a typo there or here would orphan every user's identity on
        // the next deploy).
        assert.equal(USER_TOKEN_LS_KEY, 'tmuxd:userToken')
    })

    it('writes the token BEFORE returning, not after', () => {
        // Regression guard for the original bug: the old code returned the
        // token without writing, leaving the persist for the submit-success
        // handler. If a future refactor splits this back into "compute" +
        // "persist later" steps, this test will catch the gap by asserting
        // a write is observable as soon as the helper returns.
        const storage = makeFakeStorage()
        const before = storage.writes.length
        const token = generateAndPersistUserToken(storage)
        const after = storage.writes.length
        assert.equal(after - before, 1, 'exactly one persist per call')
        assert.equal(storage.writes[storage.writes.length - 1][1], token)
    })
})
