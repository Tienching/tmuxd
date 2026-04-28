import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/client'
import { listOpenSessions, removeOpenSession, subscribeOpenSessions, type OpenSession } from '../session/openSessions'
import { createSessionWithOptionalName } from '../session/createSession'

const SIDEBAR_HIDDEN_KEY = 'tmuxd.sidebarHidden'

export function OpenSessionsSidebar({ currentName, hidden, onToggleHidden }: { currentName: string; hidden: boolean; onToggleHidden: () => void }) {
    const navigate = useNavigate()
    const { createAndOpenSession, creating, createError } = useCreateAndOpenSession()
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
                className="hidden shrink-0 border-neutral-800 bg-neutral-950 px-3 py-2 text-left text-xs text-neutral-400 hover:text-neutral-100 md:block md:h-full md:border-r md:[writing-mode:vertical-rl]"
                onClick={onToggleHidden}
                title="Show sessions sidebar"
            >
                Sessions
            </button>
        )
    }

    return (
        <aside className="hidden shrink-0 overflow-y-auto border-neutral-800 bg-neutral-950/80 p-2 md:block md:h-full md:w-56 md:border-r">
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
            <button
                type="button"
                className="mb-2 w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-2 text-left text-xs font-medium text-neutral-100 hover:bg-neutral-900 disabled:opacity-50"
                disabled={creating}
                onClick={createAndOpenSession}
            >
                {creating ? 'Creating…' : '+ New session'}
            </button>
            {createError && <p className="mb-2 px-1 text-xs text-red-400">{createError}</p>}
            {visibleOpenedSessions.length === 0 ? (
                <p className="px-1 text-xs text-neutral-600">No opened sessions yet.</p>
            ) : (
                <nav className="flex flex-col gap-2">
                    {visibleOpenedSessions.map((s) => {
                        const active = s.name === currentName
                        return (
                            <div
                                key={s.name}
                                className={`flex min-w-0 items-center gap-1 rounded-md border ${
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
                <nav className="flex flex-col gap-2">
                    {otherSessions.map((s) => (
                        <button
                            key={s.name}
                            className="min-w-0 truncate rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-2 text-left font-mono text-xs text-neutral-100 hover:bg-neutral-900"
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

export function MobileSessionSelect({ currentName }: { currentName: string }) {
    const navigate = useNavigate()
    const [sessions, setSessions] = useState<OpenSession[]>(() => listOpenSessions())
    const [menuOpen, setMenuOpen] = useState(false)
    const { createAndOpenSession, creating, createError } = useCreateAndOpenSession({
        onCreated: () => setMenuOpen(false)
    })
    const { data, error, isLoading } = useQuery({
        queryKey: ['sessions'],
        queryFn: () => api.listSessions(),
        refetchInterval: 5000
    })

    useEffect(() => {
        return subscribeOpenSessions(() => setSessions(listOpenSessions()))
    }, [])

    const liveNames = data ? new Set(data.sessions.map((s) => s.name)) : null
    const visibleOpenedSessions = liveNames ? sessions.filter((s) => liveNames.has(s.name)) : sessions
    const openedNames = new Set(visibleOpenedSessions.map((s) => s.name))
    const otherSessions = data?.sessions.filter((s) => !openedNames.has(s.name)) ?? []
    const knownNames = new Set([...visibleOpenedSessions.map((s) => s.name), ...otherSessions.map((s) => s.name)])
    const showCurrentFallback = !knownNames.has(currentName)
    const hasAnySession = showCurrentFallback || visibleOpenedSessions.length > 0 || otherSessions.length > 0

    const attachSession = (name: string) => {
        if (!name) return
        setMenuOpen(false)
        if (name !== currentName) {
            navigate({ to: '/attach/$name', params: { name } })
        }
    }

    return (
        <div className="flex min-w-0 items-center gap-1 md:hidden">
            <button
                type="button"
                className="max-w-[58vw] truncate rounded-md border border-neutral-700 bg-neutral-950 px-2 py-1 text-left font-mono text-xs text-neutral-100"
                aria-expanded={menuOpen}
                disabled={isLoading || Boolean(error)}
                onClick={() => setMenuOpen((open) => !open)}
            >
                {currentName} ▾
            </button>
            {menuOpen && (
                <div className="fixed inset-0 z-50 bg-black/50 p-2 pt-14" onClick={() => setMenuOpen(false)}>
                    <div
                        className="mobile-session-menu max-h-[72dvh] overflow-y-auto rounded-lg border border-neutral-700 bg-neutral-950 p-2 shadow-xl"
                        onClick={(event) => event.stopPropagation()}
                    >
                        <div className="mb-2 flex items-center justify-between px-1">
                            <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Sessions</h2>
                            <button
                                type="button"
                                className="rounded px-2 py-1 text-xs text-neutral-400 active:bg-neutral-800"
                                onClick={() => setMenuOpen(false)}
                            >
                                Close
                            </button>
                        </div>

                        <button
                            type="button"
                            className="mb-2 w-full rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-2 text-left text-xs font-medium text-neutral-100 active:bg-neutral-800 disabled:opacity-50"
                            disabled={creating}
                            onClick={createAndOpenSession}
                        >
                            {creating ? 'Creating…' : '+ New session'}
                        </button>
                        {createError && <p className="mb-2 px-1 text-xs text-red-400">{createError}</p>}

                        {showCurrentFallback && <SessionMenuButton name={currentName} active onClick={() => attachSession(currentName)} />}

                        {visibleOpenedSessions.length > 0 && (
                            <>
                                <div className="mt-2 mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-600">Opened</div>
                                <nav className="flex flex-col gap-1">
                                    {visibleOpenedSessions.map((s) => (
                                        <div
                                            key={`opened-mobile-${s.name}`}
                                            className={`flex min-w-0 items-center gap-1 rounded-md border ${
                                                s.name === currentName ? 'border-neutral-500 bg-neutral-800' : 'border-neutral-800 bg-neutral-900/60'
                                            }`}
                                        >
                                            <button
                                                type="button"
                                                className="min-w-0 flex-1 truncate px-2 py-2 text-left font-mono text-xs text-neutral-100"
                                                aria-current={s.name === currentName ? 'page' : undefined}
                                                onClick={() => attachSession(s.name)}
                                            >
                                                {s.name}
                                            </button>
                                            <button
                                                type="button"
                                                className="px-3 py-2 text-xs text-neutral-500 active:bg-neutral-800 active:text-neutral-100"
                                                aria-label={`Remove ${s.name} from opened sessions`}
                                                onClick={() => removeOpenSession(s.name)}
                                            >
                                                ×
                                            </button>
                                        </div>
                                    ))}
                                </nav>
                            </>
                        )}

                        <div className="mt-3 mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-600">All sessions</div>
                        {error ? (
                            <p className="px-1 text-xs text-red-400">Failed to load sessions.</p>
                        ) : !hasAnySession ? (
                            <p className="px-1 text-xs text-neutral-600">No sessions.</p>
                        ) : otherSessions.length === 0 ? (
                            <p className="px-1 text-xs text-neutral-600">No more sessions.</p>
                        ) : (
                            <nav className="flex flex-col gap-1">
                                {otherSessions.map((s) => (
                                    <SessionMenuButton
                                        key={`all-mobile-${s.name}`}
                                        name={s.name}
                                        active={s.name === currentName}
                                        onClick={() => attachSession(s.name)}
                                    />
                                ))}
                            </nav>
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

function SessionMenuButton({ name, active, onClick }: { name: string; active?: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            className={`truncate rounded-md border px-2 py-2 text-left font-mono text-xs text-neutral-100 ${
                active ? 'border-neutral-500 bg-neutral-800' : 'border-neutral-800 bg-neutral-900/60 active:bg-neutral-800'
            }`}
            aria-current={active ? 'page' : undefined}
            onClick={onClick}
        >
            {name}
        </button>
    )
}

function useCreateAndOpenSession(options: { onCreated?: () => void } = {}) {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState<string | null>(null)

    const createAndOpenSession = async () => {
        if (creating) return
        setCreating(true)
        setCreateError(null)
        try {
            const name = await createSessionWithOptionalName()
            await queryClient.invalidateQueries({ queryKey: ['sessions'] })
            options.onCreated?.()
            navigate({ to: '/attach/$name', params: { name } })
        } catch {
            setCreateError('Failed to create session.')
        } finally {
            setCreating(false)
        }
    }

    return { createAndOpenSession, creating, createError }
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
