import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createSessionsRoutes } from './sessions.js'
import { issueToken } from '../auth.js'
import { TmuxActionStore } from '../actions.js'
import { AgentError } from '../agentRegistry.js'
import { parseCaptureMetadata } from '../tmux.test.js'
import type { TmuxPaneCapture, TmuxPaneStatus, TmuxSession } from '@tmuxd/shared'

function authHeader(token: string): { Authorization: string } {
    return { Authorization: `Bearer ${token}` }
}

interface FakeTmuxCall {
    args: string[]
}

interface FakeTmuxFixture {
    calls: FakeTmuxCall[]
    statePath: string
    workDir: string
    token: string
    app: Hono
    cleanup: () => Promise<void>
}

async function createFakeTmuxScript(workDir: string): Promise<string> {
    const scriptPath = join(workDir, 'tmux')
    const script = String.raw`#!/usr/bin/env node
const fs = require('node:fs')

const statePath = process.env.TMUXD_FAKE_TMUX_STATE || ''
const logPath = process.env.TMUXD_FAKE_TMUX_LOG || ''

function readState() {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'))
}

function writeState(state) {
    fs.writeFileSync(statePath, JSON.stringify(state))
}

function fail(message, code = 1) {
    if (message) process.stderr.write(String(message))
    process.exit(code)
}

function log(entry) {
    if (!logPath) return
    fs.appendFileSync(logPath, JSON.stringify(entry) + '\n')
}

function listSessionsOutput(state) {
    return state.sessions
        .map((session) => [
            session.name,
            session.windows,
            session.attachedClients > 0 ? '1' : '0',
            session.created,
            session.activity
        ].join('\t'))
        .join('\n')
}

function paneRecord(pane) {
    return [
        pane.sessionName,
        String(pane.windowIndex),
        pane.windowName,
        pane.windowActive ? '1' : '0',
        String(pane.paneIndex),
        pane.paneId,
        pane.paneActive ? '1' : '0',
        pane.paneDead ? '1' : '0',
        pane.currentCommand,
        pane.currentPath,
        pane.title,
        String(pane.width),
        String(pane.height),
        pane.paneInMode ? '1' : '0',
        String(pane.scrollPosition),
        String(pane.historySize),
        String(pane.sessionAttachedClients),
        String(pane.sessionActivity),
        String(pane.windowActivity)
    ].join('\t')
}

function listPanesOutput(state, sessionName) {
    const filtered = sessionName ? state.panes.filter((pane) => pane.sessionName === sessionName) : state.panes
    return filtered.map(paneRecord).join('\n')
}

function findPane(state, target) {
    if (!target) return null
    if (target.startsWith('%')) {
        return state.panes.find((pane) => pane.paneId === target)
    }
    if (target.includes('.')) {
        return state.panes.find((pane) => pane.target === target)
    }
    if (target.includes(':')) {
        const [sessionName] = target.split(':', 1)
        return state.panes.find((pane) => pane.sessionName === sessionName) || state.panes.find((pane) => pane.target === target)
    }
    return state.panes.find((pane) => pane.sessionName === target)
}

function hasSession(state, name) {
    return state.sessions.some((session) => session.name === name)
}

function findSession(state, name) {
    return state.sessions.find((session) => session.name === name)
}

const raw = process.argv.slice(2)
log({ args: raw })
if (!raw.length) fail('missing tmux command', 2)
if (!statePath) fail('TMUXD_FAKE_TMUX_STATE not set', 2)

const cmd = raw[0]
const state = readState()

if (cmd === 'list-sessions') {
    process.stdout.write(listSessionsOutput(state))
    process.exit(0)
}

if (cmd === 'has-session') {
    const tIndex = raw.indexOf('-t')
    const name = raw[tIndex + 1]
    if (!name || !hasSession(state, name)) fail("can't find session")
    process.exit(0)
}

if (cmd === 'new-session') {
    const sIndex = raw.indexOf('-s')
    const name = raw[sIndex + 1]
    if (!name || hasSession(state, name)) fail('Session already exists')
    const created = 100000
    state.sessions.push({
        name,
        windows: 1,
        attached: false,
        attachedClients: 0,
        created,
        activity: created
    })
            state.panes.push({
                target: name + ':0.0',
                sessionName: name,
        windowIndex: 0,
        windowName: 'created',
        windowActive: true,
        paneIndex: 0,
                paneId: '%' + state.nextPaneId++,
        paneActive: true,
        paneDead: false,
        currentCommand: 'bash',
        currentPath: '/tmp',
        title: 'bash',
        width: 80,
        height: 24,
        paneInMode: false,
        scrollPosition: 0,
        historySize: 100,
        sessionAttached: false,
        sessionAttachedClients: 0,
        sessionActivity: created,
        windowActivity: created
    })
    writeState(state)
    process.exit(0)
}

if (cmd === 'kill-session') {
    const tIndex = raw.indexOf('-t')
    const name = raw[tIndex + 1]
    if (!name || !hasSession(state, name)) fail('no such session')
    state.sessions = state.sessions.filter((session) => session.name !== name)
    state.panes = state.panes.filter((pane) => pane.sessionName !== name)
    writeState(state)
    process.exit(0)
}

if (cmd === 'list-panes') {
    const target = (() => {
        const tIndex = raw.lastIndexOf('-t')
        return tIndex >= 0 ? raw[tIndex + 1] : null
    })()
    process.stdout.write(listPanesOutput(state, target))
    process.exit(0)
}

if (cmd === 'display-message') {
    process.stdout.write('0\t0\t200\t24\n')
    process.exit(0)
}

if (cmd === 'capture-pane') {
    const target = (() => {
        const tIndex = raw.lastIndexOf('-t')
        return tIndex >= 0 ? raw[tIndex + 1] : null
    })()
    const pane = findPane(state, target)
    if (!pane) fail('can\'t find target')
    const text = state.captures[target] || state.captures[pane.target] || pane.sessionName + ' capture\\n'
    process.stdout.write(text)
    process.exit(0)
}

if (cmd === 'send-keys') {
    const tIndex = raw.indexOf('-t')
    const target = raw[tIndex + 1]
    if (!target) fail('no target')
    if (!findPane(state, target)) fail("can't find pane")
    process.exit(0)
}

fail('unknown tmux command', 1)
`
    await writeFile(scriptPath, script, { mode: 0o755 })
    return scriptPath
}

