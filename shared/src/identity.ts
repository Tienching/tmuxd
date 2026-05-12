/**
 * Identity model for tmuxd.
 *
 * Two token concept (see docs/identity-model.md):
 *
 *  - **Server token**: shared within the trust circle. Anyone who knows
 *    it can **reach** the hub (use it as a relay). Configured on the hub
 *    as `TMUXD_SERVER_TOKEN`. Constant within a deployment.
 *
 *  - **User token**: personal. A user's `TMUXD_USER_TOKEN` determines
 *    which namespace they log into. The hub does NOT store user tokens;
 *    it treats them as opaque secrets and derives a stable namespace ID
 *    from them via `computeNamespace()`.
 *
 * Namespace derivation is a one-way hash so that:
 *  - namespace strings are safe to print, log, and write into URLs/JWTs
 *  - the same user-token always produces the same namespace across hubs,
 *    agent restarts, login sessions, and CLI credentials files
 *  - a leaked namespace does NOT reveal the user token
 *
 * The namespace is 16 lowercase hex characters (64 bits). Collision
 * probability for a reasonable team (≤ 10^6 users) is astronomically
 * small; a user who cares can mitigate by choosing a longer random
 * user-token.
 */

const NAMESPACE_HEX_LENGTH = 16

/** Regex a computed namespace always matches. Also used by schemas. */
export const NAMESPACE_PATTERN = /^[a-f0-9]{16}$/

function getCrypto(): Crypto {
    // Node 18+ exposes the Web Crypto API on globalThis. Modern browsers
    // do too. We do not use node:crypto here because shared/ is consumed
    // by the web bundle, where node:crypto is unavailable.
    const c = (globalThis as { crypto?: Crypto }).crypto
    if (!c?.subtle || typeof c.getRandomValues !== 'function') {
        throw new Error('Web Crypto API unavailable; need Node 18+ or a modern browser')
    }
    return c
}

/**
 * Derive a stable namespace identifier from a user token.
 *
 * Async because Web Crypto's digest is async. Cheap (sub-ms); call sites
 * cache the result wherever possible.
 *
 * Input validation: user tokens must be non-empty after trimming. An
 * empty/whitespace-only input is a caller bug and throws — we do NOT
 * return a sentinel namespace for it, because that would let every
 * misconfigured client accidentally share one namespace.
 */
export async function computeNamespace(userToken: string): Promise<string> {
    if (typeof userToken !== 'string') {
        throw new TypeError('userToken must be a string')
    }
    const trimmed = userToken.trim()
    if (trimmed.length === 0) {
        throw new Error('userToken must not be empty')
    }
    const bytes = new TextEncoder().encode(trimmed)
    const digest = await getCrypto().subtle.digest('SHA-256', bytes)
    const view = new Uint8Array(digest)
    let hex = ''
    for (let i = 0; i < view.length; i++) {
        hex += view[i].toString(16).padStart(2, '0')
    }
    return hex.slice(0, NAMESPACE_HEX_LENGTH)
}

/**
 * Generate a fresh random user token. Used by `tmuxd login --generate`
 * and the web UI's "generate user token" helper. 32 bytes of entropy
 * rendered as 64 hex chars; long enough that the birthday bound on
 * `computeNamespace` collisions is irrelevant.
 */
export function generateUserToken(): string {
    const bytes = new Uint8Array(32)
    getCrypto().getRandomValues(bytes)
    let hex = ''
    for (let i = 0; i < bytes.length; i++) {
        hex += bytes[i].toString(16).padStart(2, '0')
    }
    return hex
}
