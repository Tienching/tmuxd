import { Hono } from 'hono'
import type { Context } from 'hono'
import { loginSchema } from '@tmuxd/shared'
import { checkPassword, issueToken } from '../auth.js'

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

export function createAuthRoutes(password: string, jwtSecret: Uint8Array): Hono {
    const app = new Hono()

    app.post('/auth', async (c) => {
        const clientKey = getClientKey(c)
        const limited = checkLimit(clientKey)
        if (limited) {
            return c.json({ error: 'rate_limited' }, 429)
        }
        const body = await c.req.json().catch(() => null)
        const parsed = loginSchema.safeParse(body)
        if (!parsed.success) {
            return c.json({ error: 'invalid_body' }, 400)
        }
        if (!checkPassword(password, parsed.data.password)) {
            recordFailure(clientKey)
            return c.json({ error: 'invalid_password' }, 401)
        }
        clearFailure(clientKey)
        const { token, expiresAt } = await issueToken(jwtSecret)
        return c.json({ token, expiresAt })
    })

    return app
}

function getClientKey(c: Context): string {
    return (
        c.req.header('cf-connecting-ip') ||
        c.req.header('x-real-ip') ||
        c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
        'unknown'
    )
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
