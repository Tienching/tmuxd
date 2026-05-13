import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { File } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { ZodError } from 'zod'
import { verifyJwt } from '../auth.js'
import {
    createSessionSchema,
    paneCaptureQuerySchema,
    sendKeysRequestSchema,
    sendTextRequestSchema,
    snapshotQuerySchema,
    tmuxActionIdSchema,
    wsTicketRequestSchema,
    type TmuxAction,
    type TmuxActionRun,
    type TmuxPaneStatus,
    type TmuxSnapshot,
    type TmuxSnapshotError,
    type TargetPane,
    type TmuxPane,
    type TmuxSession
} from '@tmuxd/shared'
import { getLocalHost, isLocalHost, localHostEnabled } from '../hosts.js'
import { logAudit } from '../audit.js'
import {
    capturePane,
    captureSession,
    createSession,
    killSession,
    listPanes,
    listSessions,
    sendKeysToTarget,
    sendTextToSession,
    sendTextToTarget,
    validateSessionTargetName
} from '../tmux.js'
import { issueWsTicket } from '../wsTickets.js'
import { ClientError, type ClientRegistry } from '../clientRegistry.js'
import { ActionStoreError, type TmuxActionStore } from '../actions.js'
import { markPaneActivityRead, trackPaneActivity } from '../paneActivity.js'
import { classifyPaneStatus, findPaneForTarget } from '../paneStatus.js'

function bearerAuth(jwtSecret: Uint8Array) {
    return async (c: Context, next: Next) => {
        const header = c.req.header('authorization') || ''
        const match = /^Bearer\s+(\S+)$/i.exec(header)
        if (!match) {
            // Audit attempts at API surface that don't even carry a
            // bearer header — distinguishes "missing creds" from
            // "tampered token" and gives forensic visibility on
            // /api/* probing.
            logAudit({
                event: 'auth_failure',
                namespace: '',
                remoteAddr: clientIpFromRequest(c),
                reason: 'missing_token'
            })
            return c.json({ error: 'missing_token' }, 401)
        }
        const payload = await verifyJwt(jwtSecret, match[1])
        if (!payload) {
            logAudit({
                event: 'auth_failure',
                namespace: '',
                remoteAddr: clientIpFromRequest(c),
                reason: 'invalid_jwt'
            })
            return c.json({ error: 'invalid_token' }, 401)
        }
        // Stash the caller's namespace for downstream handlers. The JWT
        // verifier already enforces ns being a valid 16-hex namespace, so
        // by the time we get here `payload.ns` is guaranteed present.
        c.set('ns', payload.ns)
        await next()
    }
}

/**
 * Best-effort client IP for audit logging. Reads CF / X-Forwarded-For
 * headers when present (common when fronted by a proxy), then falls
 * through to the raw socket peer address (for direct connections in
 * development or single-box deployments). Returns the literal string
 * `'unknown'` only when neither path yields anything — this is the
 * signal that the proxy chain is misconfigured.
 */
function clientIpFromRequest(c: Context): string {
    const fromHeader =
        c.req.header('cf-connecting-ip') ||
        c.req.header('x-real-ip') ||
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (fromHeader) return fromHeader
    // Hono node-server exposes the raw IncomingMessage as c.env.incoming.
    // Fall back gracefully if the runtime doesn't expose it (e.g. in
    // tests using app.request()).
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
    return incoming?.socket?.remoteAddress || 'unknown'
}

/**
 * Read the namespace stamped on the authenticated request by `bearerAuth`.
 *
 * Throws `MissingNamespaceError` if no `ns` is present on the context.
 * The route handler treats this as a 500 (server_misconfigured) rather
 * than silently routing to `default` — a route reaching this helper
 * without `bearerAuth` having populated `ns` is a programmer error
 * (route mounted under the wrong app or someone forgot to chain auth),
 * and falling back to `default` would hand attacker-controlled input
 * to the default namespace's resources. Fail loud, fail closed.
 */
