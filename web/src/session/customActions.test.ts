import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
    actionPayloadNeedsTimerConfirmation,
    clampCustomActionInterval,
    createCustomAction,
    formatActionPayloadPreview,
    loadCustomActions,
    MIN_CUSTOM_ACTION_INTERVAL_SECONDS,
    moveCustomAction,
    saveCustomActions,
    upsertCustomAction
} from './customActions'

class MemoryStorage {
    private readonly values = new Map<string, string>()
    getItem(key: string) {
        return this.values.get(key) ?? null
    }
    setItem(key: string, value: string) {
        this.values.set(key, value)
    }
    removeItem(key: string) {
        this.values.delete(key)
    }
    clear() {
        this.values.clear()
    }
}

beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
        value: new MemoryStorage(),
        configurable: true
    })
})

describe('custom actions', () => {
    it('creates and persists normalized actions', () => {
        const action = createCustomAction({ label: '  Logs  ', payload: 'tail -f app.log\r', intervalSeconds: 1, repeatCount: '3' })
        assert.equal(action.label, 'Logs')
        assert.equal(action.intervalSeconds, MIN_CUSTOM_ACTION_INTERVAL_SECONDS)
        assert.equal(action.repeatCount, 3)

        saveCustomActions([action])
        assert.deepEqual(loadCustomActions(), [action])
    })

    it('rejects empty labels or payloads', () => {
        assert.throws(() => createCustomAction({ label: '', payload: 'x' }))
        assert.throws(() => createCustomAction({ label: 'x', payload: '' }))
    })

    it('upserts and reorders actions', () => {
        const a = createCustomAction({ label: 'A', payload: 'a' })
        const b = createCustomAction({ label: 'B', payload: 'b' })
        const updated = upsertCustomAction([a, b], { ...b, label: 'B2', payload: 'bb' })
        assert.equal(updated.length, 2)
        assert.equal(updated[1].label, 'B2')

        const moved = moveCustomAction(updated, b.id, -1)
        assert.equal(moved[0].id, b.id)
    })

    it('formats safety previews and detects enter payloads', () => {
        assert.equal(actionPayloadNeedsTimerConfirmation('echo hi\r'), true)
        assert.equal(actionPayloadNeedsTimerConfirmation('echo hi'), false)
        assert.equal(formatActionPayloadPreview('a b\t\u001b\r'), 'a·b⇥⎋↵')
    })

    it('treats blank interval as no timer default', () => {
        assert.equal(clampCustomActionInterval(''), null)
    })
})
