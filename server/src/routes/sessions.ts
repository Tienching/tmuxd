import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { verifyJwt } from '../auth.js'
import { createSessionSchema, wsTicketRequestSchema, type TmuxSession } from '@tmuxd/shared'
import { getLocalHost, isLocalHost } from '../hosts.js'
import { captureSession, createSession, killSession, listSessions, validateSessionName } from '../tmux.js'
import { issueWsTicket } from '../wsTickets.js'
import { AgentError, type AgentRegistry } from '../agentRegistry.js'

function bearerAuth(jwtSecret: Uint8Array) {
    return async (c: Context, next: Next) => {
        const header = c.req.header('authorization') || ''
        const match = /^Bearer\s+(\S+)$/i.exec(header)
        if (!match) return c.json({ error: 'missing_token' }, 401)
        const payload = await verifyJwt(jwtSecret, match[1])
        if (!payload) return c.json({ error: 'invalid_token' }, 401)
        await next()
    }
}

export function createSessionsRoutes(jwtSecret: Uint8Array, agentRegistry?: AgentRegistry): Hono {
    const app = new Hono()
    app.use('*', bearerAuth(jwtSecret))

    app.get('/hosts', (c) => {
        return c.json({ hosts: [getLocalHost(), ...(agentRegistry?.listHosts() ?? [])] })
    })

    app.get('/sessions', async (c) => {
        try {
            const list = await listSessions()
            return c.json({ sessions: list })
        } catch (err) {
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 500)
        }
    })

    app.get('/hosts/:hostId/sessions', async (c) => {
        const hostId = c.req.param('hostId')
        if (!isLocalHost(hostId)) {
            if (!agentRegistry?.hasHost(hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                return c.json({ sessions: await agentRegistry.listSessions(hostId) })
            } catch (err) {
                return agentRouteError(c, err)
            }
        }
        try {
            const host = getLocalHost()
            const list = await listSessions()
            return c.json({ sessions: toTargetSessions(list, host.id, host.name) })
        } catch (err) {
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 500)
        }
    })

    app.post('/sessions', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = createSessionSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
        try {
            await createSession(parsed.data.name)
            return c.json({ ok: true }, 201)
        } catch (err) {
            const message = errMsg(err)
            if (/already exists/i.test(message)) return c.json({ error: 'session_exists' }, 409)
            return c.json({ error: 'tmux_error', message }, 500)
        }
    })

    app.post('/hosts/:hostId/sessions', async (c) => {
        const hostId = c.req.param('hostId')
        const body = await c.req.json().catch(() => null)
        const parsed = createSessionSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
        if (!isLocalHost(hostId)) {
            if (!agentRegistry?.hasHost(hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                await agentRegistry.createSession(hostId, parsed.data.name)
                return c.json({ ok: true }, 201)
            } catch (err) {
                return agentRouteError(c, err)
            }
        }
        try {
            await createSession(parsed.data.name)
            return c.json({ ok: true }, 201)
        } catch (err) {
            const message = errMsg(err)
            if (/already exists/i.test(message)) return c.json({ error: 'session_exists' }, 409)
            return c.json({ error: 'tmux_error', message }, 500)
        }
    })

    app.post('/ws-ticket', (c) => {
        return issueTargetWsTicket(c, agentRegistry)
    })

    app.get('/hosts/:hostId/sessions/:name/capture', async (c) => {
        const hostId = c.req.param('hostId')
        const name = c.req.param('name')
        if (!isLocalHost(hostId)) {
            if (!agentRegistry?.hasHost(hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                return c.json(await agentRegistry.captureSession(hostId, name))
            } catch (err) {
                return agentRouteError(c, err)
            }
        }
        try {
            const capture = await captureSession(name)
            return c.json(capture)
        } catch (err) {
            const message = errMsg(err)
            if (/can't find|no such|not found/i.test(message)) {
                return c.json({ error: 'session_not_found' }, 404)
            }
            return c.json({ error: 'tmux_error', message }, 400)
        }
    })

    app.delete('/hosts/:hostId/sessions/:name', async (c) => {
        const hostId = c.req.param('hostId')
        const name = c.req.param('name')
        if (!isLocalHost(hostId)) {
            if (!agentRegistry?.hasHost(hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                await agentRegistry.killSession(hostId, name)
                return c.body(null, 204)
            } catch (err) {
                return agentRouteError(c, err)
            }
        }
        try {
            const safe = validateSessionName(name)
            await killSession(safe)
            return c.body(null, 204)
        } catch (err) {
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 400)
        }
    })

    app.get('/sessions/:name/capture', async (c) => {
        const name = c.req.param('name')
        try {
            const capture = await captureSession(name)
            return c.json(capture)
        } catch (err) {
            const message = errMsg(err)
            if (/can't find|no such|not found/i.test(message)) {
                return c.json({ error: 'session_not_found' }, 404)
            }
            return c.json({ error: 'tmux_error', message }, 400)
        }
    })

    app.delete('/sessions/:name', async (c) => {
        const name = c.req.param('name')
        try {
            const safe = validateSessionName(name)
            await killSession(safe)
            return c.body(null, 204)
        } catch (err) {
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 400)
        }
    })

    return app
}

async function issueTargetWsTicket(c: Context, agentRegistry?: AgentRegistry) {
    const raw = await c.req.text().catch(() => '')
    let body: unknown = undefined
    if (raw.trim()) {
        try {
            body = JSON.parse(raw)
        } catch {
            return c.json({ error: 'invalid_body' }, 400)
        }
    }
    const parsed = wsTicketRequestSchema.safeParse(body)
    if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
    const hostId = parsed.data?.hostId
    if (hostId && !isLocalHost(hostId) && !agentRegistry?.hasHost(hostId)) return c.json({ error: 'host_not_found' }, 404)
    return c.json(issueWsTicket())
}

function agentRouteError(c: Context, err: unknown) {
    const message = errMsg(err)
    if (err instanceof AgentError) {
        if (message === 'host_not_found') return c.json({ error: 'host_not_found' }, 404)
        if (message === 'capability_not_supported') return c.json({ error: 'capability_not_supported' }, 405)
        if (/already exists/i.test(message)) return c.json({ error: 'session_exists' }, 409)
        if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
        if (/timeout/i.test(message)) return c.json({ error: 'agent_timeout' }, 504)
    }
    if (/already exists/i.test(message)) return c.json({ error: 'session_exists' }, 409)
    if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
    return c.json({ error: 'agent_error', message }, 502)
}

function toTargetSessions(sessions: TmuxSession[], hostId: string, hostName: string) {
    return sessions.map((session) => ({ ...session, hostId, hostName }))
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
