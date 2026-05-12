import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import WebSocket from 'ws'
import { DEFAULT_NAMESPACE } from '@tmuxd/shared'
import { AgentRegistry, type AgentTokenBinding } from './agentRegistry.js'

/**
 * Spin up a real `http.Server` + `AgentRegistry` listening on an
 * ephemeral port, so we can drive a real WebSocket client at the
 * agent-protocol level. This exercises the actual Buffer parsing,
 * close-code propagation, and JSON wire format that the agent CLI
 * sees in production — which is the whole point: a unit test of
 * `acceptAgent()` would mock those out.
 */
async function startHub(bindings: AgentTokenBinding[]): Promise<{
    registry: AgentRegistry
    server: Server
    url: string
    close(): Promise<void>
}> {
    const registry = new AgentRegistry(bindings)
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
    const url = `ws://127.0.0.1:${addr.port}/agent/connect`
    return {
        registry,
        server,
        url,
        async close() {
            registry.close()
            await new Promise<void>((resolve) => server.close(() => resolve()))
        }
    }
}

interface AgentClientOpts {
    url: string
    token: string
    hello: Record<string, unknown>
    /**
     * If true, the client closes itself as soon as it receives a
     * `hello_ack` (server has accepted the agent). Tests that probe the
     * REJECTED path leave this false so they wait for the server's close.
     */
    closeAfterAck?: boolean
}

/**
 * Connect an agent-style WebSocket client, send the supplied hello, and
 * resolve with whatever close-code/reason the server emits.
 */
function runAgentClient(opts: AgentClientOpts): Promise<{ code: number; reason: string; helloAck: any | null }> {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(opts.url, {
            headers: { authorization: `Bearer ${opts.token}` }
        })
        let helloAck: any = null
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
                        // Client-initiated normal close so the server stops
                        // its heartbeat timer and the test settles fast.
                        ws.close(1000, 'test_done')
                    }
                }
            } catch {
                // ignore non-JSON; agent protocol is JSON only
            }
        })
        ws.on('close', (code, reasonBuf) => {
            clearTimeout(timeoutHandle)
            resolve({ code, reason: reasonBuf?.toString('utf8') || '', helloAck })
        })
        ws.on('error', () => {
            // wait for close to settle so we can capture code/reason
        })
    })
}

