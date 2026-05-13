import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_HOST_ID } from '@tmuxd/shared'
import {
    getLocalHost,
    isLocalHost,
    localHostEnabled,
    setLocalHostEnabled
} from './hosts.js'

/**
 * `localHostEnabled()` is the gate that turns hub-only mode into actual
 * 403s in `routes/sessions.ts`. It defaults to true (legacy / single-user
 * mode) and is flipped to false at startup when TMUXD_RELAY=1. The
 * toggle is module-level state, so we save and restore it around each
 * test to avoid leaking into siblings that share the same import.
 */
describe('hosts module', () => {
    let saved = true
    beforeEach(() => {
        saved = localHostEnabled()
    })
    afterEach(() => {
        setLocalHostEnabled(saved)
    })

    it('defaults to enabled (legacy / non-hub-only mode)', () => {
        // The default is what every existing single-user deploy depends
        // on: tmuxd hosts a local tmux on the box that runs the web
        // server. If this default ever flips, every legacy deployment
        // breaks silently.
        assert.equal(localHostEnabled(), true)
    })

    it('round-trips through setLocalHostEnabled', () => {
        setLocalHostEnabled(false)
        assert.equal(localHostEnabled(), false, 'should be disabled after set false')
        setLocalHostEnabled(true)
        assert.equal(localHostEnabled(), true, 'should be enabled after set true')
    })

    it('isLocalHost matches the canonical LOCAL_HOST_ID and nothing else', () => {
        // This is the predicate every per-host route uses to decide
        // "dispatch local vs registry". A bug here is a 404 storm or,
        // worse, a route that thinks an attacker-supplied hostId is the
        // local host.
        assert.equal(isLocalHost(LOCAL_HOST_ID), true)
        assert.equal(isLocalHost('local'), true) // current value of LOCAL_HOST_ID
        assert.equal(isLocalHost('LOCAL'), false, 'case-sensitive')
        assert.equal(isLocalHost('local '), false, 'trailing space rejected')
        assert.equal(isLocalHost('alice-laptop'), false)
        assert.equal(isLocalHost(''), false)
    })

    it('getLocalHost returns a HostInfo with isLocal=true and the canonical id', () => {
        const host = getLocalHost()
        assert.equal(host.id, LOCAL_HOST_ID)
        assert.equal(host.isLocal, true)
        assert.equal(host.status, 'online')
        assert.ok(Array.isArray(host.capabilities) && host.capabilities.includes('attach'))
        // lastSeenAt should be a recent timestamp, not 0 / undefined.
        assert.ok(typeof host.lastSeenAt === 'number' && host.lastSeenAt > 0)
        assert.ok(Date.now() - host.lastSeenAt < 5_000, 'lastSeenAt should be ~now')
    })

    it('getLocalHost is independent of localHostEnabled() — the gate is enforced at the route layer', () => {
        // getLocalHost() always returns a valid HostInfo so the
        // routes layer can decide whether to surface it. Hiding the
        // local host is a layer-7 policy, not a property of the model.
        setLocalHostEnabled(false)
        const host = getLocalHost()
        assert.equal(host.id, LOCAL_HOST_ID)
        assert.equal(host.isLocal, true)
    })
})
