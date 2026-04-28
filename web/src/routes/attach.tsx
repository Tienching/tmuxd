import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { Terminal, IDisposable } from '@xterm/xterm'
import { TerminalView } from '../components/TerminalView'
import { MobileQuickKeys } from '../components/MobileQuickKeys'
import { encodeTerminalInputPayload } from '../components/quickKeys'
import { getScrollTopForTmuxPosition } from '../components/terminalText'
import { getInitialSidebarHidden, MobileSessionSelect, OpenSessionsSidebar, saveSidebarHidden } from '../components/OpenSessionsSidebar'
import { api } from '../api/client'
import { getToken } from '../auth/tokenStore'
import { markOpenSession } from '../session/openSessions'
import type { ClientWsMessage, ServerWsMessage } from '@tmuxd/shared'

type Status = 'connecting' | 'open' | 'closed' | 'error'

export function AttachPage() {
    const { name } = useParams({ from: '/attach/$name' })
    const navigate = useNavigate()
    const termRef = useRef<Terminal | null>(null)
    const wsRef = useRef<WebSocket | null>(null)
    const inputSubRef = useRef<IDisposable | null>(null)
    const reconnectRef = useRef<{ timer: number | null; attempt: number; aborted: boolean }>({
        timer: null,
        attempt: 0,
        aborted: false
    })
    const dimsRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 })
    const copyRequestRef = useRef(0)

    const [status, setStatus] = useState<Status>('connecting')
    const [statusMsg, setStatusMsg] = useState<string | null>(null)
    const [sidebarHidden, setSidebarHidden] = useState(() => getInitialSidebarHidden())
    const [copyText, setCopyText] = useState<string | null>(null)
    const [copyScrollPosition, setCopyScrollPosition] = useState(0)
    const [copyLoading, setCopyLoading] = useState(false)
    const [copyError, setCopyError] = useState<string | null>(null)

    function sendInput(input: string) {
        const ws = wsRef.current
        if (ws && ws.readyState === ws.OPEN) {
            sendWs(ws, { type: 'input', payload: encodeTerminalInputPayload(input) })
        }
    }

    async function openCopySheet() {
        const requestId = copyRequestRef.current + 1
        copyRequestRef.current = requestId
        setCopyText(null)
        setCopyScrollPosition(0)
        setCopyError(null)
        setCopyLoading(true)
        try {
            const res = await api.captureSession(name)
            if (copyRequestRef.current !== requestId) return
            setCopyText(res.text)
            setCopyScrollPosition(res.text ? res.scrollPosition : 0)
        } catch {
            if (copyRequestRef.current !== requestId) return
            setCopyText('')
            setCopyScrollPosition(0)
            setCopyError('Could not load full tmux history.')
        } finally {
            if (copyRequestRef.current === requestId) setCopyLoading(false)
        }
    }

    useEffect(() => {
        markOpenSession(name)
    }, [name])

    useEffect(() => {
        reconnectRef.current.aborted = false
        return () => {
            reconnectRef.current.aborted = true
            if (reconnectRef.current.timer !== null) {
                window.clearTimeout(reconnectRef.current.timer)
                reconnectRef.current.timer = null
            }
            try {
                inputSubRef.current?.dispose()
            } catch {
                /* ignore */
            }
            inputSubRef.current = null
            const ws = wsRef.current
            wsRef.current = null
            if (ws) {
                try {
                    ws.close(1000, 'unmount')
                } catch {
                    /* ignore */
                }
            }
        }
    }, [])

    async function connect(term: Terminal) {
        if (reconnectRef.current.aborted) return

        // Drop any pending timer.
        if (reconnectRef.current.timer !== null) {
            window.clearTimeout(reconnectRef.current.timer)
            reconnectRef.current.timer = null
        }
        // Close any existing socket before opening a new one.
        const old = wsRef.current
        if (old && old.readyState <= WebSocket.OPEN) {
            try {
                old.close(1000, 'reconnecting')
            } catch {
                /* ignore */
            }
        }
        wsRef.current = null

        const token = getToken()
        if (!token) {
            navigate({ to: '/login' })
            return
        }

        setStatus('connecting')
        setStatusMsg(null)
        let ticket: string
        try {
            ticket = (await api.createWsTicket()).ticket
        } catch (err) {
            if (!reconnectRef.current.aborted) {
                setStatus('error')
                setStatusMsg(err instanceof Error ? err.message : 'failed to create websocket ticket')
            }
            return
        }
        if (reconnectRef.current.aborted) return

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = new URL(`${proto}//${window.location.host}/ws/${encodeURIComponent(name)}`)
        url.searchParams.set('ticket', ticket)
        url.searchParams.set('cols', String(dimsRef.current.cols || term.cols))
        url.searchParams.set('rows', String(dimsRef.current.rows || term.rows))

        const ws = new WebSocket(url.toString())
        wsRef.current = ws

        let pingTimer: number | null = null
        let sawError = false

        ws.onopen = () => {
            if (reconnectRef.current.aborted || wsRef.current !== ws) return
            setStatus('open')
            reconnectRef.current.attempt = 0
            sendWs(ws, { type: 'resize', cols: dimsRef.current.cols, rows: dimsRef.current.rows })
            pingTimer = window.setInterval(() => {
                if (ws.readyState === ws.OPEN) sendWs(ws, { type: 'ping' })
            }, 25000)
        }

        ws.onmessage = (ev) => {
            if (wsRef.current !== ws) return
            let msg: ServerWsMessage
            try {
                msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data))
            } catch {
                return
            }
            if (msg.type === 'data') {
                // base64 -> bytes. xterm handles UTF-8 decoding itself for Uint8Array input.
                const bin = atob(msg.payload)
                const bytes = new Uint8Array(bin.length)
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
                term.write(bytes)
            } else if (msg.type === 'exit') {
                term.writeln(`\r\n\x1b[90m[pty exited, code=${msg.code ?? 'n/a'}]\x1b[0m`)
            } else if (msg.type === 'ready') {
                term.writeln(`\x1b[90m[attached to ${msg.session}]\x1b[0m`)
            } else if (msg.type === 'error') {
                setStatusMsg(msg.message)
            }
        }

        ws.onerror = () => {
            sawError = true
            if (wsRef.current === ws) setStatus('error')
        }

        ws.onclose = (ev) => {
            if (pingTimer !== null) {
                window.clearInterval(pingTimer)
                pingTimer = null
            }
            if (wsRef.current !== ws) return
            if (wsRef.current === ws) {
                wsRef.current = null
                setStatus(sawError || (ev.code !== 1000 && ev.code !== 1001) ? 'error' : 'closed')
            }
            if (reconnectRef.current.aborted) return
            if (ev.code === 4401 || ev.code === 1008 || ev.code === 401) {
                navigate({ to: '/login' })
                return
            }
            if (ev.code === 1000) {
                // normal close (e.g. user unmount / tmux session killed server-side)
                return
            }
            scheduleReconnect(term)
        }
    }

    function scheduleReconnect(term: Terminal) {
        if (reconnectRef.current.aborted) return
        if (reconnectRef.current.timer !== null) {
            window.clearTimeout(reconnectRef.current.timer)
        }
        const attempt = Math.min(reconnectRef.current.attempt + 1, 6)
        reconnectRef.current.attempt = attempt
        const delay = Math.min(30000, 500 * 2 ** attempt)
        reconnectRef.current.timer = window.setTimeout(() => {
            reconnectRef.current.timer = null
            connect(term)
        }, delay)
    }

    return (
        <div className="flex h-full flex-col">
            <div className="border-b border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm sm:px-4">
                <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 md:hidden">
                    <button
                        className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 active:bg-neutral-800"
                        onClick={() => navigate({ to: '/' })}
                    >
                        ← Back
                    </button>
                    <div className="min-w-0 justify-self-center">
                        <MobileSessionSelect currentName={name} />
                    </div>
                    <div className="flex items-center justify-end gap-1 text-xs">
                        <StatusDot status={status} />
                        <span className="text-neutral-400">{status}</span>
                    </div>
                </div>
                <div className="hidden grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 md:grid">
                    <div className="min-w-0 justify-self-start">
                        <button
                            className="rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
                            onClick={() => navigate({ to: '/' })}
                        >
                            ← Back
                        </button>
                    </div>
                    <span className="max-w-[50vw] truncate font-mono">{name}</span>
                    <div className="flex min-w-0 items-center justify-end gap-2 justify-self-end text-xs">
                        <StatusDot status={status} />
                        <span className="text-neutral-400">{status}</span>
                        {statusMsg && <span className="truncate text-red-400">· {statusMsg}</span>}
                    </div>
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <OpenSessionsSidebar
                    currentName={name}
                    hidden={sidebarHidden}
                    onToggleHidden={() => {
                        setSidebarHidden((hidden) => {
                            const next = !hidden
                            saveSidebarHidden(next)
                            return next
                        })
                    }}
                />
                <div className="flex min-h-0 flex-1 flex-col bg-neutral-950">
                    <div className="min-h-0 flex-1 p-1 sm:p-2">
                        <TerminalView
                            key={name}
                            className="rounded-md overflow-hidden"
                            onMount={(term) => {
                                termRef.current = term
                                try {
                                    inputSubRef.current?.dispose()
                                } catch {
                                    /* ignore */
                                }
                                inputSubRef.current = term.onData(sendInput)
                                connect(term)
                            }}
                            onResize={(cols, rows) => {
                                dimsRef.current = { cols, rows }
                                const ws = wsRef.current
                                if (ws && ws.readyState === ws.OPEN) {
                                    sendWs(ws, { type: 'resize', cols, rows })
                                }
                            }}
                        />
                    </div>
                    <MobileQuickKeys
                        onInput={sendInput}
                        onCopy={() => {
                            void openCopySheet()
                        }}
                        copyLoading={copyLoading}
                    />
                </div>
            </div>
            {(copyLoading || copyText !== null || copyError !== null) && (
                <TerminalCopySheet
                    text={copyText}
                    initialScrollPosition={copyScrollPosition}
                    loading={copyLoading}
                    error={copyError}
                    onClose={() => {
                        copyRequestRef.current += 1
                        setCopyLoading(false)
                        setCopyText(null)
                        setCopyScrollPosition(0)
                        setCopyError(null)
                    }}
                />
            )}
        </div>
    )
}

