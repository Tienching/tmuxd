const STORAGE_KEY = 'tmuxd.customActions.v1'
export const MIN_CUSTOM_ACTION_INTERVAL_SECONDS = 5
export const MAX_CUSTOM_ACTION_INTERVAL_SECONDS = 3600
export const MAX_CUSTOM_ACTION_REPEAT_COUNT = 999
export const MAX_CUSTOM_ACTION_LABEL_LENGTH = 24
export const MAX_CUSTOM_ACTION_PAYLOAD_LENGTH = 4096
export const MAX_CUSTOM_ACTION_TRIGGER_DELAY_SECONDS = 7 * 24 * 60 * 60
export const MAX_CUSTOM_ACTION_TRIGGER_DELAY_MS = MAX_CUSTOM_ACTION_TRIGGER_DELAY_SECONDS * 1000

export type CustomActionTriggerMode = 'manual' | 'delay' | 'datetime'
export type CustomActionValidationReason = 'required' | 'invalid_trigger_at_local'

export class CustomActionValidationError extends Error {
    readonly reason: CustomActionValidationReason

    constructor(reason: CustomActionValidationReason) {
        super(`invalid_custom_action:${reason}`)
        this.name = 'CustomActionValidationError'
        this.reason = reason
    }
}

export interface CustomAction {
    id: string
    label: string
    payload: string
    triggerMode: CustomActionTriggerMode
    triggerDelaySeconds: number | null
    triggerAtLocal: string | null
    intervalSeconds: number | null
    repeatCount: number | null
    updatedAt: number
}

export interface CustomActionDraft {
    id?: string
    label?: string
    payload?: string
    triggerMode?: CustomActionTriggerMode | string | null
    triggerDelaySeconds?: number | string | null
    triggerAtLocal?: string | null
    intervalSeconds?: number | string | null
    repeatCount?: number | string | null
}

export function loadCustomActions(): CustomAction[] {
    try {
        const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
            .map((value) => normalizeStoredAction(value))
            .filter((action): action is CustomAction => Boolean(action))
            .slice(0, 32)
    } catch {
        return []
    }
}

export function saveCustomActions(actions: CustomAction[]): void {
    const normalized = actions
        .map((action) => normalizeStoredAction(action))
        .filter((action): action is CustomAction => Boolean(action))
        .slice(0, 32)
    try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(normalized))
    } catch {
        /* storage can be unavailable in private mode */
    }
}

export function createCustomAction(draft: CustomActionDraft, now = Date.now()): CustomAction {
    const action = normalizeDraft(draft, now)
    if (!action) throw new CustomActionValidationError('required')
    return action
}

export function upsertCustomAction(actions: CustomAction[], draft: CustomActionDraft, now = Date.now()): CustomAction[] {
    const nextAction = createCustomAction(draft, now)
    const existingIndex = actions.findIndex((action) => action.id === nextAction.id)
    if (existingIndex < 0) return [nextAction, ...actions].slice(0, 32)
    const next = [...actions]
    next[existingIndex] = nextAction
    return next
}

export function moveCustomAction(actions: CustomAction[], id: string, direction: -1 | 1): CustomAction[] {
    const index = actions.findIndex((action) => action.id === id)
    const nextIndex = index + direction
    if (index < 0 || nextIndex < 0 || nextIndex >= actions.length) return actions
    const next = [...actions]
    const [item] = next.splice(index, 1)
    next.splice(nextIndex, 0, item)
    return next
}

export function deleteCustomAction(actions: CustomAction[], id: string): CustomAction[] {
    return actions.filter((action) => action.id !== id)
}

export function actionPayloadNeedsTimerConfirmation(payload: string): boolean {
    return /[\r\n]/.test(payload)
}

export function formatActionPayloadPreview(payload: string): string {
    return payload
        .replace(/\u001b/g, '⎋')
        .replace(/\r/g, '↵')
        .replace(/\n/g, '↵')
        .replace(/\t/g, '⇥')
        .replace(/ /g, '·')
        .slice(0, 80)
}

export function formatActionTriggerSummary(action: Pick<CustomAction, 'triggerMode' | 'triggerDelaySeconds' | 'triggerAtLocal'>): string {
    if (action.triggerMode === 'delay' && action.triggerDelaySeconds) return `after ${action.triggerDelaySeconds}s`
    if (action.triggerMode === 'datetime' && action.triggerAtLocal) return `at ${action.triggerAtLocal.replace('T', ' ')}`
    return 'on click'
}