class MissingNamespaceError extends Error {
    constructor() {
        super('namespace_missing_on_context')
        this.name = 'MissingNamespaceError'
    }
}

function requireNamespace(c: Context): string {
    const ns = c.get('ns')
    if (typeof ns !== 'string' || ns.length === 0) {
        throw new MissingNamespaceError()
    }
    return ns
}

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024
const CLIPBOARD_IMAGE_EXTENSIONS: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff'
}

export function createSessionsRoutes(jwtSecret: Uint8Array, clientRegistry: ClientRegistry | undefined, actionStore: TmuxActionStore): Hono {
    const app = new Hono()
    app.use('*', bearerAuth(jwtSecret))

    // Fail-closed handler. If `requireNamespace` (or any other
    // chokepoint helper) throws a `MissingNamespaceError`, surface it
    // as 500 server_misconfigured rather than letting the request fall
    // through to a default-namespace shadow read. This is defense in
    // depth — under normal flow `bearerAuth` always populates `ns`.
    app.onError((err, c) => {
        if (err instanceof MissingNamespaceError) {
            console.error('[tmuxd] route reached without ns on context — bearerAuth missing or wired wrong')
            return c.json({ error: 'server_misconfigured' }, 500)
        }
        throw err
    })

    app.get('/hosts', (c) => {
        const ns = requireNamespace(c)
        const local = localHostEnabled() ? [getLocalHost()] : []
        return c.json({ hosts: [...local, ...(clientRegistry?.listHosts(ns) ?? [])] })
    })

    app.get('/client/snapshot', async (c) => {
        const query = snapshotQuerySchema.safeParse(readCaptureQuery(c, ['capture', 'captureLimit']))
        if (!query.success) return c.json({ error: 'invalid_query' }, 400)
        return c.json(await buildClientSnapshot(clientRegistry, requireNamespace(c), query.data))
    })

    app.get('/sessions', async (c) => {
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        try {
            const list = await listSessions()
            return c.json({ sessions: list })
        } catch (err) {
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 500)
        }
    })

    app.get('/hosts/:hostId/sessions', async (c) => {
        const hostId = c.req.param('hostId')
        const ns = requireNamespace(c)
        if (!isLocalHost(hostId)) {
            if (!clientRegistry?.hasHost(ns, hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                return c.json({ sessions: await clientRegistry.listSessions(ns, hostId) })
            } catch (err) {
                return clientRouteError(c, err)
            }
        }
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        try {
            const host = getLocalHost()
            const list = await listSessions()
            return c.json({ sessions: toTargetSessions(list, host.id, host.name) })
        } catch (err) {
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 500)
        }
    })

    app.post('/sessions', async (c) => {
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
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
        const ns = requireNamespace(c)
        const body = await c.req.json().catch(() => null)
        const parsed = createSessionSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
        if (!isLocalHost(hostId)) {
            if (!clientRegistry?.hasHost(ns, hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                await clientRegistry.createSession(ns, hostId, parsed.data.name)
                return c.json({ ok: true }, 201)
            } catch (err) {
                return clientRouteError(c, err)
            }
        }
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
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
        return issueTargetWsTicket(c, clientRegistry)
    })

    app.get('/actions', async (c) => {
        return c.json({ actions: await actionStore.list() })
    })

    app.get('/actions/history', async (c) => {
        const limit = readOptionalInt(c.req.query('limit'), 1, 1000)
        if (limit === null) return c.json({ error: 'invalid_query' }, 400)
        return c.json({ runs: await actionStore.listHistory(limit) })
    })

    app.post('/actions', async (c) => {
        const body = await c.req.json().catch(() => null)
        try {
            const action = await actionStore.create(body)
            return c.json({ action }, 201)
        } catch (err) {
            return actionRouteError(c, err)
        }
    })

    app.put('/actions/:id', async (c) => {
        const id = c.req.param('id')
        const body = await c.req.json().catch(() => null)
        try {
            const action = await actionStore.upsert(id, body)
            return c.json({ action })
        } catch (err) {
            return actionRouteError(c, err)
        }
    })

    app.delete('/actions/:id', async (c) => {
        const id = c.req.param('id')
        try {
            const deleted = await actionStore.delete(id)
            return deleted ? c.body(null, 204) : c.json({ error: 'action_not_found' }, 404)
        } catch (err) {
            return actionRouteError(c, err)
        }
    })

    app.get('/sessions/:name/panes', async (c) => {
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        const name = c.req.param('name')
        try {
            const host = getLocalHost()
            const panes = await listPanes(name)
            return c.json({ panes: toTargetPanes(panes, host.id, host.name) })
        } catch (err) {
            const message = errMsg(err)
            if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
            return c.json({ error: 'tmux_error', message }, 400)
        }
    })

    app.get('/hosts/:hostId/panes', async (c) => {
        const hostId = c.req.param('hostId')
        const session = c.req.query('session') || undefined
        const result = await listPanesForHost(requireNamespace(c), hostId, session, clientRegistry)
        if ('response' in result) return result.response
        return c.json({ panes: result.panes })
    })

    app.get('/hosts/:hostId/sessions/:name/panes', async (c) => {
        const hostId = c.req.param('hostId')
        const name = c.req.param('name')
        const result = await listPanesForHost(requireNamespace(c), hostId, name, clientRegistry)
        if ('response' in result) return result.response
        return c.json({ panes: result.panes })
    })

    app.get('/hosts/:hostId/panes/:target/capture', async (c) => {
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const ns = requireNamespace(c)
        const query = paneCaptureQuerySchema.safeParse(readCaptureQuery(c))
        if (!query.success) return c.json({ error: 'invalid_query' }, 400)
        if (!isLocalHost(hostId)) {
            if (!clientRegistry?.hasHost(ns, hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                return c.json(await clientRegistry.capturePane(ns, hostId, target, query.data.lines, query.data.maxBytes))
            } catch (err) {
                return clientRouteError(c, err)
            }
        }
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        try {
            return c.json(await capturePane(target, { lines: query.data.lines, maxBytes: query.data.maxBytes }))
        } catch (err) {
            const message = errMsg(err)
            if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
            return c.json({ error: 'tmux_error', message }, 400)
        }
    })

    app.get('/hosts/:hostId/panes/:target/status', async (c) => {
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const ns = requireNamespace(c)
        const query = paneCaptureQuerySchema.safeParse(readCaptureQuery(c))
        if (!query.success) return c.json({ error: 'invalid_query' }, 400)
        if (!isLocalHost(hostId)) {
            if (!clientRegistry?.hasHost(ns, hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                const panes = await clientRegistry.listPanes(ns, hostId)
                const capture = await clientRegistry.capturePane(ns, hostId, target, query.data.lines, query.data.maxBytes)
                const pane = findPaneForTarget(panes, target)
                return c.json(classifyPaneStatus({ target, pane, capture, activity: trackPaneActivity({ hostId, target, pane, capture }) }))
            } catch (err) {
                return clientRouteError(c, err)
            }
        }
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        try {
            const panes = await listPanes()
            const capture = await capturePane(target, { lines: query.data.lines, maxBytes: query.data.maxBytes })
            const pane = findPaneForTarget(panes, target)
            return c.json(classifyPaneStatus({ target, pane, capture, activity: trackPaneActivity({ hostId: getLocalHost().id, target, pane, capture }) }))
        } catch (err) {
            const message = errMsg(err)
            if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
            return c.json({ error: 'tmux_error', message }, 400)
        }
    })

    app.post('/hosts/:hostId/panes/:target/activity/read', async (c) => {
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const result = await markPaneReadForHost(requireNamespace(c), hostId, target, clientRegistry)
        if ('response' in result) return result.response
        return c.json({ ok: true, activity: result.activity })
    })

    app.post('/hosts/:hostId/panes/:target/input', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = sendTextRequestSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const result = await sendInputToHost(requireNamespace(c), hostId, target, parsed.data, clientRegistry)
        if ('response' in result) return result.response
        return c.json({ ok: true })
    })

    app.post('/hosts/:hostId/panes/:target/keys', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = sendKeysRequestSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const result = await sendKeysToHost(requireNamespace(c), hostId, target, parsed.data.keys, clientRegistry)
        if ('response' in result) return result.response
        return c.json({ ok: true })
    })

    app.post('/hosts/:hostId/panes/:target/actions/:actionId/run', async (c) => {
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const actionId = c.req.param('actionId')
        const ns = requireNamespace(c)
        const parsedActionId = tmuxActionIdSchema.safeParse(actionId)
        if (!parsedActionId.success) return c.json({ error: 'invalid_action_id' }, 400)
        const action = await actionStore.get(parsedActionId.data)
        if (!action) return c.json({ error: 'action_not_found' }, 404)
        const startedAt = Date.now()
        const result = await runActionOnHost(ns, hostId, target, action, clientRegistry)
        if ('response' in result) {
            await recordActionRun(actionStore, action, hostId, target, false, startedAt, `http_${result.response.status}`)
            return result.response
        }
        const run = await recordActionRun(actionStore, action, hostId, target, true, startedAt)
        return c.json({ ok: true, actionId: action.id, hostId, target, runId: run?.id })
    })

    app.post('/uploads/clipboard-image', async (c) => {
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        const result = await saveClipboardImage(c)
        if ('response' in result) return result.response
        return c.json(result.upload, 201)
    })

    app.post('/sessions/:name/uploads/clipboard-image', async (c) => {
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        const sessionName = c.req.param('name')
        let safe: string
        try {
            safe = validateSessionTargetName(sessionName)
        } catch {
            return c.json({ error: 'invalid_session_name' }, 400)
        }

        const result = await saveClipboardImage(c)
        if ('response' in result) return result.response

        try {
            await sendTextToSession(safe, `${shellQuote(result.upload.path)} `)
        } catch (err) {
            await rm(result.upload.path, { force: true }).catch(() => undefined)
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 400)
        }
        return c.json(result.upload, 201)
    })

    app.post('/hosts/:hostId/sessions/:name/uploads/clipboard-image', async (c) => {
        const hostId = c.req.param('hostId')
        const sessionName = c.req.param('name')
        const ns = requireNamespace(c)
        if (!isLocalHost(hostId)) {
            // Remote clipboard-image paste is not supported today: the save
            // writes to the HUB's filesystem, and the agent's shell runs on
            // a different machine, so the path we'd paste wouldn't exist
            // there. Refuse explicitly rather than silently succeeding.
            if (!clientRegistry?.hasHost(ns, hostId)) return c.json({ error: 'host_not_found' }, 404)
            return c.json({ error: 'clipboard_image_remote_unsupported' }, 501)
        }
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)

        let safe: string
        try {
            safe = validateSessionTargetName(sessionName)
        } catch {
            return c.json({ error: 'invalid_session_name' }, 400)
        }

        const result = await saveClipboardImage(c)
        if ('response' in result) return result.response

        try {
            await sendTextToSession(safe, `${shellQuote(result.upload.path)} `)
        } catch (err) {
            await rm(result.upload.path, { force: true }).catch(() => undefined)
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 400)
        }
        return c.json(result.upload, 201)
    })

    app.get('/hosts/:hostId/sessions/:name/capture', async (c) => {
        const hostId = c.req.param('hostId')
        const name = c.req.param('name')
        const ns = requireNamespace(c)
        if (!isLocalHost(hostId)) {
            if (!clientRegistry?.hasHost(ns, hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                return c.json(await clientRegistry.captureSession(ns, hostId, name))
            } catch (err) {
                return clientRouteError(c, err)
            }
        }
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
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
        const ns = requireNamespace(c)
        if (!isLocalHost(hostId)) {
            if (!clientRegistry?.hasHost(ns, hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                await clientRegistry.killSession(ns, hostId, name)
                return c.body(null, 204)
            } catch (err) {
                return clientRouteError(c, err)
            }
        }
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        try {
            const safe = validateSessionTargetName(name)
            await killSession(safe)
            return c.body(null, 204)
        } catch (err) {
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 400)
        }
    })

    app.get('/sessions/:name/capture', async (c) => {
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
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
        if (!localHostEnabled()) return c.json({ error: 'local_host_disabled' }, 403)
        const name = c.req.param('name')
        try {
            const safe = validateSessionTargetName(name)
            await killSession(safe)
            return c.body(null, 204)
        } catch (err) {
            return c.json({ error: 'tmux_error', message: errMsg(err) }, 400)
        }
    })

    return app
}

