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

    it('auto-settles back to green after content is stable past the threshold', () => {
        trackPaneActivity({ hostId: 'local', target: 'main:0.0', pane: pane(), capture: capture('hello'), now: 1000 })
        const afterChange = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture('hello world'),
            now: 2000
        })
        assert.equal(afterChange.light, 'yellow')
        assert.equal(afterChange.unread, true)
        assert.equal(afterChange.seq, 1)

        // A poll shortly after the change keeps the light yellow because the
        // content hasn't been stable long enough to auto-settle.
        const shortlyAfter = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture('hello world'),
            now: 6000
        })
        assert.equal(shortlyAfter.light, 'yellow')
        assert.equal(shortlyAfter.unread, true)
        assert.equal(shortlyAfter.seq, 1)

        // Past the AUTO_SETTLE_MS threshold (7s from the last change at 2000),
        // the next poll with unchanged content auto-advances the baseline.
        const afterSettle = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture('hello world'),
            now: 9100
        })
        assert.equal(afterSettle.light, 'green')
        assert.equal(afterSettle.unread, false)
        // `seq` is preserved (monotonic): we only reset the observed baseline.
        assert.equal(afterSettle.seq, 1)
    })

    it('does not auto-settle while content keeps changing', () => {
        trackPaneActivity({ hostId: 'local', target: 'main:0.0', pane: pane(), capture: capture('a'), now: 1000 })
        // Each tick changes content; auto-settle must never trigger because
        // lastChangeAt keeps sliding forward.
        for (let t = 2000; t <= 30000; t += 2000) {
            const r = trackPaneActivity({
                hostId: 'local',
                target: 'main:0.0',
                pane: pane(),
                capture: capture(`a${t}`),
                now: t
            })
            assert.equal(r.light, 'yellow', `expected yellow at t=${t}`)
            assert.equal(r.unread, true, `expected unread at t=${t}`)
        }
    })

    it('records the baseline hash when explicitly marked read', () => {
        trackPaneActivity({ hostId: 'local', target: 'main:0.0', pane: pane(), capture: capture('first'), now: 1000 })
        trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture('second'),
            now: 2000
        })
        const read = markPaneActivityRead({ hostId: 'local', target: 'main:0.0', pane: pane(), now: 2100 })
        assert.equal(read?.light, 'green')
        assert.equal(read?.unread, false)

        // Re-observing the same content stays green (baseline matches).
        const stillGreen = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture('second'),
            now: 2500
        })
        assert.equal(stillGreen.light, 'green')
        assert.equal(stillGreen.unread, false)

        // A later real change after the read point goes yellow again.
        const laterChange = trackPaneActivity({
            hostId: 'local',
            target: 'main:0.0',
            pane: pane(),
            capture: capture('third'),
            now: 3000
        })
        assert.equal(laterChange.light, 'yellow')
        assert.equal(laterChange.unread, true)
        assert.equal(laterChange.reason, 'output')
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
