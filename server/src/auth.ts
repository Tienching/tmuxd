import { SignJWT, jwtVerify } from 'jose'
import { DEFAULT_NAMESPACE, namespaceSchema } from '@tmuxd/shared'

// Re-export so existing call sites (`import { parseAccessToken } from '../auth.js'`)
// keep working. Canonical definition lives in @tmuxd/shared because both the
// CLI and the server need the exact same parsing rule.
export { parseAccessToken, type ParsedAccessToken } from '@tmuxd/shared'

export interface JwtPayload {
    sub: 'web'
    /** Namespace this JWT is scoped to. See DEFAULT_NAMESPACE. */
    ns: string
    iat: number
    exp: number
}

const ALG = 'HS256'
const DEFAULT_TTL_SECONDS = 12 * 60 * 60 // 12h

export async function issueToken(
    secret: Uint8Array,
    ttlSeconds: number = DEFAULT_TTL_SECONDS,
    namespace: string = DEFAULT_NAMESPACE
): Promise<{ token: string; expiresAt: number }> {
    const parsedNs = namespaceSchema.safeParse(namespace)
    if (!parsedNs.success) {
        throw new Error(`Invalid namespace: ${namespace}`)
    }
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + ttlSeconds
    const token = await new SignJWT({ ns: parsedNs.data })
        .setProtectedHeader({ alg: ALG })
        .setSubject('web')
        .setIssuedAt(now)
        .setExpirationTime(expiresAt)
        .sign(secret)
    return { token, expiresAt }
}

export async function verifyJwt(secret: Uint8Array, token: string): Promise<JwtPayload | null> {
    try {
        const { payload } = await jwtVerify(token, secret, { algorithms: [ALG] })
        if (payload.sub !== 'web' || typeof payload.iat !== 'number' || typeof payload.exp !== 'number') {
            return null
        }
        // Backwards compatibility: tokens issued before the ns claim existed are
        // still accepted and default to DEFAULT_NAMESPACE. New tokens always
        // carry ns. Invalid ns values are rejected.
        let ns: string = DEFAULT_NAMESPACE
        if (typeof payload.ns === 'string') {
            const parsed = namespaceSchema.safeParse(payload.ns)
            if (!parsed.success) return null
            ns = parsed.data
        } else if (payload.ns !== undefined) {
            return null
        }
        return { sub: 'web', ns, iat: payload.iat, exp: payload.exp }
    } catch {
        return null
    }
}

/**
 * Parse an access token of the form `<baseToken>:<namespace>`.
 *
 * Re-exported from `@tmuxd/shared/accessToken` — see that module for
 * the canonical definition. Kept here as a re-export so server imports
 * (`import { parseAccessToken } from '../auth.js'`) don't need to
 * change.
 */
export type { ParsedAccessToken as ParsedAccessTokenLegacy } from '@tmuxd/shared'
