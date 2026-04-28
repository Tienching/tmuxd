import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { useState } from 'react'
import { api } from '../api/client'
import { clearToken } from '../auth/tokenStore'
import type { TmuxSession } from '@tmuxd/shared'

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
        queryKey: ['sessions'],
        queryFn: () => api.listSessions(),
        refetchInterval: 5000
    })

    const [newName, setNewName] = useState('')
    const [pendingKills, setPendingKills] = useState<Set<string>>(() => new Set())
    const createMut = useMutation({
        mutationFn: (name: string) => api.createSession(name),
        onSuccess: () => {
            setNewName('')
            qc.invalidateQueries({ queryKey: ['sessions'] })
        }
    })
    const killMut = useMutation({
        mutationFn: async (name: string) => {
            setPendingKills((s) => {
                const n = new Set(s)
                n.add(name)
                return n
            })
            try {
                await api.killSession(name)
            } finally {
                setPendingKills((s) => {
                    const n = new Set(s)
                    n.delete(name)
                    return n
                })
            }
        },
        onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] })
    })

    const confirmKill = (name: string) => {
        if (pendingKills.has(name)) return
        const ok = window.confirm(
            `Kill tmux session "${name}"? Any running processes inside it will be terminated.`
        )
        if (ok) killMut.mutate(name)
    }

    return (
        <div className="mx-auto flex h-full min-h-0 max-w-4xl flex-col gap-4 p-4 sm:gap-6 sm:p-6">
            <header className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-center">
                <div>
                    <h1 className="text-lg font-semibold tracking-tight">tmux sessions</h1>
                    <p className="text-xs text-neutral-500">Pick a session to attach, or create a new one.</p>
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
                    if (newName.trim()) createMut.mutate(newName.trim())
                }}
            >
                <input
                    className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
                    placeholder="New session name (letters, digits, ._-)"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    pattern="[A-Za-z0-9._-]+"
                    maxLength={64}
                />
                <button
                    type="submit"
                    disabled={!newName.trim() || createMut.isPending}
                    className="rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
                >
                    Create
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
                <ul className="min-h-0 flex-1 divide-y divide-neutral-800 overflow-y-auto rounded-lg border border-neutral-800 bg-neutral-900/40">
                    {data.sessions.length === 0 && (
                        <li className="p-4 text-center text-sm text-neutral-500">No sessions yet.</li>
                    )}
                    {data.sessions.map((s) => (
                        <SessionRow
                            key={s.name}
                            session={s}
                            onAttach={() => navigate({ to: '/attach/$name', params: { name: s.name } })}
                            onKill={() => confirmKill(s.name)}
                            killing={pendingKills.has(s.name)}
                        />
                    ))}
                </ul>
            )}
        </div>
    )
}

function SessionRow(props: {
    session: TmuxSession
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
