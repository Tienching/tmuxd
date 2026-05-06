import {
    forwardRef,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
    type FormEvent,
    type PointerEvent as ReactPointerEvent,
    type ReactNode
} from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { Terminal, IDisposable } from '@xterm/xterm'
import { TerminalView } from '../components/TerminalView'
import { MobileQuickKeys } from '../components/MobileQuickKeys'
import { encodeTerminalInputPayload } from '../components/quickKeys'
import { getScrollTopForTmuxPosition } from '../components/terminalText'
import { getInitialSidebarHidden, MobileSessionSelect, OpenSessionsSidebar, saveSidebarHidden } from '../components/OpenSessionsSidebar'
import { api } from '../api/client'
import { listHostSessionsData } from '../hosts/sessionData'
import { getToken } from '../auth/tokenStore'
import { createSessionWithOptionalName } from '../session/createSession'
import { listOpenSessions, markOpenSession, removeOpenSession, subscribeOpenSessions, type OpenSession } from '../session/openSessions'
import {
    closeWorkspacePane,
    createWorkspaceId,
    createWorkspacePane,
    formatWorkspaceTarget,
    findWorkspacePane,
    listWorkspacePanes,
    parseWorkspaceLayout,
    sameWorkspaceTarget,
    setWorkspacePaneTarget,
    splitWorkspacePane,
    updateWorkspaceSplitRatio,
    type WorkspaceDirection,
    type WorkspaceNode,
    type WorkspacePane,
    type WorkspaceSplit
} from '../workspace/layout'
import { LOCAL_HOST_ID, type ClientWsMessage, type HostInfo, type ServerWsMessage, type SessionTarget, type TargetSession } from '@tmuxd/shared'

type Status = 'connecting' | 'open' | 'closed' | 'error'

interface TerminalPaneHandle {
    sendInput(input: string): void
}

interface PaneStatus {
    status: Status
    statusMsg: string | null
}

interface SplitRequest {
    paneId: string
    direction: WorkspaceDirection
}

const WORKSPACE_STORAGE_KEY = 'tmuxd.workspace.v1'
const MAX_WORKSPACE_PANES = 6
type HostOption = Pick<HostInfo, 'id' | 'name'>

export function AttachPage() {
    const { name } = useParams({ from: '/attach/$name' })
    return <AttachTargetPage initialTarget={{ hostId: LOCAL_HOST_ID, sessionName: name }} />
}

export function AttachHostPage() {
    const { hostId, name } = useParams({ from: '/attach/$hostId/$name' })
    return <AttachTargetPage initialTarget={{ hostId, sessionName: name }} />
}

