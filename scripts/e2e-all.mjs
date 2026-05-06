#!/usr/bin/env node
/**
 * Full E2E runner. Boots a server, runs the API suite, then the
 * shutdown + web smoke + multi-tab suites. Aggregates results.
 *
 * Used by: npm run e2e
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const PORT = 17686
const PASSWORD = 'e2e-all-password'
const AGENT_TOKEN = 'e2e-agent-token'

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
    // Boot a server for the API suite.
    const server = spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/index.ts'],
        {
            env: {
                ...process.env,
                TMUXD_PASSWORD: PASSWORD,
                PORT: String(PORT),
                HOST: '127.0.0.1',
                TMUXD_HOME: '/tmp/tmuxd-e2e-all',
                TMUXD_AGENT_TOKEN: AGENT_TOKEN
            },
            stdio: ['ignore', 'inherit', 'inherit']
        }
    )

    const fails = []
    try {
        await waitUp(PORT)

        console.log('\n=== API suite ===')
        try {
            await run('scripts/e2e.mjs', { PORT: String(PORT), TMUXD_PASSWORD: PASSWORD, HOST: '127.0.0.1', TMUXD_AGENT_TOKEN: AGENT_TOKEN })
        } catch (e) {
            fails.push('api')
        }

        console.log('\n=== Multi-tab attach ===')
        try {
            // This script has its port baked in for port 17683; we need to pass env.
            // Easier: reuse the API-test port by calling e2e-multi via env.
            await run('scripts/e2e-multi.mjs', {})
        } catch (e) {
            fails.push('multi-tab')
        }
    } finally {
        server.kill('SIGTERM')
        await new Promise((r) => server.on('exit', r))
    }

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
