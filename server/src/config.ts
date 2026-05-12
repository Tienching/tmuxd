import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'
import { DEFAULT_NAMESPACE, hostIdSchema, namespaceSchema } from '@tmuxd/shared'
import type { AgentTokenBinding } from './agentRegistry.js'

// Load .env from the repo root regardless of CWD.
const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: join(__dirname, '..', '..', '.env') })
// Also fall back to CWD-local .env if present.
loadDotenv()

export interface Config {
    /**
     * Shared web-login token. Clients authenticate by sending this token
     * verbatim for single-user mode, or `<token>:<namespace>` for the
     * HAPI-style multi-user form. The hub stamps every issued JWT with
     * the requested namespace (default: `DEFAULT_NAMESPACE`).
     *
     * There is exactly one auth concept; single-user is the no-namespace
     * special case of the multi-user form. See `docs/hub-mode.md`.
     */
    token: string
    /**
     * When true (TMUXD_HUB_ONLY=1), tmuxd refuses to host any tmux session
     * itself; only registered agents serve sessions. Every route that today
     * dispatches via `isLocalHost(hostId)` returns 403 in this mode and the
     * hub's own host is hidden from every namespace's host list. Sysadmins
     * who want to use tmux on the box itself should SSH in directly.
     */
    hubOnly: boolean
    host: string
    port: number
    jwtSecret: Uint8Array
    dataDir: string
    agentTokens: AgentTokenBinding[]
}

function resolveDataDir(): string {
    const dir = process.env.TMUXD_HOME || join(process.cwd(), '.tmuxd')
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 })
    }
    return dir
}

function resolveJwtSecret(dataDir: string): Uint8Array {
    if (process.env.JWT_SECRET) {
        const secret = new TextEncoder().encode(process.env.JWT_SECRET)
        if (secret.length < 32) {
            throw new Error('JWT_SECRET must be at least 32 bytes')
        }
        return secret
    }
    const file = join(dataDir, 'jwt-secret')
    if (existsSync(file)) {
        return new Uint8Array(readFileSync(file))
    }
    const buf = randomBytes(48)
    writeFileSync(file, buf, { mode: 0o600 })
    return new Uint8Array(buf)
}

