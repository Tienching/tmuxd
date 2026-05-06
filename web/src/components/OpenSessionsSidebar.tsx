import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { LOCAL_HOST_ID, type SessionTarget, type TargetSession } from '@tmuxd/shared'
import { api } from '../api/client'
import { listHostSessionsData } from '../hosts/sessionData'
import { listOpenSessions, removeOpenSession, subscribeOpenSessions, type OpenSession } from '../session/openSessions'
import { createSessionWithOptionalName } from '../session/createSession'

const SIDEBAR_HIDDEN_KEY = 'tmuxd.sidebarHidden'

export function OpenSessionsSidebar({
    currentName,
    currentHostId = LOCAL_HOST_ID,
    hidden,
    onToggleHidden,
    onOpenSession
}: {
    currentName: string
    currentHostId?: string
    hidden: boolean
    onToggleHidden: () => void
    onOpenSession?: (target: SessionTarget) => void
}) {
    const navigate = useNavigate()
    const { createAndOpenSession, creating, createError } = useCreateAndOpenSession({ hostId: currentHostId, onOpenSession })
    const [sessions, setSessions] = useState<OpenSession[]>(() => listOpenSessions())
    const { data, error, isLoading } = useQuery({
        queryKey: ['hostSessions'],
        queryFn: listHostSessionsData,
        refetchInterval: 5000
    })

    useEffect(() => {
        return subscribeOpenSessions(() => setSessions(listOpenSessions()))
    }, [])

    const openSession = (target: SessionTarget) => {
        if (onOpenSession) {
            onOpenSession(target)
            return
        }
        navigateToTarget(navigate, target)
    }

    const liveKeys = data ? new Set(data.sessions.map(targetSessionKey)) : null
    const visibleOpenedSessions = liveKeys ? sessions.filter((s) => liveKeys.has(openSessionKey(s))) : sessions
    const openedGroups = groupedOpenSessions(visibleOpenedSessions)
    const openedKeys = new Set(visibleOpenedSessions.map(openSessionKey))
    const otherSessions = data?.sessions.filter((s) => !openedKeys.has(targetSessionKey(s))) ?? []
    const totalSessionCount = data?.sessions.length ?? 0
    const hostTotals = countSessionsByHost(data?.sessions ?? [])

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
        <aside className="hidden shrink-0 overflow-y-auto border-neutral-800 bg-neutral-950/80 p-2 md:block md:h-full md:w-60 md:border-r">
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
            <NewSessionForm creating={creating} createError={createError} onCreate={createAndOpenSession} />
            {createError && <p className="mb-2 px-1 text-xs text-red-400">{createError}</p>}
            {visibleOpenedSessions.length === 0 ? (
                <p className="px-1 text-xs text-neutral-600">No opened sessions yet.</p>
            ) : (
                openedGroups.map((group) => (
                    <SessionGroup key={`opened-${group.hostId}`} title={group.hostName} count={group.sessions.length}>
                        {group.sessions.map((s) => {
                            const active = s.name === currentName && s.hostId === currentHostId
                            return (
                                <div
                                    key={`${s.hostId}:${s.name}`}
                                    className={`flex min-w-0 items-center gap-1 rounded-md border ${
                                        active
                                            ? 'border-neutral-500 bg-neutral-800'
                                            : 'border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900'
                                    }`}
                                >
                                    <button
                                        className="min-w-0 flex-1 px-2 py-2 text-left text-xs text-neutral-100"
                                        aria-current={active ? 'page' : undefined}
                                        onClick={() => openSession(openSessionTarget(s))}
                                    >
                                        <span className="block truncate font-mono">{s.name}</span>
                                    </button>
                                    <button
                                        type="button"
                                        className="px-2 py-2 text-xs text-neutral-500 hover:text-neutral-100"
                                        aria-label={`Remove ${s.name} from opened sessions`}
                                        onClick={() => removeOpenSession({ hostId: s.hostId, sessionName: s.name })}
                                    >
                                        ×
                                    </button>
                                </div>
                            )
                        })}
                    </SessionGroup>
                ))
            )}
            <div className="mt-3 mb-2 flex items-center justify-between gap-2 px-1">
                <h2 className="text-xs font-medium uppercase tracking-wide text-neutral-500">Not opened</h2>
                <span className="text-[10px] text-neutral-600">{otherSessions.length} / {totalSessionCount} total</span>
            </div>
            {isLoading ? (
                <p className="px-1 text-xs text-neutral-600">Loading sessions…</p>
            ) : error ? (
                <p className="px-1 text-xs text-red-400">Failed to load sessions.</p>
            ) : otherSessions.length === 0 ? (
                <p className="px-1 text-xs text-neutral-600">All live sessions are already in Opened.</p>
            ) : (
                groupedTargetSessions(otherSessions).map((group) => (
                    <SessionGroup
                        key={group.hostId}
                        title={group.hostName}
                        count={group.sessions.length}
                        countLabel={formatSessionCount(group.sessions.length, hostTotals.get(group.hostId) ?? group.sessions.length)}
                    >
                        {group.sessions.map((s) => (
                            <button
                                key={`${s.hostId}:${s.name}`}
                                className="min-w-0 truncate rounded-md border border-neutral-800 bg-neutral-900/60 px-2 py-2 text-left font-mono text-xs text-neutral-100 hover:bg-neutral-900"
                                onClick={() => openSession(targetFromSession(s))}
                            >
                                {s.name}
                            </button>
                        ))}
                    </SessionGroup>
                ))
            )}
        </aside>
    )
}

