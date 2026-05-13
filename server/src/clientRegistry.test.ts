import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { computeNamespace } from '@tmuxd/shared'
import { ClientRegistry } from './clientRegistry.js'

/**
 * Spin up a real `http.Server` + `ClientRegistry` listening on an
 * ephemeral port, so we can drive a real WebSocket client at the
 * agent-protocol level. This exercises the actual Buffer parsing,
 * close-code propagation, and JSON wire format that the agent CLI
 * sees in production — which is the whole point: a unit test of
 * `acceptAgent()` would mock those out.
 */
async function startHub(serverToken: string): Promise<{
    registry: ClientRegistry
    server: Server
    baseUrl: string
    close(): Promise<void>
}> {
    const registry = new ClientRegistry(serverToken)
    const server = createServer()
    server.on('upgrade', async (request: IncomingMessage, socket: any, head: Buffer) => {
        try {
            const handled = await registry.tryHandleUpgrade(request, socket, head)
            if (!handled) socket.destroy()
        } catch {
            socket.destroy()
        }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    return {
        registry,
        server,
        baseUrl: `ws://127.0.0.1:${addr.port}`,
        async close() {
            registry.close()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    }
}

interface AgentClientOpts {
    baseUrl: string
    serverToken?: string
    userToken?: string
    hello: Record<string, unknown>
    /**
     * If true, the client closes itself as soon as it receives a
     * `hello_ack` (server has accepted the agent). Tests that probe the
     * REJECTED path leave this false so they wait for the server's close.
     */
    closeAfterAck?: boolean
}

interface AgentClientResult {
    code: number
    reason: string
    helloAck: { type: 'hello_ack'; hostId: string; heartbeatMs: number } | null
    upgradeStatus: number | null
}

/**
 * Connect an agent-style WebSocket client to /client/connect with the
 * given (serverToken, userToken) on the URL query string. Resolves with
 * the close code/reason the server emits, or the HTTP rejection status
 * if the upgrade is refused.
 */
function runAgentClient(opts: AgentClientOpts): Promise<AgentClientResult> {
    return new Promise((resolve, reject) => {
        const url = new URL('/client/connect', opts.baseUrl)
        if (opts.serverToken !== undefined) url.searchParams.set('serverToken', opts.serverToken)
        if (opts.userToken !== undefined) url.searchParams.set('userToken', opts.userToken)
        const ws = new WebSocket(url.toString())
        let helloAck: AgentClientResult['helloAck'] = null
        let upgradeStatus: number | null = null
        let resolved = false
        const finish = (r: AgentClientResult) => {
            if (resolved) return
            resolved = true
            clearTimeout(timeoutHandle)
            resolve(r)
        }
        const timeoutHandle = setTimeout(() => {
            try {
                ws.close()
            } catch {}
            reject(new Error('agent client timeout'))
        }, 5000)

        ws.on('open', () => {
            ws.send(JSON.stringify(opts.hello))
        })
        ws.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString('utf8'))
                if (msg.type === 'hello_ack') {
                    helloAck = msg
                    if (opts.closeAfterAck) {
                        ws.close(1000, 'test_done')
                    }
                }
            } catch {
                /* ignore */
            }
        })
        ws.on('unexpected-response', (_req, res) => {
            // 401 from tryHandleUpgrade: no WS opened. We'll never get
            // 'close' here, so resolve immediately with the HTTP status.
            upgradeStatus = res.statusCode ?? null
            finish({ code: 0, reason: '', helloAck, upgradeStatus })
        })
        ws.on('close', (code, reasonBuf) => {
            finish({ code, reason: reasonBuf?.toString('utf8') || '', helloAck, upgradeStatus })
        })
        ws.on('error', () => {
            // For some platforms 'error' precedes 'close' and we may never
            // see 'unexpected-response'. Wait for close to settle.
        })
    })
}

