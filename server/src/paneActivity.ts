import { createHash } from 'node:crypto'
import type { TmuxPane, TmuxPaneActivity, TmuxPaneCapture } from '@tmuxd/shared'

const MAX_TRACKED_PANES = 512
const ACTIVITY_SAMPLE_CHARS = 4096
/**
 * After the pane content stops changing for this long, the tracker auto-advances
 * its observed baseline (`lastReadHash`) to the current content. This keeps the
 * sidebar from remaining yellow forever for opened-but-not-attached sessions
 * that had some activity in the past but have since settled on a stable final
 * screen — the user doesn't have to click the row to clear it.
 *
 * The threshold is intentionally slightly larger than the sidebar's /status
 * poll interval (see `OPENED_SESSION_STATUS_POLL_MS` in the web package)
 * so that auto-settle only happens once at least one full unchanged poll
 * has been observed.
 */
const AUTO_SETTLE_MS = 7_000

interface PaneActivityRecord {
    contentHash: string
    /**
     * Hash of the content at the last time the pane was considered "read":
     *  - explicit markPaneActivityRead (user opened the session, activity/read route), or
     *  - auto-settle inside trackPaneActivity after content has been stable past AUTO_SETTLE_MS.
     * A pane is `unread` iff `contentHash !== lastReadHash`.
     */
    lastReadHash: string
    /** Unix ms of the most recent transition of `contentHash`. */
    lastChangeAt: number
    paneDead: boolean
    /**
     * True if the last trackPaneActivity call observed a hash transition or
     * a dead-pane transition (used for the public `changed` field).
     */
    changed: boolean
    /** Monotonic counter of observed changes. Kept for observability/e2e assertions. */
    seq: number
    /** Kept for observability. Advanced alongside `lastReadHash` on read / auto-settle. */
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

    if (!previous) {
        // First observation. Treat the current screen as already "read" so the
        // initial light is green; only subsequent transitions produce unread.
        const record: PaneActivityRecord = {
            contentHash,
            lastReadHash: contentHash,
            lastChangeAt: now,
            paneDead,
            changed: false,
            seq: 0,
            readSeq: 0,
            updatedAt: now,
            checkedAt: now
        }
        remember(key, record)
        return toActivity(record)
    }

    const outputChanged = previous.contentHash !== contentHash
    const closedChanged = paneDead && !previous.paneDead
    const changed = outputChanged || closedChanged

    let { lastReadHash, lastChangeAt, seq, readSeq, reason, updatedAt } = previous

    if (changed) {
        // `closed` takes precedence over `output` when both transition in the
        // same observation — the surviving reason should reflect the most
        // user-visible state change.
        reason = closedChanged ? 'closed' : 'output'
        seq += 1
        updatedAt = now
        if (outputChanged) lastChangeAt = now
    } else if (!paneDead && now - lastChangeAt >= AUTO_SETTLE_MS && lastReadHash !== contentHash) {
        // Auto-settle: content has been stable past the threshold since its
        // last transition. Advance the observed baseline so sticky unread
        // clears without requiring an explicit activity/read call.
        lastReadHash = contentHash
        readSeq = seq
    }

    const record: PaneActivityRecord = {
        contentHash,
        lastReadHash,
        lastChangeAt,
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
    record.lastReadHash = record.contentHash
    record.readSeq = record.seq
    record.checkedAt = input.now ?? Date.now()
    records.set(key, record)
    return toActivity(record)
}

export function resetPaneActivityTracker(): void {
    records.clear()
}

function toActivity(record: PaneActivityRecord): TmuxPaneActivity {
    const unread = record.contentHash !== record.lastReadHash
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