function readCaptureQuery(c: Context, extraKeys: string[] = []) {
    const query: Record<string, string | undefined> = {
        lines: c.req.query('lines') ?? undefined,
        maxBytes: c.req.query('maxBytes') ?? undefined
    }
    for (const key of extraKeys) query[key] = c.req.query(key) ?? undefined
    return query
}

function readOptionalInt(value: string | undefined, min: number, max: number): number | undefined | null {
    if (value === undefined) return undefined
    if (!/^[0-9]+$/.test(value)) return null
    const parsed = Number.parseInt(value, 10)
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) return null
    return parsed
}

async function buildClientSnapshot(
    clientRegistry: ClientRegistry | undefined,
    namespace: string,
    query: { lines?: number; maxBytes?: number; capture?: string; captureLimit?: number }
): Promise<TmuxSnapshot> {
    const generatedAt = Date.now()
    const local = getLocalHost()
    const remoteHosts = clientRegistry?.listHosts(namespace) ?? []
    const localIncluded = localHostEnabled()
    const hosts = localIncluded ? [local, ...remoteHosts] : [...remoteHosts]
    const sessions: ReturnType<typeof toTargetSessions> = []
    const panes: ReturnType<typeof toTargetPanes> = []
    const statuses: TmuxPaneStatus[] = []
    const errors: TmuxSnapshotError[] = []

    if (localIncluded) {
        try {
            sessions.push(...toTargetSessions(await listSessions(), local.id, local.name))
        } catch (err) {
            errors.push(snapshotError(local.id, 'list_sessions', err))
        }
        try {
            panes.push(...toTargetPanes(await listPanes(), local.id, local.name))
        } catch (err) {
            errors.push(snapshotError(local.id, 'list_panes', err))
        }
    }

    for (const host of remoteHosts) {
        try {
            sessions.push(...(await clientRegistry!.listSessions(namespace, host.id)))
        } catch (err) {
            errors.push(snapshotError(host.id, 'list_sessions', err))
        }
        try {
            panes.push(...toTargetPanes(await clientRegistry!.listPanes(namespace, host.id), host.id, host.name))
        } catch (err) {
            errors.push(snapshotError(host.id, 'list_panes', err))
        }
    }

    if (isCaptureEnabled(query.capture)) {
        const limit = query.captureLimit ?? 8
        const panesToCapture = selectSnapshotCapturePanes(panes, limit)
        const captureResults = await mapConcurrent<TargetPane, { status: TmuxPaneStatus } | { error: TmuxSnapshotError }>(
            panesToCapture,
            4,
            async (pane) => {
                try {
                    const capture = isLocalHost(pane.hostId)
                        ? await capturePane(pane.target, { lines: query.lines, maxBytes: query.maxBytes })
                        : await clientRegistry!.capturePane(namespace, pane.hostId, pane.target, query.lines, query.maxBytes)
                    return {
                        status: classifyPaneStatus({
                            target: pane.target,
                            pane,
                            capture,
                            activity: trackPaneActivity({ hostId: pane.hostId, target: pane.target, pane, capture })
                        })
                    }
                } catch (err) {
                    return { error: snapshotError(pane.hostId, `capture_pane:${pane.target}`, err) }
                }
            }
        )
        for (const result of captureResults) {
            if ('status' in result) statuses.push(result.status)
            else errors.push(result.error)
        }
    }

    return {
        generatedAt,
        hosts,
        sessions,
        panes,
        ...(isCaptureEnabled(query.capture) ? { statuses } : {}),
        errors
    }
}

