import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_NAMESPACE } from '@tmuxd/shared'
import { parseBoundAgentTokens } from './config.js'

describe('parseBoundAgentTokens', () => {
    it('parses a single legacy hostId=token entry into DEFAULT_NAMESPACE', () => {
        const out = parseBoundAgentTokens('workstation=supersecret')
        assert.deepEqual(out, [{ namespace: DEFAULT_NAMESPACE, hostId: 'workstation', token: 'supersecret' }])
    })
    it('parses a single namespace/hostId=token entry', () => {
        const out = parseBoundAgentTokens('alice/laptop=supersecret')
        assert.deepEqual(out, [{ namespace: 'alice', hostId: 'laptop', token: 'supersecret' }])
    })
    it('parses multiple entries separated by commas', () => {
        const out = parseBoundAgentTokens('alice/laptop=tok1,bob/desktop=tok2')
        assert.deepEqual(out, [
            { namespace: 'alice', hostId: 'laptop', token: 'tok1' },
            { namespace: 'bob', hostId: 'desktop', token: 'tok2' }
        ])
    })
    it('allows mixing legacy and new formats', () => {
        const out = parseBoundAgentTokens('workstation=tok1,bob/desktop=tok2')
        assert.deepEqual(out, [
            { namespace: DEFAULT_NAMESPACE, hostId: 'workstation', token: 'tok1' },
            { namespace: 'bob', hostId: 'desktop', token: 'tok2' }
        ])
    })
    it('tolerates surrounding whitespace on entries', () => {
        const out = parseBoundAgentTokens('  alice/laptop = tok1  ,  bob/desktop=tok2')
        assert.deepEqual(out, [
            { namespace: 'alice', hostId: 'laptop', token: 'tok1' },
            { namespace: 'bob', hostId: 'desktop', token: 'tok2' }
        ])
    })
    it('ignores empty entries from trailing commas', () => {
        const out = parseBoundAgentTokens('alice/laptop=tok1,,')
        assert.equal(out.length, 1)
        assert.equal(out[0].namespace, 'alice')
    })
    it('rejects missing = separator', () => {
        assert.throws(() => parseBoundAgentTokens('alice/laptop'), /must use \[namespace\/\]hostId=token/)
    })
    it('rejects empty token', () => {
        assert.throws(() => parseBoundAgentTokens('alice/laptop='), /token is empty/)
    })
    it('rejects "local" as hostId (matches legacy behavior)', () => {
        assert.throws(() => parseBoundAgentTokens('alice/local=tok'), /Invalid TMUXD_AGENT_TOKENS host id/)
        assert.throws(() => parseBoundAgentTokens('local=tok'), /Invalid TMUXD_AGENT_TOKENS host id/)
    })
    it('rejects invalid charset in hostId', () => {
        assert.throws(() => parseBoundAgentTokens('alice/has space=tok'), /Invalid TMUXD_AGENT_TOKENS host id/)
        assert.throws(() => parseBoundAgentTokens('alice/has!bang=tok'), /Invalid TMUXD_AGENT_TOKENS host id/)
    })
    it('rejects invalid charset in namespace', () => {
        assert.throws(() => parseBoundAgentTokens('has space/laptop=tok'), /Invalid TMUXD_AGENT_TOKENS namespace/)
        assert.throws(() => parseBoundAgentTokens('has!bang/laptop=tok'), /Invalid TMUXD_AGENT_TOKENS namespace/)
    })
    it('rejects empty namespace before slash', () => {
        assert.throws(() => parseBoundAgentTokens('/laptop=tok'), /namespace is empty/)
    })
    it('rejects empty hostId after slash', () => {
        assert.throws(() => parseBoundAgentTokens('alice/=tok'), /host id is empty/)
    })
    it('rejects a completely empty value', () => {
        assert.throws(() => parseBoundAgentTokens(''), /did not contain any/)
        assert.throws(() => parseBoundAgentTokens(',,'), /did not contain any/)
    })
    it('allows tokens that contain = signs (split on first =)', () => {
        // This matches historical behavior: indexOf('=') splits on the first `=`,
        // so tokens can contain `=` (e.g., base64url padding).
        const out = parseBoundAgentTokens('alice/laptop=ZXhhbXBsZQ==')
        assert.equal(out[0].token, 'ZXhhbXBsZQ==')
    })

    it('rejects duplicate (namespace, hostId) pairs', () => {
        // Two entries pinning the same agent slot is ambiguous: only the
        // first will ever match. Treat as a config error so the operator
        // notices instead of silently shadowing.
        assert.throws(
            () => parseBoundAgentTokens('alice/laptop=token-1,alice/laptop=token-2'),
            /Duplicate TMUXD_AGENT_TOKENS binding for "alice\/laptop"/
        )
    })

    it('rejects duplicate (default-namespace, hostId) via legacy + explicit form', () => {
        // Legacy `laptop=token` and `default/laptop=token-2` both bind the
        // same slot; the duplicate-detector must catch that too.
        assert.throws(
            () => parseBoundAgentTokens('laptop=token-1,default/laptop=token-2'),
            /Duplicate TMUXD_AGENT_TOKENS binding for "default\/laptop"/
        )
    })

    it('rejects two bindings sharing the same token', () => {
        // Same secret authenticating as two different agents is a
        // security footgun (token rotation by accident).
        assert.throws(
            () => parseBoundAgentTokens('alice/laptop=shared-token,bob/desktop=shared-token'),
            /Duplicate TMUXD_AGENT_TOKENS token shared by "alice\/laptop" and "bob\/desktop"/
        )
    })

    it('allows different namespaces with the same hostId', () => {
        // alice/laptop and bob/laptop are legitimately distinct: both
        // users have a "laptop" agent. Only the (ns, hostId) pair must
        // be unique, not the hostId alone.
        const out = parseBoundAgentTokens('alice/laptop=token-a,bob/laptop=token-b')
        assert.equal(out.length, 2)
        assert.equal(out[0].namespace, 'alice')
        assert.equal(out[1].namespace, 'bob')
    })
})
