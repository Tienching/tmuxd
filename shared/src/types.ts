export interface TmuxSession {
    name: string
    windows: number
    attached: boolean
    created: number // unix seconds
    activity: number // unix seconds
}

export const LOCAL_HOST_ID = 'local'

export type HostStatus = 'online' | 'offline'
export type HostCapability = 'list' | 'create' | 'kill' | 'capture' | 'attach'

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
