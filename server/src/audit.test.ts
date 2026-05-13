import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The audit module reads `TMUXD_AUDIT_DISABLE` at import time, so to
 * exercise both modes we use dynamic imports with module cache reset.
 */

async function importAudit(disable: boolean): Promise<typeof import('./audit.js')> {
    if (disable) {
        process.env.TMUXD_AUDIT_DISABLE = '1'
    } else {
        delete process.env.TMUXD_AUDIT_DISABLE
    }
    // Bust the module cache so the top-level `enabled` re-reads the env.
    return await import(`./audit.js?cacheBust=${Math.random()}`)
}

describe('audit', () => {
    it('writes a single JSON-shaped line to stderr per call', async () => {
        const audit = await importAudit(false)
        const lines: string[] = []
        const origWrite = process.stderr.write.bind(process.stderr)
        ;(process.stderr as any).write = (chunk: any) => {
            lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
            return true
        }
        try {
            audit.logAudit({ event: 'client_register', namespace: 'alice', hostId: 'laptop', name: 'Alice Laptop' })
        } finally {
            ;(process.stderr as any).write = origWrite
        }
        assert.equal(lines.length, 1)
        const line = lines[0]
        assert.ok(line.startsWith('[tmuxd:audit] '), 'audit line should be prefixed')
        const json = line.slice('[tmuxd:audit] '.length).trim()
        const parsed = JSON.parse(json) as Record<string, unknown>
        assert.equal(parsed.event, 'client_register')
        assert.equal(parsed.namespace, 'alice')
        assert.equal(parsed.hostId, 'laptop')
        assert.equal(parsed.name, 'Alice Laptop')
        assert.ok(typeof parsed.ts === 'string')
    })

    it('emits nothing when TMUXD_AUDIT_DISABLE=1', async () => {
        const audit = await importAudit(true)
        const lines: string[] = []
        const origWrite = process.stderr.write.bind(process.stderr)
        ;(process.stderr as any).write = (chunk: any) => {
            lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
            return true
        }
        try {
            audit.logAudit({ event: 'ws_attach', namespace: 'bob', hostId: 'desktop', sessionName: 'main' })
        } finally {
            ;(process.stderr as any).write = origWrite
            delete process.env.TMUXD_AUDIT_DISABLE
        }
        assert.equal(lines.length, 0)
    })

    it('never crashes the process if JSON.stringify throws', async () => {
        const audit = await importAudit(false)
        const cyclic: any = {}
        cyclic.self = cyclic
        // Don't capture writes — just confirm no throw.
        const origWrite = process.stderr.write.bind(process.stderr)
        ;(process.stderr as any).write = () => true
        try {
            assert.doesNotThrow(() =>
                audit.logAudit({
                    event: 'ws_attach',
                    namespace: 'alice',
                    hostId: 'laptop',
                    // Force JSON failure by smuggling a cyclic ref through cast.
                    ...(cyclic as any)
                })
            )
        } finally {
            ;(process.stderr as any).write = origWrite
        }
    })

    it('serializes login_success / login_failure / client_disconnect with their fields', async () => {
        const audit = await importAudit(false)
        const lines: string[] = []
        const origWrite = process.stderr.write.bind(process.stderr)
        ;(process.stderr as any).write = (chunk: any) => {
            lines.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
            return true
        }
        try {
            audit.logAudit({
                event: 'login_success',
                namespace: 'alice',
                remoteAddr: '10.0.0.1'
            })
            audit.logAudit({
                event: 'login_failure',
                namespace: 'bob',
                remoteAddr: '10.0.0.2',
                reason: 'token_mismatch'
            })
            audit.logAudit({
                event: 'client_disconnect',
                namespace: 'alice',
                hostId: 'laptop',
                reason: 'client_error'
            })
        } finally {
            ;(process.stderr as any).write = origWrite
        }
        assert.equal(lines.length, 3)
        const parsed = lines.map((line) => JSON.parse(line.slice('[tmuxd:audit] '.length).trim()))
        assert.equal(parsed[0].event, 'login_success')
        assert.equal(parsed[0].namespace, 'alice')
        assert.equal(parsed[0].remoteAddr, '10.0.0.1')
        assert.equal(parsed[1].event, 'login_failure')
        assert.equal(parsed[1].reason, 'token_mismatch')
        // login_failure with empty namespace is allowed (unparseable token).
        assert.equal(parsed[2].event, 'client_disconnect')
        assert.equal(parsed[2].reason, 'client_error')
        assert.equal(parsed[2].hostId, 'laptop')
    })
})
