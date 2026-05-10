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
import { getLocalHost, isLocalHost } from '../hosts.js'
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
import { AgentError, type AgentRegistry } from '../agentRegistry.js'
import { ActionStoreError, type TmuxActionStore } from '../actions.js'
import { markPaneActivityRead, trackPaneActivity } from '../paneActivity.js'
import { classifyPaneStatus, findPaneForTarget } from '../paneStatus.js'

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

const MAX_CLIPBOARD_IMAGE_BYTES = 20 * 1024 * 1024
const CLIPBOARD_IMAGE_EXTENSIONS: Record<string, string> = {
    'image/png': '.png',
    'image/jpeg': '.jpg',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/bmp': '.bmp',
    'image/tiff': '.tiff'
}

export function createSessionsRoutes(jwtSecret: Uint8Array, agentRegistry: AgentRegistry | undefined, actionStore: TmuxActionStore): Hono {
    const app = new Hono()
    app.use('*', bearerAuth(jwtSecret))

    app.get('/hosts', (c) => {
        return c.json({ hosts: [getLocalHost(), ...(agentRegistry?.listHosts() ?? [])] })
    })

    app.get('/agent/snapshot', async (c) => {
        const query = snapshotQuerySchema.safeParse(readCaptureQuery(c, ['capture', 'captureLimit']))
        if (!query.success) return c.json({ error: 'invalid_query' }, 400)
        return c.json(await buildAgentSnapshot(agentRegistry, query.data))
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
        const result = await listPanesForHost(hostId, session, agentRegistry)
        if ('response' in result) return result.response
        return c.json({ panes: result.panes })
    })

    app.get('/hosts/:hostId/sessions/:name/panes', async (c) => {
        const hostId = c.req.param('hostId')
        const name = c.req.param('name')
        const result = await listPanesForHost(hostId, name, agentRegistry)
        if ('response' in result) return result.response
        return c.json({ panes: result.panes })
    })

    app.get('/hosts/:hostId/panes/:target/capture', async (c) => {
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const query = paneCaptureQuerySchema.safeParse(readCaptureQuery(c))
        if (!query.success) return c.json({ error: 'invalid_query' }, 400)
        if (!isLocalHost(hostId)) {
            if (!agentRegistry?.hasHost(hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                return c.json(await agentRegistry.capturePane(hostId, target, query.data.lines, query.data.maxBytes))
            } catch (err) {
                return agentRouteError(c, err)
            }
        }
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
        const query = paneCaptureQuerySchema.safeParse(readCaptureQuery(c))
        if (!query.success) return c.json({ error: 'invalid_query' }, 400)
        if (!isLocalHost(hostId)) {
            if (!agentRegistry?.hasHost(hostId)) return c.json({ error: 'host_not_found' }, 404)
            try {
                const panes = await agentRegistry.listPanes(hostId)
                const capture = await agentRegistry.capturePane(hostId, target, query.data.lines, query.data.maxBytes)
                const pane = findPaneForTarget(panes, target)
                return c.json(classifyPaneStatus({ target, pane, capture, activity: trackPaneActivity({ hostId, target, pane, capture }) }))
            } catch (err) {
                return agentRouteError(c, err)
            }
        }
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
        const result = await markPaneReadForHost(hostId, target, agentRegistry)
        if ('response' in result) return result.response
        return c.json({ ok: true, activity: result.activity })
    })

    app.post('/hosts/:hostId/panes/:target/input', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = sendTextRequestSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const result = await sendInputToHost(hostId, target, parsed.data, agentRegistry)
        if ('response' in result) return result.response
        return c.json({ ok: true })
    })

    app.post('/hosts/:hostId/panes/:target/keys', async (c) => {
        const body = await c.req.json().catch(() => null)
        const parsed = sendKeysRequestSchema.safeParse(body)
        if (!parsed.success) return c.json({ error: 'invalid_body' }, 400)
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const result = await sendKeysToHost(hostId, target, parsed.data.keys, agentRegistry)
        if ('response' in result) return result.response
        return c.json({ ok: true })
    })

    app.post('/hosts/:hostId/panes/:target/actions/:actionId/run', async (c) => {
        const hostId = c.req.param('hostId')
        const target = c.req.param('target')
        const actionId = c.req.param('actionId')
        const parsedActionId = tmuxActionIdSchema.safeParse(actionId)
        if (!parsedActionId.success) return c.json({ error: 'invalid_action_id' }, 400)
        const action = await actionStore.get(parsedActionId.data)
        if (!action) return c.json({ error: 'action_not_found' }, 404)
        const startedAt = Date.now()
        const result = await runActionOnHost(hostId, target, action, agentRegistry)
        if ('response' in result) {
            await recordActionRun(actionStore, action, hostId, target, false, startedAt, `http_${result.response.status}`)
            return result.response
        }
        const run = await recordActionRun(actionStore, action, hostId, target, true, startedAt)
        return c.json({ ok: true, actionId: action.id, hostId, target, runId: run?.id })
    })

    app.post('/uploads/clipboard-image', async (c) => {
        const result = await saveClipboardImage(c)
        if ('response' in result) return result.response
        return c.json(result.upload, 201)
    })

    app.post('/sessions/:name/uploads/clipboard-image', async (c) => {
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
            const safe = validateSessionTargetName(name)
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

async function buildAgentSnapshot(
    agentRegistry: AgentRegistry | undefined,
    query: { lines?: number; maxBytes?: number; capture?: string; captureLimit?: number }
): Promise<TmuxSnapshot> {
    const generatedAt = Date.now()
    const local = getLocalHost()
    const remoteHosts = agentRegistry?.listHosts() ?? []
    const hosts = [local, ...remoteHosts]
    const sessions: ReturnType<typeof toTargetSessions> = []
    const panes: ReturnType<typeof toTargetPanes> = []
    const statuses: TmuxPaneStatus[] = []
    const errors: TmuxSnapshotError[] = []

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

    for (const host of remoteHosts) {
        try {
            sessions.push(...(await agentRegistry!.listSessions(host.id)))
        } catch (err) {
            errors.push(snapshotError(host.id, 'list_sessions', err))
        }
        try {
            panes.push(...toTargetPanes(await agentRegistry!.listPanes(host.id), host.id, host.name))
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
                        : await agentRegistry!.capturePane(pane.hostId, pane.target, query.lines, query.maxBytes)
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
        error: err instanceof AgentError ? err.message : 'tmux_error',
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
    const { hostId, sessionName } = parsed.data
    if (!isLocalHost(hostId) && !agentRegistry?.hasHost(hostId)) return c.json({ error: 'host_not_found' }, 404)
    return c.json(issueWsTicket({ hostId: isLocalHost(hostId) ? getLocalHost().id : hostId, sessionName }))
}

async function listPanesForHost(
    hostId: string,
    session: string | undefined,
    agentRegistry?: AgentRegistry
): Promise<{ panes: ReturnType<typeof toTargetPanes> } | { response: Response }> {
    if (!isLocalHost(hostId)) {
        if (!agentRegistry) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        const host = agentRegistry.listHosts().find((candidate) => candidate.id === hostId)
        if (!host) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        try {
            const panes = await agentRegistry.listPanes(hostId, session)
            return { panes: toTargetPanes(panes, host.id, host.name) }
        } catch (err) {
            return { response: await agentErrorResponse(err) }
        }
    }
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

function agentRouteError(c: Context, err: unknown) {
    if (err instanceof ZodError) return c.json({ error: 'agent_protocol_mismatch' }, 502)
    const message = errMsg(err)
    if (err instanceof AgentError) {
        if (message === 'host_not_found') return c.json({ error: 'host_not_found' }, 404)
        if (message === 'capability_not_supported') return c.json({ error: 'capability_not_supported' }, 405)
        if (/already exists/i.test(message)) return c.json({ error: 'session_exists' }, 409)
        if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
        if (/invalid/i.test(message)) return c.json({ error: 'tmux_error', message }, 400)
        if (/timeout/i.test(message)) return c.json({ error: 'agent_timeout' }, 504)
    }
    if (/already exists/i.test(message)) return c.json({ error: 'session_exists' }, 409)
    if (/can't find|no such|not found/i.test(message)) return c.json({ error: 'session_not_found' }, 404)
    if (/invalid/i.test(message)) return c.json({ error: 'tmux_error', message }, 400)
    return c.json({ error: 'agent_error', message }, 502)
}

function actionRouteError(c: Context, err: unknown) {
    const message = errMsg(err)
    if (err instanceof ActionStoreError && message === 'action_exists') return c.json({ error: 'action_exists' }, 409)
    if (err instanceof ZodError) return c.json({ error: 'invalid_body', message }, 400)
    if (/invalid|required|too_small|too_big/i.test(message)) return c.json({ error: 'invalid_body', message }, 400)
    return c.json({ error: 'action_error', message }, 500)
}

async function sendInputToHost(
    hostId: string,
    target: string,
    input: { text: string; enter?: boolean },
    agentRegistry?: AgentRegistry
): Promise<{ ok: true } | { response: Response }> {
    if (!isLocalHost(hostId)) {
        if (!agentRegistry?.hasHost(hostId)) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        try {
            await agentRegistry.sendText(hostId, target, input.text, input.enter)
            return { ok: true }
        } catch (err) {
            return { response: await agentErrorResponse(err) }
        }
    }
    try {
        await sendTextToTarget(target, input.text, input.enter)
        return { ok: true }
    } catch (err) {
        return { response: jsonResponse({ error: 'tmux_error', message: errMsg(err) }, 400) }
    }
}

async function sendKeysToHost(
    hostId: string,
    target: string,
    keys: string[],
    agentRegistry?: AgentRegistry
): Promise<{ ok: true } | { response: Response }> {
    if (!isLocalHost(hostId)) {
        if (!agentRegistry?.hasHost(hostId)) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        try {
            await agentRegistry.sendKeys(hostId, target, keys)
            return { ok: true }
        } catch (err) {
            return { response: await agentErrorResponse(err) }
        }
    }
    try {
        await sendKeysToTarget(target, keys)
        return { ok: true }
    } catch (err) {
        return { response: jsonResponse({ error: 'tmux_error', message: errMsg(err) }, 400) }
    }
}

async function markPaneReadForHost(
    hostId: string,
    target: string,
    agentRegistry?: AgentRegistry
): Promise<{ activity: ReturnType<typeof markPaneActivityRead> } | { response: Response }> {
    const readCaptureOptions = { lines: 120, maxBytes: 65_536 }
    if (!isLocalHost(hostId)) {
        if (!agentRegistry?.hasHost(hostId)) return { response: jsonResponse({ error: 'host_not_found' }, 404) }
        try {
            const panes = await agentRegistry.listPanes(hostId)
            const pane = findPaneForTarget(panes, target)
            const capture = await agentRegistry.capturePane(hostId, target, readCaptureOptions.lines, readCaptureOptions.maxBytes)
            trackPaneActivity({ hostId, target, pane, capture })
            return { activity: markPaneActivityRead({ hostId, target, pane }) }
        } catch (err) {
            return { response: await agentErrorResponse(err) }
        }
    }
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
    hostId: string,
    target: string,
    action: TmuxAction,
    agentRegistry?: AgentRegistry
): Promise<{ ok: true } | { response: Response }> {
    if (action.kind === 'send-keys') {
        return sendKeysToHost(hostId, target, action.keys ?? [], agentRegistry)
    }
    return sendInputToHost(hostId, target, { text: action.payload ?? '', enter: action.enter }, agentRegistry)
}

async function agentErrorResponse(err: unknown): Promise<Response> {
    if (err instanceof ZodError) return jsonResponse({ error: 'agent_protocol_mismatch' }, 502)
    const message = errMsg(err)
    if (err instanceof AgentError) {
        if (message === 'host_not_found') return jsonResponse({ error: 'host_not_found' }, 404)
        if (message === 'capability_not_supported') return jsonResponse({ error: 'capability_not_supported' }, 405)
        if (/can't find|no such|not found/i.test(message)) return jsonResponse({ error: 'session_not_found' }, 404)
        if (/invalid/i.test(message)) return jsonResponse({ error: 'tmux_error', message }, 400)
        if (/timeout/i.test(message)) return jsonResponse({ error: 'agent_timeout' }, 504)
    }
    if (/invalid/i.test(message)) return jsonResponse({ error: 'tmux_error', message }, 400)
    return jsonResponse({ error: 'agent_error', message }, 502)
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