export function MobileSessionSelect({
    currentName,
    currentHostId = LOCAL_HOST_ID,
    onOpenSession
}: {
    currentName: string
    currentHostId?: string
    onOpenSession?: (target: SessionTarget) => void
}) {
    const navigate = useNavigate()
    const [sessions, setSessions] = useState<OpenSession[]>(() => listOpenSessions())
    const [menuOpen, setMenuOpen] = useState(false)
    const { createAndOpenSession, creating, createError } = useCreateAndOpenSession({
        hostId: currentHostId,
        onCreated: () => setMenuOpen(false),
        onOpenSession
    })
    const { data, error, isLoading } = useQuery({
        queryKey: ['hostSessions'],
        queryFn: listHostSessionsData,
        refetchInterval: 5000
    })

    useEffect(() => {
        return subscribeOpenSessions(() => setSessions(listOpenSessions()))
    }, [])

    const liveKeys = data ? new Set(data.sessions.map(targetSessionKey)) : null
    const visibleOpenedSessions = liveKeys ? sessions.filter((s) => liveKeys.has(openSessionKey(s))) : sessions
    const openedGroups = groupedOpenSessions(visibleOpenedSessions)
    const openedKeys = new Set(visibleOpenedSessions.map(openSessionKey))
    const otherSessions = data?.sessions.filter((s) => !openedKeys.has(targetSessionKey(s))) ?? []
    const totalSessionCount = data?.sessions.length ?? 0
    const hostTotals = countSessionsByHost(data?.sessions ?? [])
    const currentKey = targetKey({ hostId: currentHostId, sessionName: currentName })
    const knownKeys = new Set([...visibleOpenedSessions.map(openSessionKey), ...otherSessions.map(targetSessionKey)])
    const showCurrentFallback = !knownKeys.has(currentKey)
    const hasAnySession = showCurrentFallback || visibleOpenedSessions.length > 0 || otherSessions.length > 0
    const currentHostName = data?.hosts.find((host) => host.id === currentHostId)?.name ?? hostLabel(currentHostId)

    const attachSession = (target: SessionTarget) => {
        setMenuOpen(false)
        if (onOpenSession) {
            onOpenSession(target)
            return
        }
        if (!sameTarget(target, { hostId: currentHostId, sessionName: currentName })) {
            navigateToTarget(navigate, target)
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
                {currentHostId === LOCAL_HOST_ID ? currentName : `${currentHostName}/${currentName}`} ▾
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

                        <NewSessionForm creating={creating} createError={createError} onCreate={createAndOpenSession} mobile />
                        {createError && <p className="mb-2 px-1 text-xs text-red-400">{createError}</p>}

                        {showCurrentFallback && (
                            <SessionMenuButton
                                name={currentName}
                                hostName={currentHostId === LOCAL_HOST_ID ? undefined : currentHostName}
                                active
                                onClick={() => attachSession({ hostId: currentHostId, sessionName: currentName })}
                            />
                        )}

                        {visibleOpenedSessions.length > 0 && (
                            <>
                                <div className="mt-2 mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-600">Opened</div>
                                {openedGroups.map((group) => (
                                    <SessionGroup key={`opened-mobile-${group.hostId}`} title={group.hostName} count={group.sessions.length} mobile>
                                        {group.sessions.map((s) => (
                                            <div
                                                key={`opened-mobile-${s.hostId}-${s.name}`}
                                                className={`flex min-w-0 items-center gap-1 rounded-md border ${
                                                    s.name === currentName && s.hostId === currentHostId
                                                        ? 'border-neutral-500 bg-neutral-800'
                                                        : 'border-neutral-800 bg-neutral-900/60'
                                                }`}
                                            >
                                                <button
                                                    type="button"
                                                    className="min-w-0 flex-1 px-2 py-2 text-left text-xs text-neutral-100"
                                                    aria-current={s.name === currentName && s.hostId === currentHostId ? 'page' : undefined}
                                                    onClick={() => attachSession(openSessionTarget(s))}
                                                >
                                                    <span className="block truncate font-mono">{s.name}</span>
                                                </button>
                                                <button
                                                    type="button"
                                                    className="px-3 py-2 text-xs text-neutral-500 active:bg-neutral-800 active:text-neutral-100"
                                                    aria-label={`Remove ${s.name} from opened sessions`}
                                                    onClick={() => removeOpenSession({ hostId: s.hostId, sessionName: s.name })}
                                                >
                                                    ×
                                                </button>
                                            </div>
                                        ))}
                                    </SessionGroup>
                                ))}
                            </>
                        )}

                        <div className="mt-3 mb-1 flex items-center justify-between gap-2 px-1">
                            <span className="text-[10px] font-medium uppercase tracking-wide text-neutral-600">Not opened</span>
                            <span className="text-[10px] text-neutral-700">{otherSessions.length} / {totalSessionCount} total</span>
                        </div>
                        {error ? (
                            <p className="px-1 text-xs text-red-400">Failed to load sessions.</p>
                        ) : !hasAnySession ? (
                            <p className="px-1 text-xs text-neutral-600">No sessions.</p>
                        ) : otherSessions.length === 0 ? (
                            <p className="px-1 text-xs text-neutral-600">All live sessions are already in Opened.</p>
                        ) : (
                            groupedTargetSessions(otherSessions).map((group) => (
                                <SessionGroup
                                    key={`mobile-${group.hostId}`}
                                    title={group.hostName}
                                    count={group.sessions.length}
                                    countLabel={formatSessionCount(group.sessions.length, hostTotals.get(group.hostId) ?? group.sessions.length)}
                                    mobile
                                >
                                    {group.sessions.map((s) => (
                                        <SessionMenuButton
                                            key={`all-mobile-${s.hostId}-${s.name}`}
                                            name={s.name}
                                            active={s.name === currentName && s.hostId === currentHostId}
                                            onClick={() => attachSession(targetFromSession(s))}
                                        />
                                    ))}
                                </SessionGroup>
                            ))
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

function SessionGroup({
    title,
    count,
    countLabel,
    mobile,
    children
}: {
    title: string
    count: number
    countLabel?: string
    mobile?: boolean
    children: ReactNode
}) {
    return (
        <section className="mb-3 last:mb-0">
            <div className="mb-1 flex items-center justify-between gap-2 px-1">
                <h3 className="truncate text-[10px] font-medium uppercase tracking-wide text-neutral-600">{title}</h3>
                <span className="shrink-0 text-[10px] text-neutral-700">{countLabel ?? count}</span>
            </div>
            <nav className={`flex flex-col ${mobile ? 'gap-1' : 'gap-2'}`}>{children}</nav>
        </section>
    )
}

function SessionMenuButton({ name, hostName, active, onClick }: { name: string; hostName?: string; active?: boolean; onClick: () => void }) {
    return (
        <button
            type="button"
            className={`truncate rounded-md border px-2 py-2 text-left text-xs text-neutral-100 ${
                active ? 'border-neutral-500 bg-neutral-800' : 'border-neutral-800 bg-neutral-900/60 active:bg-neutral-800'
            }`}
            aria-current={active ? 'page' : undefined}
            onClick={onClick}
        >
            <span className="block truncate font-mono">{name}</span>
            {hostName && <span className="block truncate text-[10px] text-neutral-500">{hostName}</span>}
        </button>
    )
}

function NewSessionForm({
    creating,
    createError,
    onCreate,
    mobile = false
}: {
    creating: boolean
    createError: string | null
    onCreate: (name?: string) => Promise<boolean>
    mobile?: boolean
}) {
    const [name, setName] = useState('')

    return (
        <form
            className="mb-2 flex gap-1"
            onSubmit={(event) => {
                event.preventDefault()
                void onCreate(name).then((ok) => {
                    if (ok) setName('')
                })
            }}
        >
            <input
                className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-2 text-xs text-neutral-100 outline-none focus:border-neutral-600"
                placeholder="Session name (optional)"
                value={name}
                onChange={(event) => setName(event.target.value)}
                pattern="[A-Za-z0-9._-]+"
                maxLength={64}
                disabled={creating}
                aria-invalid={Boolean(createError)}
            />
            <button
                type="submit"
                className={`shrink-0 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-2 text-xs font-medium text-neutral-100 disabled:opacity-50 ${
                    mobile ? 'active:bg-neutral-800' : 'hover:bg-neutral-800'
                }`}
                disabled={creating}
            >
                {creating ? 'New…' : 'New'}
            </button>
        </form>
    )
}

function useCreateAndOpenSession(options: { hostId: string; onCreated?: () => void; onOpenSession?: (target: SessionTarget) => void }) {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState<string | null>(null)

    const createAndOpenSession = async (inputName = ''): Promise<boolean> => {
        if (creating) return false
        setCreating(true)
        setCreateError(null)
        try {
            const hostId = options.hostId || LOCAL_HOST_ID
            const name = await createSessionWithOptionalName(inputName, (name) => api.createHostSession(hostId, name))
            await invalidateSessionQueries(queryClient, hostId)
            options.onCreated?.()
            const target = { hostId, sessionName: name }
            if (options.onOpenSession) {
                options.onOpenSession(target)
                return true
            }
            navigateToTarget(navigate, target)
            return true
        } catch {
            setCreateError('Failed to create session.')
            return false
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

function targetKey(target: SessionTarget): string {
    return `${target.hostId}\n${target.sessionName}`
}

function targetSessionKey(session: TargetSession): string {
    return targetKey(targetFromSession(session))
}

function openSessionKey(session: OpenSession): string {
    return targetKey(openSessionTarget(session))
}

function targetFromSession(session: TargetSession): SessionTarget {
    return { hostId: session.hostId, sessionName: session.name }
}

function openSessionTarget(session: OpenSession): SessionTarget {
    return { hostId: session.hostId, sessionName: session.name }
}

function sameTarget(a: SessionTarget, b: SessionTarget): boolean {
    return a.hostId === b.hostId && a.sessionName === b.sessionName
}

function groupedOpenSessions(sessions: OpenSession[]): Array<{ hostId: string; hostName: string; sessions: OpenSession[] }> {
    const groups = new Map<string, { hostId: string; hostName: string; sessions: OpenSession[] }>()
    for (const session of sessions) {
        const existing = groups.get(session.hostId)
        if (existing) existing.sessions.push(session)
        else groups.set(session.hostId, { hostId: session.hostId, hostName: session.hostName, sessions: [session] })
    }
    return [...groups.values()]
}

function countSessionsByHost(sessions: TargetSession[]): Map<string, number> {
    const counts = new Map<string, number>()
    for (const session of sessions) counts.set(session.hostId, (counts.get(session.hostId) ?? 0) + 1)
    return counts
}

function formatSessionCount(visible: number, total: number): string {
    return `${visible} / ${total} total`
}

function groupedTargetSessions(sessions: TargetSession[]): Array<{ hostId: string; hostName: string; sessions: TargetSession[] }> {
    const groups = new Map<string, { hostId: string; hostName: string; sessions: TargetSession[] }>()
    for (const session of sessions) {
        const existing = groups.get(session.hostId)
        if (existing) existing.sessions.push(session)
        else groups.set(session.hostId, { hostId: session.hostId, hostName: session.hostName, sessions: [session] })
    }
    return [...groups.values()]
}

function hostLabel(hostId: string): string {
    return hostId === LOCAL_HOST_ID ? 'Local' : hostId
}

async function invalidateSessionQueries(queryClient: ReturnType<typeof useQueryClient>, hostId: string): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['sessions'] }),
        queryClient.invalidateQueries({ queryKey: ['hostSessions'] }),
        queryClient.invalidateQueries({ queryKey: ['sessions', hostId] }),
        queryClient.invalidateQueries({ queryKey: ['hosts'] })
    ])
}

function navigateToTarget(navigate: ReturnType<typeof useNavigate>, target: SessionTarget): void {
    if (target.hostId === LOCAL_HOST_ID) navigate({ to: '/attach/$name', params: { name: target.sessionName } })
    else navigate({ to: '/attach/$hostId/$name', params: { hostId: target.hostId, name: target.sessionName } })
}
