import assert from 'node:assert/strict'
import { beforeEach, describe, it } from 'node:test'
import {
    actionPayloadNeedsTimerConfirmation,
    clampCustomActionInterval,
    createCustomAction,
    CustomActionValidationError,
    formatActionPayloadPreview,
    formatActionTriggerSummary,
    getActionTriggerDelayMs,
    loadCustomActions,
    MAX_CUSTOM_ACTION_TRIGGER_DELAY_MS,
    MAX_CUSTOM_ACTION_TRIGGER_DELAY_SECONDS,
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
        assert.equal(action.triggerMode, 'manual')
        assert.equal(action.triggerDelaySeconds, null)
        assert.equal(action.triggerAtLocal, null)
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
        const action = createCustomAction({ label: 'A', payload: 'a', repeatCount: '3' })
        assert.equal(action.intervalSeconds, null)
        assert.equal(action.repeatCount, null)
    })

    it('normalizes delayed and dated triggers', () => {
        const now = new Date(2026, 0, 2, 3, 3).getTime()
        const delayed = createCustomAction({ label: 'Later', payload: 'x', triggerMode: 'delay', triggerDelaySeconds: '2' })
        assert.equal(delayed.triggerMode, 'delay')
        assert.equal(delayed.triggerDelaySeconds, 2)
        assert.equal(getActionTriggerDelayMs(delayed), 2000)
        assert.equal(formatActionTriggerSummary(delayed), 'after 2s')

        const dated = createCustomAction({ label: 'At', payload: 'x', triggerMode: 'datetime', triggerAtLocal: formatLocalDateTime(new Date(now + 60_000)) }, now)
        assert.equal(dated.triggerMode, 'datetime')
        assert.equal(dated.triggerAtLocal, formatLocalDateTime(new Date(now + 60_000)))
        assert.equal(formatActionTriggerSummary(dated), `at ${formatLocalDateTime(new Date(now + 60_000)).replace('T', ' ')}`)
        assert.equal(getActionTriggerDelayMs(dated, now), 60_000)
    })

    it('rejects dated triggers beyond the safe scheduler horizon', () => {
        const now = new Date(2026, 0, 2, 3, 3).getTime()
        assert.throws(
            () =>
                createCustomAction(
                    {
                        label: 'Too far',
                        payload: 'x',
                        triggerMode: 'datetime',
                        triggerAtLocal: formatLocalDateTime(new Date(now + MAX_CUSTOM_ACTION_TRIGGER_DELAY_MS + 60_000))
                    },
                    now
                ),
            (error) => error instanceof CustomActionValidationError && error.reason === 'invalid_trigger_at_local'
        )
    })

    it('caps defensive datetime delay calculations to the safe scheduler horizon', () => {
        const now = new Date(2026, 0, 2, 3, 3).getTime()
        assert.equal(
            getActionTriggerDelayMs(
                {
                    triggerMode: 'datetime',
                    triggerDelaySeconds: null,
                    triggerAtLocal: formatLocalDateTime(new Date(now + MAX_CUSTOM_ACTION_TRIGGER_DELAY_MS + 60_000))
                },
                now
            ),
            MAX_CUSTOM_ACTION_TRIGGER_DELAY_SECONDS * 1000
        )
    })
})

function formatLocalDateTime(value: Date): string {
    const pad = (part: number) => String(part).padStart(2, '0')
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`
}
