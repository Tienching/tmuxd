import { timingSafeEqual } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'

export interface JwtPayload {
    sub: 'web'
    iat: number
    exp: number
}

const ALG = 'HS256'
const DEFAULT_TTL_SECONDS = 12 * 60 * 60 // 12h

export async function issueToken(secret: Uint8Array, ttlSeconds = DEFAULT_TTL_SECONDS): Promise<{ token: string; expiresAt: number }> {
    const now = Math.floor(Date.now() / 1000)
    const expiresAt = now + ttlSeconds
    const token = await new SignJWT({})
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
        return payload as JwtPayload
    } catch {
        return null
    }
}

export function checkPassword(expected: string, provided: string): boolean {
    // constant-time compare
    const a = Buffer.from(expected, 'utf8')
    const b = Buffer.from(provided, 'utf8')
    if (a.length !== b.length) {
        // Still do a compare against self to avoid length-based timing, then return false.
        timingSafeEqual(a, a)
        return false
    }
    return timingSafeEqual(a, b)
}