function TerminalCopySheet({
    text,
    initialScrollPosition,
    loading,
    error,
    onClose
}: {
    text: string | null
    initialScrollPosition: number
    loading: boolean
    error: string | null
    onClose: () => void
}) {
    const textareaRef = useRef<HTMLTextAreaElement | null>(null)
    const [copied, setCopied] = useState(false)

    useEffect(() => {
        if (loading || text === null) return
        requestAnimationFrame(() => {
            const textarea = textareaRef.current
            if (!textarea) return
            scrollTextareaToTmuxPosition(textarea, initialScrollPosition)
        })
    }, [initialScrollPosition, loading, text])

    async function copy() {
        if (text === null) return
        const textarea = textareaRef.current
        const copyText =
            textarea && textarea.selectionEnd > textarea.selectionStart
                ? text.slice(textarea.selectionStart, textarea.selectionEnd)
                : text
        try {
            await navigator.clipboard.writeText(copyText)
            setCopied(true)
        } catch {
            textareaRef.current?.focus()
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/60 p-3 pt-16 md:hidden" onClick={onClose}>
            <div className="rounded-lg border border-neutral-700 bg-neutral-950 p-3 shadow-xl" onClick={(event) => event.stopPropagation()}>
                <div className="mb-2 flex items-center justify-between">
                    <h2 className="text-sm font-medium text-neutral-100">Session text</h2>
                    <button type="button" className="rounded px-2 py-1 text-xs text-neutral-400 active:bg-neutral-800" onClick={onClose}>
                        Close
                    </button>
                </div>
                {loading ? (
                    <div className="flex h-56 items-center justify-center rounded-md border border-neutral-800 bg-neutral-900 p-2 text-xs text-neutral-400">
                        Loading full tmux pane history…
                    </div>
                ) : (
                    <textarea
                        ref={textareaRef}
                        readOnly
                        wrap="off"
                        value={text ?? ''}
                        className="h-56 w-full resize-none rounded-md border border-neutral-800 bg-neutral-900 p-2 font-mono text-xs text-neutral-100"
                    />
                )}
                {error && <p className="mt-2 text-xs text-amber-400">{error}</p>}
                <div className="mt-2 flex items-center justify-between gap-2">
                    <p className="text-xs text-neutral-500">
                        {loading ? 'Fetching scrollback from tmux…' : 'Scrolled by tmux position. Select a range, or send all to clipboard.'}
                    </p>
                    <button
                        type="button"
                        className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-100 active:bg-neutral-800 disabled:opacity-50"
                        disabled={loading || text === null}
                        onClick={copy}
                    >
                        {copied ? 'Done' : 'Clipboard'}
                    </button>
                </div>
            </div>
        </div>
    )
}

function scrollTextareaToTmuxPosition(textarea: HTMLTextAreaElement, scrollPosition: number) {
    const style = window.getComputedStyle(textarea)
    const fontSize = Number.parseFloat(style.fontSize) || 12
    const lineHeight = Number.parseFloat(style.lineHeight) || fontSize * 1.4
    textarea.scrollTop = getScrollTopForTmuxPosition(textarea.scrollHeight, textarea.clientHeight, lineHeight, scrollPosition)
    textarea.scrollLeft = 0
}

function StatusDot({ status }: { status: Status }) {
    const color =
        status === 'open'
            ? 'bg-emerald-400'
            : status === 'connecting'
              ? 'bg-amber-400 animate-pulse'
              : status === 'error'
                ? 'bg-red-500'
                : 'bg-neutral-500'
    return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />
}

function sendWs(ws: WebSocket, msg: ClientWsMessage) {
    try {
        ws.send(JSON.stringify(msg))
    } catch {
        /* socket transitioning — ignore */
    }
}
