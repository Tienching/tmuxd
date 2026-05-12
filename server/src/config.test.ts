import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from './config.js'

/**
 * loadConfig() reads from process.env directly. We snapshot/restore the
 * env around each test to avoid leaking state between cases.
 */
function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
    const snapshot: Record<string, string | undefined> = {}
    for (const k of Object.keys(overrides)) snapshot[k] = process.env[k]
    try {
        for (const [k, v] of Object.entries(overrides)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
        return fn()
    } finally {
        for (const [k, v] of Object.entries(snapshot)) {
            if (v === undefined) delete process.env[k]
            else process.env[k] = v
        }
    }
}

describe('loadConfig', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'tmuxd-config-test-'))

    it('requires TMUXD_SERVER_TOKEN', () => {
        assert.throws(
            () =>
                withEnv(
                    { TMUXD_SERVER_TOKEN: undefined, TMUXD_HOME: dataDir, JWT_SECRET: 'a'.repeat(32) },
                    () => loadConfig()
                ),
            /Missing required auth: set TMUXD_SERVER_TOKEN/
        )
    })

    it('parses TMUXD_SERVER_TOKEN and defaults host/port', () => {
        const config = withEnv(
            {
                TMUXD_SERVER_TOKEN: 'team-secret',
                TMUXD_HOME: dataDir,
                JWT_SECRET: 'a'.repeat(32),
                HOST: undefined,
                PORT: undefined
            },
            () => loadConfig()
        )
        assert.equal(config.serverToken, 'team-secret')
        assert.equal(config.host, '127.0.0.1')
        assert.equal(config.port, 7681)
        assert.equal(config.hubOnly, false)
    })

    it('TMUXD_HUB_ONLY=1 → hubOnly true', () => {
        const config = withEnv(
            {
                TMUXD_SERVER_TOKEN: 'team-secret',
                TMUXD_HUB_ONLY: '1',
                TMUXD_HOME: dataDir,
                JWT_SECRET: 'a'.repeat(32)
            },
            () => loadConfig()
        )
        assert.equal(config.hubOnly, true)
    })

    it('rejects invalid PORT', () => {
        assert.throws(
            () =>
                withEnv(
                    {
                        TMUXD_SERVER_TOKEN: 'tok',
                        PORT: 'not-a-number',
                        TMUXD_HOME: dataDir,
                        JWT_SECRET: 'a'.repeat(32)
                    },
                    () => loadConfig()
                ),
            /Invalid PORT/
        )
    })

    it('JWT_SECRET shorter than 32 bytes is rejected', () => {
        assert.throws(
            () =>
                withEnv(
                    {
                        TMUXD_SERVER_TOKEN: 'tok',
                        JWT_SECRET: 'too-short',
                        TMUXD_HOME: dataDir
                    },
                    () => loadConfig()
                ),
            /at least 32 bytes/
        )
    })
})
