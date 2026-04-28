#!/usr/bin/env node
/**
 * Multi-tab attach test: two WebSocket clients attached to the same tmux
 * session should see each other's output (shared tmux attach).
 */
import WebSocket from 'ws'

const HOST = process.env.HOST || '127.0.0.1'
const PORT = Number(process.env.PORT || 17686)
const PW = process.env.TMUXD_PASSWORD || 'e2e-all-password'

const tok = await fetch(`http://${HOST}:${PORT}/api/auth`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password: PW })
})
    .then((r) => r.json())
    .then((j) => j.token)
if (!tok) {
    console.error('no token')
    process.exit(2)
}

const SESSION = 'tmuxd-e2e-multi'
await fetch(`http://${HOST}:${PORT}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
    body: JSON.stringify({ name: SESSION })
}).catch(() => {})

function mkWs(label) {
    return new Promise((res, rej) => {
        const ws = new WebSocket(
            `ws://${HOST}:${PORT}/ws/${SESSION}?token=${encodeURIComponent(tok)}&cols=100&rows=30`
        )
        const frames = []
        ws.on('open', () => res({ ws, frames, label }))
        ws.on('error', rej)
        ws.on('message', (d) => {
            try {
                frames.push(JSON.parse(d.toString()))
            } catch {
                /* ignore */
            }
        })
    })
}

const a = await mkWs('A')
const b = await mkWs('B')
await new Promise((r) => setTimeout(r, 400))

const marker = 'MULTI-TAB-MARKER-' + Math.random().toString(36).slice(2, 8)
const cmd = `printf "${marker}\\n"\n`
a.ws.send(JSON.stringify({ type: 'input', payload: Buffer.from(cmd).toString('base64') }))

// Wait up to 3s for both to see the marker.
const deadline = Date.now() + 3000
let sawA = false
let sawB = false
while (Date.now() < deadline && !(sawA && sawB)) {
    const check = (frames) =>
        frames.some(
            (f) =>
                f.type === 'data' && Buffer.from(f.payload, 'base64').toString('utf8').includes(marker)
        )
    sawA = sawA || check(a.frames)
    sawB = sawB || check(b.frames)
    if (sawA && sawB) break
    await new Promise((r) => setTimeout(r, 75))
}

a.ws.close()
b.ws.close()
await fetch(`http://${HOST}:${PORT}/api/sessions/${SESSION}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${tok}` }
}).catch(() => {})

console.log(`multi-tab: A sees marker=${sawA}  B sees marker=${sawB}`)
if (!sawA || !sawB) {
    console.error('FAIL: shared attach did not deliver marker to both clients')
    process.exit(1)
}
console.log('PASS: both clients received the shared tmux output')
