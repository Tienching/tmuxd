import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isOpenedSessionUnread } from './OpenSessionsSidebar'
import type { TmuxPaneStatus } from '@tmuxd/shared'

function statusWithActivity(unread: boolean): TmuxPaneStatus {
    return {
        target: 'local\u0000main',
        state: 'idle',
        signals: [],
        summary: 'No known running or input-needed signals detected.',
        checkedAt: 1,
        capture: {
            target: 'main',
            text: '',
            truncated: false,
            maxBytes: 1,
            paneInMode: false,
            scrollPosition: 0,
            historySize: 0,
            paneHeight: 0
        },
        activity: {
            light: unread ? 'yellow' : 'green',
            unread,
            changed: false,
            seq: 1,
            updatedAt: 1,
            checkedAt: 1
        }
    } as unknown as TmuxPaneStatus
}

describe('opened session unread state', () => {
    it('uses status.unread when pane status is available', () => {
        assert.equal(isOpenedSessionUnread({ active: false, status: statusWithActivity(true), light: {} }), true)
    })

    it('returns false for active session even when status shows unread', () => {
        assert.equal(isOpenedSessionUnread({ active: true, status: statusWithActivity(true), light: {} }), false)
    })

    it('returns false when server activity is read, even if no light override is present', () => {
        assert.equal(isOpenedSessionUnread({ active: false, status: statusWithActivity(false), light: {} }), false)
    })

    it('treats workspace light.unread as a fast-path immediate unread', () => {
        assert.equal(isOpenedSessionUnread({ active: false, light: { unread: true } }), true)
    })

    it('falls back to false when status is unavailable and there is no light override', () => {
        assert.equal(isOpenedSessionUnread({ active: false, light: {} }), false)
    })

    it('lets a fresh ws light.unread surface even when server status still reports read', () => {
        // ws data arrived faster than the next /status poll; we surface the
        // local signal so users see activity immediately rather than waiting
        // up to 5s for the next server poll.
        assert.equal(
            isOpenedSessionUnread({
                active: false,
                light: { unread: true },
                status: statusWithActivity(false)
            }),
            true
        )
    })
})