export function getActionTriggerDelayMs(action: Pick<CustomAction, 'triggerMode' | 'triggerDelaySeconds' | 'triggerAtLocal'>, now = Date.now()): number {
    if (action.triggerMode === 'delay' && action.triggerDelaySeconds) return Math.min(MAX_CUSTOM_ACTION_TRIGGER_DELAY_MS, action.triggerDelaySeconds * 1000)
    if (action.triggerMode === 'datetime' && action.triggerAtLocal) {
        const scheduledAt = new Date(action.triggerAtLocal).getTime()
        if (Number.isFinite(scheduledAt)) return Math.min(MAX_CUSTOM_ACTION_TRIGGER_DELAY_MS, Math.max(0, scheduledAt - now))
    }
    return 0
}

export function clampCustomActionInterval(value: unknown): number | null {
    const parsed = parseNullableInteger(value)
    if (parsed === null) return null
    return Math.min(MAX_CUSTOM_ACTION_INTERVAL_SECONDS, Math.max(MIN_CUSTOM_ACTION_INTERVAL_SECONDS, parsed))
}

export function clampCustomActionRepeatCount(value: unknown): number | null {
    const parsed = parseNullableInteger(value)
    if (parsed === null) return null
    return Math.min(MAX_CUSTOM_ACTION_REPEAT_COUNT, Math.max(1, parsed))
}

export function clampCustomActionTriggerDelay(value: unknown): number | null {
    const parsed = parseNullableInteger(value)
    if (parsed === null) return null
    return Math.min(MAX_CUSTOM_ACTION_TRIGGER_DELAY_SECONDS, Math.max(1, parsed))
}

function normalizeDraft(draft: CustomActionDraft, now: number): CustomAction | null {
    const label = String(draft.label ?? '').trim().slice(0, MAX_CUSTOM_ACTION_LABEL_LENGTH)
    const payload = String(draft.payload ?? '').slice(0, MAX_CUSTOM_ACTION_PAYLOAD_LENGTH)
    if (!label || !payload) return null
    const triggerMode = normalizeTriggerMode(draft.triggerMode)
    const triggerDelaySeconds = triggerMode === 'delay' ? clampCustomActionTriggerDelay(draft.triggerDelaySeconds ?? null) : null
    const rawTriggerAtLocal = typeof draft.triggerAtLocal === 'string' ? draft.triggerAtLocal.trim() : ''
    const triggerAtLocal = triggerMode === 'datetime' ? normalizeTriggerAtLocal(rawTriggerAtLocal, now) : null
    if (triggerMode === 'datetime' && rawTriggerAtLocal && !triggerAtLocal) {
        throw new CustomActionValidationError('invalid_trigger_at_local')
    }
    const intervalSeconds = clampCustomActionInterval(draft.intervalSeconds ?? null)
    return {
        id: draft.id?.trim() || makeCustomActionId(),
        label,
        payload,
        triggerMode: triggerDelaySeconds || triggerAtLocal ? triggerMode : 'manual',
        triggerDelaySeconds,
        triggerAtLocal,
        intervalSeconds,
        repeatCount: intervalSeconds ? clampCustomActionRepeatCount(draft.repeatCount ?? null) : null,
        updatedAt: Date.now()
    }
}

function normalizeStoredAction(value: unknown): CustomAction | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    const label = typeof record.label === 'string' ? record.label.trim().slice(0, MAX_CUSTOM_ACTION_LABEL_LENGTH) : ''
    const payload = typeof record.payload === 'string' ? record.payload.slice(0, MAX_CUSTOM_ACTION_PAYLOAD_LENGTH) : ''
    if (!id || !label || !payload) return null
    const triggerMode = normalizeTriggerMode(record.triggerMode)
    const triggerDelaySeconds = triggerMode === 'delay' ? clampCustomActionTriggerDelay(record.triggerDelaySeconds ?? null) : null
    const triggerAtLocal = triggerMode === 'datetime' ? normalizeTriggerAtLocal(record.triggerAtLocal ?? null) : null
    const intervalSeconds = clampCustomActionInterval(record.intervalSeconds ?? null)
    return {
        id,
        label,
        payload,
        triggerMode: triggerDelaySeconds || triggerAtLocal ? triggerMode : 'manual',
        triggerDelaySeconds,
        triggerAtLocal,
        intervalSeconds,
        repeatCount: intervalSeconds ? clampCustomActionRepeatCount(record.repeatCount ?? null) : null,
        updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0
    }
}

function parseNullableInteger(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return Math.floor(parsed)
}

function normalizeTriggerMode(value: unknown): CustomActionTriggerMode {
    return value === 'delay' || value === 'datetime' ? value : 'manual'
}

function normalizeTriggerAtLocal(value: unknown, now = Date.now()): string | null {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    if (!trimmed) return null
    const parsed = new Date(trimmed).getTime()
    if (!Number.isFinite(parsed)) return null
    if (parsed - now > MAX_CUSTOM_ACTION_TRIGGER_DELAY_MS) return null
    return trimmed.slice(0, 16)
}

function makeCustomActionId(): string {
    try {
        return globalThis.crypto?.randomUUID?.() ?? `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    } catch {
        return `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }
}
