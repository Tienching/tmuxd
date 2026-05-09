import type { HostInfo, TargetPane, TargetSession } from '@tmuxd/shared'
import { api } from '../api/client'

export interface HostSessionsData {
    hosts: HostInfo[]
    sessions: TargetSession[]
    panes: TargetPane[]
    errors: Array<{ hostId: string; hostName: string; message: string }>
}

export async function listHostSessionsData(): Promise<HostSessionsData> {
    const { hosts } = await api.listHosts()
    const results = await Promise.all(
        hosts.map(async (host) => {
            if (host.status !== 'online') {
                return { host, sessions: [] as TargetSession[], panes: [] as TargetPane[], errors: [] as string[] }
            }
            const errors: string[] = []
            let sessions: TargetSession[] = []
            let panes: TargetPane[] = []
            try {
                sessions = readArrayResponse<TargetSession>(await api.listHostSessions(host.id), 'sessions')
            } catch (err) {
                errors.push(err instanceof Error ? err.message : String(err))
            }
            try {
                panes = readArrayResponse<TargetPane>(await api.listHostPanes(host.id), 'panes')
            } catch (err) {
                errors.push(err instanceof Error ? err.message : String(err))
            }
            return { host, sessions, panes, errors }
        })
    )
    const panes = results.flatMap((result) => result.panes)
    return {
        hosts,
        sessions: withPaneActivity(results.flatMap((result) => result.sessions), panes),
        panes,
        errors: results.flatMap((result) =>
            result.errors.map((message) => ({ hostId: result.host.id, hostName: result.host.name, message }))
        )
    }
}

export function withPaneActivity(sessions: TargetSession[], panes: TargetPane[]): TargetSession[] {
    const activityBySession = new Map<string, number>()
    for (const pane of panes) {
        const key = sessionKey(pane.hostId, pane.sessionName)
        const paneActivity = Math.max(pane.sessionActivity || 0, pane.windowActivity || 0)
        activityBySession.set(key, Math.max(activityBySession.get(key) ?? 0, paneActivity))
    }
    return sessions.map((session) => {
        const paneActivity = activityBySession.get(sessionKey(session.hostId, session.name)) ?? 0
        return paneActivity > session.activity ? { ...session, activity: paneActivity } : session
    })
}

function sessionKey(hostId: string, sessionName: string): string {
    return `${hostId}\0${sessionName}`
}

function readArrayResponse<T>(response: unknown, key: string): T[] {
    const value = response && typeof response === 'object' ? (response as Record<string, unknown>)[key] : undefined
    if (Array.isArray(value)) return value as T[]
    throw new Error(`invalid_${key}_response`)
}
