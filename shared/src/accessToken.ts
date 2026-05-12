/**
 * Pure parsing of an access-token-with-namespace string. Lives in shared
 * because both the server (when validating `/api/auth` bodies) and the
 * CLI (when persisting credentials) need the exact same definition of
 * "what a `<token>:<namespace>` string means". Drift here is a wire-
 * contract bug.
 *
 * Format:
 *   `<baseToken>:<namespace>`  → multi-user
 *   `<baseToken>`              → single-user (namespace = DEFAULT_NAMESPACE)
 *
 * Uses `lastIndexOf(':')`, so `:` is permitted inside the base token;
 * only the last `:` separates namespace. Mirrors HAPI's
 * `parseAccessToken` behavior.
 *
 * Returns:
 *  - `{ baseToken, namespace }` when the string contains at least one
 *    `:` with non-empty segments on each side. Namespace is validated
 *    against `namespaceSchema`; if it fails, returns `null`.
 *  - `{ baseToken: trimmed, namespace: DEFAULT_NAMESPACE }` when there
 *    is no `:` at all (legacy single-user form).
 *  - `null` for empty input, whitespace-wrapped segments, empty
 *    segments, or an invalid namespace charset.
 */
import { namespaceSchema } from './schemas.js'
import { DEFAULT_NAMESPACE } from './types.js'

export interface ParsedAccessToken {
    baseToken: string
    namespace: string
}

export function parseAccessToken(raw: string): ParsedAccessToken | null {
    if (typeof raw !== 'string' || raw.length === 0) return null
    const trimmed = raw.trim()
    if (trimmed.length === 0) return null
    // Reject values whose outer whitespace would have been stripped — callers
    // that want to accept `"  secret:alice  "` should trim before passing.
    if (trimmed !== raw) return null

    const separator = trimmed.lastIndexOf(':')
    if (separator === -1) {
        return { baseToken: trimmed, namespace: DEFAULT_NAMESPACE }
    }

    const baseToken = trimmed.slice(0, separator)
    const namespace = trimmed.slice(separator + 1)
    if (baseToken.length === 0 || namespace.length === 0) return null
    if (baseToken.trim() !== baseToken || namespace.trim() !== namespace) return null

    const parsedNs = namespaceSchema.safeParse(namespace)
    if (!parsedNs.success) return null

    return { baseToken, namespace: parsedNs.data }
}
