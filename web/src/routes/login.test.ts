import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { USER_TOKEN_LS_KEY } from './login'

/**
 * The web login form deliberately has NO "Generate user token" button —
 * generation belongs in the CLI, where the freshly-minted token can be
 * captured into stderr → password manager. A web-side Generate would
 * invite users on a second device to click it, get a fresh token, and
 * silently land in a brand-new namespace where their existing sessions
 * are invisible.
 *
 * These tests pin two things that hold the design together:
 *   1. The USER_TOKEN_LS_KEY constant stays canonical so a refactor that
 *      renames it doesn't orphan everyone's saved user token on the
 *      next deploy.
 *   2. The web bundle does NOT export a generate-and-persist helper —
 *      that's a regression guard against accidentally re-introducing
 *      the button by adding the helper first and "wiring it up later."
 *
 * The web workspace runs node-test without jsdom, so React render tests
 * are out of reach; these are the bits we CAN cover at unit-test
 * granularity.
 */
describe('web login form', () => {
    it('exposes the canonical localStorage key', () => {
        // Pin the key so a refactor that renames the constant in
        // login.tsx doesn't silently invalidate everyone's saved user
        // token (the initial-state hook reads
        // `localStorage.getItem(USER_TOKEN_LS_KEY)` — a typo there or
        // here would orphan every user's identity on the next deploy).
        assert.equal(USER_TOKEN_LS_KEY, 'tmuxd:userToken')
    })

    it('does NOT export a generate-and-persist helper', async () => {
        // Regression guard: removing the button on its own is reversible
        // by accident if someone adds the helper back "for testability"
        // and an LLM-generated PR wires up the button to call it. Keep
        // the helper out of the module surface entirely so the only
        // path to client-side token generation is "rip out this test
        // and explain why in a commit message."
        const mod = (await import('./login')) as Record<string, unknown>
        assert.equal(
            mod.generateAndPersistUserToken,
            undefined,
            'web bundle should not expose a client-side user-token generator; ' +
                'the canonical path is `tmuxd login --user-token-generate` in the CLI.'
        )
    })
})
