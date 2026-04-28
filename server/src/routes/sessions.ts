import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { verifyJwt } from '../auth.js'
import { createSessionSchema } from '@tmuxd/shared'
import { captureSession, createSession, killSession, listSessions, validateSessionName } from '../tmux.js'
import { issueWsTicket } from '../wsTickets.js'

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

export function createSessionsRoutes(jwtSecret: Uint8Array): Hono {
    const app = new Hono()
    app.use('*', bearerAuth(jwtSecret))

    app.get('/sessions', async (c) => {
        try {
            const list = await listSessions()
            return c.json({ sessions: list })
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

    app.post('/ws-ticket', (c) => {
        return c.json(issueWsTicket())
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

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}
