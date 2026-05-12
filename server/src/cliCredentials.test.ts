import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let testHome: string
let originalHome: string | undefined

before(async () => {
    originalHome = process.env.HOME
})

after(() => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
})

beforeEach(async () => {
    testHome = await mkdtemp(join(tmpdir(), 'tmuxd-cli-creds-test-'))
    process.env.HOME = testHome
})

afterEach(async () => {
    await rm(testHome, { recursive: true, force: true }).catch(() => {})
})

/**
 * Re-import on each test so the module's bound `homedir()` picks up the
 * fresh `HOME`. Without this, all tests would share the first-imported
 * homedir() result. We import via a query-string cache buster.
 */
async function freshModule() {
    return await import(`./cliCredentials.ts?t=${Date.now()}-${Math.random()}`)
}

describe('cliCredentials', () => {
    it('save → load round trip', async () => {
        const m = await freshModule()
        const cred = {
            hubUrl: 'http://hub.example:7681',
            jwt: 'eyJtest',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            namespace: 'alice'
        }
        await m.saveCredentials(cred)
        const loaded = await m.loadCredentials()
        assert.deepEqual(loaded, cred)
    })

    it('returns null when credentials file does not exist', async () => {
        const m = await freshModule()
        assert.equal(await m.loadCredentials(), null)
        assert.equal(await m.loadCredentials('http://nope'), null)
    })

    it('writes file with mode 0600 and parent dir mode 0700', async () => {
        const m = await freshModule()
        await m.saveCredentials({
            hubUrl: 'http://hub.example:7681',
            jwt: 'eyJtest',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            namespace: 'alice'
        })
        const path = m.credentialsPath()
        const fileSt = await stat(path)
        assert.equal(fileSt.mode & 0o777, 0o600)
        const dirSt = await stat(join(testHome, '.tmuxd', 'cli'))
        assert.equal(dirSt.mode & 0o777, 0o700)
    })

    it('refuses to load a 0644 file with a clear error', async () => {
        const m = await freshModule()
        // Save once at 0600 so the file exists and is well-formed JSON.
        await m.saveCredentials({
            hubUrl: 'http://hub.example:7681',
            jwt: 'eyJtest',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            namespace: 'alice'
        })
        // Loosen the mode to simulate `chmod 644 ~/.tmuxd/cli/credentials.json`.
        const path = m.credentialsPath()
        await chmod(path, 0o644)
        await assert.rejects(
            () => m.loadCredentials(),
            (err: unknown) => {
                if (!(err instanceof Error)) return false
                if (!err.message.includes('mode is 644')) return false
                if (!err.message.includes('chmod 600')) return false
                return true
            }
        )
    })

    it('refuses to load a 0640 file (group bit set)', async () => {
        const m = await freshModule()
        await m.saveCredentials({
            hubUrl: 'http://hub.example:7681',
            jwt: 'eyJtest',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            namespace: 'alice'
        })
        await chmod(m.credentialsPath(), 0o640)
        await assert.rejects(() => m.loadCredentials(), /mode is 640/)
    })

    it('refuses a symlinked credentials path', async () => {
        const m = await freshModule()
        // Plant a real file elsewhere with mode 0600 so a naive
        // stat-and-read implementation would happily slurp it.
        const decoy = join(testHome, 'decoy-creds.json')
        await writeFile(decoy, JSON.stringify({ version: 1, default: null, servers: {} }), { mode: 0o600 })
        // Set up the symlink at the canonical credentials path.
        const credPath = m.credentialsPath()
        // Ensure parent dir exists at 0700 first.
        const { mkdir } = await import('node:fs/promises')
        await mkdir(join(testHome, '.tmuxd', 'cli'), { recursive: true, mode: 0o700 })
        await symlink(decoy, credPath)
        await assert.rejects(() => m.loadCredentials(), /not a regular file|symlink|refusing/i)
    })

    it('rejects malformed JSON with a useful error', async () => {
        const m = await freshModule()
        const { mkdir, writeFile } = await import('node:fs/promises')
        await mkdir(join(testHome, '.tmuxd', 'cli'), { recursive: true, mode: 0o700 })
        await writeFile(m.credentialsPath(), '{ this is not json }', { mode: 0o600 })
        await assert.rejects(() => m.loadCredentials(), /not valid JSON/i)
    })

    it('rejects a version mismatch with a deletion hint', async () => {
        const m = await freshModule()
        const { mkdir, writeFile } = await import('node:fs/promises')
        await mkdir(join(testHome, '.tmuxd', 'cli'), { recursive: true, mode: 0o700 })
        await writeFile(
            m.credentialsPath(),
            JSON.stringify({ version: 999, default: null, servers: {} }),
            { mode: 0o600 }
        )
        await assert.rejects(() => m.loadCredentials(), /version mismatch.*Delete/is)
    })

    it('multi-hub: load(hubUrl) selects the requested hub', async () => {
        const m = await freshModule()
        const a = {
            hubUrl: 'http://hub-a.example',
            jwt: 'a-jwt',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            namespace: 'alice'
        }
        const b = {
            hubUrl: 'http://hub-b.example',
            jwt: 'b-jwt',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            namespace: 'bob'
        }
        await m.saveCredentials(a)
        await m.saveCredentials(b)
        // Latest save becomes the default.
        assert.deepEqual(await m.loadCredentials(), b)
        // Explicit hubUrl looks up that entry.
        assert.deepEqual(await m.loadCredentials(a.hubUrl), a)
        assert.deepEqual(await m.loadCredentials(b.hubUrl), b)
        // Unknown hub returns null.
        assert.equal(await m.loadCredentials('http://nope.example'), null)
    })

    it('clearCredentials removes one hub and picks new default', async () => {
        const m = await freshModule()
        const a = {
            hubUrl: 'http://hub-a.example',
            jwt: 'a-jwt',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            namespace: 'alice'
        }
        const b = {
            hubUrl: 'http://hub-b.example',
            jwt: 'b-jwt',
            expiresAt: Math.floor(Date.now() / 1000) + 3600,
            namespace: 'bob'
        }
        await m.saveCredentials(a)
        await m.saveCredentials(b)
        // b is default; clear it and a should become default.
        await m.clearCredentials(b.hubUrl)
        const def = await m.loadCredentials()
        assert.equal(def?.hubUrl, a.hubUrl)
        // Clear the last one too; loadCredentials returns null.
        await m.clearCredentials(a.hubUrl)
        assert.equal(await m.loadCredentials(), null)
    })

    it('saveCredentials replaces an existing hub entry (alice → bob on same hub)', async () => {
        // The login-as-alice-then-bob flow must fully overwrite, no stale JWT
        // lingering. This is the "namespace switch is clean" claim from the
        // security review.
        const m = await freshModule()
        const url = 'http://hub.example'
        await m.saveCredentials({
            hubUrl: url,
            jwt: 'alice-jwt',
            expiresAt: 9999999999,
            namespace: 'alice'
        })
        await m.saveCredentials({
            hubUrl: url,
            jwt: 'bob-jwt',
            expiresAt: 9999999999,
            namespace: 'bob'
        })
        const loaded = await m.loadCredentials(url)
        assert.equal(loaded?.jwt, 'bob-jwt')
        assert.equal(loaded?.namespace, 'bob')
        // Read the file directly to be sure no alice entry hides under
        // a different shape.
        const raw = await (await import('node:fs/promises')).readFile(m.credentialsPath(), 'utf8')
        assert.equal(raw.includes('alice-jwt'), false, 'alice-jwt should be gone')
    })

    it('atomic write survives tmp file from a previous crash', async () => {
        const m = await freshModule()
        // Plant a stale tmp file at the same name our writer would use,
        // simulating a crashed earlier run.
        const { mkdir, writeFile } = await import('node:fs/promises')
        await mkdir(join(testHome, '.tmuxd', 'cli'), { recursive: true, mode: 0o700 })
        const tmp = `${m.credentialsPath()}.tmp.${process.pid}`
        await writeFile(tmp, 'stale garbage', { mode: 0o600 })
        // saveCredentials should clean up and succeed.
        await m.saveCredentials({
            hubUrl: 'http://hub.example',
            jwt: 'eyJfresh',
            expiresAt: 9999999999,
            namespace: 'alice'
        })
        const loaded = await m.loadCredentials()
        assert.equal(loaded?.jwt, 'eyJfresh')
    })
})
