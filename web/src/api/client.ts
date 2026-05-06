import {
    LOCAL_HOST_ID,
    type AuthResponse,
    type ClipboardImageUploadResponse,
    type HostInfo,
    type SessionTarget,
    type TargetSession,
    type TmuxSession
} from '@tmuxd/shared'
import { getToken, notifyAuthRequired } from '../auth/tokenStore'

interface CaptureResponse {
    text: string
    paneInMode: boolean
    scrollPosition: number
    historySize: number
    paneHeight: number
}

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

async function uploadRequest<T>(path: string, form: FormData): Promise<T> {
    const headers = new Headers()
    const token = getToken()
    if (token) headers.set('authorization', `Bearer ${token}`)
    const res = await fetch(path, { method: 'POST', headers, body: form })
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
    listHosts: () => request<{ hosts: HostInfo[] }>('/api/hosts'),
    listSessions: () => request<{ sessions: TmuxSession[] }>('/api/sessions'),
    listHostSessions: (hostId = LOCAL_HOST_ID) =>
        request<{ sessions: TargetSession[] }>(`/api/hosts/${encodeURIComponent(hostId)}/sessions`),
    createSession: (name: string) =>
        request<{ ok: true }>('/api/sessions', { method: 'POST', body: JSON.stringify({ name }) }),
    createHostSession: (hostId: string, name: string) =>
        request<{ ok: true }>(`/api/hosts/${encodeURIComponent(hostId)}/sessions`, { method: 'POST', body: JSON.stringify({ name }) }),
    captureSession: (name: string) => request<CaptureResponse>(`/api/sessions/${encodeURIComponent(name)}/capture`),
    captureTargetSession: (target: SessionTarget) =>
        target.hostId === LOCAL_HOST_ID
            ? request<CaptureResponse>(`/api/sessions/${encodeURIComponent(target.sessionName)}/capture`)
            : request<CaptureResponse>(
                  `/api/hosts/${encodeURIComponent(target.hostId)}/sessions/${encodeURIComponent(target.sessionName)}/capture`
              ),
    createWsTicket: (target?: Partial<SessionTarget>) =>
        request<{ ticket: string; expiresAt: number }>('/api/ws-ticket', {
            method: 'POST',
            body: JSON.stringify(target ?? {})
        }),
    uploadClipboardImage: (file: File) => {
        const form = new FormData()
        form.set('file', file, file.name || 'clipboard-image')
        return uploadRequest<ClipboardImageUploadResponse>('/api/uploads/clipboard-image', form)
    },
    killSession: (name: string) =>
        request<null>(`/api/sessions/${encodeURIComponent(name)}`, { method: 'DELETE' }),
    killTargetSession: (target: SessionTarget) =>
        target.hostId === LOCAL_HOST_ID
            ? request<null>(`/api/sessions/${encodeURIComponent(target.sessionName)}`, { method: 'DELETE' })
            : request<null>(`/api/hosts/${encodeURIComponent(target.hostId)}/sessions/${encodeURIComponent(target.sessionName)}`, {
                  method: 'DELETE'
              })
}
