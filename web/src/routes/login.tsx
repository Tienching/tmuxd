import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { api } from '../api/client'
import { setToken } from '../auth/tokenStore'

export function LoginPage() {
    const navigate = useNavigate()
    const [token, setTokenInput] = useState('')
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState<string | null>(null)

    async function submit(e: React.FormEvent) {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            const res = await api.login(token)
            setToken(res.token, res.expiresAt)
            await navigate({ to: '/' })
        } catch (err) {
            const msg = err instanceof Error ? err.message : 'login failed'
            setError(
                msg === 'invalid_token'
                    ? 'Wrong token.'
                    : msg === 'rate_limited'
                    ? 'Too many failed attempts. Wait a minute.'
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
                        Enter your access token. Add <code>:&lt;namespace&gt;</code> for multi-user
                        deployments (e.g. <code>secret:alice</code>).
                    </p>
                </div>
                <label className="block space-y-1">
                    <span className="text-sm text-neutral-300">Access token</span>
                    <input
                        type="password"
                        autoFocus
                        autoComplete="current-password"
                        spellCheck={false}
                        aria-invalid={!!error}
                        className="w-full rounded-md border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm outline-none focus:border-neutral-500"
                        value={token}
                        onChange={(e) => setTokenInput(e.target.value)}
                    />
                </label>
                {error && (
                    <p className="text-sm text-red-400" role="alert">
                        {error}
                    </p>
                )}
                <button
                    type="submit"
                    disabled={busy || !token}
                    className="w-full rounded-md bg-neutral-100 px-3 py-2 text-sm font-medium text-neutral-900 transition enabled:hover:bg-white disabled:opacity-50"
                >
                    {busy ? 'Signing in…' : 'Sign in'}
                </button>
            </form>
        </div>
    )
}
