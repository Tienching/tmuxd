const STORAGE_KEY = 'tmuxd.customActions.v1'
export const MIN_CUSTOM_ACTION_INTERVAL_SECONDS = 5
export const MAX_CUSTOM_ACTION_INTERVAL_SECONDS = 3600
export const MAX_CUSTOM_ACTION_REPEAT_COUNT = 999
export const MAX_CUSTOM_ACTION_LABEL_LENGTH = 24
export const MAX_CUSTOM_ACTION_PAYLOAD_LENGTH = 4096

export interface CustomAction {
    id: string
    label: string
    payload: string
    intervalSeconds: number | null
    repeatCount: number | null
    updatedAt: number
}

export interface CustomActionDraft {
    id?: string
    label?: string
    payload?: string
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

export function createCustomAction(draft: CustomActionDraft): CustomAction {
    const action = normalizeDraft(draft)
    if (!action) throw new Error('invalid_custom_action')
    return action
}

export function upsertCustomAction(actions: CustomAction[], draft: CustomActionDraft): CustomAction[] {
    const nextAction = createCustomAction(draft)
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

function normalizeDraft(draft: CustomActionDraft): CustomAction | null {
    const label = String(draft.label ?? '').trim().slice(0, MAX_CUSTOM_ACTION_LABEL_LENGTH)
    const payload = String(draft.payload ?? '').slice(0, MAX_CUSTOM_ACTION_PAYLOAD_LENGTH)
    if (!label || !payload) return null
    return {
        id: draft.id?.trim() || makeCustomActionId(),
        label,
        payload,
        intervalSeconds: clampCustomActionInterval(draft.intervalSeconds ?? null),
        repeatCount: clampCustomActionRepeatCount(draft.repeatCount ?? null),
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
    return {
        id,
        label,
        payload,
        intervalSeconds: clampCustomActionInterval(record.intervalSeconds ?? null),
        repeatCount: clampCustomActionRepeatCount(record.repeatCount ?? null),
        updatedAt: typeof record.updatedAt === 'number' && Number.isFinite(record.updatedAt) ? record.updatedAt : 0
    }
}

function parseNullableInteger(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
    if (!Number.isFinite(parsed) || parsed <= 0) return null
    return Math.floor(parsed)
}

function makeCustomActionId(): string {
    try {
        return globalThis.crypto?.randomUUID?.() ?? `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    } catch {
        return `action-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    }
}
