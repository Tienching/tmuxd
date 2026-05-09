import type { SessionTarget, TargetSession } from '@tmuxd/shared'
import type { WorkspacePane } from '../workspace/layout'

export type PaneConnectionStatus = 'connecting' | 'open' | 'closed' | 'error'

export interface PaneSignals {
    outputChanged?: boolean
    closed?: boolean
    timerTriggered?: boolean
    lastAt?: number
}

export interface PaneStatusForLight {
    status: PaneConnectionStatus
    statusMsg: string | null
    signals?: PaneSignals
}

export interface SessionLightOverride {
    unread?: boolean
    closed?: boolean
}

export interface PaneStatusLightModel {
    colorClass: string
    title: string
}

export function targetKey(target: SessionTarget): string {
    return `${target.hostId}\n${target.sessionName}`
}

export function getWorkspaceSessionLights(
    panes: WorkspacePane[],
    paneStatuses: Record<string, PaneStatusForLight>
): Record<string, SessionLightOverride> {
    const lights: Record<string, SessionLightOverride> = {}
    for (const pane of panes) {
        const paneStatus = paneStatuses[pane.id]
        const signals = paneStatus?.signals
        const unread = hasUnreadSignals(signals)
        const closed = Boolean(signals?.closed || paneStatus?.status === 'closed' || paneStatus?.status === 'error')
        if (!unread && !closed) continue
        const key = targetKey(pane.target)
        lights[key] = {
            unread: Boolean(lights[key]?.unread || unread),
            closed: Boolean(lights[key]?.closed || closed)
        }
    }
    return lights
}

export function clearTargetPaneSignalsState(
    panes: WorkspacePane[],
    paneStatuses: Record<string, PaneStatusForLight>,
    target: SessionTarget,
    keys: Array<keyof PaneSignals>
): Record<string, PaneStatusForLight> {
    const targetKeyToClear = targetKey(target)
    let changed = false
    const next: Record<string, PaneStatusForLight> = {}
    for (const [paneId, previous] of Object.entries(paneStatuses)) {
        const pane = panes.find((candidate) => candidate.id === paneId)
        if (!pane || targetKey(pane.target) !== targetKeyToClear || !previous.signals) {
            next[paneId] = previous
            continue
        }
        const nextSignals = { ...previous.signals }
        let paneChanged = false
        for (const key of keys) {
            if (nextSignals[key] !== undefined) {
                delete nextSignals[key]
                paneChanged = true
            }
        }
        if (paneChanged) changed = true
        next[paneId] = paneChanged ? { ...previous, signals: nextSignals } : previous
    }
    return changed ? next : paneStatuses
}

export function getPaneStatusLight(input: {
    status: PaneConnectionStatus
    signals?: PaneSignals
    timerActive?: boolean
}): PaneStatusLightModel {
    const unread = hasUnreadSignals(input.signals)
    const closed = Boolean(input.signals?.closed || input.status === 'closed' || input.status === 'error')
    const timerActive = Boolean(input.timerActive)
    const colorClass = closed
        ? 'bg-red-500'
        : unread
          ? 'bg-amber-400'
          : input.status === 'connecting'
            ? 'bg-neutral-500 animate-pulse'
            : input.status === 'open'
              ? 'bg-emerald-400'
              : timerActive
                ? 'bg-emerald-400'
                : 'bg-neutral-500'
    const title = closed
        ? 'Closed or error'
        : unread
          ? 'Unread output or timer activity'
          : timerActive
            ? 'Open; timer active'
            : input.status === 'open'
              ? 'Open and read'
              : 'Connecting or unknown'
    return { colorClass, title }
}

export function isSessionActivityUnread(liveSession: Pick<TargetSession, 'activity'> | undefined, lastReadAt: number): boolean {
    if (!liveSession) return false
    return liveSession.activity * 1000 > lastReadAt
}

function hasUnreadSignals(signals: PaneSignals | undefined): boolean {
    return Boolean(signals?.outputChanged || signals?.timerTriggered)
}
