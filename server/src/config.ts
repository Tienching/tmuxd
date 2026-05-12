import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { config as loadDotenv } from 'dotenv'

// Load .env from the repo root regardless of CWD.
const __dirname = dirname(fileURLToPath(import.meta.url))
loadDotenv({ path: join(__dirname, '..', '..', '.env') })
// Also fall back to CWD-local .env if present.
loadDotenv()

export interface Config {
    /**
     * Shared trust-circle token. Any client (human via web/CLI, or
     * machine via agent WebSocket) must present this plus a personal
     * user-token to interact with the hub.
     *
     * Treat it like a team credential — everyone in the circle has it.
     * It authenticates "you may use this hub as a relay"; it does NOT
     * identify who you are.
     *
     * See `docs/identity-model.md`.
     */
    serverToken: string
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
    const serverToken = process.env.TMUXD_SERVER_TOKEN?.trim() || null
    if (!serverToken) {
        throw new Error(
            'Missing required auth: set TMUXD_SERVER_TOKEN (the shared team ' +
                'token). Each user also needs a personal TMUXD_USER_TOKEN when ' +
                'they log in — see docs/identity-model.md.'
        )
    }

    const host = process.env.HOST?.trim() || '127.0.0.1'
    const portStr = process.env.PORT?.trim() || '7681'
    const port = Number.parseInt(portStr, 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid PORT: ${portStr}`)
    }
    const dataDir = resolveDataDir()
    const jwtSecret = resolveJwtSecret(dataDir)
    const hubOnly = parseBoolean(process.env.TMUXD_HUB_ONLY)
    return { serverToken, hubOnly, host, port, jwtSecret, dataDir }
}

function parseBoolean(value: string | undefined): boolean {
    if (!value) return false
    const lower = value.trim().toLowerCase()
    return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on'
}
