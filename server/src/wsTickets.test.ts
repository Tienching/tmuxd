import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { consumeWsTicket, issueWsTicket } from './wsTickets.js'

describe('wsTickets', () => {
    it('binds one-time tickets to a specific host and session', () => {
        const first = issueWsTicket({ hostId: 'local', sessionName: 'main' })

        assert.equal(consumeWsTicket(first.ticket, { hostId: 'remote', sessionName: 'main' }), false)
        assert.equal(consumeWsTicket(first.ticket, { hostId: 'local', sessionName: 'main' }), false)

        const second = issueWsTicket({ hostId: 'local', sessionName: 'main' })
        assert.equal(consumeWsTicket(second.ticket, { hostId: 'local', sessionName: 'other' }), false)

        const third = issueWsTicket({ hostId: 'local', sessionName: 'main' })
        assert.equal(consumeWsTicket(third.ticket, { hostId: 'local', sessionName: 'main' }), true)
        assert.equal(consumeWsTicket(third.ticket, { hostId: 'local', sessionName: 'main' }), false)
    })
})
