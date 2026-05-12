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

/**
 * Decode the `ns` claim from the current JWT for display purposes only
 * (the namespace badge in the header). Returns null if no token, the
 * token is malformed, or the claim is missing.
 *
 * The signature is NOT verified client-side — that is the server's job.
 * This is purely a UX affordance so the user can confirm "I'm logged in
 * as alice." The server enforces the actual identity boundary on every
 * request.
 */
export function getCurrentNamespace(): string | null {
    const token = getToken()
    if (!token) return null
    const parts = token.split('.')
    if (parts.length !== 3) return null
    try {
        const payload = parts[1]
        // base64url → base64
        const padded = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(payload.length + ((4 - (payload.length % 4)) % 4), '=')
        const json = atob(padded)
        const obj = JSON.parse(json) as { ns?: unknown }
        return typeof obj.ns === 'string' && obj.ns.length > 0 ? obj.ns : null
    } catch {
        return null
    }
}
