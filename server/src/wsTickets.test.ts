import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_NAMESPACE } from '@tmuxd/shared'
import { consumeWsTicket, issueWsTicket } from './wsTickets.js'

describe('wsTickets', () => {
    it('binds one-time tickets to a specific host and session', () => {
        // Wrong host → reject, and the ticket is consumed (deleted).
        const first = issueWsTicket({ hostId: 'local', sessionName: 'main' })
        assert.equal(consumeWsTicket(first.ticket, { hostId: 'remote', sessionName: 'main' }), null)
        assert.equal(consumeWsTicket(first.ticket, { hostId: 'local', sessionName: 'main' }), null)

        // Wrong session → reject, ticket consumed.
        const second = issueWsTicket({ hostId: 'local', sessionName: 'main' })
        assert.equal(consumeWsTicket(second.ticket, { hostId: 'local', sessionName: 'other' }), null)

        // Correct target → succeed once, subsequent consume fails.
        const third = issueWsTicket({ hostId: 'local', sessionName: 'main' })
        const ok = consumeWsTicket(third.ticket, { hostId: 'local', sessionName: 'main' })
        assert.ok(ok)
        assert.equal(ok!.namespace, DEFAULT_NAMESPACE)
        assert.equal(consumeWsTicket(third.ticket, { hostId: 'local', sessionName: 'main' }), null)
    })

    it('returns the namespace that was stamped at issuance', () => {
        const issued = issueWsTicket({ hostId: 'alice-laptop', sessionName: 'work', namespace: 'alice' })
        const result = consumeWsTicket(issued.ticket, { hostId: 'alice-laptop', sessionName: 'work' })
        assert.ok(result)
        assert.equal(result!.namespace, 'alice')
    })

    it('defaults namespace to DEFAULT_NAMESPACE when not supplied', () => {
        const issued = issueWsTicket({ hostId: 'local', sessionName: 'main' })
        const result = consumeWsTicket(issued.ticket, { hostId: 'local', sessionName: 'main' })
        assert.ok(result)
        assert.equal(result!.namespace, DEFAULT_NAMESPACE)
    })

    it('does not allow a probe with the wrong host to retry', () => {
        // Defense in depth: first consume burns the ticket regardless of
        // outcome. An attacker who guesses the right ticket but the wrong
        // hostId/sessionName cannot try again.
        const issued = issueWsTicket({ hostId: 'alice-laptop', sessionName: 'main', namespace: 'alice' })
        // First attempt — wrong host. Returns null AND deletes the ticket.
        assert.equal(
            consumeWsTicket(issued.ticket, { hostId: 'bob-desktop', sessionName: 'main' }),
            null
        )
        // Second attempt — even with the correct host, the ticket is gone.
        assert.equal(
            consumeWsTicket(issued.ticket, { hostId: 'alice-laptop', sessionName: 'main' }),
            null
        )
    })

    it('does not allow a probe with the wrong session to retry', () => {
        const issued = issueWsTicket({ hostId: 'alice-laptop', sessionName: 'work', namespace: 'alice' })
        assert.equal(
            consumeWsTicket(issued.ticket, { hostId: 'alice-laptop', sessionName: 'wrong' }),
            null
        )
        // Even now with the correct sessionName the ticket has been burned.
        assert.equal(
            consumeWsTicket(issued.ticket, { hostId: 'alice-laptop', sessionName: 'work' }),
            null
        )
    })

    it('issues namespaces independently per ticket', () => {
        // Two tickets minted with different namespaces are tracked separately
        // and each carries its own namespace through to consume.
        const aliceTicket = issueWsTicket({ hostId: 'alice-laptop', sessionName: 'main', namespace: 'alice' })
        const bobTicket = issueWsTicket({ hostId: 'bob-desktop', sessionName: 'main', namespace: 'bob' })
        const a = consumeWsTicket(aliceTicket.ticket, { hostId: 'alice-laptop', sessionName: 'main' })
        const b = consumeWsTicket(bobTicket.ticket, { hostId: 'bob-desktop', sessionName: 'main' })
        assert.ok(a)
        assert.ok(b)
        assert.equal(a!.namespace, 'alice')
        assert.equal(b!.namespace, 'bob')
    })
})