describe('AgentRegistry.acceptAgent — namespace enforcement', { concurrency: 1 }, () => {
    it("closes with 4401 when hello.namespace doesn't match the binding", async () => {
        const hub = await startHub([
            { namespace: 'alice', hostId: 'laptop', token: 'shared-agent-token-12345' }
        ])
        try {
            const result = await runAgentClient({
                url: hub.url,
                token: 'shared-agent-token-12345',
                hello: {
                    type: 'hello',
                    id: 'laptop',
                    name: 'Alice Laptop',
                    version: '0.1.0',
                    namespace: 'bob' // wrong — binding is alice
                }
            })
            assert.equal(result.code, 4401, `expected 4401, got ${result.code} (reason: ${result.reason})`)
            assert.ok(
                result.reason.startsWith('agent_namespace_mismatch'),
                `expected reason to start with agent_namespace_mismatch, got: ${result.reason}`
            )
            // Sanity: the registry must NOT have stamped the agent in.
            assert.equal(hub.registry.listHosts('alice').length, 0)
            assert.equal(hub.registry.listHosts('bob').length, 0)
        } finally {
            await hub.close()
        }
    })

    it('closes with 4401 when hello omits namespace but binding is non-default', async () => {
        const hub = await startHub([
            { namespace: 'alice', hostId: 'laptop', token: 'shared-agent-token-67890' }
        ])
        try {
            const result = await runAgentClient({
                url: hub.url,
                token: 'shared-agent-token-67890',
                hello: {
                    type: 'hello',
                    id: 'laptop',
                    name: 'Alice Laptop',
                    version: '0.1.0'
                    // no namespace field → defaults to 'default' on the server,
                    // mismatching the 'alice' binding
                }
            })
            assert.equal(result.code, 4401)
            assert.ok(result.reason.includes('binding=alice'))
            assert.ok(result.reason.includes(`hello=${DEFAULT_NAMESPACE}`))
        } finally {
            await hub.close()
        }
    })

    it('accepts a legacy hello (no namespace) against a default-namespace binding', async () => {
        const hub = await startHub([
            { namespace: DEFAULT_NAMESPACE, hostId: 'workstation', token: 'legacy-agent-token-abc' }
        ])
        try {
            const result = await runAgentClient({
                url: hub.url,
                token: 'legacy-agent-token-abc',
                hello: {
                    type: 'hello',
                    id: 'workstation',
                    name: 'Legacy Workstation',
                    version: '0.1.0'
                    // no namespace → default → matches binding
                },
                closeAfterAck: true
            })
            assert.ok(result.helloAck, `expected hello_ack before close, got code=${result.code} reason=${result.reason}`)
            assert.equal(result.helloAck.hostId, 'workstation')
        } finally {
            await hub.close()
        }
    })

    it('accepts a hello whose namespace matches a non-default binding', async () => {
        const hub = await startHub([
            { namespace: 'bob', hostId: 'desktop', token: 'bob-token-xyz-2026' }
        ])

        // Issue the agent connection; before the client closes, we peek
        // at the registry from outside via a deferred promise so we can
        // assert the registration is observable mid-connection. We do
        // this by hooking close-after-ack and assertion-before-close in
        // sequence.
        const ws = new WebSocket(hub.url, {
            headers: { authorization: `Bearer bob-token-xyz-2026` }
        })
        const settled = new Promise<{ code: number; reason: string; helloAck: any }>((resolve) => {
            let helloAck: any = null
            ws.on('open', () => {
                ws.send(
                    JSON.stringify({
                        type: 'hello',
                        id: 'desktop',
                        name: 'Bob Desktop',
                        version: '0.1.0',
                        namespace: 'bob'
                    })
                )
            })
            ws.on('message', (raw) => {
                try {
                    const msg = JSON.parse(raw.toString('utf8'))
                    if (msg.type === 'hello_ack') {
                        helloAck = msg
                        // Assert *while* the connection is live and the agent
                        // is in the registry's map.
                        try {
                            assert.equal(hub.registry.listHosts('bob').length, 1, 'bob registered')
                            assert.equal(hub.registry.listHosts('alice').length, 0, 'alice empty')
                        } catch {
                            // pass through; the close-handler will resolve
                        }
                        ws.close(1000, 'test_done')
                    }
                } catch {}
            })
            ws.on('close', (code, reason) => {
                resolve({ code, reason: reason?.toString('utf8') || '', helloAck })
            })
        })

        try {
            const result = await settled
            assert.ok(result.helloAck, 'expected hello_ack')
            assert.equal(result.helloAck.hostId, 'desktop')
        } finally {
            await hub.close()
        }
    })

    it('closes with 4401 even when the hostId matches the binding', async () => {
        // Defense in depth: hostId match is necessary but not sufficient;
        // namespace must also match. This catches a hypothetical bug
        // where someone short-circuited the ns check based on hostId.
        const hub = await startHub([
            { namespace: 'alice', hostId: 'laptop', token: 'shared-agent-token-defense' }
        ])
        try {
            const result = await runAgentClient({
                url: hub.url,
                token: 'shared-agent-token-defense',
                hello: {
                    type: 'hello',
                    id: 'laptop',
                    name: 'Alice Laptop',
                    version: '0.1.0',
                    namespace: 'eve' // attacker tries to claim eve namespace
                }
            })
            assert.equal(result.code, 4401)
            assert.ok(result.reason.includes('binding=alice'))
            assert.ok(result.reason.includes('hello=eve'))
            assert.equal(hub.registry.listHosts('eve').length, 0)
            assert.equal(hub.registry.listHosts('alice').length, 0)
        } finally {
            await hub.close()
        }
    })
})

