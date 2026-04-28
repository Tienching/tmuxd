const KEY = 'tmuxd.openSessions'
const EVENT = 'tmuxd.openSessions.changed'

export interface OpenSession {
    name: string
    lastOpenedAt: number
}

export function listOpenSessions(): OpenSession[] {
    try {
        const raw = localStorage.getItem(KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
            .filter((s): s is OpenSession => typeof s?.name === 'string' && typeof s?.lastOpenedAt === 'number')
            .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt)
    } catch {
        return []
    }
}

export function markOpenSession(name: string): void {
    const trimmed = name.trim()
    if (!trimmed) return
    const next = [
        { name: trimmed, lastOpenedAt: Date.now() },
        ...listOpenSessions().filter((s) => s.name !== trimmed)
    ].slice(0, 32)
    write(next)
}

export function removeOpenSession(name: string): void {
    write(listOpenSessions().filter((s) => s.name !== name))
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

function write(sessions: OpenSession[]): void {
    try {
        localStorage.setItem(KEY, JSON.stringify(sessions))
        window.dispatchEvent(new Event(EVENT))
    } catch {
        /* storage can be unavailable in private mode */
    }
}
