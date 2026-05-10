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

        assert.equal(isOpenedSessionUnread({ active: false, status, light: {}, lastOpenedAt: 1 }), true)
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

        assert.equal(isOpenedSessionUnread({ active: true, status, light: {}, lastOpenedAt: 2_000 }), false)
    })

    it('does not mark unread when status update is older than last opened time', () => {
        const status = {
            target: 'local\u0000main',
            state: 'idle',
            signals: [],
            summary: 'No known running or input-needed signals detected.',
            checkedAt: 2_000,
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
                updatedAt: 1_500,
                checkedAt: 1_500
            }
        } as unknown as TmuxPaneStatus

        assert.equal(isOpenedSessionUnread({ active: false, light: {}, status, lastOpenedAt: 2_000 }), false)
    })

    it('marks unread when status update is newer than last opened time', () => {
        const status = {
            target: 'local\u0000main',
            state: 'idle',
            signals: [],
            summary: 'No known running or input-needed signals detected.',
            checkedAt: 2_500,
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
                updatedAt: 2_500,
                checkedAt: 2_500
            }
        } as unknown as TmuxPaneStatus

        assert.equal(isOpenedSessionUnread({ active: false, light: {}, status, lastOpenedAt: 2_000 }), true)
    })

    it('allows explicit read-mark override to force unread', () => {
        assert.equal(isOpenedSessionUnread({ active: false, light: { unread: true }, lastOpenedAt: 1 }), true)
    })

    it('uses server activity state when both signal light and status are present', () => {
        const status = {
            target: 'local\u0000main',
            state: 'idle',
            signals: [],
            summary: 'No known running or input-needed signals detected.',
            checkedAt: 3_000,
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
                light: 'green',
                unread: false,
                changed: false,
                seq: 10,
                updatedAt: 4_000,
                checkedAt: 4_000
            }
        } as unknown as TmuxPaneStatus

        assert.equal(
            isOpenedSessionUnread({
                active: false,
                light: { unread: true },
                status,
                lastOpenedAt: 1
            }),
            false
        )
    })

    it('falls back to false when status is unavailable', () => {
        assert.equal(isOpenedSessionUnread({ active: false, light: {}, lastOpenedAt: 1 }), false)
    })
})