describe('ClientRegistry — trust-model handshake', { concurrency: 1 }, () => {
    it('rejects upgrade with HTTP 401 when serverToken is missing', async () => {
        const hub = await startHub('correct-server-token')
        try {
            const result = await runAgentClient({
                baseUrl: hub.baseUrl,
                userToken: 'alice-secret',
                hello: { type: 'hello', name: 'should not matter' }
            })
            assert.equal(result.upgradeStatus, 401)
        } finally {
            await hub.close()
        }
    })

    it('rejects upgrade with HTTP 401 when userToken is missing', async () => {
        const hub = await startHub('correct-server-token')
        try {
            const result = await runAgentClient({
                baseUrl: hub.baseUrl,
                serverToken: 'correct-server-token',
                hello: { type: 'hello', name: 'should not matter' }
            })
            assert.equal(result.upgradeStatus, 401)
        } finally {
            await hub.close()
        }
    })

    it('rejects upgrade with HTTP 401 when serverToken is wrong', async () => {
        const hub = await startHub('correct-server-token')
        try {
            const result = await runAgentClient({
                baseUrl: hub.baseUrl,
                serverToken: 'WRONG',
                userToken: 'alice-secret',
                hello: { type: 'hello', name: 'should not matter' }
            })
            assert.equal(result.upgradeStatus, 401)
        } finally {
            await hub.close()
        }
    })

    it('accepts upgrade with both tokens; namespace = sha256(userToken)', async () => {
        const hub = await startHub('correct-server-token')
        try {
            // Open a long-lived WS so we can observe the registry state
            // *while* the agent is connected (closeAfterAck would race
            // the cleanup against our listHosts() assertion).
            const url = new URL('/client/connect', hub.baseUrl)
            url.searchParams.set('serverToken', 'correct-server-token')
            url.searchParams.set('userToken', 'alice-secret')
            const ws = new WebSocket(url.toString())
            const ackPromise = new Promise<{ hostId: string }>((resolve, reject) => {
                ws.on('open', () => {
                    ws.send(JSON.stringify({ type: 'hello', id: 'laptop', name: 'Alice Laptop', version: '0.1.0' }))
                })
                ws.on('message', (raw) => {
                    try {
                        const msg = JSON.parse(raw.toString('utf8'))
                        if (msg.type === 'hello_ack') resolve({ hostId: msg.hostId })
                    } catch {
                        /* ignore */
                    }
                })
                ws.on('error', reject)
                ws.on('close', () => reject(new Error('closed before hello_ack')))
            })
            const ack = await ackPromise
            assert.equal(ack.hostId, 'laptop')

            // Verify the registry stamped the agent into the right namespace.
            const aliceNs = await computeNamespace('alice-secret')
            const hosts = hub.registry.listHosts(aliceNs)
            assert.equal(hosts.length, 1)
            assert.equal(hosts[0].id, 'laptop')

            ws.close()
            await new Promise((r) => setTimeout(r, 50))
        } finally {
            await hub.close()
        }
    })

    it('different userTokens land in different namespaces (no cross-leak)', async () => {
        const hub = await startHub('correct-server-token')
        try {
            await runAgentClient({
                baseUrl: hub.baseUrl,
                serverToken: 'correct-server-token',
                userToken: 'alice-secret',
                hello: { type: 'hello', id: 'laptop', name: 'Alice Laptop' },
                closeAfterAck: true
            })
            await runAgentClient({
                baseUrl: hub.baseUrl,
                serverToken: 'correct-server-token',
                userToken: 'bob-secret',
                hello: { type: 'hello', id: 'desktop', name: 'Bob Desktop' },
                closeAfterAck: true
            })
            const aliceNs = await computeNamespace('alice-secret')
            const bobNs = await computeNamespace('bob-secret')
            assert.notEqual(aliceNs, bobNs)
            // Wait briefly for both close handlers + cleanup to fire.
            await new Promise((r) => setTimeout(r, 50))
            // After clean shutdown, the registry should be empty for both
            // namespaces — agents disconnect when the WS closes.
            assert.equal(hub.registry.listHosts(aliceNs).length, 0)
            assert.equal(hub.registry.listHosts(bobNs).length, 0)
        } finally {
            await hub.close()
        }
    })

    it('rejects duplicate hostId within the same namespace', async () => {
        const hub = await startHub('correct-server-token')
        const aliceNs = await computeNamespace('alice-secret')
        try {
            // First connection: lives forever (we never closeAfterAck).
            const first = new WebSocket(
                `${hub.baseUrl}/client/connect?serverToken=correct-server-token&userToken=alice-secret`
            )
            await new Promise<void>((resolve) => first.on('open', () => resolve()))
            first.send(JSON.stringify({ type: 'hello', id: 'laptop', name: 'Alice Laptop' }))
            // Wait a beat for the registry to register it.
            await new Promise((r) => setTimeout(r, 100))
            assert.equal(hub.registry.listHosts(aliceNs).length, 1)

            // Second connection: same userToken, same hostId → should be rejected.
            const result = await runAgentClient({
                baseUrl: hub.baseUrl,
                serverToken: 'correct-server-token',
                userToken: 'alice-secret',
                hello: { type: 'hello', id: 'laptop', name: 'Alice Laptop' }
            })
            assert.equal(result.code, 1008)
            assert.equal(result.reason, 'host_already_connected')

            first.close()
        } finally {
            await hub.close()
        }
    })

    it('same hostId in DIFFERENT namespaces is allowed (per-ns scoping)', async () => {
        const hub = await startHub('correct-server-token')
        try {
            // alice/laptop and bob/laptop coexist.
            const aliceWs = new WebSocket(
                `${hub.baseUrl}/client/connect?serverToken=correct-server-token&userToken=alice-secret`
            )
            await new Promise<void>((resolve) => aliceWs.on('open', () => resolve()))
            aliceWs.send(JSON.stringify({ type: 'hello', id: 'laptop', name: 'Alice Laptop' }))
            await new Promise((r) => setTimeout(r, 80))

            const bobWs = new WebSocket(
                `${hub.baseUrl}/client/connect?serverToken=correct-server-token&userToken=bob-secret`
            )
            await new Promise<void>((resolve) => bobWs.on('open', () => resolve()))
            bobWs.send(JSON.stringify({ type: 'hello', id: 'laptop', name: 'Bob Laptop' }))
            await new Promise((r) => setTimeout(r, 80))

            const aliceNs = await computeNamespace('alice-secret')
            const bobNs = await computeNamespace('bob-secret')
            const aliceHosts = hub.registry.listHosts(aliceNs)
            const bobHosts = hub.registry.listHosts(bobNs)
            assert.equal(aliceHosts.length, 1)
            assert.equal(bobHosts.length, 1)
            assert.equal(aliceHosts[0].name, 'Alice Laptop')
            assert.equal(bobHosts[0].name, 'Bob Laptop')

            aliceWs.close()
            bobWs.close()
        } finally {
            await hub.close()
        }
    })

    it('rejects upgrade if /client/connect path is wrong', async () => {
        const hub = await startHub('correct-server-token')
        try {
            const url = new URL('/wrong-path', hub.baseUrl)
            url.searchParams.set('serverToken', 'correct-server-token')
            url.searchParams.set('userToken', 'alice')
            const ws = new WebSocket(url.toString())
            const result = await new Promise<{ code: number; status: number | null }>((resolve) => {
                let status: number | null = null
                ws.on('unexpected-response', (_req, res) => {
                    status = res.statusCode ?? null
                })
                ws.on('error', () => {
                    resolve({ code: 0, status })
                })
                ws.on('close', (code) => resolve({ code, status }))
            })
            // tryHandleUpgrade returns false; outer handler destroys the socket.
            assert.notEqual(result.status, 101)
        } finally {
            await hub.close()
        }
    })
})
