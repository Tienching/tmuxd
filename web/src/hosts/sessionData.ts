import type { HostInfo, TargetSession } from '@tmuxd/shared'
import { api } from '../api/client'

export interface HostSessionsData {
    hosts: HostInfo[]
    sessions: TargetSession[]
    errors: Array<{ hostId: string; hostName: string; message: string }>
}

export async function listHostSessionsData(): Promise<HostSessionsData> {
    const { hosts } = await api.listHosts()
    const results = await Promise.all(
        hosts.map(async (host) => {
            if (host.status !== 'online') return { host, sessions: [] as TargetSession[], error: null as string | null }
            try {
                const { sessions } = await api.listHostSessions(host.id)
                return { host, sessions, error: null as string | null }
            } catch (err) {
                return { host, sessions: [] as TargetSession[], error: err instanceof Error ? err.message : String(err) }
            }
        })
    )
    return {
        hosts,
        sessions: results.flatMap((result) => result.sessions),
        errors: results
            .filter((result) => result.error)
            .map((result) => ({ hostId: result.host.id, hostName: result.host.name, message: result.error as string }))
    }
}
