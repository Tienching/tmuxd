#!/usr/bin/env node
/**
 * Web UI smoke test:
 *   1. Start server with production web/dist build.
 *   2. GET / → served HTML contains the React root + bundle tag.
 *   3. GET the bundle → contains login/sessions/attach route markers,
 *      plus xterm.js symbols and our API endpoints.
 *   4. Use headless Chrome (--dump-dom) to fetch /login and verify the
 *      login form renders at runtime.
 */
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as sleep } from 'node:timers/promises'

const execFileP = promisify(execFile)
const PORT = 17685
const TOKEN = 'web-smoke-token'

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

let failed = 0
let passed = 0
const log = (name, ok, extra = '') => {
    const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m'
    console.log(`  ${tag}  ${name}${extra ? ' — ' + extra : ''}`)
    ok ? passed++ : failed++
}

async function main() {
    const server = spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/index.ts'],
        {
            env: {
                ...process.env,
                TMUXD_SERVER_TOKEN: TOKEN,
                PORT: String(PORT),
                HOST: '127.0.0.1',
                TMUXD_HOME: '/tmp/tmuxd-web-smoke'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    )
    let serverLog = ''
    server.stdout.on('data', (d) => (serverLog += d))
    server.stderr.on('data', (d) => (serverLog += d))

    try {
        await waitUp(PORT)
        const base = `http://127.0.0.1:${PORT}`

        // 1. Root HTML
        const rootRes = await fetch(base + '/')
        const html = await rootRes.text()
        log('/ returns HTML', rootRes.status === 200 && /<html/i.test(html))
        log('HTML has <div id="root">', /<div\s+id=["']root["']/i.test(html))
        const scriptMatch = html.match(/<script[^>]+src="([^"]+\.js)"/i)
        log('HTML references a JS bundle', !!scriptMatch, scriptMatch?.[1])

        // 2. SPA fallback
        for (const p of ['/login', '/attach/anything', '/unknown/deep/path']) {
            const r = await fetch(base + p)
            const t = await r.text()
            log(`SPA fallback ${p} → HTML`, r.status === 200 && /<html/i.test(t))
        }

        // 3. Bundle content check
        if (scriptMatch) {
            const bundleRes = await fetch(base + scriptMatch[1])
            const code = await bundleRes.text()
            log('Bundle returns 200', bundleRes.status === 200)
            log('Bundle contains /api/auth path', code.includes('/api/auth'))
            log('Bundle contains /api/sessions path', code.includes('/api/sessions'))
            log('Bundle contains xterm usage', /xterm/i.test(code))
            log('Bundle contains login / sessions / attach labels',
                code.includes('Sign in') && code.includes('Attach') && code.includes('Kill'))
        }

        // 4. Runtime render with headless Chrome --dump-dom
        try {
            const { stdout } = await execFileP(
                'google-chrome',
                [
                    '--headless=new',
                    '--no-sandbox',
                    '--disable-gpu',
                    '--virtual-time-budget=5000',
                    '--dump-dom',
                    base + '/login'
                ],
                { timeout: 30000, maxBuffer: 10 * 1024 * 1024 }
            )
            const renders = /tmuxd/.test(stdout) && /Server token/i.test(stdout) && /User token/i.test(stdout) && /Sign in/i.test(stdout)
            log('Chrome renders /login (Sign in + token labels)', renders)
        } catch (err) {
            log('Chrome renders /login', false, err.message.slice(0, 120))
        }
    } finally {
        server.kill('SIGTERM')
        await new Promise((r) => server.on('exit', r))
    }

    console.log(`\n  PASS: ${passed}   FAIL: ${failed}`)
    if (failed > 0) {
        console.log('--- server log ---')
        console.log(serverLog)
        process.exit(1)
    }
}

main().catch((err) => {
    console.error('fatal:', err)
    process.exit(2)
})
