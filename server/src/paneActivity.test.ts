import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { markPaneActivityRead, resetPaneActivityTracker, trackPaneActivity } from './paneActivity.js'
import type { TmuxPane, TmuxPaneCapture } from '@tmuxd/shared'

describe('pane activity tracker', () => {
    beforeEach(() => resetPaneActivityTracker())

    it('uses a sticky unread yellow light until the pane is marked read', () => {
        const first = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane({ paneId: '%7' }),
            capture: capture('hello'),
            now: 1000
        })
        assert.equal(first.light, 'green')
        assert.equal(first.unread, false)
        assert.equal(first.seq, 0)

        const second = trackPaneActivity({
            hostId: 'local',
            target: 'main',
            pane: pane({ paneId: '%7' }),
            capture: capture('hello world'),
            now: 2000
        })
        assert.equal(second.light, 'yellow')
        assert.equal(second.unread, true)
        assert.equal(second.changed, true)
        assert.equal(second.seq, 1)
        assert.equal(second.reason, 'output')
        assert.equal(second.updatedAt, 2000)

        const stillUnread = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane({ paneId: '%7' }),
            capture: capture('hello world'),
            now: 3000
        })
        assert.equal(stillUnread.light, 'yellow')
        assert.equal(stillUnread.unread, true)
        assert.equal(stillUnread.seq, 1)

        const read = markPaneActivityRead({ hostId: 'local', target: 'main:0.0', pane: pane({ paneId: '%7' }), now: 4000 })
        assert.equal(read?.light, 'green')
        assert.equal(read?.unread, false)
        assert.equal(read?.seq, 1)
    })

    it('uses a red light when a tracked pane closes', () => {
        trackPaneActivity({ hostId: 'local', target: 'main:0.0', pane: pane(), capture: capture('running'), now: 1000 })
        const closed = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane({ paneDead: true }),
            capture: capture('done'),
            now: 2000
        })

        assert.equal(closed.light, 'red')
        assert.equal(closed.unread, true)
        assert.equal(closed.reason, 'closed')
    })

    it('compares a stable tail sample so different capture windows do not create false unread lights', () => {
        const sharedTail = `latest\n${'same-tail\n'.repeat(600)}`
        const first = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture(`${'old-prefix\n'.repeat(600)}${sharedTail}`),
            now: 1000
        })
        const widerOrNarrowerCapture = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture(`${'different-prefix\n'.repeat(1200)}${sharedTail}`),
            now: 2000
        })
        const changedTail = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture(`${'different-prefix\n'.repeat(1200)}${sharedTail}new output\n`),
            now: 3000
        })

        assert.equal(first.light, 'green')
        assert.equal(widerOrNarrowerCapture.light, 'green')
        assert.equal(widerOrNarrowerCapture.seq, 0)
        assert.equal(changedTail.light, 'yellow')
        assert.equal(changedTail.seq, 1)
    })
})

function capture(text: string, overrides: Partial<TmuxPaneCapture> = {}): TmuxPaneCapture {
    return {
        target: 'main:0.0',
        text,
        truncated: false,
        maxBytes: 262144,
        paneInMode: false,
        scrollPosition: 0,
        historySize: 0,
        paneHeight: 24,
        ...overrides
    }
}

function pane(overrides: Partial<TmuxPane> = {}): TmuxPane {
    return {
        target: 'main:0.0',
        sessionName: 'main',
        windowIndex: 0,
        windowName: 'zsh',
        windowActive: true,
        paneIndex: 0,
        paneId: '%7',
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
        sessionActivity: 0,
        windowActivity: 0,
        ...overrides
    }
}
