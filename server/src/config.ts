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
    password: string
    host: string
    port: number
    jwtSecret: Uint8Array
    dataDir: string
    agentToken: string | null
}

function requireEnv(name: string): string {
    const v = process.env[name]
    if (!v || !v.trim()) {
        throw new Error(`Missing required environment variable: ${name}`)
    }
    return v
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
    const password = requireEnv('TMUXD_PASSWORD')
    const host = process.env.HOST?.trim() || '127.0.0.1'
    const portStr = process.env.PORT?.trim() || '7681'
    const port = Number.parseInt(portStr, 10)
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid PORT: ${portStr}`)
    }
    const dataDir = resolveDataDir()
    const jwtSecret = resolveJwtSecret(dataDir)
    const agentToken = process.env.TMUXD_AGENT_TOKEN?.trim() || null
    return { password, host, port, jwtSecret, dataDir, agentToken }
}
