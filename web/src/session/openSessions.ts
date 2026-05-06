import { LOCAL_HOST_ID, type SessionTarget } from '@tmuxd/shared'

const KEY = 'tmuxd.openSessions'
const EVENT = 'tmuxd.openSessions.changed'

export interface OpenSession {
    name: string
    hostId: string
    hostName: string
    lastOpenedAt: number
}

export function listOpenSessions(): OpenSession[] {
    try {
        const raw = localStorage.getItem(KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
            .map(parseOpenSession)
            .filter((s): s is OpenSession => Boolean(s))
            .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    } catch {
        return []
    }
}

export function markOpenSession(nameOrTarget: string | SessionTarget, hostName = 'Local'): void {
    const target = normalizeTarget(nameOrTarget)
    if (!target) return
    const next = [
        { name: target.sessionName, hostId: target.hostId, hostName, lastOpenedAt: Date.now() },
        ...listOpenSessions().filter((s) => s.name !== target.sessionName || s.hostId !== target.hostId)
    ].slice(0, 32)
    write(next)
}

export function removeOpenSession(nameOrTarget: string | SessionTarget): void {
    const target = normalizeTarget(nameOrTarget)
    if (!target) return
    write(listOpenSessions().filter((s) => s.name !== target.sessionName || s.hostId !== target.hostId))
}

export function subscribeOpenSessions(onChange: () => void): () => void {
    const onStorage = (event: StorageEvent) => {
        if (event.key === KEY) onChange()
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener(EVENT, onChange)
    return () => {
        window.removeEventListener('storage', onStorage)
        window.removeEventListener(EVENT, onChange)
    }
}

function parseOpenSession(value: unknown): OpenSession | null {
    if (!value || typeof value !== 'object') return null
    const record = value as Record<string, unknown>
    const name = typeof record.name === 'string' ? record.name.trim() : ''
    const lastOpenedAt = typeof record.lastOpenedAt === 'number' ? record.lastOpenedAt : 0
    if (!name || !lastOpenedAt) return null
    const hostId = typeof record.hostId === 'string' && record.hostId.trim() ? record.hostId.trim() : LOCAL_HOST_ID
    const hostName = typeof record.hostName === 'string' && record.hostName.trim() ? record.hostName.trim() : hostLabel(hostId)
    return { name, hostId, hostName, lastOpenedAt }
}

function normalizeTarget(nameOrTarget: string | SessionTarget): SessionTarget | null {
    if (typeof nameOrTarget === 'string') {
        const sessionName = nameOrTarget.trim()
        return sessionName ? { hostId: LOCAL_HOST_ID, sessionName } : null
    }
    const hostId = nameOrTarget.hostId.trim()
    const sessionName = nameOrTarget.sessionName.trim()
    if (!hostId || !sessionName) return null
    return { hostId, sessionName }
}

function hostLabel(hostId: string): string {
    return hostId === LOCAL_HOST_ID ? 'Local' : hostId
}

function write(sessions: OpenSession[]): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(sessions))
        window.dispatchEvent(new Event(EVENT))
    } catch {
        /* storage can be unavailable in private mode */
    }
}
