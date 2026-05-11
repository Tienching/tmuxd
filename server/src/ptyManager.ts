import { execFileSync } from 'node:child_process'
import pty, { type IPty } from 'node-pty'
import { validateSessionTargetName } from './tmux.js'

let tmuxCommandCache: string | null = null

/** A live PTY attached to an existing tmux session. */
export interface PtyBridge {
    proc: IPty
    session: string
    cols: number
    rows: number
    dispose(): void
}

export function attachTmuxPty(session: string, cols: number, rows: number): PtyBridge {
    const safe = validateSessionTargetName(session)
    const tmux = resolveTmuxCommand()
    try {
        execFileSync(tmux, ['has-session', '-t', safe], { encoding: 'utf8', stdio: 'pipe' })
    } catch {
        throw new Error('session_not_found')
    }
    // Attach only; session creation is an explicit API action. Using
    // `new-session -A` here can silently recreate stale Opened entries as empty
    // tmux sessions when a browser reconnects.
    const args = ['attach-session', '-t', safe]

    // Strip sensitive env vars from the shell the user will interact with.
    const {
        TMUXD_PASSWORD: _tp,
        TMUXD_AGENT_TOKEN: _tat,
        TMUXD_AGENT_TOKENS: _tats,
        JWT_SECRET: _js,
        ...cleanEnv
    } = process.env

    const proc = pty.spawn(tmux, args, {
        name: 'xterm-256color',
        cols: clampDim(cols),
        rows: clampDim(rows),
        cwd: process.env.HOME || process.cwd(),
        env: { ...cleanEnv, TERM: 'xterm-256color' }
    })

    let disposed = false

    const bridge: PtyBridge = {
        proc,
        session: safe,
        cols: clampDim(cols),
        rows: clampDim(rows),
        dispose() {
            if (disposed) return
            disposed = true
            try {
                proc.kill()
            } catch {
                /* ignore */
            }
        }
    }

    return bridge
}

function resolveTmuxCommand(): string {
    if (tmuxCommandCache) return tmuxCommandCache
    if (process.env.TMUXD_TMUX_PATH?.trim()) {
        tmuxCommandCache = process.env.TMUXD_TMUX_PATH.trim()
        return tmuxCommandCache
    }
    if (process.platform !== 'win32') {
        tmuxCommandCache = 'tmux'
        return tmuxCommandCache
    }
    try {
        const out = execFileSync('where.exe', ['tmux'], { encoding: 'utf8' })
        const first = out
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.toLowerCase().endsWith('.exe'))
        tmuxCommandCache = first || 'tmux.exe'
    } catch {
        tmuxCommandCache = 'tmux.exe'
    }
    return tmuxCommandCache
}

function clampDim(n: number): number {
    if (!Number.isFinite(n)) return 80
    return Math.min(1000, Math.max(1, Math.floor(n)))
}
