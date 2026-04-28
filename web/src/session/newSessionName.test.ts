import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { makeNewSessionName } from './newSessionName'

describe('makeNewSessionName', () => {
    it('creates an argv-safe session name from local time', () => {
        assert.equal(makeNewSessionName(new Date(2026, 3, 28, 9, 5, 7)), 'web-20260428-090507')
    })

    it('adds an argv-safe suffix for collision retries', () => {
        assert.equal(makeNewSessionName(new Date(2026, 3, 28, 9, 5, 7), 'a7f'), 'web-20260428-090507-a7f')
    })
})
