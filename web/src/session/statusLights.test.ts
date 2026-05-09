import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { LOCAL_HOST_ID } from '@tmuxd/shared'
import { createWorkspacePane } from '../workspace/layout'
import {
    clearTargetPaneSignalsState,
    getPaneStatusLight,
    getWorkspaceSessionLights,
    isSessionActivityUnread,
    targetKey,
    type PaneStatusForLight
} from './statusLights'

describe('status lights', () => {
    it('turns yellow for unread output even when the pane is open', () => {
        assert.deepEqual(getPaneStatusLight({ status: 'open' }), {
            colorClass: 'bg-emerald-400',
            title: 'Open and read'
        })

        assert.deepEqual(getPaneStatusLight({ status: 'open', signals: { outputChanged: true } }), {
            colorClass: 'bg-amber-400',
            title: 'Unread output or timer activity'
        })
    })

    it('keeps one shared unread light for duplicate panes targeting the same tmux session', () => {
        const panes = [
            createWorkspacePane({ hostId: LOCAL_HOST_ID, sessionName: 'main' }, 'pane-a'),
            createWorkspacePane({ hostId: LOCAL_HOST_ID, sessionName: 'main' }, 'pane-b')
        ]
        const statuses: Record<string, PaneStatusForLight> = {
            'pane-a': { status: 'open', statusMsg: null, signals: { outputChanged: true } },
            'pane-b': { status: 'open', statusMsg: null }
        }

        assert.deepEqual(getWorkspaceSessionLights(panes, statuses), {
            [targetKey({ hostId: LOCAL_HOST_ID, sessionName: 'main' })]: { unread: true, closed: false }
        })
    })

    it('clears unread signals for every pane with the same tmux target', () => {
        const panes = [
            createWorkspacePane({ hostId: LOCAL_HOST_ID, sessionName: 'main' }, 'pane-a'),
            createWorkspacePane({ hostId: LOCAL_HOST_ID, sessionName: 'main' }, 'pane-b'),
            createWorkspacePane({ hostId: LOCAL_HOST_ID, sessionName: 'other' }, 'pane-c')
        ]
        const statuses: Record<string, PaneStatusForLight> = {
            'pane-a': { status: 'open', statusMsg: null, signals: { outputChanged: true, lastAt: 1 } },
            'pane-b': { status: 'open', statusMsg: null, signals: { timerTriggered: true, lastAt: 2 } },
            'pane-c': { status: 'open', statusMsg: null, signals: { outputChanged: true, lastAt: 3 } }
        }

        const next = clearTargetPaneSignalsState(panes, statuses, { hostId: LOCAL_HOST_ID, sessionName: 'main' }, [
            'outputChanged',
            'timerTriggered'
        ])

        assert.equal(next['pane-a'].signals?.outputChanged, undefined)
        assert.equal(next['pane-a'].signals?.lastAt, 1)
        assert.equal(next['pane-b'].signals?.timerTriggered, undefined)
        assert.equal(next['pane-c'].signals?.outputChanged, true)
        assert.deepEqual(getPaneStatusLight({ status: next['pane-a'].status, signals: next['pane-a'].signals }), {
            colorClass: 'bg-emerald-400',
            title: 'Open and read'
        })
    })

    it('treats session activity after the last read as unread even for the current session', () => {
        assert.equal(isSessionActivityUnread({ activity: 100 }, 99_000), true)
        assert.equal(isSessionActivityUnread({ activity: 100 }, 100_000), false)
    })
})