export function loadConfig(): Config {
    const rawToken = process.env.TMUXD_TOKEN?.trim() || null
    // Migration helper: old deployments may still set TMUXD_PASSWORD or
    // TMUXD_BASE_TOKEN. Accept either as an alias for TMUXD_TOKEN, with
    // a one-time startup warning pointing at the new name. Removing the
    // aliases is a future cleanup; keeping them as a "we read your old
    // config but please rename" courtesy.
    const legacyPassword = process.env.TMUXD_PASSWORD?.trim() || null
    const legacyBaseToken = process.env.TMUXD_BASE_TOKEN?.trim() || null

    let token = rawToken
    if (!token && legacyBaseToken) {
        console.warn('[tmuxd] TMUXD_BASE_TOKEN is deprecated; please rename to TMUXD_TOKEN.')
        token = legacyBaseToken
    }
    if (!token && legacyPassword) {
        console.warn('[tmuxd] TMUXD_PASSWORD is deprecated; please rename to TMUXD_TOKEN. Single-user login is the same value with no `:namespace` suffix.')
        token = legacyPassword
    }
    if (!token) {
        throw new Error('Missing required auth: set TMUXD_TOKEN. For multi-user, clients log in with <token>:<namespace>; for single-user, the bare token.')
    }

    const host = process.env.HOST?.trim() || '127.0.0.1'
    const portStr = process.env.PORT?.trim() || '7681'
    const port = Number.parseInt(portStr, 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid PORT: ${portStr}`)
    }
    const dataDir = resolveDataDir()
    const jwtSecret = resolveJwtSecret(dataDir)
    const agentTokens = resolveAgentTokens()
    const hubOnly = parseBoolean(process.env.TMUXD_HUB_ONLY)
    return { token, hubOnly, host, port, jwtSecret, dataDir, agentTokens }
}

function parseBoolean(value: string | undefined): boolean {
    if (!value) return false
    const lower = value.trim().toLowerCase()
    return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on'
}

function resolveAgentTokens(): AgentTokenBinding[] {
    const bound = process.env.TMUXD_AGENT_TOKENS?.trim()
    if (bound) return parseBoundAgentTokens(bound)

    const token = process.env.TMUXD_AGENT_TOKEN?.trim()
    return token ? [{ namespace: DEFAULT_NAMESPACE, hostId: null, token }] : []
}

/**
 * Parse `TMUXD_AGENT_TOKENS`.
 *
 * Each comma-separated entry is `<lhs>=<token>`. The LHS has two accepted
 * shapes:
 *
 *   - `<namespace>/<hostId>=<token>` — per-user binding (preferred for hub
 *     mode). Both segments validated against their respective schemas.
 *   - `<hostId>=<token>` — legacy shape, binds into `DEFAULT_NAMESPACE`.
 *
 * Tokens are raw secrets; the `BASE:<ns>` suffix form is a **web-login**
 * concept only, not an agent-token concept. Agents use the raw token and
 * report namespace via `hello`.
 */
export function parseBoundAgentTokens(value: string): AgentTokenBinding[] {
    const bindings: AgentTokenBinding[] = []
    for (const part of value.split(',')) {
        const entry = part.trim()
        if (!entry) continue
        const separator = entry.indexOf('=')
        if (separator <= 0) throw new Error('TMUXD_AGENT_TOKENS entries must use [namespace/]hostId=token')
        const rawLhs = entry.slice(0, separator).trim()
        const token = entry.slice(separator + 1).trim()
        if (!token) throw new Error(`TMUXD_AGENT_TOKENS token is empty for "${rawLhs}"`)

        let rawNamespace: string
        let rawHostId: string
        const slashIndex = rawLhs.indexOf('/')
        if (slashIndex === -1) {
            rawNamespace = DEFAULT_NAMESPACE
            rawHostId = rawLhs
        } else {
            rawNamespace = rawLhs.slice(0, slashIndex).trim()
            rawHostId = rawLhs.slice(slashIndex + 1).trim()
            if (!rawNamespace) throw new Error(`TMUXD_AGENT_TOKENS namespace is empty in "${rawLhs}"`)
            if (!rawHostId) throw new Error(`TMUXD_AGENT_TOKENS host id is empty in "${rawLhs}"`)
        }

        const parsedHostId = hostIdSchema.safeParse(rawHostId)
        if (!parsedHostId.success || parsedHostId.data === 'local') {
            throw new Error(`Invalid TMUXD_AGENT_TOKENS host id: "${rawHostId}"`)
        }
        const parsedNamespace = namespaceSchema.safeParse(rawNamespace)
        if (!parsedNamespace.success) {
            throw new Error(`Invalid TMUXD_AGENT_TOKENS namespace: "${rawNamespace}"`)
        }
        bindings.push({ namespace: parsedNamespace.data, hostId: parsedHostId.data, token })
    }
    if (bindings.length === 0) throw new Error('TMUXD_AGENT_TOKENS did not contain any [namespace/]hostId=token entries')

    // Reject duplicate (namespace, hostId) pairs and duplicate token values.
    // Both are almost certainly typos: the first produces ambiguous binding
    // behavior (only one entry can ever match at registration time), and
    // the second means one token authenticates as two different agents,
    // which is a security footgun. Operators rotating tokens should remove
    // the old entry, not leave both in place.
    const seenPairs = new Map<string, string>()
    const seenTokens = new Map<string, string>()
    for (const b of bindings) {
        const pairKey = `${b.namespace}/${b.hostId}`
        if (seenPairs.has(pairKey)) {
            throw new Error(
                `Duplicate TMUXD_AGENT_TOKENS binding for "${pairKey}". ` +
                `Each (namespace, hostId) pair must appear at most once.`
            )
        }
        seenPairs.set(pairKey, b.token)
        if (seenTokens.has(b.token)) {
            throw new Error(
                `Duplicate TMUXD_AGENT_TOKENS token shared by "${seenTokens.get(b.token)}" and "${pairKey}". ` +
                `Each agent must have its own token; rotate one before reusing.`
            )
        }
        seenTokens.set(b.token, pairKey)
    }

    return bindings
}
