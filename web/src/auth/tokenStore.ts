const TOKEN_KEY = 'tmuxd.token'
const EXP_KEY = 'tmuxd.token.exp'
export const AUTH_REQUIRED_EVENT = 'tmuxd.auth.required'

let memoryToken: { token: string; exp: number } | null = null

export function getToken(): string | null {
    let token = memoryToken?.token ?? null
    let exp = memoryToken?.exp ?? 0
    try {
        token = localStorage.getItem(TOKEN_KEY) ?? token
        exp = Number(localStorage.getItem(EXP_KEY) || exp || '0')
    } catch {
        /* storage unavailable; fall back to memory */
    }
    if (!token || !exp) return null
    if (!Number.isFinite(exp)) {
        clearToken()
        return null
    }
    if (exp * 1000 < Date.now()) {
        clearToken()
        return null
    }
    return token
}

export function setToken(token: string, expiresAt: number): void {
    memoryToken = { token, exp: expiresAt }
    try {
        localStorage.setItem(TOKEN_KEY, token)
        localStorage.setItem(EXP_KEY, String(expiresAt))
    } catch {
        /* storage unavailable; memory token lasts until reload */
    }
}

export function clearToken(): void {
    memoryToken = null
    try {
        localStorage.removeItem(TOKEN_KEY)
        localStorage.removeItem(EXP_KEY)
    } catch {
        /* ignore */
    }
}

export function notifyAuthRequired(): void {
    clearToken()
    window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
}
