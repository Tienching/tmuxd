import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isOpenedSessionUnread } from './OpenSessionsSidebar'
import type { TmuxPaneStatus } from '@tmuxd/shared'

describe('opened session unread state', () => {
    it('uses status.unread when pane status is available', () => {
        const status = {
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
                light: 'yellow',
                unread: true,
                changed: false,
                seq: 2,
                updatedAt: 1,
                checkedAt: 1
            }
        } as unknown as TmuxPaneStatus

        assert.equal(isOpenedSessionUnread({ active: false, status, light: {}, }), true)
    })

    it('returns false for active session even when status shows unread', () => {
        const status = {
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
                light: 'yellow',
                unread: true,
                changed: false,
                seq: 2,
                updatedAt: 1,
                checkedAt: 1
            }
        } as unknown as TmuxPaneStatus

        assert.equal(isOpenedSessionUnread({ active: true, status, light: {} }), false)
    })

    it('falls back to false when status is unavailable', () => {
        assert.equal(isOpenedSessionUnread({ active: false, light: {} }), false)
    })

    it('allows explicit read-mark override to force unread', () => {
        assert.equal(isOpenedSessionUnread({ active: false, light: { unread: true } }), true)
    })
})
