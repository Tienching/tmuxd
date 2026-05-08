import { useEffect, useMemo, useState, type FormEvent } from 'react'
import {
    createCustomAction,
    deleteCustomAction,
    formatActionPayloadPreview,
    MAX_CUSTOM_ACTION_INTERVAL_SECONDS,
    MAX_CUSTOM_ACTION_LABEL_LENGTH,
    MAX_CUSTOM_ACTION_PAYLOAD_LENGTH,
    MAX_CUSTOM_ACTION_REPEAT_COUNT,
    MIN_CUSTOM_ACTION_INTERVAL_SECONDS,
    moveCustomAction,
    upsertCustomAction,
    type CustomAction
} from '../session/customActions'

export interface CustomActionTimerView {
    id: string
    actionId: string
    label: string
    targetTitle: string
    intervalSeconds: number
    sentCount: number
    repeatCount: number | null
}

export function CustomActionsPanel({
    open,
    actions,
    activeTargetTitle,
    timers,
    onActionsChange,
    onClose,
    onSend,
    onStartTimer,
    onStopTimer
}: {
    open: boolean
    actions: CustomAction[]
    activeTargetTitle: string
    timers: CustomActionTimerView[]
    onActionsChange: (actions: CustomAction[]) => void
    onClose: () => void
    onSend: (action: CustomAction) => void
    onStartTimer: (action: CustomAction) => void
    onStopTimer: (timerId: string) => void
}) {
    const [editingId, setEditingId] = useState<string | null>(null)
    const [label, setLabel] = useState('')
    const [payload, setPayload] = useState('')
    const [intervalSeconds, setIntervalSeconds] = useState('')
    const [repeatCount, setRepeatCount] = useState('')
    const [error, setError] = useState<string | null>(null)

    const editingAction = useMemo(() => actions.find((action) => action.id === editingId) ?? null, [actions, editingId])

    useEffect(() => {
        if (!editingAction) return
        setLabel(editingAction.label)
        setPayload(editingAction.payload)
        setIntervalSeconds(editingAction.intervalSeconds ? String(editingAction.intervalSeconds) : '')
        setRepeatCount(editingAction.repeatCount ? String(editingAction.repeatCount) : '')
        setError(null)
    }, [editingAction])

    if (!open) return null

    function persist(next: CustomAction[]) {
        onActionsChange(next)
    }

    function resetForm() {
        setEditingId(null)
        setLabel('')
        setPayload('')
        setIntervalSeconds('')
        setRepeatCount('')
        setError(null)
    }

    function submit(event: FormEvent) {
        event.preventDefault()
        try {
            const next = upsertCustomAction(actions, {
                id: editingId ?? undefined,
                label,
                payload,
                intervalSeconds,
                repeatCount
            })
            persist(next)
            resetForm()
        } catch {
            setError('Label and payload are required.')
        }
    }

    function edit(action: CustomAction) {
        setEditingId(action.id)
        setLabel(action.label)
        setPayload(action.payload)
        setIntervalSeconds(action.intervalSeconds ? String(action.intervalSeconds) : '')
        setRepeatCount(action.repeatCount ? String(action.repeatCount) : '')
        setError(null)
    }

    function appendPayload(input: string) {
        setPayload((value) => `${value}${input}`.slice(0, MAX_CUSTOM_ACTION_PAYLOAD_LENGTH))
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/60 p-3 pt-12" onClick={onClose}>
            <div
                className="mx-auto flex max-h-[86dvh] w-full max-w-2xl flex-col rounded-lg border border-neutral-700 bg-neutral-950 p-3 shadow-xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                        <h2 className="text-sm font-medium text-neutral-100">Custom actions</h2>
                        <p className="truncate text-xs text-neutral-500">Target: {activeTargetTitle}</p>
                    </div>
                    <button type="button" className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 active:bg-neutral-800" onClick={onClose}>
                        Close
                    </button>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto pr-1">
                    {timers.length > 0 && (
                        <section className="mb-3 rounded-md border border-emerald-900/60 bg-emerald-950/20 p-2">
                            <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-emerald-300">Active timers</h3>
                            <div className="space-y-2">
                                {timers.map((timer) => (
                                    <div key={timer.id} className="flex min-w-0 items-center justify-between gap-2 rounded border border-emerald-900/50 bg-neutral-950/80 p-2 text-xs">
                                        <div className="min-w-0">
                                            <div className="truncate font-medium text-neutral-100">{timer.label}</div>
                                            <div className="truncate text-neutral-500">
                                                {timer.targetTitle} · every {timer.intervalSeconds}s · sent {timer.sentCount}
                                                {timer.repeatCount ? ` / ${timer.repeatCount}` : ''}
                                            </div>
                                        </div>
                                        <button
                                            type="button"
                                            className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-neutral-100 hover:bg-neutral-800 active:bg-neutral-800"
                                            onClick={() => onStopTimer(timer.id)}
                                        >
                                            Stop
                                        </button>
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    <section className="mb-3">
                        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">Actions</h3>
                        {actions.length === 0 ? (
                            <p className="rounded-md border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-500">
                                No custom actions yet. Create one below, then run it against the active pane.
                            </p>
                        ) : (
                            <div className="space-y-2">
                                {actions.map((action, index) => (
                                    <div key={action.id} className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2">
                                        <div className="flex min-w-0 items-center gap-2">
                                            <button
                                                type="button"
                                                className="min-w-0 flex-1 rounded border border-neutral-700 bg-neutral-950 px-2 py-2 text-left text-xs text-neutral-100 hover:bg-neutral-800 active:bg-neutral-800"
                                                onClick={() => onSend(action)}
                                            >
                                                <span className="block truncate font-medium">{action.label}</span>
                                                <span className="block truncate font-mono text-[10px] text-neutral-500">{formatActionPayloadPreview(action.payload)}</span>
                                            </button>
                                            {action.intervalSeconds && (
                                                <button
                                                    type="button"
                                                    className="shrink-0 rounded border border-neutral-700 px-2 py-2 text-xs text-neutral-100 hover:bg-neutral-800 active:bg-neutral-800"
                                                    title="Start timer for active pane"
                                                    onClick={() => onStartTimer(action)}
                                                >
                                                    Start
                                                </button>
                                            )}
                                        </div>
                                        <div className="mt-2 flex flex-wrap gap-1 text-xs">
                                            <button type="button" className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800" disabled={index === 0} onClick={() => persist(moveCustomAction(actions, action.id, -1))}>
                                                ↑
                                            </button>
                                            <button type="button" className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800" disabled={index === actions.length - 1} onClick={() => persist(moveCustomAction(actions, action.id, 1))}>
                                                ↓
                                            </button>
                                            <button type="button" className="rounded px-2 py-1 text-neutral-400 hover:bg-neutral-800" onClick={() => edit(action)}>
                                                Edit
                                            </button>
                                            <button type="button" className="rounded px-2 py-1 text-red-400 hover:bg-neutral-800" onClick={() => persist(deleteCustomAction(actions, action.id))}>
                                                Delete
                                            </button>
                                            {action.intervalSeconds && (
                                                <span className="px-2 py-1 text-neutral-500">
                                                    every {action.intervalSeconds}s{action.repeatCount ? ` · ${action.repeatCount}x` : ' · until stopped'}
                                                </span>
                                            )}
                                        </div>
                                    </div>
                                ))}
                            </div>
                        )}
                    </section>

                    <form className="rounded-md border border-neutral-800 bg-neutral-900/50 p-2" onSubmit={submit}>
                        <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-neutral-500">
                            {editingId ? 'Edit action' : 'New action'}
                        </h3>
                        <label className="mb-2 block text-xs text-neutral-400">
                            Label
                            <input
                                className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-xs text-neutral-100 outline-none focus:border-neutral-600"
                                value={label}
                                maxLength={MAX_CUSTOM_ACTION_LABEL_LENGTH}
                                placeholder="e.g. logs"
                                onChange={(event) => setLabel(event.target.value)}
                            />
                        </label>
                        <label className="mb-2 block text-xs text-neutral-400">
                            Payload
                            <textarea
                                className="mt-1 h-24 w-full resize-y rounded border border-neutral-800 bg-neutral-950 px-2 py-2 font-mono text-xs text-neutral-100 outline-none focus:border-neutral-600"
                                value={payload}
                                maxLength={MAX_CUSTOM_ACTION_PAYLOAD_LENGTH}
                                placeholder="Text to send to the active terminal"
                                onChange={(event) => setPayload(event.target.value)}
                            />
                        </label>
                        <div className="mb-2 flex flex-wrap gap-1">
                            <button type="button" className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800" onClick={() => appendPayload('\r')}>
                                + Enter
                            </button>
                            <button type="button" className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800" onClick={() => appendPayload('\t')}>
                                + Tab
                            </button>
                            <button type="button" className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800" onClick={() => appendPayload('\u001b')}>
                                + Esc
                            </button>
                        </div>
                        <div className="grid gap-2 sm:grid-cols-2">
                            <label className="block text-xs text-neutral-400">
                                Timer interval seconds
                                <input
                                    className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-xs text-neutral-100 outline-none focus:border-neutral-600"
                                    type="number"
                                    min={MIN_CUSTOM_ACTION_INTERVAL_SECONDS}
                                    max={MAX_CUSTOM_ACTION_INTERVAL_SECONDS}
                                    placeholder="blank = no timer"
                                    value={intervalSeconds}
                                    onChange={(event) => setIntervalSeconds(event.target.value)}
                                />
                            </label>
                            <label className="block text-xs text-neutral-400">
                                Repeat count
                                <input
                                    className="mt-1 w-full rounded border border-neutral-800 bg-neutral-950 px-2 py-2 text-xs text-neutral-100 outline-none focus:border-neutral-600"
                                    type="number"
                                    min={1}
                                    max={MAX_CUSTOM_ACTION_REPEAT_COUNT}
                                    placeholder="blank = until stopped"
                                    value={repeatCount}
                                    onChange={(event) => setRepeatCount(event.target.value)}
                                />
                            </label>
                        </div>
                        {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
                        <p className="mt-2 text-xs text-neutral-500">
                            Timer starts send immediately, then repeats by interval. Timers with Enter/newline ask for confirmation.
                        </p>
                        <div className="mt-2 flex justify-end gap-2">
                            {editingId && (
                                <button type="button" className="rounded border border-neutral-700 px-3 py-1.5 text-xs text-neutral-100 hover:bg-neutral-800" onClick={resetForm}>
                                    Cancel
                                </button>
                            )}
                            <button type="submit" className="rounded border border-neutral-700 px-3 py-1.5 text-xs font-medium text-neutral-100 hover:bg-neutral-800 active:bg-neutral-800">
                                {editingId ? 'Save' : 'Add'}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    )
}

export function CustomActionsBar({
    actions,
    timers,
    onManage,
    onSend,
    onStopTimer
}: {
    actions: CustomAction[]
    timers: CustomActionTimerView[]
    onManage: () => void
    onSend: (action: CustomAction) => void
    onStopTimer: (timerId: string) => void
}) {
    return (
        <div className="hidden border-t border-neutral-800 bg-neutral-950 px-2 py-1.5 md:flex">
            <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                <button
                    type="button"
                    className="sticky left-0 z-10 shrink-0 rounded border border-neutral-700 bg-neutral-950 px-2 py-1 text-xs font-medium text-neutral-200 hover:bg-neutral-800"
                    title="Manage custom actions and timers"
                    onClick={onManage}
                >
                    Actions{timers.length ? ` · ${timers.length}` : ''}
                </button>
                {actions.length === 0 ? (
                    <button
                        type="button"
                        className="shrink-0 rounded border border-dashed border-neutral-700 px-2 py-1 text-xs text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300"
                        onClick={onManage}
                    >
                        + Add action
                    </button>
                ) : (
                    actions.map((action) => (
                        <button
                            key={action.id}
                            type="button"
                            className="shrink-0 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-100 hover:bg-neutral-800 active:bg-neutral-700"
                            title={`${action.label}: ${formatActionPayloadPreview(action.payload)}`}
                            onClick={() => onSend(action)}
                        >
                            {action.label}
                            {action.intervalSeconds ? <span className="ml-1 text-neutral-500">⏱</span> : null}
                        </button>
                    ))
                )}
                {timers.map((timer) => (
                    <button
                        key={timer.id}
                        type="button"
                        className="shrink-0 rounded border border-emerald-900/70 bg-emerald-950/30 px-2 py-1 text-xs text-emerald-200 hover:bg-emerald-900/40"
                        title={`Stop ${timer.label} timer`}
                        onClick={() => onStopTimer(timer.id)}
                    >
                        {timer.label} {timer.sentCount}
                        {timer.repeatCount ? `/${timer.repeatCount}` : ''} ×
                    </button>
                ))}
            </div>
        </div>
    )
}
