import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { api } from '../api/client'
import { listOpenSessions, removeOpenSession, subscribeOpenSessions, type OpenSession } from '../session/openSessions'

const SIDEBAR_HIDDEN_KEY = 'tmuxd.sidebarHidden'

export function OpenSessionsSidebar({ currentName, hidden, onToggleHidden }: { currentName: string; hidden: boolean; onToggleHidden: () => void }) {
    const navigate = useNavigate()
    const [sessions, setSessions] = useState<OpenSession[]>(() => listOpenSessions())
    const { data, error, isLoading } = useQuery({
        queryKey: ['sessions'],
        queryFn: () => api.listSessions(),
        refetchInterval: 5000
    })

    useEffect(() => {
        return subscribeOpenSessions(() => setSessions(listOpenSessions()))
    }, [])

    const openSession = (name: string) => {
        const trimmed = name.trim()
        if (!trimmed) return
        navigate({ to: '/attach/$name', params: { name: trimmed } })
    }

    const liveNames = data ? new Set(data.sessions.map((s) => s.name)) : null
    const visibleOpenedSessions = liveNames ? sessions.filter((s) => liveNames.has(s.name)) : sessions
    const openedNames = new Set(visibleOpenedSessions.map((s) => s.name))
    const otherSessions = data?.sessions.filter((s) => !openedNames.has(s.name)) ?? []

    if (hidden) {
        return (
            <button
                type="button"
                className="shrink-0 border-b border-neutral-800 bg-neutral-950 px-3 py-2 text-left text-xs text-neutral-400 hover:text-neutral-100 md:h-full md:border-b-0 md:border-r md:[writing-mode:vertical-rl]"
                onClick={onToggleHidden}
                title="Show sessions sidebar"
            >
                Sessions
            </button>
        )
    }

    return (
        <aside className="max-h-48 shrink-0 overflow-y-auto border-b border-neutral-800 bg-neutral-950/80 p-2 md:h-full md:max-h-none md:w-56 md:border-b-0 md:border-r">
            <div className="mb-2 flex items-center justify-between gap-2 px-1">
                <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Opened</h2>
                <div className="flex items-center gap-2">
                    <span className="text-[10px] text-neutral-600">{visibleOpenedSessions.length}</span>
                    <button
                        type="button"
                        className="rounded px-1 text-xs text-neutral-500 hover:text-neutral-100"
                        onClick={onToggleHidden}
                        title="Hide sessions sidebar"
                    >
                        Hide
                    </button>
                </div>
            </div>
            {visibleOpenedSessions.length === 0 ? (
                <p className="px-1 text-xs text-neutral-600">No opened sessions yet.</p>
            ) : (
                <nav className="flex gap-2 overflow-x-auto md:flex-col md:overflow-x-visible">
                    {visibleOpenedSessions.map((s) => {
                        const active = s.name === currentName
                        return (
                            <div
                                key={s.name}
                                className={`flex min-w-40 items-center gap-1 rounded-md border md:min-w-0 ${
                                    active
                                        ? 'border-neutral-500 bg-neutral-800'
                                        : 'border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900'
                                }`}
                            >
                                <button
                                    className="min-w-0 flex-1 truncate px-2 py-2 text-left font-mono text-xs text-neutral-100"
                                    aria-current={active ? 'page' : undefined}
                                    onClick={() => openSession(s.name)}
                                >
                                    {s.name}
                                </button>
                                <button
                                    type="button"
                                    className="px-2 py-2 text-xs text-neutral-500 hover:text-neutral-100"
                                    aria-label={`Remove ${s.name} from opened sessions`}
                                    onClick={() => removeOpenSession(s.name)}
                                >
                                    ×
                                </button>
                            </div>
                        )
                    })}
                </nav>
            )}
            <div className="mt-3 mb-2 flex items-center justify-between gap-2 px-1">
                <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">All sessions</h2>
                <span className="text-[10px] text-neutral-600">{data?.sessions.length ?? 0}</span>
            </div>
            {isLoading ? (
                <p className="px-1 text-xs text-neutral-600">Loading sessions…</p>
            ) : error ? (
                <p className="px-1 text-xs text-red-400">Failed to load sessions.</p>
            ) : otherSessions.length === 0 ? (
                <p className="px-1 text-xs text-neutral-600">No more sessions.</p>
            ) : (
                <nav className="flex gap-2 overflow-x-auto md:flex-col md:overflow-x-visible">
                    {otherSessions.map((s) => (
                        <button
                            key={s.name}
                            className="min-w-40 truncate rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-2 text-left font-mono text-xs text-neutral-100 hover:bg-neutral-900 md:min-w-0"
                            onClick={() => openSession(s.name)}
                        >
                            {s.name}
                        </button>
                    ))}
                </nav>
            )}
        </aside>
    )
}

export function getInitialSidebarHidden(): boolean {
    try {
        return localStorage.getItem(SIDEBAR_HIDDEN_KEY) === '1'
    } catch {
        return false
    }
}

export function saveSidebarHidden(hidden: boolean): void {
    try {
        localStorage.setItem(SIDEBAR_HIDDEN_KEY, hidden ? '1' : '0')
    } catch {
        /* ignore */
    }
}
