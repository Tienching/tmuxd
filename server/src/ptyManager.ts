import pty, { type IPty } from 'node-pty'
import { validateSessionName } from './tmux.js'

/** A live PTY attached to `tmux new-session -A -s <name>`. */
export interface PtyBridge {
    proc: IPty
    session: string
    cols: number
    rows: number
    dispose(): void
}

export function attachTmuxPty(session: string, cols: number, rows: number): PtyBridge {
    const safe = validateSessionName(session)
    const shell = 'tmux'
    // `-A` attaches if exists, otherwise creates. `-D` detaches other clients so
    // resize matches the browser viewport (optional; comment out for shared).
    // We keep shared attach (no -D) so multi-client viewing works.
    const args = ['new-session', '-A', '-s', safe]

    // Strip sensitive env vars from the shell the user will interact with.
    const {
        TMUXD_PASSWORD: _tp,
        JWT_SECRET: _js,
        ...cleanEnv
    } = process.env

    const proc = pty.spawn(shell, args, {
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

function clampDim(n: number): number {
    if (!Number.isFinite(n)) return 80
    return Math.min(1000, Math.max(1, Math.floor(n)))
}
