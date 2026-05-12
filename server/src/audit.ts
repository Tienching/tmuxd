/**
 * Phase-1 audit log.
 *
 * Structured single-line JSON to stderr at INFO level. Only logs the
 * shape of events, never payloads or session content. The doc's open
 * question called this the minimum for phase 1 — when phase 2 lands a
 * real audit table, the same call sites should keep working.
 *
 * Toggle off with `TMUXD_AUDIT_DISABLE=1` for tests that don't want the
 * noise. Default behavior in production is on.
 *
 * Events emitted today:
 *   - `login_success`     — a user logged in (`namespace` carries who)
 *   - `login_failure`     — a `/api/auth` attempt failed; `reason` says
 *                           why, `namespace` is best-effort (may be empty)
 *   - `auth_failure`      — a bearer JWT on /api/* was missing or invalid;
 *                           catches brute-forcing the API surface vs the
 *                           login endpoint
 *   - `agent_register`    — agent passed hello + binding check
 *   - `agent_rejected`    — agent's hello was rejected after a successful
 *                           token check (e.g. namespace mismatch); WS
 *                           closed with a 4xxx code, agent told to fix
 *                           its config and exit
 *   - `agent_disconnect`  — agent's WS closed; `reason` carries the cause
 *   - `ws_attach`         — browser opened an attach WS
 */

const enabled = process.env.TMUXD_AUDIT_DISABLE !== '1'

export type AuditEventType =
    | 'login_success'
    | 'login_failure'
    | 'auth_failure'
    | 'agent_register'
    | 'agent_rejected'
    | 'agent_disconnect'
    | 'ws_attach'

export interface AuditEvent {
    event: AuditEventType
    /**
     * Namespace the event belongs to. For `login_failure`, may be the
     * empty string when the input couldn't be parsed (still useful: an
     * empty namespace + failures from one IP is a signal).
     */
    namespace: string
    /** Set for agent_* and ws_attach. Empty for login_*. */
    hostId?: string
    /** Optional fields for ws_attach events. */
    sessionName?: string
    /** Source IP if we know it (from `request.socket.remoteAddress`). */
    remoteAddr?: string
    /** Optional human-readable agent display name for agent_register. */
    name?: string
    /** Why something failed, was rejected, or disconnected. */
    reason?: string
}

export function logAudit(evt: AuditEvent): void {
    if (!enabled) return
    try {
        const line = JSON.stringify({ ts: new Date().toISOString(), ...evt })
        // stderr keeps audit lines out of the JSON-RPC stdout path used
        // by some agent setups; matches what `console.log/console.error`
        // already do for tmuxd's own startup messages.
        process.stderr.write(`[tmuxd:audit] ${line}\n`)
    } catch {
        // Swallow — an audit log must never crash the process.
    }
}
