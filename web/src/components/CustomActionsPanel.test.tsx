import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { CustomActionsBar } from './CustomActionsPanel'
import type { CustomAction } from '../session/customActions'

describe('CustomActionsBar', () => {
    it('renders the manage entry and saved action buttons', () => {
        const action: CustomAction = {
            id: 'action-1',
            label: 'Logs',
            payload: 'tail -f app.log',
            triggerMode: 'manual',
            triggerDelaySeconds: null,
            triggerAtLocal: null,
            intervalSeconds: null,
            repeatCount: null,
            updatedAt: 1
        }

        const element = CustomActionsBar({
            actions: [action],
            timers: [],
            onManage() {
                throw new Error('not called')
            },
            onSend() {
                throw new Error('not called')
            },
            onStopTimer() {
                throw new Error('not called')
            }
        })

        const text = collectText(element)
        assert.match(text, /Actions/)
        assert.match(text, /Logs/)
    })
})

function collectText(value: unknown): string {
    if (typeof value === 'string' || typeof value === 'number') return String(value)
    if (Array.isArray(value)) return value.map(collectText).join('')
    if (value && typeof value === 'object' && 'props' in value) {
        return collectText((value as { props?: { children?: unknown } }).props?.children)
    }
    return ''
}