function isCaptureEnabled(value: string | undefined): boolean {
    return value === '1' || value === 'true' || value === 'yes'
}

function selectSnapshotCapturePanes(panes: TargetPane[], limit: number): TargetPane[] {
    if (limit <= 0) return []
    const selected: TargetPane[] = []
    const selectedTargets = new Set<string>()
    const selectedHosts = new Set<string>()

    for (const pane of panes) {
        if (selected.length >= limit) return selected
        if (selectedHosts.has(pane.hostId)) continue
        selected.push(pane)
        selectedTargets.add(`${pane.hostId}\0${pane.target}`)
        selectedHosts.add(pane.hostId)
    }

    for (const pane of panes) {
        if (selected.length >= limit) return selected
        const key = `${pane.hostId}\0${pane.target}`
        if (selectedTargets.has(key)) continue
        selected.push(pane)
        selectedTargets.add(key)
    }
    return selected
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results = new Array<R>(items.length)
    let nextIndex = 0
    const workerCount = Math.min(Math.max(concurrency, 1), items.length)
    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++
                results[index] = await fn(items[index])
            }
        })
    )
    return results
}

function snapshotError(hostId: string, operation: string, err: unknown): TmuxSnapshotError {
    if (err instanceof ZodError) {
        return {
            hostId,
            operation,
            error: 'agent_protocol_mismatch'
        }
    }
    const message = errMsg(err)
    return {
        hostId,
        operation,
        error: err instanceof ClientError ? err.message : 'tmux_error',
        message
    }
}

