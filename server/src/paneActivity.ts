import { createHash } from 'node:crypto'
import type { TmuxPane, TmuxPaneActivity, TmuxPaneCapture } from '@tmuxd/shared'

const MAX_TRACKED_PANES = 512
const ACTIVITY_SAMPLE_CHARS = 4096

interface PaneActivityRecord {
    contentHash: string
    paneDead: boolean
    changed: boolean
    seq: number
    readSeq: number
    reason?: TmuxPaneActivity['reason']
    updatedAt: number
    checkedAt: number
}

const records = new Map<string, PaneActivityRecord>()

export function trackPaneActivity(input: {
    hostId: string
    target: string
    pane?: TmuxPane | null
    capture: TmuxPaneCapture
    now?: number
}): TmuxPaneActivity {
    const now = input.now ?? Date.now()
    const pane = input.pane ?? null
    const key = paneActivityKey(input.hostId, input.target, pane)
    const contentHash = hashText(activitySample(input.capture.text))
    const paneDead = Boolean(pane?.paneDead)
    const previous = records.get(key)
    const outputChanged = Boolean(previous && previous.contentHash !== contentHash)
    const closedChanged = Boolean(previous && paneDead && !previous.paneDead)
    const changed = outputChanged || closedChanged
    const seq = changed ? (previous?.seq ?? 0) + 1 : (previous?.seq ?? 0)
    const readSeq = previous?.readSeq ?? seq
    const reason = closedChanged ? 'closed' : outputChanged ? 'output' : previous?.reason
    const updatedAt = changed || !previous ? now : previous.updatedAt
    const record: PaneActivityRecord = {
        contentHash,
        paneDead,
        changed,
        seq,
        readSeq,
        reason,
        updatedAt,
        checkedAt: now
    }

    remember(key, record)
    return toActivity(record)
}

export function markPaneActivityRead(input: { hostId: string; target: string; pane?: TmuxPane | null; now?: number }): TmuxPaneActivity | null {
    const key = paneActivityKey(input.hostId, input.target, input.pane ?? null)
    const record = records.get(key)
    if (!record) return null
    record.readSeq = record.seq
    record.checkedAt = input.now ?? Date.now()
    records.set(key, record)
    return toActivity(record)
}

export function resetPaneActivityTracker(): void {
    records.clear()
}

function toActivity(record: PaneActivityRecord): TmuxPaneActivity {
    const unread = record.seq > record.readSeq
    return {
        light: record.paneDead ? 'red' : unread ? 'yellow' : 'green',
        unread,
        changed: record.changed,
        seq: record.seq,
        ...(record.reason ? { reason: record.reason } : {}),
        updatedAt: record.updatedAt,
        checkedAt: record.checkedAt
    }
}

function paneActivityKey(hostId: string, target: string, pane: TmuxPane | null): string {
    return `${hostId}\0${pane?.paneId || target}`
}

function hashText(text: string): string {
    return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

function activitySample(text: string): string {
    return text.length <= ACTIVITY_SAMPLE_CHARS ? text : text.slice(text.length - ACTIVITY_SAMPLE_CHARS)
}

function remember(key: string, record: PaneActivityRecord): void {
    if (!records.has(key) && records.size >= MAX_TRACKED_PANES) {
        let oldestKey = ''
        let oldestCheckedAt = Number.POSITIVE_INFINITY
        for (const [candidateKey, candidate] of records) {
            if (candidate.checkedAt < oldestCheckedAt) {
                oldestKey = candidateKey
                oldestCheckedAt = candidate.checkedAt
            }
        }
        if (oldestKey) records.delete(oldestKey)
    }
    records.set(key, record)
}
