#!/usr/bin/env node
/**
 * Full E2E runner. Boots a server, runs the API suite, then the
 * shutdown + web smoke + multi-tab suites. Aggregates results.
 *
 * Used by: npm run e2e
 */
import { spawn } from 'node:child_process'
import { mkdir, rm } from 'node:fs/promises'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 17686
const TOKEN = 'e2e-all-token'

// Isolate every tmux server we (or anything we spawn that doesn't set its
// own TMUX_TMPDIR) start under a per-run scratch directory. Without this
// our API-suite server lands in /tmp/tmux-<uid>/, sharing the user's
// default socket dir — a single tmux 3.x server crash can then take out
// the user's interactive sessions. Independent of the per-script
// isolation that e2e-cli.mjs / e2e-shutdown.mjs / etc. already do for
// their own children; this catches the API server e2e-all spawns
// directly, plus serves as a fallback umbrella for any sub-script that
// inherits from us.
const TMUX_TMPDIR = `/tmp/tmuxd-e2e-all-tmux-${process.pid}`

async function waitUp(port, maxMs = 10000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`)
            if (r.ok) return true
        } catch {}
        await sleep(150)
    }
    throw new Error('server boot timeout')
}

function run(script, env = {}) {
    return new Promise((resolve, reject) => {
        const p = spawn('node', [script], { env: { ...process.env, ...env }, stdio: 'inherit' })
        p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${script} exited ${code}`))))
    })
}

async function main() {
    await rm(TMUX_TMPDIR, { recursive: true, force: true }).catch(() => {})
    await mkdir(TMUX_TMPDIR, { recursive: true })
    // Boot a server for the API suite.
    const server = spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/index.ts'],
        {
            env: {
                ...process.env,
                TMUXD_SERVER_TOKEN: TOKEN,
                PORT: String(PORT),
                HOST: '127.0.0.1',
                TMUXD_HOME: '/tmp/tmuxd-e2e-all',
                TMUX_TMPDIR
            },
            stdio: ['ignore', 'inherit', 'inherit']
        }
    )

    const fails = []
    try {
        await waitUp(PORT)

        console.log('\n=== API suite ===')
        try {
            await run('scripts/e2e.mjs', {
                PORT: String(PORT),
                TMUXD_SERVER_TOKEN: TOKEN,
                HOST: '127.0.0.1',
                TMUXD_E2E_CLIENT_HOST_BOUND: '1',
                // CRITICAL: e2e.mjs runs `tmux has-session`, `tmux capture-pane`,
                // `tmux display-message` directly to verify the server's effects.
                // Those calls MUST hit the same socket the server is on, otherwise
                // they look at an empty tmux world and assertions fail. Pass our
                // umbrella TMUX_TMPDIR through explicitly. Same applies to
                // the agent process e2e.mjs spawns via startAgentProcess().
                TMUX_TMPDIR
            })
        } catch (e) {
            fails.push('api')
        }

        console.log('\n=== Multi-tab attach ===')
        try {
            // This script has its port baked in for port 17683; we need to pass env.
            // Easier: reuse the API-test port by calling e2e-multi via env.
            // No tmux ops in e2e-multi.mjs itself, but pass TMUX_TMPDIR for
            // any sub-process that might exist.
            await run('scripts/e2e-multi.mjs', { TMUX_TMPDIR })
        } catch (e) {
            fails.push('multi-tab')
        }
    } finally {
        server.kill('SIGTERM')
        await new Promise((r) => server.on('exit', r))
    }

    // Past this point the sub-scripts spawn their own servers/clients;
    // each isolates its own TMUX_TMPDIR. Drop ours so the e2e-all
    // umbrella doesn't leave a stale empty dir behind.
    await rm(TMUX_TMPDIR, { recursive: true, force: true }).catch(() => {})

    console.log('\n=== Shutdown (own server) ===')
    try {
        await run('scripts/e2e-shutdown.mjs')
    } catch {
        fails.push('shutdown')
    }

    console.log('\n=== Web UI smoke (own server) ===')
    try {
        await run('scripts/e2e-web.mjs')
    } catch {
        fails.push('web')
    }

    // Relay-mode suites — each script spawns its own server on a unique
    // port and tears it down on exit. They don't share fixture state
    // with the API suite above.
    console.log('\n=== Relay mode: HTTP isolation (own server) ===')
    try {
        await run('scripts/e2e-relay.mjs')
    } catch {
        fails.push('relay')
    }

    console.log('\n=== Relay mode: real two-client isolation (own server) ===')
    try {
        await run('scripts/e2e-relay-clients.mjs')
    } catch {
        fails.push('relay-clients')
    }

    console.log('\n=== Relay mode: same-hostId + reconnect lifecycle (own server) ===')
    try {
        await run('scripts/e2e-relay-lifecycle.mjs')
    } catch {
        fails.push('relay-lifecycle')
    }

    console.log('\n=== CLI smoke (own server + real client) ===')
    try {
        await run('scripts/e2e-cli.mjs')
    } catch {
        fails.push('cli')
    }

    console.log('\n========')
    if (fails.length === 0) {
        console.log('ALL E2E SUITES PASS ✓')
    } else {
        console.log('FAILED SUITES:', fails.join(', '))
        process.exit(1)
    }
}

main().catch((err) => {
    console.error(err)
    process.exit(2)
})