async function recordActionRun(
    actionStore: TmuxActionStore,
    action: TmuxAction,
    hostId: string,
    target: string,
    ok: boolean,
    startedAt: number,
    error?: string
): Promise<TmuxActionRun | null> {
    try {
        return await actionStore.recordRun({
            actionId: action.id,
            label: action.label,
            kind: action.kind,
            hostId,
            target,
            ok,
            error,
            startedAt,
            completedAt: Date.now()
        })
    } catch {
        return null
    }
}

async function issueTargetWsTicket(c: Context, clientRegistry?: ClientRegistry) {
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
    const { hostId, sessionName } = parsed.data
    const ns = requireNamespace(c)
    if (isLocalHost(hostId) && !localHostEnabled()) {
        return c.json({ error: 'local_host_disabled' }, 403)
    }
    if (!isLocalHost(hostId) && !clientRegistry?.hasHost(ns, hostId)) {
        return c.json({ error: 'host_not_found' }, 404)
    }
    return c.json(
        issueWsTicket({
            hostId: isLocalHost(hostId) ? getLocalHost().id : hostId,
            sessionName,
            namespace: ns
        })
    )
}

async function listPanesForHost(
    namespace: string,
    hostId: string,
    session: string | undefined,
    clientRegistry?: ClientRegistry
): Promise<{ panes: ReturnType<typeof toTargetPanes> } | { response: Response }> {
    if (!isLocalHost(hostId)) {
        if (!clientRegistry) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        const host = clientRegistry.listHosts(namespace).find((candidate) => candidate.id === hostId)
        if (!host) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        try {
            const panes = await clientRegistry.listPanes(namespace, hostId, session)
            return { panes: toTargetPanes(panes, host.id, host.name) }
        } catch (err) {
            return { response: await agentErrorResponse(err) }
        }
    }
    if (!localHostEnabled()) return { response: jsonResponse({ error: 'local_host_disabled' }, 403) }
    try {
        const host = getLocalHost()
        const panes = await listPanes(session)
        return { panes: toTargetPanes(panes, host.id, host.name) }
    } catch (err) {
        const message = errMsg(err)
        if (/can't find|no such|not found/i.test(message)) return { response: jsonResponse({ error: 'session_not_found' }, 404) }
        return { response: jsonResponse({ error: 'tmux_error', message }, 400) }
    }
}

function clientRouteError(c: Context, err: unknown) {
    if (err instanceof ZodError) return c.json({ error: 'agent_protocol_mismatch' }, 502)
    const message = errMsg(err)
    if (err instanceof ClientError) {
        if (message === 'host_not_found') return c.json({ error: 'host_not_found' }, 404)
        if (message === 'capability_not_supported') return c.json({ error: 'capability_not_supported' }, 405)
        if (/already exists/i.test(message)) return c.json({ error: 'session_exists' }, 409)
        if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
        if (/invalid/i.test(message)) return c.json({ error: 'tmux_error', message }, 400)
        if (/timeout/i.test(message)) return c.json({ error: 'client_timeout' }, 504)
    }
    if (/already exists/i.test(message)) return c.json({ error: 'session_exists' }, 409)
    if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
    if (/invalid/i.test(message)) return c.json({ error: 'tmux_error', message }, 400)
    return c.json({ error: 'client_error', message }, 502)
}

function actionRouteError(c: Context, err: unknown) {
    const message = errMsg(err)
    if (err instanceof ActionStoreError && message === 'action_exists') return c.json({ error: 'action_exists' }, 409)
    if (err instanceof ZodError) return c.json({ error: 'invalid_body', message }, 400)
    if (/invalid|required|too_small|too_big/i.test(message)) return c.json({ error: 'invalid_body', message }, 400)
    return c.json({ error: 'action_error', message }, 500)
}

async function sendInputToHost(
    namespace: string,
    hostId: string,
    target: string,
    input: { text: string; enter?: boolean },
    clientRegistry?: ClientRegistry
): Promise<{ ok: true } | { response: Response }> {
    if (!isLocalHost(hostId)) {
        if (!clientRegistry?.hasHost(namespace, hostId)) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        try {
            await clientRegistry.sendText(namespace, hostId, target, input.text, input.enter)
            return { ok: true }
        } catch (err) {
            return { response: await agentErrorResponse(err) }
        }
    }
    if (!localHostEnabled()) return { response: jsonResponse({ error: 'local_host_disabled' }, 403) }
    try {
        await sendTextToTarget(target, input.text, input.enter)
        return { ok: true }
    } catch (err) {
        return { response: jsonResponse({ error: 'tmux_error', message: errMsg(err) }, 400) }
    }
}

async function sendKeysToHost(
    namespace: string,
    hostId: string,
    target: string,
    keys: string[],
    clientRegistry?: ClientRegistry
): Promise<{ ok: true } | { response: Response }> {
    if (!isLocalHost(hostId)) {
        if (!clientRegistry?.hasHost(namespace, hostId)) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        try {
            await clientRegistry.sendKeys(namespace, hostId, target, keys)
            return { ok: true }
        } catch (err) {
            return { response: await agentErrorResponse(err) }
        }
    }
    if (!localHostEnabled()) return { response: jsonResponse({ error: 'local_host_disabled' }, 403) }
    try {
        await sendKeysToTarget(target, keys)
        return { ok: true }
    } catch (err) {
        return { response: jsonResponse({ error: 'tmux_error', message: errMsg(err) }, 400) }
    }
}

async function markPaneReadForHost(
    namespace: string,
    hostId: string,
    target: string,
    clientRegistry?: ClientRegistry
): Promise<{ activity: ReturnType<typeof markPaneActivityRead> } | { response: Response }> {
    const readCaptureOptions = { lines: 120, maxBytes: 65_536 }
    if (!isLocalHost(hostId)) {
        if (!clientRegistry?.hasHost(namespace, hostId)) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        try {
            const panes = await clientRegistry.listPanes(namespace, hostId)
            const pane = findPaneForTarget(panes, target)
            const capture = await clientRegistry.capturePane(namespace, hostId, target, readCaptureOptions.lines, readCaptureOptions.maxBytes)
            trackPaneActivity({ hostId, target, pane, capture })
            return { activity: markPaneActivityRead({ hostId, target, pane }) }
        } catch (err) {
            return { response: await agentErrorResponse(err) }
        }
    }
    if (!localHostEnabled()) return { response: jsonResponse({ error: 'local_host_disabled' }, 403) }
    try {
        const panes = await listPanes()
        const pane = findPaneForTarget(panes, target)
        const capture = await capturePane(target, readCaptureOptions)
        trackPaneActivity({ hostId: getLocalHost().id, target, pane, capture })
        const activity = markPaneActivityRead({ hostId: getLocalHost().id, target, pane })
        return activity ? { activity } : { response: jsonResponse({ error: 'tmux_error', message: 'unable_to_mark_activity_as_read' }, 500) }
    } catch (err) {
        const message = errMsg(err)
        if (/can't find|no such|not found/i.test(message)) return { response: jsonResponse({ error: 'session_not_found' }, 404) }
        return { response: jsonResponse({ error: 'tmux_error', message }, 400) }
    }
}

async function runActionOnHost(
    namespace: string,
    hostId: string,
    target: string,
    action: TmuxAction,
    clientRegistry?: ClientRegistry
): Promise<{ ok: true } | { response: Response }> {
    if (action.kind === 'send-keys') {
        return sendKeysToHost(namespace, hostId, target, action.keys ?? [], clientRegistry)
    }
    return sendInputToHost(namespace, hostId, target, { text: action.payload ?? '', enter: action.enter }, clientRegistry)
}

async function agentErrorResponse(err: unknown): Promise<Response> {
    if (err instanceof ZodError) return jsonResponse({ error: 'agent_protocol_mismatch' }, 502)
    const message = errMsg(err)
    if (err instanceof ClientError) {
        if (message === 'host_not_found') return jsonResponse({ error: 'host_not_found' }, 404)
        if (message === 'capability_not_supported') return jsonResponse({ error: 'capability_not_supported' }, 405)
        if (/can't find|no such|not found/i.test(message)) return jsonResponse({ error: 'session_not_found' }, 404)
        if (/invalid/i.test(message)) return jsonResponse({ error: 'tmux_error', message }, 400)
        if (/timeout/i.test(message)) return jsonResponse({ error: 'client_timeout' }, 504)
    }
    if (/invalid/i.test(message)) return jsonResponse({ error: 'tmux_error', message }, 400)
    return jsonResponse({ error: 'client_error', message }, 502)
}

function jsonResponse(body: object, status: number): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'content-type': 'application/json; charset=UTF-8'
        }
    })
}

