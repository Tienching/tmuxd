import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Duplex, PassThrough } from 'node:stream'
import { WebSocketServer } from 'ws'
import { issueToken } from './auth.js'
import { issueWsTicket } from './wsTickets.js'
import { tryHandleUpgrade } from './ws.js'

const TEST_SECRET = new TextEncoder().encode('test-jwt-secret-of-at-least-32-bytes-long')

/**
 * Synthesize a minimal IncomingMessage + Duplex pair so we can drive
 * `tryHandleUpgrade` directly without standing up a real HTTP server.
 *
 * The interesting part is the response sniffer: our test reads whatever
 * tryHandleUpgrade writes to the duplex (e.g. `HTTP/1.1 401 Unauthorized`)
 * so we can assert on the status line.
 *
 * On the success path tryHandleUpgrade calls `wss.handleUpgrade` which
 * tries to complete a real WebSocket handshake. We don't care about the
 * downstream WS — we just want to know the gate let us through. The
 * test uses a separate "did it get to handleUpgrade" hook to detect
 * success without negotiating.
 */
function fakeRequest(url: string): { req: any; sock: Duplex; written: string[]; destroyed: () => boolean } {
    const written: string[] = []
    let isDestroyed = false
    const sock = new PassThrough() as unknown as Duplex
    const realWrite = (sock as any).write.bind(sock)
    ;(sock as any).write = (chunk: any) => {
        written.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
        return realWrite(chunk)
    }
    ;(sock as any).destroy = () => {
        isDestroyed = true
    }
    const req = Object.assign(new EventEmitter(), {
        method: 'GET',
        url,
        headers: {} as Record<string, string>
    })
    return { req, sock, written, destroyed: () => isDestroyed }
}

interface FakeAgentRegistry {
    hasHost(ns: string, hostId: string): boolean
}

function makeRegistry(map: Record<string, string[]>): FakeAgentRegistry {
    return {
        hasHost: (ns, hostId) => (map[ns] ?? []).includes(hostId)
    }
}

describe('ws.tryHandleUpgrade — namespace gating', { concurrency: 1 }, () => {
    it("rejects Alice's JWT trying to attach Bob's host with 404", async () => {
        const wss = new WebSocketServer({ noServer: true })
        try {
            const aliceToken = (await issueToken(TEST_SECRET, 60, 'alice')).token
            const registry = makeRegistry({ alice: ['alice-laptop'], bob: ['bob-desktop'] })
            const { req, sock, written } = fakeRequest(
                `/ws/bob-desktop/main?token=${encodeURIComponent(aliceToken)}`
            )
            const handled = await tryHandleUpgrade(wss, TEST_SECRET, req, sock, Buffer.alloc(0), {
                agentRegistry: registry as any
            })
            assert.equal(handled, true, 'tryHandleUpgrade should claim the request')
            const wrote = written.join('')
            assert.ok(wrote.includes('404 Not Found'), `expected 404 status line, got: ${wrote}`)
        } finally {
            wss.close()
        }
    })

    it('rejects unknown JWT with 401', async () => {
        const wss = new WebSocketServer({ noServer: true })
        try {
            const registry = makeRegistry({ alice: ['alice-laptop'] })
            const { req, sock, written } = fakeRequest('/ws/alice-laptop/main?token=garbage')
            const handled = await tryHandleUpgrade(wss, TEST_SECRET, req, sock, Buffer.alloc(0), {
                agentRegistry: registry as any
            })
            assert.equal(handled, true)
            const wrote = written.join('')
            assert.ok(wrote.includes('401 Unauthorized'), `expected 401, got: ${wrote}`)
        } finally {
            wss.close()
        }
    })

    it("rejects a ticket stamped 'alice' that targets Bob's host with 404", async () => {
        // Subtle case: the ticket can't actually be issued to target Bob's
        // host as Alice in production (the routes layer blocks that). But
        // if someone forged or replayed one, tryHandleUpgrade still has to
        // close the door because the registry won't find (alice, bob-desktop).
        const wss = new WebSocketServer({ noServer: true })
        try {
            const registry = makeRegistry({ alice: ['alice-laptop'], bob: ['bob-desktop'] })
            // Mint a ticket directly via the ticket store, stamping ns=alice
            // but pointing at bob-desktop. (In production wsTicketRequestSchema
            // + the routes layer would refuse to issue this, but the WS layer
            // is the last line of defense.)
            const { ticket } = issueWsTicket({
                hostId: 'bob-desktop',
                sessionName: 'main',
                namespace: 'alice'
            })
            const { req, sock, written } = fakeRequest(
                `/ws/bob-desktop/main?ticket=${encodeURIComponent(ticket)}`
            )
            const handled = await tryHandleUpgrade(wss, TEST_SECRET, req, sock, Buffer.alloc(0), {
                agentRegistry: registry as any
            })
            assert.equal(handled, true)
            const wrote = written.join('')
            // Either 404 (registry says alice doesn't have bob-desktop) is fine.
            assert.ok(wrote.includes('404 Not Found'), `expected 404, got: ${wrote}`)
        } finally {
            wss.close()
        }
    })

    it('rejects requests without any auth credential with 401', async () => {
        const wss = new WebSocketServer({ noServer: true })
        try {
            const registry = makeRegistry({ alice: ['alice-laptop'] })
            const { req, sock, written } = fakeRequest('/ws/alice-laptop/main')
            const handled = await tryHandleUpgrade(wss, TEST_SECRET, req, sock, Buffer.alloc(0), {
                agentRegistry: registry as any
            })
            assert.equal(handled, true)
            const wrote = written.join('')
            assert.ok(wrote.includes('401 Unauthorized'), `expected 401, got: ${wrote}`)
        } finally {
            wss.close()
        }
    })

    it('returns false (not handled) for non-/ws paths', async () => {
        const wss = new WebSocketServer({ noServer: true })
        try {
            const registry = makeRegistry({ alice: ['alice-laptop'] })
            const { req, sock } = fakeRequest('/api/something/else')
            const handled = await tryHandleUpgrade(wss, TEST_SECRET, req, sock, Buffer.alloc(0), {
                agentRegistry: registry as any
            })
            assert.equal(handled, false, 'tryHandleUpgrade should not claim non-/ws paths')
        } finally {
            wss.close()
        }
    })
})