async function installFakeTmux(defaultState: { sessions: TmuxSession[]; panes: any[]; captures: Record<string, string>; nextPaneId: number }, preserveStatePath?: string): Promise<FakeTmuxFixture> {
    const workDir = await mkdtemp(join(tmpdir(), 'tmuxd-fake-tmux-'))
    const statePath = preserveStatePath || join(workDir, 'tmux-state.json')
    const logPath = join(workDir, 'tmux-calls.log')
    await writeFile(statePath, JSON.stringify(defaultState), 'utf8')
    await writeFile(join(workDir, 'tmux.log'), '')
    await createFakeTmuxScript(workDir)

    const tmuxScriptPath = join(workDir, 'tmux')
    const originalPath = process.env.PATH ?? ''
    const originalState = process.env.TMUXD_FAKE_TMUX_STATE
    const originalLog = process.env.TMUXD_FAKE_TMUX_LOG
    process.env.PATH = `${workDir}:${originalPath}`
    process.env.TMUXD_FAKE_TMUX_STATE = statePath
    process.env.TMUXD_FAKE_TMUX_LOG = logPath

    const jwtSecret = new TextEncoder().encode('test-jwt-secret')
    const { token } = await issueToken(jwtSecret)
    const app = new Hono()

    const actionStore = TmuxActionStore.inDataDir(join(workDir, 'actions'))
    const remoteHost = {
        id: 'remote',
        name: 'Remote',
        status: 'online',
        isLocal: false,
        version: '0.1.0',
        lastSeenAt: 1700001000,
        capabilities: ['list', 'create', 'kill', 'capture', 'attach', 'panes', 'input']
    } as const

    const remotePanes = [
        {
            target: 'remote:0.0',
            sessionName: 'remote',
            windowIndex: 0,
            windowName: 'vim',
            windowActive: true,
            paneIndex: 0,
            paneId: '%r0',
            paneActive: true,
            paneDead: false,
            currentCommand: 'bash',
            currentPath: '/tmp',
            title: 'remote-title',
            width: 80,
            height: 24,
            paneInMode: false,
            scrollPosition: 1,
            historySize: 240,
            sessionAttached: false,
            sessionAttachedClients: 0,
            sessionActivity: 1700003000,
            windowActivity: 1700003000
        }
    ]

    const agentRegistry = {
        listHosts: () => [remoteHost],
        hasHost: (id: string) => id === remoteHost.id,
        listSessions: async () => [
            {
                name: 'remote',
                windows: 1,
                attached: false,
                attachedClients: 0,
                created: 900,
                activity: 1700002000
            }
        ],
        createSession: async () => {
            return
        },
        killSession: async () => {
            return
        },
        captureSession: async (_hostId: string, name: string) => {
            if (name !== 'remote') throw new AgentError("can't find session")
            return {
                text: 'remote session capture\\n',
                paneInMode: false,
                scrollPosition: 3,
                historySize: 300,
                paneHeight: 24
            } satisfies TmuxPaneCapture
        },
        listPanes: async (_hostId: string, session?: string) =>
            session ? remotePanes.filter((pane) => pane.sessionName === session) : remotePanes,
        capturePane: async (_hostId: string, target: string) => {
            if (target === 'bad-target') {
                const err: NodeJS.ErrnoException = new Error('timeout from remote') as NodeJS.ErrnoException
                err.message = 'timeout'
                throw err
            }
            return {
                target,
                text: 'remote pane output\n',
                truncated: false,
                maxBytes: 262144,
                paneInMode: false,
                scrollPosition: 1,
                historySize: 120,
                paneHeight: 24
            } as TmuxPaneCapture
        },
        sendText: async () => {
            return
        },
        sendKeys: async () => {
            return
        },
        attach: async () => {
            throw new Error('not implemented')
        }
    } as any

    app.route('/api', createSessionsRoutes(jwtSecret, agentRegistry, actionStore))

    const calls = async (): Promise<FakeTmuxCall[]> => {
        try {
            const raw = await readFile(logPath, 'utf8')
            if (!raw.trim()) return []
            return raw
                .trim()
                .split('\n')
                .filter(Boolean)
                .map((line) => JSON.parse(line) as FakeTmuxCall)
        } catch {
            return []
        }
    }

    const cleanup = async () => {
        process.env.PATH = originalPath
        if (originalState === undefined) {
            delete process.env.TMUXD_FAKE_TMUX_STATE
        } else {
            process.env.TMUXD_FAKE_TMUX_STATE = originalState
        }
        if (originalLog === undefined) {
            delete process.env.TMUXD_FAKE_TMUX_LOG
        } else {
            process.env.TMUXD_FAKE_TMUX_LOG = originalLog
        }
        await rm(workDir, { recursive: true, force: true })
    }

    return {
        calls,
        statePath,
        workDir,
        token,
        app,
        cleanup
    }
}

