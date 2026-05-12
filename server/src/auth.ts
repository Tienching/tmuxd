import { SignJWT, jwtVerify } from 'jose'
import { namespaceSchema } from '@tmuxd/shared'

export interface JwtPayload {
    sub: 'web'
    /** Namespace this JWT is scoped to. Derived from sha256(userToken). */
    ns: string
    iat: number
    exp: number
}

const ALG = 'HS256'
const DEFAULT_TTL_SECONDS = 12 * 60 * 60 // 12h

/**
 * Sign a JWT scoped to `namespace`.
 *
 * Callers pass the already-computed namespace (via `computeNamespace` in
 * `@tmuxd/shared`). This function does NOT accept a raw user-token — it
 * would be too easy to forget to hash and accidentally leak secrets
 * into JWT payloads.
 */
export async function issueToken(
    secret: Uint8Array,
    namespace: string,
    ttlSeconds: number = DEFAULT_TTL_SECONDS
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
        if (typeof payload.ns !== 'string') return null
        const parsed = namespaceSchema.safeParse(payload.ns)
        if (!parsed.success) return null
        return { sub: 'web', ns: parsed.data, iat: payload.iat, exp: payload.exp }
    } catch {
        return null
    }
}
