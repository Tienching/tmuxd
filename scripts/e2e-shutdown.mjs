#!/usr/bin/env node
/**
 * Graceful-shutdown test.
 *
 * Starts `tsx server/src/index.ts` as a child process, opens a WebSocket,
 * sends SIGTERM to the server, and verifies:
 *   1. the server exits within 3.5s (force-exit safety net: 3s)
 *   2. the client sees a 'close' event within the same window
 */
import { spawn } from 'node:child_process'
import WebSocket from 'ws'

const PORT = 17684
const PASSWORD = 'shutdown-test-pw'

async function waitUp(port, maxMs = 8000) {
    const deadline = Date.now() + maxMs
    while (Date.now() < deadline) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/health`)
            if (r.ok) return true
        } catch {
            /* booting */
        }
        await new Promise((r) => setTimeout(r, 150))
    }
    throw new Error('server boot timeout')
}

async function main() {
    const server = spawn(
        'node',
        ['node_modules/.bin/tsx', 'server/src/index.ts'],
        {
            env: {
                ...process.env,
                TMUXD_PASSWORD: PASSWORD,
                PORT: String(PORT),
                HOST: '127.0.0.1',
                TMUXD_HOME: '/tmp/tmuxd-shutdown-home'
            },
            stdio: ['ignore', 'pipe', 'pipe']
        }
    )
    let serverLog = ''
    server.stdout.on('data', (d) => (serverLog += d))
    server.stderr.on('data', (d) => (serverLog += d))

    let exited = null
    const exitPromise = new Promise((resolve) => {
        server.on('exit', (code, signal) => {
            exited = { code, signal, at: Date.now() }
            resolve(exited)
        })
    })

    await waitUp(PORT)
    console.log('server up')

    const login = await fetch(`http://127.0.0.1:${PORT}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: PASSWORD })
    }).then((r) => r.json())
    const token = login.token
    if (!token) throw new Error('no token')

    await fetch(`http://127.0.0.1:${PORT}/api/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ name: 'tmuxd-shut' })
    }).catch(() => {})

    const ws = new WebSocket(
        `ws://127.0.0.1:${PORT}/ws/tmuxd-shut?token=${encodeURIComponent(token)}&cols=80&rows=24`
    )
    await new Promise((res, rej) => {
        ws.on('open', res)
        ws.on('error', rej)
    })
    let closeCode = null
    const closePromise = new Promise((resolve) => {
        ws.on('close', (code) => {
            closeCode = code
            resolve(code)
        })
    })
    console.log('ws attached')

    const kick = Date.now()
    server.kill('SIGTERM')

    const result = await Promise.race([
        Promise.all([exitPromise, closePromise]).then(() => 'ok'),
        new Promise((r) => setTimeout(() => r('timeout'), 5000))
    ])

    const serverExitMs = exited ? exited.at - kick : null
    console.log(
        JSON.stringify(
            {
                result,
                serverExitMs,
                serverExit: exited,
                closeCode
            },
            null,
            2
        )
    )

    const { execFile } = await import('node:child_process')
    await new Promise((r) => execFile('tmux', ['kill-session', '-t', 'tmuxd-shut'], () => r()))

    if (result !== 'ok') {
        console.log('--- server log ---')
        console.log(serverLog)
        process.exit(1)
    }
    if (serverExitMs > 3500) {
        console.log('server took too long:', serverExitMs, 'ms')
        process.exit(1)
    }
    console.log(`PASS: graceful shutdown with live ws in ${serverExitMs}ms, close code=${closeCode}`)
}

main().catch((err) => {
    console.error('fatal:', err)
    process.exit(2)
})
