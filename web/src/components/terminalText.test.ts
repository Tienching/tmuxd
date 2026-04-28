import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getScrollTopForTmuxPosition } from './terminalText'

describe('getScrollTopForTmuxPosition', () => {
    it('scrolls to the bottom when tmux is not scrolled', () => {
        assert.equal(getScrollTopForTmuxPosition(1000, 100, 10, 0), 900)
    })

    it('uses tmux scroll position directly as lines from bottom', () => {
        assert.equal(getScrollTopForTmuxPosition(1000, 100, 10, 20), 700)
    })

    it('clamps when tmux scroll position is beyond the textarea height', () => {
        assert.equal(getScrollTopForTmuxPosition(1000, 100, 10, 200), 0)
    })
})
