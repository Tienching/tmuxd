import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { generateUserToken } from '@tmuxd/shared'
import { api } from '../api/client'
import { setToken } from '../auth/tokenStore'

export const USER_TOKEN_LS_KEY = 'tmuxd:userToken'

/**
 * Generate a fresh user token AND persist it to localStorage in the same
 * call. Exported (and tested) separately because the failure mode it
 * fixes — submit fails after Generate, user reloads, token is gone — is
 * subtle enough to warrant a focused unit test rather than relying on
 * a manual click-test of the whole login form.
 *
 * Returns the generated token so the caller can also stuff it into
 * component state.
 */
export function generateAndPersistUserToken(
    storage: Pick<Storage, 'setItem'> = localStorage
): string {
    const token = generateUserToken()
    storage.setItem(USER_TOKEN_LS_KEY, token)
    return token
}

/**
 * Login form for the two-token model. The user fills in:
 *
 *  - Server token: shared by the team. Operator gives it out.
 *  - User token: personal. Generate once and remember it; whoever has
 *    your user-token IS you on this hub.
 *
 * We persist the user token to localStorage on success so the user
 * doesn't have to re-type it on every JWT refresh — only the JWT itself
 * has been browser-resident before, so this is a small extension of an
 * already-persisted secret. The "Generate" button creates a fresh
 * random token for first-time setup AND persists it on the spot, so
 * a failed submit doesn't drop a freshly-minted identity on the floor.
 */
export function LoginPage() {
    const navigate = useNavigate()
    const [serverToken, setServerToken] = useState('')
    const [userToken, setUserToken] = useState(() => localStorage.getItem(USER_TOKEN_LS_KEY) ?? '')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [showGeneratedHint, setShowGeneratedHint] = useState(false)

    function generate() {
        // Persist IMMEDIATELY (inside generateAndPersistUserToken), before
        // submit. Otherwise a 401 on first-ever login (e.g. user typed the
        // wrong server token) drops the freshly-generated user token on
        // the floor: the failure path doesn't reach saveCredentials, so
        // localStorage stays empty, and the next click on Generate yields
        // a different token. The user has now silently lost their
        // identity — anything they had under the discarded namespace is
        // unreachable. Persisting on click means the worst case is a
        // localStorage entry with no live JWT, which the user can recover
        // by retrying the form.
        const token = generateAndPersistUserToken()
        setUserToken(token)
        setShowGeneratedHint(true)
    }

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
                        User token is yours — generate one if it's your first login.
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
                    <span className="flex items-baseline justify-between text-sm text-neutral-300">
                        <span>User token</span>
                        <button
                            type="button"
                            onClick={generate}
                            className="text-xs text-neutral-400 underline-offset-2 hover:text-neutral-200 hover:underline"
                        >
                            Generate
                        </button>
                    </span>
                    <input
                        type="password"
                        autoComplete="off"
                        spellCheck={false}
                        aria-invalid={!!error}
                        className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm font-mono outline-none focus:border-neutral-500"
                        value={userToken}
                        onChange={(e) => {
                            setUserToken(e.target.value)
                            setShowGeneratedHint(false)
                        }}
                    />
                </label>
                {showGeneratedHint && (
                    <p className="text-xs text-amber-400">
                        Generated a new user token. <strong>Save it somewhere safe</strong> —
                        whoever has it can act as you on this hub. Use the same
                        value on every device for the same identity.
                    </p>
                )}
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
