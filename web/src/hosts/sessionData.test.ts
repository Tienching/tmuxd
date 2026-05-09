import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { listHostSessionsData, withPaneActivity } from './sessionData'
import { api } from '../api/client'
import type { HostInfo, TargetPane, TargetSession } from '@tmuxd/shared'

describe('host session data', () => {
    it('uses pane/window activity when tmux session_activity is stale', () => {
        const [session] = withPaneActivity(
            [targetSession({ activity: 100 })],
            [
                targetPane({ sessionActivity: 100, windowActivity: 120 }),
                targetPane({ paneId: '%2', paneIndex: 1, sessionActivity: 100, windowActivity: 110 })
            ]
        )

        assert.equal(session.activity, 120)
    })

    it('does not mix pane activity across hosts or session names', () => {
        const sessions = withPaneActivity(
            [targetSession({ hostId: 'local', name: 'main', activity: 100 })],
            [
                targetPane({ hostId: 'remote', sessionName: 'main', windowActivity: 200 }),
                targetPane({ hostId: 'local', sessionName: 'other', windowActivity: 300 })
            ]
        )

        assert.equal(sessions[0].activity, 100)
    })

    it('keeps sessions when a pane endpoint returns a non-JSON SPA fallback', async () => {
        const original = {
            listHosts: api.listHosts,
            listHostSessions: api.listHostSessions,
            listHostPanes: api.listHostPanes
        }
        const session = targetSession({ activity: 100 })

        try {
            api.listHosts = async () => ({ hosts: [hostInfo()] })
            api.listHostSessions = async () => ({ sessions: [session] })
            api.listHostPanes = (async () => '<html></html>') as typeof api.listHostPanes

            const data = await listHostSessionsData()

            assert.deepEqual(data.sessions, [session])
            assert.deepEqual(data.panes, [])
            assert.equal(data.errors.length, 1)
            assert.equal(data.errors[0].message, 'invalid_panes_response')
        } finally {
            api.listHosts = original.listHosts
            api.listHostSessions = original.listHostSessions
            api.listHostPanes = original.listHostPanes
        }
    })
})

function hostInfo(overrides: Partial<HostInfo> = {}): HostInfo {
    return {
        id: 'local',
        name: 'Local',
        status: 'online',
        isLocal: true,
        version: '0.1.0',
        lastSeenAt: 1,
        capabilities: ['list', 'create', 'kill', 'capture', 'attach'],
        ...overrides
    }
}

function targetSession(overrides: Partial<TargetSession> = {}): TargetSession {
    return {
        name: 'main',
        hostId: 'local',
        hostName: 'Local',
        windows: 1,
        attached: false,
        attachedClients: 0,
        created: 1,
        activity: 1,
        ...overrides
    }
}

function targetPane(overrides: Partial<TargetPane> = {}): TargetPane {
    return {
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
        title: 'title',
        width: 80,
        height: 24,
        paneInMode: false,
        scrollPosition: 0,
        historySize: 0,
        sessionAttached: false,
        sessionAttachedClients: 0,
        sessionActivity: 1,
        windowActivity: 1,
        hostId: 'local',
        hostName: 'Local',
        ...overrides
    }
}
