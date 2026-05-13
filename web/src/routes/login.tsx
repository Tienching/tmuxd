import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../api/client'
import { setToken } from '../auth/tokenStore'

export const USER_TOKEN_LS_KEY = 'tmuxd:userToken'

/**
 * Login form for the two-token model. The user fills in:
 *
 *  - Server token: shared by the team. Operator gives it out.
 *  - User token: personal. Generated ONCE in the CLI (`tmuxd login
 *    --user-token-generate`), then re-used everywhere — laptop CLI,
 *    web UI, agent processes — so the user always lands in the same
 *    namespace.
 *
 * The web form is intentionally for *consuming* identity, not minting
 * it. There is no "Generate" button here on purpose:
 *
 *   - First-time setup belongs in a context where the generated token
 *     can be visibly captured (stderr → password manager → environment
 *     variable on agent boxes). The web has none of that — the token
 *     would be a one-time string in a closed tab.
 *   - A button labeled "Generate" invites users on a second device to
 *     click it, get a fresh token, and silently land in a new namespace
 *     where their existing sessions are invisible. There's no automatic
 *     way to recover from this.
 *
 * So: web shows the form, populates the User token field from
 * localStorage if anything is saved, and points users at the CLI for
 * the one-time generate step.
 *
 * We persist the user token to localStorage on successful login so the
 * JWT refresh path doesn't need to re-prompt — same threat model as
 * persisting the JWT itself, which is already browser-resident.
 */
export function LoginPage() {
    const navigate = useNavigate()
    const [serverToken, setServerToken] = useState('')
    const [userToken, setUserToken] = useState(() => localStorage.getItem(USER_TOKEN_LS_KEY) ?? '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function submit(e: React.FormEvent) {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            const res = await api.login(serverToken, userToken)
            setToken(res.token, res.expiresAt)
            // Persist the user token so JWT refresh doesn't need to re-prompt.
            // The server token is intentionally NOT persisted — the user
            // re-enters (or the operator pre-fills via env) on first login,
            // but we don't keep it in browser storage where extensions /
            // bookmarklets / DevTools can casually inspect it. The user token
            // is what makes alice "alice"; the server token is the team key.
            localStorage.setItem(USER_TOKEN_LS_KEY, userToken)
            await navigate({ to: '/' })
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'login failed'
            setError(
                msg === 'invalid_token'
                    ? 'Wrong tokens.'
                    : msg === 'rate_limited'
                    ? 'Too many failed attempts. Wait a minute.'
                    : msg === 'invalid_body'
                    ? 'Provide both server token and user token.'
                    : msg
            )
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="flex h-full items-center justify-center p-4">
            <form
                onSubmit={submit}
                className="w-full max-w-sm space-y-4 rounded-xl border border-neutral-800 bg-neutral-900/60 p-6 shadow-xl"
            >
                <div>
                    <h1 className="text-xl font-semibold tracking-tight">tmuxd</h1>
                    <p className="text-sm text-neutral-400">
                        Two-token sign-in. Server token comes from your hub admin.
                        User token is yours — paste the same one you used in the CLI
                        to land in the same namespace.
                    </p>
                </div>
                <label className="block space-y-1">
                    <span className="text-sm text-neutral-300">Server token</span>
                    <input
                        type="password"
                        autoFocus
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!!error}
                        className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
                        value={serverToken}
                        onChange={(e) => setServerToken(e.target.value)}
                    />
                </label>
                <label className="block space-y-1">
                    <span className="text-sm text-neutral-300">User token</span>
                    <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!!error}
                        className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-mono outline-none focus:border-neutral-500"
                        value={userToken}
                        onChange={(e) => setUserToken(e.target.value)}
                    />
                </label>
                <p className="text-xs text-neutral-500">
                    First time? Generate a user token in your terminal, then paste it here:{' '}
                    <code className="rounded bg-neutral-800 px-1 py-0.5 font-mono text-neutral-300">
                        tmuxd login --hub &lt;url&gt; --server-token &lt;value&gt; --user-token-generate
                    </code>
                </p>
                {error && (
                    <p className="text-sm text-red-400" role="alert">
                        {error}
                    </p>
                )}
                <button
                    type="submit"
                    disabled={busy || !serverToken || !userToken}
                    className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition enabled:hover:bg-white disabled:opacity-50"
                >
                    {busy ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </div>
    )
}