describe('AgentRegistry — disconnect audit', { concurrency: 1 }, () => {
    it('emits agent_disconnect audit event when the agent ws closes', async () => {
        // Integration test: prove that closing an accepted agent's WS
        // results in an `agent_disconnect` audit line. We sniff the line
        // by replacing process.stderr.write for the duration of the test;
        // this is the same technique audit.test.ts uses, just plumbed
        // through a real WS round-trip.
        const lines: string[] = []
        const origWrite = process.stderr.write.bind(process.stderr)
        ;(process.stderr as any).write = (chunk: any) => {
            lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
            return true
        }

        const hub = await startHub([
            { namespace: 'alice', hostId: 'laptop', token: 'disconnect-audit-token' }
        ])
        try {
            const result = await runAgentClient({
                url: hub.url,
                token: 'disconnect-audit-token',
                hello: {
                    type: 'hello',
                    id: 'laptop',
                    name: 'Alice Laptop',
                    version: '0.1.0',
                    namespace: 'alice'
                },
                closeAfterAck: true
            })
            assert.ok(result.helloAck, 'expected hello_ack before disconnect')

            // The cleanup() audit log fires asynchronously off the WS
            // close handler. Give the event loop a tick or two to drain.
            await new Promise((r) => setTimeout(r, 50))

            const auditLines = lines
                .filter((l) => l.startsWith('[tmuxd:audit] '))
                .map((l) => JSON.parse(l.slice('[tmuxd:audit] '.length).trim()) as Record<string, unknown>)
            const register = auditLines.find((e) => e.event === 'agent_register')
            const disconnect = auditLines.find((e) => e.event === 'agent_disconnect')
            assert.ok(register, 'expected agent_register before disconnect')
            assert.ok(disconnect, 'expected agent_disconnect after WS close')
            assert.equal(disconnect!.namespace, 'alice')
            assert.equal(disconnect!.hostId, 'laptop')
            // The reason carries why we cleaned up. WS close() from the
            // client triggers `agent_disconnected` (clean), not
            // `agent_error` (transport error).
            assert.equal(disconnect!.reason, 'agent_disconnected')
        } finally {
            ;(process.stderr as any).write = origWrite
            await hub.close()
        }
    })

    it('emits agent_rejected audit event on namespace mismatch', async () => {
        // Forensic case: an attacker connects with Alice's valid token
        // but tries to claim namespace=eve. The hub closes 4401 (already
        // tested above) but must also leave a paper trail.
        const lines: string[] = []
        const origWrite = process.stderr.write.bind(process.stderr)
        ;(process.stderr as any).write = (chunk: any) => {
            lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
            return true
        }

        const hub = await startHub([
            { namespace: 'alice', hostId: 'laptop', token: 'rejected-audit-token' }
        ])
        try {
            const result = await runAgentClient({
                url: hub.url,
                token: 'rejected-audit-token',
                hello: {
                    type: 'hello',
                    id: 'laptop',
                    name: 'Eve Disguised',
                    version: '0.1.0',
                    namespace: 'eve'
                }
            })
            assert.equal(result.code, 4401)
            await new Promise((r) => setTimeout(r, 50))

            const auditLines = lines
                .filter((l) => l.startsWith('[tmuxd:audit] '))
                .map((l) => JSON.parse(l.slice('[tmuxd:audit] '.length).trim()) as Record<string, unknown>)
            const rejected = auditLines.find((e) => e.event === 'agent_rejected')
            assert.ok(rejected, `expected agent_rejected, got: ${JSON.stringify(auditLines)}`)
            assert.equal(rejected!.namespace, 'eve')
            assert.equal(rejected!.hostId, 'laptop')
            assert.ok(typeof rejected!.reason === 'string')
            assert.ok(
                (rejected!.reason as string).startsWith('namespace_mismatch'),
                `expected reason to mention namespace_mismatch, got: ${rejected!.reason}`
            )
            // No agent_register should have been emitted.
            assert.equal(auditLines.find((e) => e.event === 'agent_register'), undefined)
        } finally {
            ;(process.stderr as any).write = origWrite
            await hub.close()
        }
    })
})
