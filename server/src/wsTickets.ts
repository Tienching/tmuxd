import { randomBytes } from 'node:crypto'

const TTL_SECONDS = 30
const tickets = new Map<string, StoredTicket>()

export interface WsTicketTarget {
    hostId: string
    sessionName: string
}

interface StoredTicket {
    expiresAt: number
    target: WsTicketTarget
}

export function issueWsTicket(target: WsTicketTarget): { ticket: string; expiresAt: number } {
    sweepExpired()
    const ticket = randomBytes(24).toString('base64url')
    const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS
    tickets.set(ticket, { expiresAt, target })
    return { ticket, expiresAt }
}

export function consumeWsTicket(ticket: string, target: WsTicketTarget): boolean {
    const stored = tickets.get(ticket)
    tickets.delete(ticket)
    if (!stored) return false
    if (stored.expiresAt * 1000 < Date.now()) return false
    return stored.target.hostId === target.hostId && stored.target.sessionName === target.sessionName
}

function sweepExpired(): void {
    const now = Math.floor(Date.now() / 1000)
    for (const [ticket, stored] of tickets) {
        if (stored.expiresAt < now) tickets.delete(ticket)
    }
}
