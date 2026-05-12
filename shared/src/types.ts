export interface TmuxSession {
    name: string
    windows: number
    attached: boolean
    attachedClients: number
    created: number // unix seconds
    activity: number // unix seconds
}

export interface TmuxPane {
    target: string
    sessionName: string
    windowIndex: number
    windowName: string
    windowActive: boolean
    paneIndex: number
    paneId: string
    paneActive: boolean
    paneDead: boolean
    currentCommand: string
    currentPath: string
    title: string
    width: number
    height: number
    paneInMode: boolean
    scrollPosition: number
    historySize: number
    sessionAttached: boolean
    sessionAttachedClients: number
    sessionActivity: number // unix seconds
    windowActivity: number // unix seconds
}

export interface TmuxPaneCapture {
    target: string
    text: string
    truncated: boolean
    maxBytes: number
    paneInMode: boolean
    scrollPosition: number
    historySize: number
    paneHeight: number
}

export interface TargetPane extends TmuxPane {
    hostId: string
    hostName: string
}

export type TmuxActionKind = 'send-text' | 'send-keys'

export interface TmuxAction {
    id: string
    label: string
    description?: string
    kind: TmuxActionKind
    payload?: string
    enter?: boolean
    keys?: string[]
    createdAt: number // unix ms
    updatedAt: number // unix ms
}

export interface TmuxActionRun {
    id: string
    actionId: string
    label: string
    kind: TmuxActionKind
    hostId: string
    target: string
    ok: boolean
    error?: string
    startedAt: number // unix ms
    completedAt: number // unix ms
}

export type TmuxPaneState = 'idle' | 'running' | 'needs_input' | 'permission_prompt' | 'copy_mode' | 'dead'

export type TmuxPaneActivityLight = 'green' | 'yellow' | 'red' | 'gray'
export type TmuxPaneActivityReason = 'output' | 'closed'

export interface TmuxPaneActivity {
    light: TmuxPaneActivityLight
    unread: boolean
    changed: boolean
    seq: number
    reason?: TmuxPaneActivityReason
    updatedAt: number // unix ms
    checkedAt: number // unix ms
}

export interface TmuxPaneStatus {
    target: string
    state: TmuxPaneState
    signals: string[]
    summary: string
    checkedAt: number // unix ms
    pane?: TmuxPane
    capture: TmuxPaneCapture
    activity?: TmuxPaneActivity
}

export interface TmuxSnapshotError {
    hostId: string
    operation: string
    error: string
    message?: string
}

export interface TmuxSnapshot {
    generatedAt: number // unix ms
    hosts: HostInfo[]
    sessions: TargetSession[]
    panes: TargetPane[]
    statuses?: TmuxPaneStatus[]
    errors: TmuxSnapshotError[]
}

export const LOCAL_HOST_ID = 'local'

/**
 * Default namespace for single-user / legacy mode.
 *
 * When the operator logs in with bare `TMUXD_TOKEN` (no `:<namespace>`
 * suffix), JWTs are issued with `ns = DEFAULT_NAMESPACE`, agent
 * registrations without an explicit namespace bind to
 * `DEFAULT_NAMESPACE`, and legacy agents that do not report
 * `hello.namespace` are treated as `DEFAULT_NAMESPACE`. See
 * `docs/hub-mode.md`.
 */
export const DEFAULT_NAMESPACE = 'default'

export type HostStatus = 'online' | 'offline'
export type HostCapability = 'list' | 'create' | 'kill' | 'capture' | 'attach' | 'panes' | 'input'

export interface HostInfo {
    id: string
    name: string
    status: HostStatus
    isLocal: boolean
    version: string
    lastSeenAt: number // unix ms
    capabilities: HostCapability[]
}

export interface SessionTarget {
    hostId: string
    sessionName: string
}

export interface TargetSession extends TmuxSession {
    hostId: string
    hostName: string
}

export interface AuthResponse {
    token: string
    expiresAt: number // unix seconds
}

export interface ClipboardImageUploadResponse {
    path: string
    name: string
    size: number
    type: string
}

/** Server → client WebSocket frames */
export type ServerWsMessage =
    | { type: 'ready'; session: string; cols: number; rows: number; hostId?: string }
    | { type: 'data'; payload: string } // base64
    | { type: 'exit'; code: number | null; signal: string | null }
    | { type: 'error'; message: string }
    | { type: 'pong' }

/** Client → server WebSocket frames */
export type ClientWsMessage =
    | { type: 'input'; payload: string } // base64
    | { type: 'resize'; cols: number; rows: number }
    | { type: 'ping' }