function toTargetSessions(sessions: TmuxSession[], hostId: string, hostName: string) {
    return sessions.map((session) => ({ ...session, hostId, hostName }))
}

function toTargetPanes(panes: TmuxPane[], hostId: string, hostName: string) {
    return panes.map((pane) => ({ ...pane, hostId, hostName }))
}

function errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

function timestampForFile(): string {
    return new Date().toISOString().replace(/\D/g, '').slice(0, 14)
}

async function saveClipboardImage(c: Context) {
    const form = await c.req.raw.formData().catch(() => null)
    const file = form?.get('file')
    if (!(file instanceof File)) return { response: c.json({ error: 'missing_file' }, 400) }

    const ext = CLIPBOARD_IMAGE_EXTENSIONS[file.type]
    if (!ext) return { response: c.json({ error: 'unsupported_image_type' }, 415) }
    if (file.size <= 0 || file.size > MAX_CLIPBOARD_IMAGE_BYTES) return { response: c.json({ error: 'file_too_large' }, 413) }

    const uploadDir = join(homedir(), '.tmuxd', 'uploads')
    await mkdir(uploadDir, { recursive: true, mode: 0o700 })

    const name = `paste-${timestampForFile()}-${randomUUID().slice(0, 8)}${ext}`
    const path = join(uploadDir, name)
    const bytes = Buffer.from(await file.arrayBuffer())
    await writeFile(path, bytes, { mode: 0o600 })

    return { upload: { path, name, size: bytes.length, type: file.type } }
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}
