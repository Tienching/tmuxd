import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { consumeWsTicket, issueWsTicket } from './wsTickets.js'

const NS_ALICE = 'aaaaaaaaaaaaaaaa'
const NS_BOB = 'bbbbbbbbbbbbbbbb'

describe('wsTickets', () => {
    it('binds one-time tickets to a specific host and session', () => {
        // Wrong host → reject, and the ticket is consumed (deleted).
        const first = issueWsTicket({ hostId: 'local', sessionName: 'main', namespace: NS_ALICE })
        assert.equal(consumeWsTicket(first.ticket, { hostId: 'remote', sessionName: 'main' }), null)
        assert.equal(consumeWsTicket(first.ticket, { hostId: 'local', sessionName: 'main' }), null)

        // Wrong session → reject, ticket consumed.
        const second = issueWsTicket({ hostId: 'local', sessionName: 'main', namespace: NS_ALICE })
        assert.equal(consumeWsTicket(second.ticket, { hostId: 'local', sessionName: 'other' }), null)

        // Correct target → succeed once, subsequent consume fails.
        const third = issueWsTicket({ hostId: 'local', sessionName: 'main', namespace: NS_ALICE })
        const ok = consumeWsTicket(third.ticket, { hostId: 'local', sessionName: 'main' })
        assert.ok(ok)
        assert.equal(ok!.namespace, NS_ALICE)
        assert.equal(consumeWsTicket(third.ticket, { hostId: 'local', sessionName: 'main' }), null)
    })

    it('returns the namespace that was stamped at issuance', () => {
        const issued = issueWsTicket({ hostId: 'alice-laptop', sessionName: 'work', namespace: NS_ALICE })
        const result = consumeWsTicket(issued.ticket, { hostId: 'alice-laptop', sessionName: 'work' })
        assert.ok(result)
        assert.equal(result!.namespace, NS_ALICE)
    })

    it('does not allow a probe with the wrong host to retry', () => {
        // Defense in depth: first consume burns the ticket regardless of
        // outcome. An attacker who guesses the right ticket but the wrong
        // hostId/sessionName cannot try again.
        const issued = issueWsTicket({ hostId: 'alice-laptop', sessionName: 'main', namespace: NS_ALICE })
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
        const issued = issueWsTicket({ hostId: 'alice-laptop', sessionName: 'work', namespace: NS_ALICE })
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
        const aliceTicket = issueWsTicket({ hostId: 'alice-laptop', sessionName: 'main', namespace: NS_ALICE })
        const bobTicket = issueWsTicket({ hostId: 'bob-desktop', sessionName: 'main', namespace: NS_BOB })
        const a = consumeWsTicket(aliceTicket.ticket, { hostId: 'alice-laptop', sessionName: 'main' })
        const b = consumeWsTicket(bobTicket.ticket, { hostId: 'bob-desktop', sessionName: 'main' })
        assert.ok(a)
        assert.ok(b)
        assert.equal(a!.namespace, NS_ALICE)
        assert.equal(b!.namespace, NS_BOB)
    })
})
