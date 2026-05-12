import { randomBytes } from 'node:crypto'

const TTL_SECONDS = 30
const tickets = new Map<string, StoredTicket>()

export interface WsTicketTarget {
    hostId: string
    sessionName: string
}

export interface WsTicketIssueOptions extends WsTicketTarget {
    /** Namespace of the caller who requested the ticket. Stamped at issuance. */
    namespace: string
}

interface StoredTicket {
    expiresAt: number
    target: WsTicketTarget
    /** The namespace this ticket was issued to. */
    namespace: string
}

export interface WsTicketConsumeResult {
    /** Namespace stamped on the ticket at issuance time. */
    namespace: string
}

export function issueWsTicket(target: WsTicketIssueOptions): { ticket: string; expiresAt: number } {
    sweepExpired()
    const ticket = randomBytes(24).toString('base64url')
    const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS
    tickets.set(ticket, {
        expiresAt,
        target: { hostId: target.hostId, sessionName: target.sessionName },
        namespace: target.namespace
    })
    return { ticket, expiresAt }
}

/**
 * Consume a WebSocket ticket.
 *
 * Returns `{ namespace }` on success — the caller must then verify that the
 * namespace matches the agent registry record it is about to bridge to.
 * Returns `null` if the ticket is missing, expired, or the target mismatches.
 *
 * A ticket is always deleted on the first consume attempt, regardless of
 * outcome, so a probe with the wrong target cannot be retried.
 */
export function consumeWsTicket(ticket: string, target: WsTicketTarget): WsTicketConsumeResult | null {
    const stored = tickets.get(ticket)
    tickets.delete(ticket)
    if (!stored) return null
    if (stored.expiresAt * 1000 < Date.now()) return null
    if (stored.target.hostId !== target.hostId) return null
    if (stored.target.sessionName !== target.sessionName) return null
    return { namespace: stored.namespace }
}

function sweepExpired(): void {
    const now = Math.floor(Date.now() / 1000)
    for (const [ticket, stored] of tickets) {
        if (stored.expiresAt < now) tickets.delete(ticket)
    }
}