describe('tmuxd sessions api', { concurrency: 1 }, () => {
    it('requires auth for all sessions routes', async () => {
        const { app, cleanup } = await installFakeTmux({
            sessions: [
                {
                    name: 'main',
                    windows: 1,
                    attached: true,
                    attachedClients: 1,
                    created: 111,
                    activity: 222
                }
            ],
            panes: [],
            captures: {},
            nextPaneId: 10
        })
        try {
            const response = await app.request('/api/hosts')
            assert.equal(response.status, 401)
            assert.deepEqual(await response.json(), { error: 'missing_token' })
        } finally {
            await cleanup()
        }
    })

    it('lists hosts, local sessions/panes, and remote host inventories', async () => {
        const { app, token, cleanup } = await installFakeTmux({
            sessions: [
                {
                    name: 'main',
                    windows: 1,
                    attached: true,
                    attachedClients: 1,
                    created: 111,
                    activity: 222
                }
            ],
            panes: [
                {
                    target: 'main:0.0',
                    sessionName: 'main',
                    windowIndex: 0,
                    windowName: 'zsh',
                    windowActive: true,
                    paneIndex: 0,
                    paneId: '%1',
                    paneActive: true,
                    paneDead: false,
                    currentCommand: 'bash',
                    currentPath: '/home/ubuntu',
                    title: 'zsh',
                    width: 80,
                    height: 24,
                    paneInMode: false,
                    scrollPosition: 0,
                    historySize: 100,
                    sessionAttached: false,
                    sessionAttachedClients: 0,
                    sessionActivity: 222,
                    windowActivity: 333
                }
            ],
            captures: { 'main:0.0': 'hello\n' },
            nextPaneId: 10
        })
        try {
            const headers = authHeader(token)
            const hostsResponse = await app.request('/api/hosts', { headers })
            const hostsBody = (await hostsResponse.json()) as { hosts: Array<{ id: string }> }
            assert.equal(hostsResponse.status, 200)
            assert.equal(hostsBody.hosts.length, 2)

            const sessionsResponse = await app.request('/api/sessions', { headers })
            const sessionsBody = (await sessionsResponse.json()) as { sessions: unknown[] }
            assert.equal(sessionsResponse.status, 200)
            assert.equal(sessionsBody.sessions.length, 1)

            const remoteSessionsResponse = await app.request('/api/hosts/remote/sessions', { headers })
            const remoteSessionsBody = (await remoteSessionsResponse.json()) as { sessions: unknown[] }
            assert.equal(remoteSessionsResponse.status, 200)
            assert.equal(remoteSessionsBody.sessions[0].name, 'remote')

            const remotePanesResponse = await app.request('/api/hosts/remote/panes?session=remote', { headers })
            const remotePanesBody = (await remotePanesResponse.json()) as { panes: unknown[] }
            assert.equal(remotePanesResponse.status, 200)
            assert.equal(remotePanesBody.panes.length, 1)
            assert.equal(remotePanesBody.panes[0].target, 'remote:0.0')
        } finally {
            await cleanup()
        }
    })

    it('creates and deletes local sessions through the local tmux route', async () => {
        const state = {
            sessions: [
                {
                    name: 'main',
                    windows: 1,
                    attached: true,
                    attachedClients: 1,
                    created: 111,
                    activity: 222
                }
            ],
            panes: [],
            captures: {},
            nextPaneId: 10
        }
        const fixture = await installFakeTmux(state)
        try {
            const headers = authHeader(fixture.token)

            const createResponse = await fixture.app.request('/api/sessions', {
                method: 'POST',
                headers: {
                    ...headers,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ name: 'work' })
            })
            assert.equal(createResponse.status, 201)

            const existsResponse = await fixture.app.request('/api/sessions', {
                method: 'POST',
                headers: {
                    ...headers,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ name: 'main' })
            })
            assert.equal(existsResponse.status, 409)

            const deleteResponse = await fixture.app.request('/api/sessions/work', { method: 'DELETE', headers })
            assert.equal(deleteResponse.status, 204)

            const calls = await fixture.calls()
            assert.equal(calls.length >= 3, true)
            assert.ok(calls.some((entry) => entry.args[0] === 'has-session'))
            assert.ok(calls.some((entry) => entry.args[0] === 'new-session'))
            assert.ok(calls.some((entry) => entry.args[0] === 'kill-session'))
        } finally {
            await fixture.cleanup()
        }
    })

    it('gets captures/status and supports activity/read for local and remote panes', async () => {
        const state = {
            sessions: [
                {
                    name: 'main',
                    windows: 1,
                    attached: true,
                    attachedClients: 1,
                    created: 111,
                    activity: 222
                }
            ],
            panes: [
                {
                    target: 'main:0.0',
                    sessionName: 'main',
                    windowIndex: 0,
                    windowName: 'zsh',
                    windowActive: true,
                    paneIndex: 0,
                    paneId: '%1',
                    paneActive: true,
                    paneDead: false,
                    currentCommand: 'bash',
                    currentPath: '/home/ubuntu',
                    title: 'zsh',
                    width: 80,
                    height: 24,
                    paneInMode: false,
                    scrollPosition: 0,
                    historySize: 100,
                    sessionAttached: false,
                    sessionAttachedClients: 0,
                    sessionActivity: 222,
                    windowActivity: 333
                }
            ],
            captures: {
                'main:0.0': 'workbench output\n',
                main: 'session capture?'
            },
            nextPaneId: 10
        }
        const { app, token, cleanup } = await installFakeTmux(state)
        try {
            const headers = authHeader(token)

            const captureResponse = await app.request(
                `/api/hosts/local/panes/${encodeURIComponent('main:0.0')}/capture?lines=200&maxBytes=2048`,
                {
                    headers
                }
            )
            assert.equal(captureResponse.status, 200)
            const captureBody = (await captureResponse.json()) as TmuxPaneCapture
            assert.equal(captureBody.target, 'main:0.0')
            assert.equal(captureBody.text, 'workbench output\n')

            const statusResponse = await app.request(`/api/hosts/local/panes/${encodeURIComponent('main:0.0')}/status`, { headers })
            const statusBody = (await statusResponse.json()) as TmuxPaneStatus
            assert.equal(statusResponse.status, 200)
            assert.equal(statusBody.target, 'main:0.0')
            assert.ok(typeof statusBody.activity?.seq === 'number')

            const readResponse = await app.request(`/api/hosts/local/panes/${encodeURIComponent('main:0.0')}/activity/read`, {
                method: 'POST',
                headers
            })
            const readBody = (await readResponse.json()) as { ok: boolean }
            assert.equal(readResponse.status, 200)
            assert.equal(readBody.ok, true)

            const remoteCaptureResponse = await app.request('/api/hosts/remote/panes/remote:0.0/capture', {
                headers
            })
            const remoteCaptureBody = (await remoteCaptureResponse.json()) as TmuxPaneCapture
            assert.equal(remoteCaptureResponse.status, 200)
            assert.equal(remoteCaptureBody.text, 'remote pane output\n')
        } finally {
            await cleanup()
        }
    })

    it('validates action payloads and runs actions', async () => {
        const { app, token, cleanup } = await installFakeTmux({
            sessions: [
                {
                    name: 'main',
                    windows: 1,
                    attached: true,
                    attachedClients: 1,
                    created: 111,
                    activity: 222
                }
            ],
            panes: [
                {
                    target: 'main:0.0',
                    sessionName: 'main',
                    windowIndex: 0,
                    windowName: 'zsh',
                    windowActive: true,
                    paneIndex: 0,
                    paneId: '%1',
                    paneActive: true,
                    paneDead: false,
                    currentCommand: 'bash',
                    currentPath: '/home/ubuntu',
                    title: 'zsh',
                    width: 80,
                    height: 24,
                    paneInMode: false,
                    scrollPosition: 0,
                    historySize: 100,
                    sessionAttached: false,
                    sessionAttachedClients: 0,
                    sessionActivity: 222,
                    windowActivity: 333
                }
            ],
            captures: {},
            nextPaneId: 11
        })
        try {
            const headers = authHeader(token)

            const invalidLabelResponse = await app.request('/api/actions', {
                method: 'POST',
                headers: {
                    ...headers,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ kind: 'send-text', payload: '/status' })
            })
            assert.equal(invalidLabelResponse.status, 400)
            const invalidBody = (await invalidLabelResponse.json()) as { error: string }
            assert.equal(invalidBody.error, 'invalid_body')

            const createTextResponse = await app.request('/api/actions', {
                method: 'POST',
                headers: {
                    ...headers,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    label: 'Status',
                    kind: 'send-text',
                    payload: '/status',
                    enter: true
                })
            })
            assert.equal(createTextResponse.status, 201)
            const createdText = (await createTextResponse.json()) as { action: { id: string; kind: string } }
            const firstActionId = createdText.action.id

            const createKeysResponse = await app.request('/api/actions', {
                method: 'POST',
                headers: {
                    ...headers,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    label: 'Interrupt',
                    kind: 'send-keys',
                    keys: ['C-c']
                })
            })
            assert.equal(createKeysResponse.status, 201)
            const createdKeys = (await createKeysResponse.json()) as { action: { id: string; kind: string } }

            const listResponse = await app.request('/api/actions', { headers })
            const listBody = (await listResponse.json()) as { actions: Array<{ id: string }> }
            assert.equal(listBody.actions.length, 2)

            const updateResponse = await app.request(`/api/actions/${firstActionId}`, {
                method: 'PUT',
                headers: {
                    ...headers,
                    'content-type': 'application/json'
                },
                body: JSON.stringify({ label: 'Status2', kind: 'send-text', payload: '/status -v', enter: true })
            })
            assert.equal(updateResponse.status, 200)
            const updated = (await updateResponse.json()) as { action: { id: string; label: string } }
            assert.equal(updated.action.label, 'Status2')

            const runResponse = await app.request(
                `/api/hosts/local/panes/${encodeURIComponent('main:0.0')}/actions/${createdKeys.action.id}/run`,
                {
                    method: 'POST',
                    headers
                }
            )
            assert.equal(runResponse.status, 200)
            const runBody = (await runResponse.json()) as { ok: boolean; runId?: string }
            assert.equal(runBody.ok, true)

            const missingIdResponse = await app.request('/api/hosts/local/panes/main:0.0/actions/nope/run', {
                method: 'POST',
                headers
            })
            assert.equal(missingIdResponse.status, 404)

            const invalidIdResponse = await app.request('/api/hosts/local/panes/main:0.0/actions/bad$id/run', {
                method: 'POST',
                headers
            })
            assert.equal(invalidIdResponse.status, 400)

            const historyResponse = await app.request('/api/actions/history?limit=abc', {
                headers
            })
            assert.equal(historyResponse.status, 400)

            const deleteResponse = await app.request(`/api/actions/${createdKeys.action.id}`, { method: 'DELETE', headers })
            assert.equal(deleteResponse.status, 204)
        } finally {
            await cleanup()
        }
    })

    it('enforces key and input payload validation', async () => {
        const { app, token, cleanup, calls } = await installFakeTmux({
            sessions: [
                {
                    name: 'main',
                    windows: 1,
                    attached: true,
                    attachedClients: 1,
                    created: 111,
                    activity: 222
                }
            ],
            panes: [
                {
                    target: 'main:0.0',
                    sessionName: 'main',
                    windowIndex: 0,
                    windowName: 'zsh',
                    windowActive: true,
                    paneIndex: 0,
                    paneId: '%1',
                    paneActive: true,
                    paneDead: false,
                    currentCommand: 'bash',
                    currentPath: '/home/ubuntu',
                    title: 'zsh',
                    width: 80,
                    height: 24,
                    paneInMode: false,
                    scrollPosition: 0,
                    historySize: 100,
                    sessionAttached: false,
                    sessionAttachedClients: 0,
                    sessionActivity: 222,
                    windowActivity: 333
                }
            ],
            captures: {},
            nextPaneId: 10
        })
        try {
            const headers = authHeader(token)

            const missingTextResponse = await app.request(`/api/hosts/local/panes/${encodeURIComponent('main:0.0')}/input`, {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ text: '' })
            })
            assert.equal(missingTextResponse.status, 400)

            const badKeysResponse = await app.request(`/api/hosts/local/panes/${encodeURIComponent('main:0.0')}/keys`, {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ keys: ['-t', 'other', 'Enter'] })
            })
            assert.equal(badKeysResponse.status, 400)
            const badKeysBody = await badKeysResponse.json()
            assert.equal((badKeysBody as { error: string }).error, 'invalid_body')

            const validKeysResponse = await app.request(`/api/hosts/local/panes/${encodeURIComponent('main:0.0')}/keys`, {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ keys: ['C-c'] })
            })
            assert.equal(validKeysResponse.status, 200)

            const allCalls = await calls()
            assert.equal(
                allCalls.some((entry) => entry.args[0] === 'send-keys' && entry.args.includes('C-c')),
                true
            )
            assert.equal(
                allCalls.some((entry) => entry.args[0] === 'send-keys' && entry.args[1] === '-t' && entry.args[2] === 'main:0.0'),
                true
            )

            const localCaptureResponse = await app.request(`/api/hosts/remote/sessions/missing/capture`, { headers })
            assert.equal(localCaptureResponse.status, 404)
        } finally {
            await cleanup()
        }
    })

    it('returns agent snapshots with optional capture support', async () => {
        const { app, token, cleanup } = await installFakeTmux({
            sessions: [
                {
                    name: 'main',
                    windows: 1,
                    attached: true,
                    attachedClients: 1,
                    created: 111,
                    activity: 222
                }
            ],
            panes: [
                {
                    target: 'main:0.0',
                    sessionName: 'main',
                    windowIndex: 0,
                    windowName: 'zsh',
                    windowActive: true,
                    paneIndex: 0,
                    paneId: '%1',
                    paneActive: true,
                    paneDead: false,
                    currentCommand: 'bash',
                    currentPath: '/home/ubuntu',
                    title: 'zsh',
                    width: 80,
                    height: 24,
                    paneInMode: false,
                    scrollPosition: 0,
                    historySize: 100,
                    sessionAttached: false,
                    sessionAttachedClients: 0,
                    sessionActivity: 222,
                    windowActivity: 333
                }
            ],
            captures: { 'main:0.0': 'hello' },
            nextPaneId: 10
        })
        try {
            const headers = authHeader(token)

            const snapshotResponse = await app.request('/api/agent/snapshot', { headers })
            const snapshotBody = (await snapshotResponse.json()) as {
                hosts: Array<{ id: string }>
                sessions: Array<{ target: string }>
                panes: Array<{ target: string }>
                statuses?: TmuxPaneStatus[]
            }
            assert.equal(snapshotResponse.status, 200)
            assert.equal(snapshotBody.hosts.length, 2)
            assert.equal(snapshotBody.sessions.length, 2)
            assert.equal(snapshotBody.panes.length, 2)
            assert.equal(snapshotBody.statuses, undefined)

            const captureSnapshotResponse = await app.request('/api/agent/snapshot?capture=1&captureLimit=1&lines=120&maxBytes=2048', {
                headers
            })
            const captureSnapshotBody = (await captureSnapshotResponse.json()) as { statuses?: TmuxPaneStatus[] }
            assert.equal(captureSnapshotResponse.status, 200)
            assert.ok(captureSnapshotBody.statuses !== undefined)
            assert.equal(captureSnapshotBody.statuses.length, 1)
        } finally {
            await cleanup()
        }
    })

    it('handles ws ticket and host not found cases consistently', async () => {
        const { app, token, cleanup } = await installFakeTmux({
            sessions: [
                {
                    name: 'main',
                    windows: 1,
                    attached: true,
                    attachedClients: 1,
                    created: 111,
                    activity: 222
                }
            ],
            panes: [],
            captures: {},
            nextPaneId: 10
        })
        try {
            const headers = authHeader(token)

            const localTicket = await app.request('/api/ws-ticket', {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ hostId: 'local', sessionName: 'main' })
            })
            assert.equal(localTicket.status, 200)
            const localTicketBody = (await localTicket.json()) as { ticket: string }
            assert.equal(typeof localTicketBody.ticket, 'string')

            const remoteTicketResponse = await app.request('/api/ws-ticket', {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ hostId: 'remote', sessionName: 'remote' })
            })
            assert.equal(remoteTicketResponse.status, 200)
            const remoteTicketBody = (await remoteTicketResponse.json()) as { ticket: string }
            assert.equal(typeof remoteTicketBody.ticket, 'string')

            const missingHostTicket = await app.request('/api/ws-ticket', {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ hostId: 'missing', sessionName: 'main' })
            })
            assert.equal(missingHostTicket.status, 404)

            const badTicketBody = await app.request('/api/ws-ticket', {
                method: 'POST',
                headers: { ...headers, 'content-type': 'application/json' },
                body: JSON.stringify({ hostId: 'local' })
            })
            assert.equal(badTicketBody.status, 400)
        } finally {
            await cleanup()
        }
    })
})
