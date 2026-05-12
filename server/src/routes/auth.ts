import { Hono } from 'hono'
import type { Context } from 'hono'
import { timingSafeEqual } from 'node:crypto'
import { loginSchema } from '@tmuxd/shared'
import { issueToken, parseAccessToken } from '../auth.js'
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
 * Single auth concept: client POSTs `{ token: "<token>[:<namespace>]" }`.
 *
 * - Bare `<token>` → JWT scoped to `DEFAULT_NAMESPACE` (single-user mode is
 *   the no-namespace special case, not a separate auth path).
 * - `<token>:<namespace>` → JWT scoped to that namespace, validated against
 *   `namespaceSchema`.
 *
 * In both cases the base token must equal the configured `TMUXD_TOKEN`.
 * There is no `password` form, no `/auth/mode` endpoint, no client-side
 * mode detection — the wire shape and the UI are the same in both
 * single-user and multi-user deployments. See `docs/hub-mode.md`.
 */
export interface AuthRoutesOptions {
    token: string
    jwtSecret: Uint8Array
    /**
     * Override the JWT TTL (seconds). Defaults to 12h via `issueToken`.
     * Threading this through is for tests that need to exercise the
     * expired-JWT branch in CLI/web clients without sleeping for 12
     * hours. Production deploys should never set this; the field is
     * intentionally not wired into operator-facing config.
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
        const decoded = parseAccessToken(parsed.data.token)
        if (!decoded) {
            recordFailure(clientKey)
            logAudit({
                event: 'login_failure',
                namespace: '',
                remoteAddr: clientKey,
                reason: 'invalid_token_shape'
            })
            return c.json({ error: 'invalid_token' }, 401)
        }
        if (!constantTimeEquals(decoded.baseToken, opts.token)) {
            recordFailure(clientKey)
            // Namespace is best-effort here: the secret was wrong, but the
            // parsed namespace tells us *which* namespace the attacker
            // tried to log into. That's the forensic signal.
            logAudit({
                event: 'login_failure',
                namespace: decoded.namespace,
                remoteAddr: clientKey,
                reason: 'token_mismatch'
            })
            return c.json({ error: 'invalid_token' }, 401)
        }
        clearFailure(clientKey)
        const { token: jwt, expiresAt } = await issueToken(opts.jwtSecret, opts.jwtTtlSeconds, decoded.namespace)
        logAudit({
            event: 'login_success',
            namespace: decoded.namespace,
            remoteAddr: clientKey
        })
        return c.json({ token: jwt, expiresAt })
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
    // 'unknown' last (signals misconfigured proxy chain). Mirrors
    // the IP resolution used by the bearer-auth audit and WS attach
    // audit so the three log streams correlate by remoteAddr.
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
