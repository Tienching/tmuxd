import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { warnInsecureHubScheme } from './cli.ts'

/**
 * Capture process.stderr.write for the duration of fn(), then restore.
 * Returns whatever bytes were written. We can't easily mock fetch from
 * here without importing the whole CLI machinery, so this test focuses
 * on the surgical decision: which tmuxdUrl shapes get warned about.
 */
async function captureStderr(fn: () => void | Promise<void>): Promise<string> {
    const chunks: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    ;(process.stderr.write as unknown) = ((data: string | Uint8Array) => {
        chunks.push(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'))
        return true
    }) as typeof process.stderr.write
    try {
        await fn()
    } finally {
        process.stderr.write = original as typeof process.stderr.write
    }
    return chunks.join('')
}

describe('warnInsecureHubScheme', () => {
    it('silent on https://', async () => {
        const out = await captureStderr(() => warnInsecureHubScheme('https://hub.example.com'))
        assert.equal(out, '')
    })

    it('silent on http://localhost', async () => {
        const out = await captureStderr(() => warnInsecureHubScheme('http://localhost:7681'))
        assert.equal(out, '')
    })

    it('silent on http://127.0.0.1', async () => {
        const out = await captureStderr(() => warnInsecureHubScheme('http://127.0.0.1:7681'))
        assert.equal(out, '')
    })

    it('silent on http://[::1]', async () => {
        const out = await captureStderr(() => warnInsecureHubScheme('http://[::1]:7681'))
        assert.equal(out, '')
    })

    it('warns on http:// to a real hostname', async () => {
        const out = await captureStderr(() => warnInsecureHubScheme('http://hub.example.com'))
        assert.match(out, /warning.*plain http/i)
        assert.match(out, /hub\.example\.com/)
        assert.match(out, /sniffable/i)
        assert.match(out, /TMUXD_INSECURE_HTTP=1/)
    })

    it('warns on http:// to a private RFC1918 IP (private != safe)', async () => {
        // The threat model: shared VPC, container bridge, coffee-shop wifi.
        // "Private" is not "secret".
        const out = await captureStderr(() => warnInsecureHubScheme('http://10.0.0.5:7681'))
        assert.match(out, /warning.*plain http/i)
        assert.match(out, /10\.0\.0\.5/)
    })

    it('silent when TMUXD_INSECURE_HTTP=1 is set', async () => {
        const before = process.env.TMUXD_INSECURE_HTTP
        process.env.TMUXD_INSECURE_HTTP = '1'
        try {
            const out = await captureStderr(() => warnInsecureHubScheme('http://hub.example.com'))
            assert.equal(out, '')
        } finally {
            if (before === undefined) delete process.env.TMUXD_INSECURE_HTTP
            else process.env.TMUXD_INSECURE_HTTP = before
        }
    })

    it('does not throw on malformed URL (lets fetch surface the real error)', async () => {
        // Tolerated quietly — cmdLogin's fetch() will fail next with a
        // concrete network_error message.
        const out = await captureStderr(() => warnInsecureHubScheme('not a url'))
        assert.equal(out, '')
    })
})
