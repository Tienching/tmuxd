export interface TmuxSession {
    name: string
    windows: number
    attached: boolean
    created: number // unix seconds
    activity: number // unix seconds
}

export interface AuthResponse {
    token: string
    expiresAt: number // unix seconds
}

/** Server → client WebSocket frames */
export type ServerWsMessage =
    | { type: 'ready'; session: string; cols: number; rows: number }
    | { type: 'data'; payload: string } // base64
    | { type: 'exit'; code: number | null; signal: string | null }
    | { type: 'error'; message: string }
    | { type: 'pong' }

/** Client → server WebSocket frames */
export type ClientWsMessage =
    | { type: 'input'; payload: string } // base64
    | { type: 'resize'; cols: number; rows: number }
    | { type: 'ping' }
