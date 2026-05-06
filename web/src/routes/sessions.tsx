import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { LOCAL_HOST_ID, type HostInfo, type SessionTarget, type TargetSession } from '@tmuxd/shared'
import { api } from '../api/client'
import { clearToken } from '../auth/tokenStore'
import { listHostSessionsData } from '../hosts/sessionData'
import { createSessionWithOptionalName } from '../session/createSession'

function formatUnix(ts: number): string {
    if (!ts) return '—'
    const d = new Date(ts * 1000)
    return d.toLocaleString()
}

function errMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
}

export function SessionsPage() {
    const navigate = useNavigate()
    const qc = useQueryClient()
    const { data, isLoading, error, refetch } = useQuery({
        queryKey: ['hostSessions'],
        queryFn: listHostSessionsData,
        refetchInterval: 5000
    })

    const [newName, setNewName] = useState('')
    const [selectedHostId, setSelectedHostId] = useState(LOCAL_HOST_ID)
    const [pendingKills, setPendingKills] = useState<Set<string>>(() => new Set())
    const onlineHosts = orderLocalFirst(data?.hosts.filter((host) => host.status === 'online' && host.capabilities.includes('create')) ?? [])

    useEffect(() => {
        if (onlineHosts.length > 0 && !onlineHosts.some((host) => host.id === selectedHostId)) {
            setSelectedHostId(onlineHosts[0].id)
        }
    }, [onlineHosts, selectedHostId])

    const createMut = useMutation({
        mutationFn: (name: string) => createSessionWithOptionalName(name, (sessionName) => api.createHostSession(selectedHostId, sessionName)),
        onSuccess: () => {
            setNewName('')
            void invalidateSessionQueries(qc, selectedHostId)
        }
    })
    const killMut = useMutation({
        mutationFn: async (target: SessionTarget) => {
            const key = targetKey(target)
            setPendingKills((s) => {
                const n = new Set(s)
                n.add(key)
                return n
            })
            try {
                await api.killTargetSession(target)
            } finally {
                setPendingKills((s) => {
                    const n = new Set(s)
                    n.delete(key)
                    return n
                })
            }
        },
        onSuccess: (_data, target) => void invalidateSessionQueries(qc, target.hostId)
    })

    const confirmKill = (session: TargetSession) => {
        const target = targetFromSession(session)
        if (pendingKills.has(targetKey(target))) return
        const ok = window.confirm(
            `Kill tmux session "${session.name}" on ${session.hostName}? Any running processes inside it will be terminated.`
        )
        if (ok) killMut.mutate(target)
    }

    return (
        <div className="mx-auto flex h-full min-h-0 max-w-5xl flex-col gap-4 p-4 sm:gap-6 sm:p-6">
            <header className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
                <div>
                    <h1 className="text-lg font-semibold tracking-tight">tmux sessions</h1>
                    <p className="text-xs text-neutral-500">Pick a session from any connected host, or create a new one.</p>
                </div>
                <button
                    className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-800"
                    onClick={() => {
                        clearToken()
                        qc.clear()
                        navigate({ to: '/login' })
                    }}
                >
                    Sign out
                </button>
            </header>

            <form
                className="flex flex-col gap-2 sm:flex-row"
                onSubmit={(e) => {
                    e.preventDefault()
                    createMut.mutate(newName)
                }}
            >
                <select
                    className="rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
                    value={selectedHostId}
                    onChange={(e) => setSelectedHostId(e.target.value)}
                    disabled={createMut.isPending || onlineHosts.length === 0}
                    aria-label="Host"
                >
                    {onlineHosts.map((host) => (
                        <option key={host.id} value={host.id}>
                            {host.name}
                        </option>
                    ))}
                </select>
                <input
                    className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
                    placeholder="Session name (optional; letters, digits, ._-)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    pattern="[A-Za-z0-9._-]+"
                    maxLength={64}
                />
                <button
                    type="submit"
                    disabled={createMut.isPending || onlineHosts.length === 0}
                    className="rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
                >
                    {createMut.isPending ? 'New…' : 'New'}
                </button>
                <button
                    type="button"
                    className="rounded-md border border-neutral-700 px-3 py-2 text-sm text-neutral-300"
                    onClick={() => refetch()}
                >
                    Refresh
                </button>
            </form>

            {createMut.error && (
                <p className="text-sm text-red-400">
                    {errMessage(createMut.error) === 'session_exists'
                        ? 'A session with that name already exists.'
                        : errMessage(createMut.error)}
                </p>
            )}

            {isLoading && <p className="text-sm text-neutral-400">Loading…</p>}
            {error && <p className="text-sm text-red-400">{errMessage(error)}</p>}
            {data && (
                <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/40">
                    {data.errors.length > 0 && (
                        <div className="border-b border-amber-900/50 p-3 text-xs text-amber-300">
                            Some hosts could not be queried: {data.errors.map((item) => item.hostName).join(', ')}
                        </div>
                    )}
                    {data.sessions.length === 0 ? (
                        <div className="p-4 text-center text-sm text-neutral-500">No sessions yet.</div>
                    ) : (
                        groupedTargetSessions(data.sessions).map((group) => (
                            <HostSessionSection key={group.host.id} host={group.host} sessions={group.sessions}>
                                {group.sessions.map((s) => {
                                    const target = targetFromSession(s)
                                    return (
                                        <SessionRow
                                            key={`${s.hostId}:${s.name}`}
                                            session={s}
                                            onAttach={() => navigateToTarget(navigate, target)}
                                            onKill={() => confirmKill(s)}
                                            killing={pendingKills.has(targetKey(target))}
                                        />
                                    )
                                })}
                            </HostSessionSection>
                        ))
                    )}
                </div>
            )}
        </div>
    )
}

