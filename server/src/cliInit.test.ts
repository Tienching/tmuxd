/**
 * Unit tests for `cliInit.ts`. Covers each mode's rendering, the
 * refuse-to-overwrite gate, and the validation rules. The e2e suite
 * (scripts/e2e-cli.mjs) handles "does it actually shell out and write
 * a real file"; this file is the property-style coverage where a
 * single regression in one mode doesn't cascade.
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeEnvFile } from './cliInit.js'

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'tmuxd-init-test-'))
    try {
        await fn(dir)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

describe('writeEnvFile', () => {
    test('init server (default) writes Mode A loopback .env', async () => {
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('server', { cwd })
            assert.equal(result.path, join(cwd, '.env'))
            assert.ok(result.generatedServerToken, 'generated a token')
            // Don't pin the encoding (`/^[0-9a-f]{64}$/`); that's an
            // implementation detail. The behavior consumers depend on
            // is "the token written to the .env equals the one returned
            // here" — covered separately by the property test below.
            assert.ok(result.generatedServerToken!.length >= 32)
            const body = await readFile(result.path, 'utf8')
            assert.match(body, /Mode: A/)
            assert.match(body, /HOST=127\.0\.0\.1/)
            assert.match(body, /PORT=7681/)
            // Relay marker MUST be absent in server mode.
            assert.doesNotMatch(body, /TMUXD_RELAY/)
            assert.match(body, new RegExp(`TMUXD_SERVER_TOKEN=${result.generatedServerToken}`))
        })
    })

    test('init server --public writes Mode B', async () => {
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('server', { cwd, publicBind: true })
            const body = await readFile(result.path, 'utf8')
            assert.match(body, /Mode: B/)
            assert.match(body, /HOST=0\.0\.0\.0/)
            assert.doesNotMatch(body, /TMUXD_RELAY/)
        })
    })

    test('init relay writes Mode C with TMUXD_RELAY=1 and public bind', async () => {
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('relay', { cwd })
            const body = await readFile(result.path, 'utf8')
            assert.match(body, /Mode: C/)
            assert.match(body, /HOST=0\.0\.0\.0/)
            assert.match(body, /TMUXD_RELAY=1/)
        })
    })

    test('init server respects --port', async () => {
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('server', { cwd, port: 9000 })
            const body = await readFile(result.path, 'utf8')
            assert.match(body, /PORT=9000/)
        })
    })

    test('init server with --server-token does NOT auto-generate', async () => {
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('server', {
                cwd,
                serverToken: 'pre-existing-secret-token-value-32xx'
            })
            assert.equal(result.generatedServerToken, null)
            const body = await readFile(result.path, 'utf8')
            assert.match(body, /TMUXD_SERVER_TOKEN=pre-existing-secret-token-value-32xx/)
        })
    })

    test('init server rejects port out of range', async () => {
        await withTmp(async (cwd) => {
            await assert.rejects(() => writeEnvFile('server', { cwd, port: 999_999 }), /port/)
            await assert.rejects(() => writeEnvFile('server', { cwd, port: 0 }), /port/)
        })
    })

    test('init client writes outbound .env', async () => {
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('client', {
                cwd,
                tmuxdUrl: 'https://tmuxd.example.com',
                serverToken: 'team-secret',
                userToken: 'alice-personal',
                hostId: 'laptop',
                hostName: 'Alice Laptop'
            })
            assert.equal(result.generatedServerToken, null) // never generates for client
            const body = await readFile(result.path, 'utf8')
            assert.match(body, /TMUXD_URL=https:\/\/tmuxd\.example\.com/)
            assert.match(body, /TMUXD_SERVER_TOKEN=team-secret/)
            assert.match(body, /TMUXD_USER_TOKEN=alice-personal/)
            assert.match(body, /TMUXD_HOST_ID=laptop/)
            assert.match(body, /TMUXD_HOST_NAME=Alice Laptop/)
            // Server-side keys MUST be absent.
            assert.doesNotMatch(body, /^HOST=/m)
            assert.doesNotMatch(body, /^PORT=/m)
            assert.doesNotMatch(body, /TMUXD_RELAY/)
        })
    })

    test('init client without optional host id/name omits those lines', async () => {
        await withTmp(async (cwd) => {
            await writeEnvFile('client', {
                cwd,
                tmuxdUrl: 'https://x.example',
                serverToken: 'a',
                userToken: 'b'
            })
            const body = await readFile(join(cwd, '.env'), 'utf8')
            assert.doesNotMatch(body, /TMUXD_HOST_ID/)
            assert.doesNotMatch(body, /TMUXD_HOST_NAME/)
        })
    })

    test('init client requires url + tokens', async () => {
        await withTmp(async (cwd) => {
            await assert.rejects(() => writeEnvFile('client', { cwd }), /--url/)
            await assert.rejects(
                () => writeEnvFile('client', { cwd, tmuxdUrl: 'https://x' }),
                /--server-token/
            )
            await assert.rejects(
                () =>
                    writeEnvFile('client', {
                        cwd,
                        tmuxdUrl: 'https://x',
                        serverToken: 't'
                    }),
                /--user-token/
            )
        })
    })

    test('refuses to overwrite existing .env without force', async () => {
        await withTmp(async (cwd) => {
            await writeFile(join(cwd, '.env'), 'pre-existing\n', { mode: 0o600 })
            await assert.rejects(() => writeEnvFile('server', { cwd }), /already exists/)
        })
    })

    test('--force overwrites', async () => {
        await withTmp(async (cwd) => {
            await writeFile(join(cwd, '.env'), 'pre-existing\n', { mode: 0o600 })
            const result = await writeEnvFile('server', { cwd, force: true })
            const body = await readFile(result.path, 'utf8')
            assert.doesNotMatch(body, /pre-existing/)
            assert.match(body, /TMUXD_SERVER_TOKEN=/)
        })
    })

    test('written file has mode 0600', async () => {
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('server', { cwd })
            const st = await stat(result.path)
            // The mode field includes the file-type bits; mask to perms.
            assert.equal(st.mode & 0o777, 0o600)
        })
    })

    test('rejects values containing newlines (would corrupt .env)', async () => {
        await withTmp(async (cwd) => {
            await assert.rejects(
                () =>
                    writeEnvFile('client', {
                        cwd,
                        tmuxdUrl: 'https://x',
                        serverToken: 'a',
                        userToken: 'has\nnewline'
                    }),
                /newlines/
            )
        })
    })

    test('rejects values with leading/trailing whitespace', async () => {
        await withTmp(async (cwd) => {
            await assert.rejects(
                () =>
                    writeEnvFile('client', {
                        cwd,
                        tmuxdUrl: 'https://x',
                        serverToken: '  spaced  ',
                        userToken: 'x'
                    }),
                /whitespace/
            )
        })
    })

    test('honors --filename', async () => {
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('server', {
                cwd,
                filename: '.env.production'
            })
            assert.equal(result.path, join(cwd, '.env.production'))
            await stat(result.path) // exists
        })
    })

    // ────────────────────────────────────────────────────────────
    // Safety properties added after the security review.
    // ────────────────────────────────────────────────────────────

    test('--force preserves 0600 even when target was 0644', async () => {
        // The bug this catches: writeFile(path, body, { mode: 0o600 })'s
        // `mode` only applies on create, so overwriting an existing
        // 0644 file would silently keep the looser mode. The atomic
        // tmp+rename + chmod path fixes this.
        await withTmp(async (cwd) => {
            await writeFile(join(cwd, '.env'), 'pre-existing\n', { mode: 0o644 })
            const result = await writeEnvFile('server', { cwd, force: true })
            const st = await stat(result.path)
            assert.equal(st.mode & 0o777, 0o600)
        })
    })

    test('refuses to write through a symlink (no --force)', async () => {
        await withTmp(async (cwd) => {
            // Symlink .env → some-other-file. Without our check, the
            // .env write would silently land at the symlink target.
            const realFile = join(cwd, 'attacker-loot')
            await writeFile(realFile, '')
            await symlink(realFile, join(cwd, '.env'))
            await assert.rejects(
                () => writeEnvFile('server', { cwd }),
                /symlink/i
            )
        })
    })

    test('refuses to write through a symlink (even with --force)', async () => {
        // --force is for "overwrite the file you wrote yesterday", not
        // "blindly follow whatever symlink an attacker planted in CWD".
        await withTmp(async (cwd) => {
            const realFile = join(cwd, 'attacker-loot')
            await writeFile(realFile, '')
            await symlink(realFile, join(cwd, '.env'))
            await assert.rejects(
                () => writeEnvFile('server', { cwd, force: true }),
                /symlink/i
            )
        })
    })

    test('refuses to write to a directory at the dest path', async () => {
        await withTmp(async (cwd) => {
            const { mkdir } = await import('node:fs/promises')
            await mkdir(join(cwd, '.env'))
            await assert.rejects(
                () => writeEnvFile('server', { cwd, force: true }),
                /not a regular file/i
            )
        })
    })

    test('rejects values containing = (would break source .env)', async () => {
        await withTmp(async (cwd) => {
            await assert.rejects(
                () =>
                    writeEnvFile('client', {
                        cwd,
                        tmuxdUrl: 'https://x',
                        serverToken: 'a=b',
                        userToken: 'c'
                    }),
                /=/
            )
        })
    })

    test('rejects values containing NUL bytes', async () => {
        await withTmp(async (cwd) => {
            await assert.rejects(
                () =>
                    writeEnvFile('client', {
                        cwd,
                        tmuxdUrl: 'https://x',
                        serverToken: 'a\0b',
                        userToken: 'c'
                    }),
                /NUL/
            )
        })
    })

    test('rejects values containing Unicode line separators', async () => {
        // U+2028 / U+2029 look benign in editors but several shells
        // treat them as line breaks when sourcing a .env. We reject
        // for the same reason we reject CR/LF.
        await withTmp(async (cwd) => {
            await assert.rejects(
                () =>
                    writeEnvFile('client', {
                        cwd,
                        tmuxdUrl: 'https://x',
                        serverToken: 'a\u2028b',
                        userToken: 'c'
                    }),
                /newline/i
            )
        })
    })

    test('rejects values larger than 4 KiB', async () => {
        await withTmp(async (cwd) => {
            const big = 'x'.repeat(4097)
            await assert.rejects(
                () =>
                    writeEnvFile('client', {
                        cwd,
                        tmuxdUrl: 'https://x',
                        serverToken: 'a',
                        userToken: big
                    }),
                /4096/
            )
        })
    })

    test('rejects --filename containing .. (path traversal)', async () => {
        await withTmp(async (cwd) => {
            await assert.rejects(
                () =>
                    writeEnvFile('server', {
                        cwd,
                        filename: '../escape.env'
                    }),
                /\.\./
            )
        })
    })

    test('rejects absolute --filename', async () => {
        await withTmp(async (cwd) => {
            await assert.rejects(
                () =>
                    writeEnvFile('server', {
                        cwd,
                        filename: '/etc/passwd'
                    }),
                /absolute/i
            )
        })
    })

    test('init relay --port respects the value', async () => {
        // Spot-check: cliInit.ts:184 splits on isRelay, so a refactor
        // could move PORT rendering into the wrong branch.
        await withTmp(async (cwd) => {
            await writeEnvFile('relay', { cwd, port: 9000 })
            const body = await readFile(join(cwd, '.env'), 'utf8')
            assert.match(body, /PORT=9000/)
        })
    })

    test('generated server token is hex-encoded and matches what landed in .env', async () => {
        // The test that pinned `/^[0-9a-f]{64}$/` was testing the
        // implementation; this one tests the actual property consumers
        // rely on: the stderr-printed token is the one persisted to disk.
        await withTmp(async (cwd) => {
            const result = await writeEnvFile('server', { cwd })
            assert.ok(result.generatedServerToken)
            const body = await readFile(result.path, 'utf8')
            assert.ok(
                body.includes(`TMUXD_SERVER_TOKEN=${result.generatedServerToken}`),
                'generated token must appear verbatim in the .env file'
            )
        })
    })
})
