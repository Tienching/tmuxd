import type { AuthResponse, TmuxSession } from '@tmuxd/shared'
import { getToken, notifyAuthRequired } from '../auth/tokenStore'

export class ApiError extends Error {
    constructor(
        public status: number,
        public body: unknown,
        message: string
    ) {
        super(message)
    }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    const token = getToken()
    if (token) headers.set('authorization', `Bearer ${token}`)
    const res = await fetch(path, { ...init, headers })
    const text = await res.text()
    let body: unknown = null
    if (text) {
        try {
            body = JSON.parse(text)
        } catch {
            body = text
        }
    }
    if (!res.ok) {
        if (res.status === 401) notifyAuthRequired()
        const msg = typeof body === 'object' && body && 'error' in body ? String((body as { error: unknown }).error) : `HTTP ${res.status}`
        throw new ApiError(res.status, body, msg)
    }
    return body as T
}

export const api = {
    login: (password: string) =>
        request<AuthResponse>('/api/auth', { method: 'POST', body: JSON.stringify({ password }) }),
    listSessions: () => request<{ sessions: TmuxSession[] }>('/api/sessions'),
    createSession: (name: string) =>
        request<{ ok: true }>('/api/sessions', { method: 'POST', body: JSON.stringify({ name }) }),
    createWsTicket: () => request<{ ticket: string; expiresAt: number }>('/api/ws-ticket', { method: 'POST' }),
    killSession: (name: string) =>
        request<null>(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' })
}