function HostSessionSection({ host, sessions, children }: { host: HostInfo; sessions: TargetSession[]; children: ReactNode }) {
    return (
        <section className="border-b border-neutral-800 last:border-b-0">
            <div className="flex items-center justify-between gap-2 bg-neutral-950/50 px-4 py-2">
                <div className="min-w-0">
                    <h2 className="truncate text-xs font-medium uppercase tracking-wide text-neutral-500">{host.name}</h2>
                    <p className="text-[10px] text-neutral-600">{host.isLocal ? 'local server' : 'agent'} · {host.status}</p>
                </div>
                <span className="text-[10px] text-neutral-600">{sessions.length}</span>
            </div>
            <ul className="divide-y divide-neutral-800">{children}</ul>
        </section>
    )
}

function SessionRow(props: {
    session: TargetSession
    onAttach: () => void
    onKill: () => void
    killing: boolean
}) {
    const { session, onAttach, onKill, killing } = props
    return (
        <li className="flex flex-col items-stretch justify-between gap-3 p-4 hover:bg-neutral-900/70 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className="truncate font-mono text-sm">{session.name}</span>
                    {session.attached && (
                        <span className="rounded-full bg-emerald-900/50 px-2 py-0.5 text-xs text-emerald-300">attached</span>
                    )}
                </div>
                <div className="mt-0.5 flex flex-wrap gap-x-4 text-xs text-neutral-500">
                    <span>{session.windows} windows</span>
                    <span>created {formatUnix(session.created)}</span>
                    <span>activity {formatUnix(session.activity)}</span>
                </div>
            </div>
            <div className="flex gap-2 sm:shrink-0">
                <button
                    className="flex-1 rounded-md bg-neutral-100 px-3 py-2 text-xs font-medium text-neutral-900 hover:bg-white sm:flex-none sm:py-1.5"
                    onClick={onAttach}
                >
                    Attach
                </button>
                <button
                    className="flex-1 rounded-md border border-red-800 px-3 py-2 text-xs text-red-300 hover:bg-red-900/30 disabled:opacity-50 sm:flex-none sm:py-1.5"
                    onClick={onKill}
                    disabled={killing}
                >
                    {killing ? '…' : 'Kill'}
                </button>
            </div>
        </li>
    )
}

function orderLocalFirst(hosts: HostInfo[]): HostInfo[] {
    const local = hosts.find((host) => host.id === LOCAL_HOST_ID)
    return local ? [local, ...hosts.filter((host) => host.id !== LOCAL_HOST_ID)] : hosts
}

function groupedTargetSessions(sessions: TargetSession[]): Array<{ host: HostInfo; sessions: TargetSession[] }> {
    const groups = new Map<string, { host: HostInfo; sessions: TargetSession[] }>()
    for (const session of sessions) {
        const existing = groups.get(session.hostId)
        if (existing) existing.sessions.push(session)
        else {
            groups.set(session.hostId, {
                host: {
                    id: session.hostId,
                    name: session.hostName,
                    status: 'online',
                    isLocal: session.hostId === LOCAL_HOST_ID,
                    version: '',
                    lastSeenAt: 0,
                    capabilities: []
                },
                sessions: [session]
            })
        }
    }
    return [...groups.values()]
}

function targetFromSession(session: TargetSession): SessionTarget {
    return { hostId: session.hostId, sessionName: session.name }
}

function targetKey(target: SessionTarget): string {
    return `${target.hostId}\n${target.sessionName}`
}

function navigateToTarget(navigate: ReturnType<typeof useNavigate>, target: SessionTarget): void {
    if (target.hostId === LOCAL_HOST_ID) navigate({ to: '/attach/$name', params: { name: target.sessionName } })
    else navigate({ to: '/attach/$hostId/$name', params: { hostId: target.hostId, name: target.sessionName } })
}

async function invalidateSessionQueries(queryClient: ReturnType<typeof useQueryClient>, hostId: string): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['hostSessions'] }),
        queryClient.invalidateQueries({ queryKey: ['sessions', hostId] }),
        queryClient.invalidateQueries({ queryKey: ['hosts'] })
    ])
}