function AttachTargetPage({ initialTarget }: { initialTarget: SessionTarget }) {
    const navigate = useNavigate()
    const queryClient = useQueryClient()
    const initialWorkspaceRef = useRef<WorkspaceNode | null>(null)
    if (initialWorkspaceRef.current === null) initialWorkspaceRef.current = loadInitialWorkspace(initialTarget)

    const [workspace, setWorkspace] = useState<WorkspaceNode>(() => initialWorkspaceRef.current as WorkspaceNode)
    const [activePaneId, setActivePaneId] = useState(() => {
        const panes = listWorkspacePanes(initialWorkspaceRef.current as WorkspaceNode)
        return panes.find((pane) => sameWorkspaceTarget(pane.target, initialTarget))?.id ?? panes[0]?.id ?? ''
    })
    const [paneStatuses, setPaneStatuses] = useState<Record<string, PaneStatus>>({})
    const [sidebarHidden, setSidebarHidden] = useState(() => getInitialSidebarHidden())
    const [splitRequest, setSplitRequest] = useState<SplitRequest | null>(null)
    const [splittingPaneId, setSplittingPaneId] = useState<string | null>(null)
    const [splitError, setSplitError] = useState<string | null>(null)
    const [workspaceError, setWorkspaceError] = useState<string | null>(null)
    const [copyText, setCopyText] = useState<string | null>(null)
    const [copyScrollPosition, setCopyScrollPosition] = useState(0)
    const [copyLoading, setCopyLoading] = useState(false)
    const [copyError, setCopyError] = useState<string | null>(null)

    const paneHandlesRef = useRef<Record<string, TerminalPaneHandle | null>>({})
    const copyRequestRef = useRef(0)

    const panes = listWorkspacePanes(workspace)
    const activePane = panes.find((pane) => pane.id === activePaneId) ?? panes[0] ?? null
    const activeTarget = activePane?.target ?? initialTarget
    const activeSessionName = activeTarget.sessionName
    const activeTargetTitle = formatWorkspaceTarget(activeTarget)
    const activePaneStatus = (activePane && paneStatuses[activePane.id]) ?? { status: 'connecting' as Status, statusMsg: null }
    const paneIdsKey = panes.map((pane) => pane.id).join('\n')
    const paneTargetsKey = panes.map((pane) => targetKey(pane.target)).join('\n')

    useEffect(() => {
        setWorkspace((current) => {
            const matchingPane = listWorkspacePanes(current).find((pane) => sameWorkspaceTarget(pane.target, initialTarget))
            if (matchingPane) {
                setActivePaneId(matchingPane.id)
                return current
            }

            const next = createWorkspacePane(initialTarget)
            setActivePaneId(next.id)
            return next
        })
    }, [initialTarget.hostId, initialTarget.sessionName])

    useEffect(() => {
        const currentPanes = listWorkspacePanes(workspace)
        if (currentPanes.length > 0 && !currentPanes.some((pane) => pane.id === activePaneId)) {
            setActivePaneId(currentPanes[0].id)
        }
    }, [activePaneId, workspace])

    useEffect(() => {
        saveWorkspace(workspace)
    }, [workspace])

    useEffect(() => {
        for (const pane of panes) markOpenSession(pane.target, hostLabel(pane.target.hostId))
    }, [paneTargetsKey])

    useEffect(() => {
        const livePaneIds = new Set(paneIdsKey ? paneIdsKey.split('\n') : [])
        setPaneStatuses((current) => {
            const next: Record<string, PaneStatus> = {}
            let changed = false
            for (const [paneId, status] of Object.entries(current)) {
                if (livePaneIds.has(paneId)) next[paneId] = status
                else changed = true
            }
            return changed ? next : current
        })
    }, [paneIdsKey])

    function registerPaneHandle(paneId: string, handle: TerminalPaneHandle | null) {
        if (handle) paneHandlesRef.current[paneId] = handle
        else delete paneHandlesRef.current[paneId]
    }

    function sendInput(input: string) {
        if (!activePane) return
        paneHandlesRef.current[activePane.id]?.sendInput(input)
    }

    async function openCopySheet() {
        const target = activeTarget
        const requestId = copyRequestRef.current + 1
        copyRequestRef.current = requestId
        setCopyText(null)
        setCopyScrollPosition(0)
        setCopyError(null)
        setCopyLoading(true)
        try {
            const res = await api.captureTargetSession(target)
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

    function openSplitChooser(paneId: string, direction: WorkspaceDirection) {
        if (panes.length >= MAX_WORKSPACE_PANES) {
            setWorkspaceError(`Workspace supports up to ${MAX_WORKSPACE_PANES} panes in this version.`)
            return
        }
        setWorkspaceError(null)
        setSplitError(null)
        setActivePaneId(paneId)
        setSplitRequest({ paneId, direction })
    }

    function attachSessionToSplit(target: SessionTarget) {
        const request = splitRequest
        if (!request) return
        addSessionToSplit(request, target)
    }

    function addSessionToSplit(request: SplitRequest, target: SessionTarget) {
        const newPaneId = createWorkspaceId('pane')
        setWorkspace((current) => splitWorkspacePane(current, request.paneId, request.direction, target, newPaneId))
        setActivePaneId(newPaneId)
        markOpenSession(target, hostLabel(target.hostId))
        setSplitRequest(null)
        setSplitError(null)
    }

    async function createSessionForSplit(inputName: string, hostId: string) {
        const request = splitRequest
        if (!request || splittingPaneId) return

        setSplittingPaneId(request.paneId)
        setSplitError(null)
        try {
            const targetHostId = hostId || LOCAL_HOST_ID
            const newSessionName = await createSessionWithOptionalName(inputName, (name) => api.createHostSession(targetHostId, name))
            addSessionToSplit(request, { hostId: targetHostId, sessionName: newSessionName })
            await invalidateSessionQueries(queryClient, targetHostId)
        } catch {
            setSplitError('Failed to create session.')
        } finally {
            setSplittingPaneId(null)
        }
    }

    function closePane(paneId: string) {
        if (panes.length <= 1) return
        const next = closeWorkspacePane(workspace, paneId)
        if (!next) return
        setWorkspace(next)
        if (activePaneId === paneId) {
            setActivePaneId(listWorkspacePanes(next)[0]?.id ?? '')
        }
    }

    function attachSessionToActive(target: SessionTarget) {
        const paneId = activePane?.id
        const trimmed = target.sessionName.trim()
        const hostId = target.hostId.trim() || LOCAL_HOST_ID
        if (!trimmed || !paneId) return
        const nextTarget = { hostId, sessionName: trimmed }
        setWorkspace((current) => setWorkspacePaneTarget(current, paneId, nextTarget))
        setActivePaneId(paneId)
        markOpenSession(nextTarget, hostLabel(hostId))
        navigateToTarget(navigate, nextTarget)
    }

    function updatePaneStatus(paneId: string, status: Status, statusMsg: string | null) {
        setPaneStatuses((current) => {
            const previous = current[paneId]
            if (previous?.status === status && previous.statusMsg === statusMsg) return current
            return { ...current, [paneId]: { status, statusMsg } }
        })
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
                        <MobileSessionSelect currentName={activeSessionName} currentHostId={activeTarget.hostId} onOpenSession={attachSessionToActive} />
                    </div>
                    <div className="flex items-center justify-end gap-1 text-xs">
                        <StatusDot status={activePaneStatus.status} />
                        <span className="text-neutral-400">{activePaneStatus.status}</span>
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
                    <span className="max-w-[50vw] truncate font-mono">
                        {panes.length > 1 ? `Workspace · ${activeTargetTitle}` : activeTargetTitle}
                    </span>
                    <div className="flex min-w-0 items-center justify-end gap-2 justify-self-end text-xs">
                        {panes.length > 1 && <span className="text-neutral-500">{panes.length} panes</span>}
                        <StatusDot status={activePaneStatus.status} />
                        <span className="text-neutral-400">{activePaneStatus.status}</span>
                        {activePaneStatus.statusMsg && <span className="truncate text-red-400">· {activePaneStatus.statusMsg}</span>}
                    </div>
                </div>
            </div>
            <div className="flex min-h-0 flex-1 flex-col md:flex-row">
                <OpenSessionsSidebar
                    currentName={activeSessionName}
                    currentHostId={activeTarget.hostId}
                    hidden={sidebarHidden}
                    onOpenSession={attachSessionToActive}
                    onToggleHidden={() => {
                        setSidebarHidden((hidden) => {
                            const next = !hidden
                            saveSidebarHidden(next)
                            return next
                        })
                    }}
                />
                <div className="flex min-h-0 flex-1 flex-col bg-neutral-950">
                    {workspaceError && <div className="border-b border-red-900/50 px-3 py-2 text-xs text-red-300">{workspaceError}</div>}
                    <div className="min-h-0 flex-1 p-1 sm:p-2">
                        <WorkspaceNodeView
                            node={workspace}
                            activePaneId={activePane?.id ?? ''}
                            canClose={panes.length > 1}
                            canSplit={panes.length < MAX_WORKSPACE_PANES}
                            splittingPaneId={splittingPaneId ?? splitRequest?.paneId ?? null}
                            onActivate={setActivePaneId}
                            onSplit={openSplitChooser}
                            onClose={closePane}
                            onRatioChange={(splitId, ratio) => setWorkspace((current) => updateWorkspaceSplitRatio(current, splitId, ratio))}
                            onPaneStatus={updatePaneStatus}
                            registerPaneHandle={registerPaneHandle}
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
            {splitRequest && (
                <SplitSessionChooser
                    direction={splitRequest.direction}
                    currentSessionName={findWorkspacePaneSession(workspace, splitRequest.paneId) ?? activeSessionName}
                    currentHostId={findWorkspacePane(workspace, splitRequest.paneId)?.target.hostId ?? activeTarget.hostId}
                    creating={splittingPaneId === splitRequest.paneId}
                    error={splitError}
                    onClose={() => {
                        if (!splittingPaneId) setSplitRequest(null)
                    }}
                    onSelect={attachSessionToSplit}
                    onCreate={(inputName, hostId) => void createSessionForSplit(inputName, hostId)}
                />
            )}
        </div>
    )
}

function WorkspaceNodeView({
    node,
    activePaneId,
    canClose,
    canSplit,
    splittingPaneId,
    onActivate,
    onSplit,
    onClose,
    onRatioChange,
    onPaneStatus,
    registerPaneHandle
}: {
    node: WorkspaceNode
    activePaneId: string
    canClose: boolean
    canSplit: boolean
    splittingPaneId: string | null
    onActivate: (paneId: string) => void
    onSplit: (paneId: string, direction: WorkspaceDirection) => void
    onClose: (paneId: string) => void
    onRatioChange: (splitId: string, ratio: number) => void
    onPaneStatus: (paneId: string, status: Status, statusMsg: string | null) => void
    registerPaneHandle: (paneId: string, handle: TerminalPaneHandle | null) => void
}) {
    if (node.type === 'pane') {
        return (
            <WorkspaceTerminalPane
                key={`${node.id}:${targetKey(node.target)}`}
                ref={(handle) => registerPaneHandle(node.id, handle)}
                pane={node}
                active={node.id === activePaneId}
                canClose={canClose}
                canSplit={canSplit}
                splitting={splittingPaneId === node.id}
                onFocus={() => onActivate(node.id)}
                onClose={() => onClose(node.id)}
                onSplit={(direction) => onSplit(node.id, direction)}
                onStatus={(status, statusMsg) => onPaneStatus(node.id, status, statusMsg)}
            />
        )
    }

    return (
        <WorkspaceSplitView
            node={node}
            activePaneId={activePaneId}
            canClose={canClose}
            canSplit={canSplit}
            splittingPaneId={splittingPaneId}
            onActivate={onActivate}
            onSplit={onSplit}
            onClose={onClose}
            onRatioChange={onRatioChange}
            onPaneStatus={onPaneStatus}
            registerPaneHandle={registerPaneHandle}
        />
    )
}

function WorkspaceSplitView({
    node,
    activePaneId,
    canClose,
    canSplit,
    splittingPaneId,
    onActivate,
    onSplit,
    onClose,
    onRatioChange,
    onPaneStatus,
    registerPaneHandle
}: {
    node: WorkspaceSplit
    activePaneId: string
    canClose: boolean
    canSplit: boolean
    splittingPaneId: string | null
    onActivate: (paneId: string) => void
    onSplit: (paneId: string, direction: WorkspaceDirection) => void
    onClose: (paneId: string) => void
    onRatioChange: (splitId: string, ratio: number) => void
    onPaneStatus: (paneId: string, status: Status, statusMsg: string | null) => void
    registerPaneHandle: (paneId: string, handle: TerminalPaneHandle | null) => void
}) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const isRow = node.direction === 'row'

    function startResize(event: ReactPointerEvent<HTMLButtonElement>) {
        const rect = containerRef.current?.getBoundingClientRect()
        if (!rect) return
        event.preventDefault()
        event.currentTarget.setPointerCapture?.(event.pointerId)

        const updateRatio = (clientX: number, clientY: number) => {
            const size = isRow ? rect.width : rect.height
            if (size <= 0) return
            const offset = isRow ? clientX - rect.left : clientY - rect.top
            onRatioChange(node.id, offset / size)
        }

        const onMove = (moveEvent: PointerEvent) => updateRatio(moveEvent.clientX, moveEvent.clientY)
        const onUp = () => {
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
        }

        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
    }

    const firstStyle = { flexBasis: 0, flexGrow: node.ratio, flexShrink: 1 }
    const secondStyle = { flexBasis: 0, flexGrow: 1 - node.ratio, flexShrink: 1 }

    return (
        <div ref={containerRef} className={`flex h-full min-h-0 w-full min-w-0 gap-1 ${isRow ? 'flex-row' : 'flex-col'}`}>
            <div className="min-h-0 min-w-0" style={firstStyle}>
                <WorkspaceNodeView
                    node={node.first}
                    activePaneId={activePaneId}
                    canClose={canClose}
                    canSplit={canSplit}
                    splittingPaneId={splittingPaneId}
                    onActivate={onActivate}
                    onSplit={onSplit}
                    onClose={onClose}
                    onRatioChange={onRatioChange}
                    onPaneStatus={onPaneStatus}
                    registerPaneHandle={registerPaneHandle}
                />
            </div>
            <button
                type="button"
                className={`shrink-0 rounded-sm bg-neutral-900 hover:bg-neutral-700 active:bg-neutral-600 ${
                    isRow ? 'w-1 cursor-col-resize touch-none' : 'h-1 cursor-row-resize touch-none'
                }`}
                aria-label="Resize workspace panes"
                onPointerDown={startResize}
            />
            <div className="min-h-0 min-w-0" style={secondStyle}>
                <WorkspaceNodeView
                    node={node.second}
                    activePaneId={activePaneId}
                    canClose={canClose}
                    canSplit={canSplit}
                    splittingPaneId={splittingPaneId}
                    onActivate={onActivate}
                    onSplit={onSplit}
                    onClose={onClose}
                    onRatioChange={onRatioChange}
                    onPaneStatus={onPaneStatus}
                    registerPaneHandle={registerPaneHandle}
                />
            </div>
        </div>
    )
}

const WorkspaceTerminalPane = forwardRef<TerminalPaneHandle, {
    pane: WorkspacePane
    active: boolean
    canClose: boolean
    canSplit: boolean
    splitting: boolean
    onFocus: () => void
    onClose: () => void
    onSplit: (direction: WorkspaceDirection) => void
    onStatus: (status: Status, statusMsg: string | null) => void
}>(function WorkspaceTerminalPane({ pane, active, canClose, canSplit, splitting, onFocus, onClose, onSplit, onStatus }, ref) {
    const navigate = useNavigate()
    const wsRef = useRef<WebSocket | null>(null)
    const inputSubRef = useRef<IDisposable | null>(null)
    const reconnectRef = useRef<{ timer: number | null; attempt: number; aborted: boolean }>({
        timer: null,
        attempt: 0,
        aborted: false
    })
    const dimsRef = useRef<{ cols: number; rows: number }>({ cols: 80, rows: 24 })
    const statusRef = useRef<Status>('connecting')
    const statusMsgRef = useRef<string | null>(null)
    const onStatusRef = useRef(onStatus)
    const [status, setStatus] = useState<Status>('connecting')
    const [statusMsg, setStatusMsg] = useState<string | null>(null)

    useEffect(() => {
        onStatusRef.current = onStatus
    }, [onStatus])

    useImperativeHandle(ref, () => ({ sendInput }), [])

    function setPaneStatus(status: Status, statusMsg: string | null = null) {
        statusRef.current = status
        statusMsgRef.current = statusMsg
        setStatus(status)
        setStatusMsg(statusMsg)
        onStatusRef.current(status, statusMsg)
    }

    function setPaneStatusMsg(statusMsg: string | null) {
        statusMsgRef.current = statusMsg
        setStatusMsg(statusMsg)
        onStatusRef.current(statusRef.current, statusMsg)
    }

    function sendInput(input: string) {
        if (input === '\u0003') return
        const ws = wsRef.current
        if (ws && ws.readyState === ws.OPEN) {
            sendWs(ws, { type: 'input', payload: encodeTerminalInputPayload(input) })
        }
    }

    async function pasteClipboardImage(file: File) {
        if (pane.target.hostId !== LOCAL_HOST_ID) {
            setPaneStatusMsg('Image paste is only available for Local sessions.')
            return
        }
        setPaneStatusMsg('Saving pasted image…')
        try {
            const upload = await api.uploadClipboardImage(file)
            sendInput(`${shellQuote(upload.path)} `)
            setPaneStatusMsg('Pasted image path.')
            window.setTimeout(() => {
                if (statusMsgRef.current === 'Pasted image path.') setPaneStatusMsg(null)
            }, 3000)
        } catch {
            setPaneStatusMsg('Failed to paste image.')
        }
    }

    useEffect(() => {
        onStatusRef.current(statusRef.current, statusMsgRef.current)
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

        if (reconnectRef.current.timer !== null) {
            window.clearTimeout(reconnectRef.current.timer)
            reconnectRef.current.timer = null
        }
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

        setPaneStatus('connecting')
        let ticket: string
        try {
            ticket = (await api.createWsTicket(pane.target)).ticket
        } catch (err) {
            if (!reconnectRef.current.aborted) {
                setPaneStatus('error', err instanceof Error ? err.message : 'failed to create websocket ticket')
            }
            return
        }
        if (reconnectRef.current.aborted) return

        const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
        const url = new URL(
            `${proto}//${window.location.host}/ws/${encodeURIComponent(pane.target.hostId)}/${encodeURIComponent(pane.target.sessionName)}`
        )
        url.searchParams.set('ticket', ticket)
        url.searchParams.set('cols', String(dimsRef.current.cols || term.cols))
        url.searchParams.set('rows', String(dimsRef.current.rows || term.rows))

        const ws = new WebSocket(url.toString())
        wsRef.current = ws

        let pingTimer: number | null = null
        let sawError = false

        ws.onopen = () => {
            if (reconnectRef.current.aborted || wsRef.current !== ws) return
            setPaneStatus('open')
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
                const bin = atob(msg.payload)
                const bytes = new Uint8Array(bin.length)
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
                term.write(bytes)
            } else if (msg.type === 'exit') {
                term.writeln(`\r\n\x1b[90m[pty exited, code=${msg.code ?? 'n/a'}]\x1b[0m`)
            } else if (msg.type === 'ready') {
                term.writeln(`\x1b[90m[attached to ${msg.session}]\x1b[0m`)
            } else if (msg.type === 'error') {
                setPaneStatusMsg(msg.message)
            }
        }

        ws.onerror = () => {
            sawError = true
            if (wsRef.current === ws) setPaneStatus('error', statusMsgRef.current)
        }

        ws.onclose = (ev) => {
            if (pingTimer !== null) {
                window.clearInterval(pingTimer)
                pingTimer = null
            }
            if (wsRef.current !== ws) return
            wsRef.current = null
            setPaneStatus(sawError || (ev.code !== 1000 && ev.code !== 1001) ? 'error' : 'closed', statusMsgRef.current)
            if (reconnectRef.current.aborted) return
            if (ev.code === 4401 || ev.code === 1008 || ev.code === 401) {
                navigate({ to: '/login' })
                return
            }
            if (ev.code === 1000) return
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
        <section
            className={`flex h-full min-h-0 flex-col overflow-hidden rounded-md border bg-neutral-950 ${
                active ? 'border-neutral-500 shadow-[0_0_0_1px_rgba(255,255,255,0.08)]' : 'border-neutral-800'
            }`}
            onFocusCapture={onFocus}
            onMouseDown={onFocus}
        >
            <div className="hidden min-h-8 items-center justify-between gap-2 border-b border-neutral-800 bg-neutral-900/80 px-2 text-xs md:flex">
                <div className="flex min-w-0 items-center gap-2">
                    <StatusDot status={status} />
                    <span className="truncate font-mono text-neutral-100">{formatWorkspaceTarget(pane.target)}</span>
                    {statusMsg && <span className="truncate text-red-400">· {statusMsg}</span>}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <button
                        type="button"
                        className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                        disabled={!canSplit || splitting}
                        title="Split right and choose a tmux session"
                        onClick={(event) => {
                            event.stopPropagation()
                            onFocus()
                            onSplit('row')
                        }}
                    >
                        {splitting ? 'Choose…' : 'Split →'}
                    </button>
                    <button
                        type="button"
                        className="rounded border border-neutral-700 px-2 py-0.5 text-neutral-300 hover:bg-neutral-800 disabled:opacity-40"
                        disabled={!canSplit || splitting}
                        title="Split down and choose a tmux session"
                        onClick={(event) => {
                            event.stopPropagation()
                            onFocus()
                            onSplit('column')
                        }}
                    >
                        Split ↓
                    </button>
                    <button
                        type="button"
                        className="rounded px-2 py-0.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-30"
                        disabled={!canClose}
                        title="Close this workspace pane"
                        onClick={(event) => {
                            event.stopPropagation()
                            onClose()
                        }}
                    >
                        ×
                    </button>
                </div>
            </div>
            <div className="min-h-0 flex-1">
                <TerminalView
                    key={targetKey(pane.target)}
                    className="overflow-hidden"
                    onClipboardImage={pasteClipboardImage}
                    onMount={(term) => {
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
        </section>
    )
})

function SplitSessionChooser({
    direction,
    currentHostId,
    currentSessionName,
    creating,
    error,
    onClose,
    onSelect,
    onCreate
}: {
    direction: WorkspaceDirection
    currentHostId: string
    currentSessionName: string
    creating: boolean
    error: string | null
    onClose: () => void
    onSelect: (target: SessionTarget) => void
    onCreate: (inputName: string, hostId: string) => void
}) {
    const queryClient = useQueryClient()
    const [openedSessions, setOpenedSessions] = useState<OpenSession[]>(() => listOpenSessions())
    const [newName, setNewName] = useState('')
    const [newHostId, setNewHostId] = useState(LOCAL_HOST_ID)
    const [pendingKills, setPendingKills] = useState<Set<string>>(() => new Set())
    const { data, error: listError, isLoading } = useQuery({
        queryKey: ['hostSessions'],
        queryFn: listHostSessionsData,
        refetchInterval: 5000
    })

    useEffect(() => {
        return subscribeOpenSessions(() => setOpenedSessions(listOpenSessions()))
    }, [])

    const creatableHosts = getCreatableHosts(data?.hosts)

    useEffect(() => {
        if (!creatableHosts.some((host) => host.id === newHostId)) {
            setNewHostId(creatableHosts[0]?.id ?? LOCAL_HOST_ID)
        }
    }, [creatableHosts, newHostId])

    const liveKeys = data ? new Set(data.sessions.map(targetSessionKey)) : null
    const visibleOpenedSessions = liveKeys ? openedSessions.filter((session) => liveKeys.has(openSessionKey(session))) : openedSessions
    const openedGroups = groupedOpenSessions(visibleOpenedSessions)
    const openedKeys = new Set(visibleOpenedSessions.map(openSessionKey))
    const otherSessions = data?.sessions.filter((session) => !openedKeys.has(targetSessionKey(session))) ?? []
    const killableHostIds = getKillableHostIds(data?.hosts)
    const currentTarget = { hostId: currentHostId, sessionName: currentSessionName }
    const currentKey = targetKey(currentTarget)
    const knownKeys = new Set([...visibleOpenedSessions.map(openSessionKey), ...otherSessions.map(targetSessionKey)])
    const showCurrentFallback = currentSessionName && !knownKeys.has(currentKey)
    const directionLabel = direction === 'row' ? 'right' : 'down'
    const currentHostName = data?.hosts.find((host) => host.id === currentHostId)?.name ?? hostLabel(currentHostId)

    const submitNewSession = (event: FormEvent) => {
        event.preventDefault()
        onCreate(newName, newHostId)
    }

    async function confirmKillSession(session: TargetSession) {
        const target = { hostId: session.hostId, sessionName: session.name }
        const key = targetSessionKey(session)
        if (pendingKills.has(key)) return
        const ok = window.confirm(
            `Kill tmux session "${session.name}" on ${session.hostName}? Any running processes inside it will be terminated.`
        )
        if (!ok) return
        setPendingKills((current) => new Set(current).add(key))
        try {
            await api.killTargetSession(target)
            removeOpenSession(target)
            await invalidateSessionQueries(queryClient, target.hostId)
        } catch {
            window.alert('Failed to kill session.')
        } finally {
            setPendingKills((current) => {
                const next = new Set(current)
                next.delete(key)
                return next
            })
        }
    }

    return (
        <div className="fixed inset-0 z-50 bg-black/60 p-3 pt-16 md:p-6" onClick={onClose}>
            <div
                className="mx-auto flex max-h-[82dvh] max-w-lg flex-col rounded-lg border border-neutral-700 bg-neutral-950 shadow-xl"
                onClick={(event) => event.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-3 border-b border-neutral-800 p-3">
                    <div>
                        <h2 className="text-sm font-medium text-neutral-100">Split {directionLabel}</h2>
                        <p className="mt-1 text-xs text-neutral-500">Choose a session for the new web pane, or create one.</p>
                    </div>
                    <button
                        type="button"
                        className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 disabled:opacity-40"
                        disabled={creating}
                        onClick={onClose}
                    >
                        Close
                    </button>
                </div>

                <div className="min-h-0 overflow-y-auto p-3">
                    <form className="mb-3 flex gap-2" onSubmit={submitNewSession}>
                        <input
                            className="min-w-0 flex-1 rounded-md border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm outline-none focus:border-neutral-600"
                            placeholder="New session name (optional)"
                            value={newName}
                            onChange={(event) => setNewName(event.target.value)}
                            pattern="[A-Za-z0-9._-]+"
                            maxLength={64}
                            disabled={creating}
                        />
                        <select
                            className="w-24 shrink-0 rounded-md border border-neutral-800 bg-neutral-900 px-2 py-2 text-sm text-neutral-100 outline-none focus:border-neutral-600"
                            aria-label="New session host"
                            value={newHostId}
                            onChange={(event) => setNewHostId(event.target.value)}
                            disabled={creating}
                        >
                            {creatableHosts.map((host) => (
                                <option key={host.id} value={host.id}>
                                    {host.name}
                                </option>
                            ))}
                        </select>
                        <button
                            type="submit"
                            className="rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 disabled:opacity-50"
                            disabled={creating}
                        >
                            {creating ? 'New…' : 'New'}
                        </button>
                    </form>
                    {error && <p className="mb-3 text-xs text-red-400">{error}</p>}

                    {showCurrentFallback && (
                        <div className="mb-3">
                            <SplitSessionButton
                                name={currentSessionName}
                                hostName={currentHostId === LOCAL_HOST_ID ? undefined : currentHostName}
                                active
                                disabled={creating}
                                onClick={() => onSelect(currentTarget)}
                            />
                        </div>
                    )}

                    {visibleOpenedSessions.length > 0 &&
                        openedGroups.map((group) => (
                            <SessionChoiceSection key={`opened-split-${group.hostId}`} title={`${group.hostName} opened`}>
                                {group.sessions.map((session) => (
                                    <SplitSessionButton
                                        key={`opened-split-${session.hostId}-${session.name}`}
                                        name={session.name}
                                        active={session.name === currentSessionName && session.hostId === currentHostId}
                                        disabled={creating}
                                        onClick={() => onSelect({ hostId: session.hostId, sessionName: session.name })}
                                    />
                                ))}
                            </SessionChoiceSection>
                        ))}

                    {isLoading ? (
                        <SessionChoiceSection title="Not opened">
                            <p className="px-1 text-xs text-neutral-600">Loading sessions…</p>
                        </SessionChoiceSection>
                    ) : listError ? (
                        <SessionChoiceSection title="Not opened">
                            <p className="px-1 text-xs text-red-400">Failed to load sessions.</p>
                        </SessionChoiceSection>
                    ) : otherSessions.length === 0 ? (
                        <SessionChoiceSection title="Not opened">
                            <p className="px-1 text-xs text-neutral-600">All live sessions are already in Opened.</p>
                        </SessionChoiceSection>
                    ) : (
                        groupedTargetSessions(otherSessions).map((group) => (
                            <SessionChoiceSection key={`split-group-${group.hostId}`} title={`${group.hostName} not opened`}>
                                {group.sessions.map((session) => (
                                    <SplitSessionButton
                                        key={`all-split-${session.hostId}-${session.name}`}
                                        name={session.name}
                                        active={session.name === currentSessionName && session.hostId === currentHostId}
                                        disabled={creating}
                                        onClick={() => onSelect({ hostId: session.hostId, sessionName: session.name })}
                                        onKill={killableHostIds.has(session.hostId) ? () => void confirmKillSession(session) : undefined}
                                        killing={pendingKills.has(targetSessionKey(session))}
                                    />
                                ))}
                            </SessionChoiceSection>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}

function SessionChoiceSection({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="mb-3 last:mb-0">
            <h3 className="mb-1 px-1 text-[10px] font-medium uppercase tracking-wide text-neutral-600">{title}</h3>
            <div className="flex flex-col gap-1">{children}</div>
        </section>
    )
}

function SplitSessionButton({
    name,
    hostName,
    active,
    disabled,
    onClick,
    onKill,
    killing = false
}: {
    name: string
    hostName?: string
    active?: boolean
    disabled?: boolean
    onClick: () => void
    onKill?: () => void
    killing?: boolean
}) {
    return (
        <div
            className={`flex min-w-0 items-center justify-between gap-2 rounded-md border text-xs text-neutral-100 ${
                active ? 'border-neutral-500 bg-neutral-800' : 'border-neutral-800 bg-neutral-900/60 hover:bg-neutral-900'
            } ${disabled ? 'opacity-50' : ''}`}
        >
            <button
                type="button"
                className="min-w-0 flex-1 px-2 py-2 text-left disabled:cursor-not-allowed"
                disabled={disabled}
                onClick={onClick}
            >
                <span className="block truncate font-mono">{name}</span>
                {hostName && <span className="block truncate text-[10px] text-neutral-500">{hostName}</span>}
            </button>
            {active && <span className="shrink-0 text-[10px] text-neutral-500">current</span>}
            {onKill && (
                <button
                    type="button"
                    className="px-2 py-2 text-xs text-red-400 hover:bg-neutral-800 disabled:opacity-50"
                    aria-label={`Kill ${name}`}
                    title={`Kill ${name}`}
                    disabled={disabled || killing}
                    onClick={onKill}
                >
                    {killing ? '…' : '×'}
                </button>
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

function loadInitialWorkspace(target: SessionTarget): WorkspaceNode {
    try {
        const raw = localStorage.getItem(WORKSPACE_STORAGE_KEY)
        if (raw) {
            const parsed = parseWorkspaceLayout(JSON.parse(raw))
            if (parsed && listWorkspacePanes(parsed).some((pane) => sameWorkspaceTarget(pane.target, target))) {
                return parsed
            }
        }
    } catch {
        /* storage may be unavailable */
    }
    return createWorkspacePane(target)
}

function findWorkspacePaneSession(workspace: WorkspaceNode, paneId: string): string | null {
    if (workspace.type === 'pane') return workspace.id === paneId ? workspace.target.sessionName : null
    return findWorkspacePaneSession(workspace.first, paneId) ?? findWorkspacePaneSession(workspace.second, paneId)
}

function targetKey(target: SessionTarget): string {
    return `${target.hostId}\n${target.sessionName}`
}

function hostLabel(hostId: string): string {
    return hostId === LOCAL_HOST_ID ? 'Local' : hostId
}

function getCreatableHosts(hosts: HostInfo[] | undefined): HostOption[] {
    const onlineHosts = hosts?.filter((host) => host.status === 'online' && host.capabilities.includes('create')) ?? []
    if (onlineHosts.length === 0) return [{ id: LOCAL_HOST_ID, name: 'Local' }]
    const local = onlineHosts.find((host) => host.id === LOCAL_HOST_ID)
    return local ? [local, ...onlineHosts.filter((host) => host.id !== LOCAL_HOST_ID)] : onlineHosts
}

function getKillableHostIds(hosts: HostInfo[] | undefined): Set<string> {
    return new Set((hosts ?? []).filter((host) => host.status === 'online' && host.capabilities.includes('kill')).map((host) => host.id))
}

function targetSessionKey(session: TargetSession): string {
    return targetKey({ hostId: session.hostId, sessionName: session.name })
}

function openSessionKey(session: OpenSession): string {
    return targetKey({ hostId: session.hostId, sessionName: session.name })
}

function groupedOpenSessions(sessions: OpenSession[]): Array<{ hostId: string; hostName: string; sessions: OpenSession[] }> {
    const groups = new Map<string, { hostId: string; hostName: string; sessions: OpenSession[] }>()
    for (const session of sessions) {
        const group = groups.get(session.hostId)
        if (group) group.sessions.push(session)
        else groups.set(session.hostId, { hostId: session.hostId, hostName: session.hostName, sessions: [session] })
    }
    return [...groups.values()]
}

function groupedTargetSessions(sessions: TargetSession[]): Array<{ hostId: string; hostName: string; sessions: TargetSession[] }> {
    const groups = new Map<string, { hostId: string; hostName: string; sessions: TargetSession[] }>()
    for (const session of sessions) {
        const group = groups.get(session.hostId)
        if (group) group.sessions.push(session)
        else groups.set(session.hostId, { hostId: session.hostId, hostName: session.hostName, sessions: [session] })
    }
    return [...groups.values()]
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

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`
}

function saveWorkspace(workspace: WorkspaceNode): void {
    try {
        localStorage.setItem(WORKSPACE_STORAGE_KEY, JSON.stringify(workspace))
    } catch {
        /* storage may be unavailable */
    }
}

function sendWs(ws: WebSocket, msg: ClientWsMessage) {
    try {
        ws.send(JSON.stringify(msg))
    } catch {
        /* socket transitioning — ignore */
    }
}
