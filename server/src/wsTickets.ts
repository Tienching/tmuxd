import { randomBytes } from 'node:crypto'

const TTL_SECONDS = 30
const tickets = new Map<string, number>()

export function issueWsTicket(): { ticket: string; expiresAt: number } {
    sweepExpired()
    const ticket = randomBytes(24).toString('base64url')
    const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECONDS
    tickets.set(ticket, expiresAt)
    return { ticket, expiresAt }
}

export function consumeWsTicket(ticket: string): boolean {
    const expiresAt = tickets.get(ticket)
    tickets.delete(ticket)
    if (!expiresAt) return false
    return expiresAt * 1000 >= Date.now()
}

function sweepExpired(): void {
    const now = Math.floor(Date.now() / 1000)
    for (const [ticket, expiresAt] of tickets) {
        if (expiresAt < now) tickets.delete(ticket)
    }
}
