import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { classifyPaneStatus, findPaneForTarget } from './paneStatus.js'
import type { TmuxPane, TmuxPaneCapture } from '@tmuxd/shared'

describe('pane status classifier', () => {
    it('detects permission prompts before generic input prompts', () => {
        const status = classifyPaneStatus({
            target: 'main:0.0',
            capture: capture('Do you want to proceed? Yes/No\n> '),
            now: 42
        })

        assert.equal(status.state, 'permission_prompt')
        assert.equal(status.checkedAt, 42)
        assert.match(status.summary, /permission/i)
        assert.ok(status.signals.includes('proceed_prompt'))
        assert.ok(status.signals.includes('yes_no_prompt'))
    })

    it('detects copy mode and dead panes from tmux metadata', () => {
        assert.equal(classifyPaneStatus({ target: 'main:0.0', capture: capture('idle', { paneInMode: true }) }).state, 'copy_mode')
        assert.equal(
            classifyPaneStatus({
                target: 'main:0.0',
                pane: pane({ paneDead: true }),
                capture: capture('idle')
            }).state,
            'dead'
        )
    })

    it('finds panes by pane id, full target, window target, and session target', () => {
        const panes = [pane({ target: 'main:0.0', paneId: '%7', paneActive: true }), pane({ target: 'main:1.0', paneId: '%8', windowIndex: 1 })]

        assert.equal(findPaneForTarget(panes, '%7')?.target, 'main:0.0')
        assert.equal(findPaneForTarget(panes, 'main:1.0')?.paneId, '%8')
        assert.equal(findPaneForTarget(panes, 'main:1')?.paneId, '%8')
        assert.equal(findPaneForTarget(panes, 'main')?.paneId, '%7')
        assert.equal(findPaneForTarget(panes, 'missing'), null)
    })

    it('resolves a session-only target to the active pane in the active window', () => {
        const panes = [
            pane({ target: 'main:0.0', paneId: '%7', windowIndex: 0, windowActive: false, paneActive: true }),
            pane({ target: 'main:1.0', paneId: '%8', windowIndex: 1, windowActive: true, paneActive: true })
        ]

        assert.equal(findPaneForTarget(panes, 'main')?.paneId, '%8')
    })

    it('resolves window targets for session names with spaces', () => {
        const panes = [
            pane({ target: 'my session:0.0', paneId: '%7', windowIndex: 0, sessionName: 'my session', paneActive: true })
        ]

        assert.equal(findPaneForTarget(panes, 'my session:0.0')?.paneId, '%7')
        assert.equal(findPaneForTarget(panes, 'my session:0')?.paneId, '%7')
        assert.equal(findPaneForTarget(panes, 'my session')?.paneId, '%7')
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
