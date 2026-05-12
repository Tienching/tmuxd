import { Hono } from 'hono'
import type { Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { computeNamespace, loginSchema } from '@tmuxd/shared'
import { issueToken } from '../auth.js'
import { logAudit } from '../audit.js'

const WINDOW_MS = 60_000
const LOCK_MS = 60_000
const MAX_FAILURES_PER_CLIENT = 5
const MAX_FAILURES_GLOBAL = 50

interface Bucket {
    failures: number
    windowStart: number
    lockedUntil: number
}

const buckets = new Map<string, Bucket>()

/**
 * Two-token login. The client POSTs `{serverToken, userToken}`.
 *
 *  - `serverToken` must equal the hub's `TMUXD_SERVER_TOKEN` (shared
 *    team token — "may you use this hub"). Compared in constant time.
 *  - `userToken` is the client's personal identity. The hub does NOT
 *    store it; namespace is derived via sha256(userToken).slice(0,16).
 *
 * See `docs/identity-model.md`.
 */
export interface AuthRoutesOptions {
    serverToken: string
    jwtSecret: Uint8Array
    /**
     * Override the JWT TTL (seconds). Defaults to 12h via `issueToken`.
     * Threading this through is for tests that need to exercise the
     * expired-JWT branch in CLI/web clients without sleeping for 12
     * hours.
     */
    jwtTtlSeconds?: number
}

export function createAuthRoutes(opts: AuthRoutesOptions): Hono {
    const app = new Hono()

    app.post('/auth', async (c) => {
        const clientKey = getClientKey(c)
        if (checkLimit(clientKey)) {
            logAudit({
                event: 'login_failure',
                namespace: '',
                remoteAddr: clientKey,
                reason: 'rate_limited'
            })
            return c.json({ error: 'rate_limited' }, 429)
        }
        const body = await c.req.json().catch(() => null)
        const parsed = loginSchema.safeParse(body)
        if (!parsed.success) {
            logAudit({
                event: 'login_failure',
                namespace: '',
                remoteAddr: clientKey,
                reason: 'invalid_body'
            })
            return c.json({ error: 'invalid_body' }, 400)
        }
        if (!constantTimeEquals(parsed.data.serverToken, opts.serverToken)) {
            recordFailure(clientKey)
            logAudit({
                event: 'login_failure',
                namespace: '',
                remoteAddr: clientKey,
                reason: 'server_token_mismatch'
            })
            return c.json({ error: 'invalid_token' }, 401)
        }
        let namespace: string
        try {
            namespace = await computeNamespace(parsed.data.userToken)
        } catch {
            recordFailure(clientKey)
            logAudit({
                event: 'login_failure',
                namespace: '',
                remoteAddr: clientKey,
                reason: 'invalid_user_token'
            })
            return c.json({ error: 'invalid_token' }, 401)
        }
        clearFailure(clientKey)
        const { token: jwt, expiresAt } = await issueToken(opts.jwtSecret, namespace, opts.jwtTtlSeconds)
        logAudit({
            event: 'login_success',
            namespace,
            remoteAddr: clientKey
        })
        return c.json({ token: jwt, expiresAt, namespace })
    })

    return app
}

function constantTimeEquals(a: string, b: string): boolean {
    const ab = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ab.length !== bb.length) {
        // compare against self to avoid length-based timing leak, then fail
        timingSafeEqual(ab, ab)
        return false
    }
    return timingSafeEqual(ab, bb)
}

function getClientKey(c: Context): string {
    // Proxy headers first (operator-trusted), socket peer second
    // (works for direct connections in dev / single-box deploys),
    // 'unknown' last (signals misconfigured proxy chain).
    const fromHeader =
        c.req.header('cf-connecting-ip') ||
        c.req.header('x-real-ip') ||
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (fromHeader) return fromHeader
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming
    return incoming?.socket?.remoteAddress || 'unknown'
}

function checkLimit(clientKey: string): boolean {
    return isLocked(`client:${clientKey}`, MAX_FAILURES_PER_CLIENT) || isLocked('global', MAX_FAILURES_GLOBAL)
}

function recordFailure(clientKey: string): void {
    addFailure(`client:${clientKey}`, MAX_FAILURES_PER_CLIENT)
    addFailure('global', MAX_FAILURES_GLOBAL)
}

function clearFailure(clientKey: string): void {
    buckets.delete(`client:${clientKey}`)
}

function isLocked(key: string, maxFailures: number): boolean {
    const bucket = currentBucket(key)
    if (!bucket) return false
    if (bucket.lockedUntil > Date.now()) return true
    return bucket.failures >= maxFailures
}

function addFailure(key: string, maxFailures: number): void {
    const now = Date.now()
    const bucket = currentBucket(key) ?? { failures: 0, windowStart: now, lockedUntil: 0 }
    bucket.failures++
    if (bucket.failures >= maxFailures) {
        bucket.lockedUntil = now + LOCK_MS
    }
    buckets.set(key, bucket)
}

function currentBucket(key: string): Bucket | null {
    const bucket = buckets.get(key)
    if (!bucket) return null
    if (Date.now() - bucket.windowStart > WINDOW_MS && bucket.lockedUntil <= Date.now()) {
        buckets.delete(key)
        return null
    }
    return bucket
}
