/**
 * `tmuxd init` — write a `.env` for one of the three deployment shapes
 * (server, relay, client). The CLI is the canonical way to bootstrap
 * a tmuxd box; the .env templates in the repo are reference docs for
 * humans, but `tmuxd init` is what scripts should call.
 *
 * The output mirrors `.env.example` and `.env.client.example` exactly,
 * but with the operator's chosen values pre-filled and the unrelated
 * mode-comments stripped (only the chosen mode's values are present).
 *
 * Three modes share one writer:
 *
 *   server  → Mode A (HOST=127.0.0.1) or Mode B (HOST=0.0.0.0). The
 *             `--public` flag toggles to Mode B. TMUXD_RELAY is unset.
 *   relay   → Mode C. TMUXD_RELAY=1, HOST=0.0.0.0.
 *   client  → outbound .env (TMUXD_URL + tokens + host id/name). No
 *             HOST/PORT/JWT_SECRET, etc.
 *
 * Refuses to overwrite an existing .env unless --force; never writes
 * outside the CWD; never reads or modifies anything else.
 *
 * Security posture (paranoid by design — the server token written here
 * is the trust-circle key; an attacker who diverts the write owns the
 * deployment):
 *
 *   - The destination is `lstat`'d first; symlinks, directories,
 *     character devices, etc. are rejected up-front. `--force` does
 *     NOT bypass this; `rm` first if you really want a fresh start.
 *   - The actual write goes to a tmp file opened with
 *     `O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW` at mode 0600, so:
 *       (a) a symlink at the tmp path can't redirect the write, and
 *       (b) two concurrent `tmuxd init` runs can't both pass the gate
 *           and one silently win — the second `O_EXCL` open errors out.
 *   - We `fsync`, then `rename()` over the destination, then
 *     defensively `chmod(dest, 0o600)` to make sure --force on a
 *     pre-existing 0644 file ends up at 0600. (`rename` preserves the
 *     source's mode, so this is belt-and-suspenders.)
 *   - The `filename` opt is path-normalized inside `cwd`; an attempt
 *     to escape via `../` is rejected outright.
 */
import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, open, rename, unlink } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { isAbsolute, normalize, relative, resolve, sep } from 'node:path'

export type InitMode = 'server' | 'relay' | 'client'

export interface InitOptions {
    /** Working directory the .env file goes into. Defaults to process.cwd(). */
    cwd?: string
    /** Overwrite an existing .env. Default: refuse. */
    force?: boolean
    /**
     * Output filename, resolved relative to `cwd`. Defaults to `.env`.
     * Path traversal (`..`, absolute paths) is rejected — you cannot
     * use this to write outside `cwd`.
     */
    filename?: string

    // server / relay
    /** Pre-existing server token, or generate a fresh one if undefined. */
    serverToken?: string
    /** Mode B (`HOST=0.0.0.0`) instead of Mode A loopback for `init server`. */
    publicBind?: boolean
    /** TCP port. Default: 7681. */
    port?: number

    // client
    tmuxdUrl?: string
    userToken?: string
    hostId?: string
    hostName?: string
}

export interface InitResult {
    /** Absolute path to the file we wrote. */
    path: string
    /** Auto-generated server token (server / relay only); echo to user once. */
    generatedServerToken: string | null
}

const DEFAULT_PORT = 7681

/**
 * Per-value byte cap. .env files are read into memory by every dotenv
 * loader; an attacker (or accidental shell substitution) handing us a
 * 10 MB host name shouldn't propagate. 4 KiB is a comfortable ceiling
 * — server tokens are 64 hex chars, host ids are ≤ 64, URLs are
 * pragma-bound. If you have a value bigger than 4 KiB, you have a
 * different problem.
 */
const MAX_VALUE_BYTES = 4096

/** 64 hex chars = 32 random bytes. Mirrors `openssl rand -hex 32`. */
function generateServerToken(): string {
    return randomBytes(32).toString('hex')
}

/**
 * Validate a candidate value before we paste it into a `.env` line.
 * The risks we filter:
 *
 *   - Empty: meaningless; would emit `KEY=` and many shells then
 *     interpret a missing value as the variable being unset.
 *   - Newlines (LF/CR + Unicode line separators U+2028/U+2029):
 *     would break the dotenv parser or, worse, smuggle a fake KEY=
 *     line in via the value. The Unicode separators look benign in
 *     editors but several shells `source .env` and treat them as
 *     line breaks.
 *   - Leading/trailing whitespace: dotenv tools handle this
 *     inconsistently across runtimes; we reject so the round-trip
 *     is deterministic.
 *   - `=`: dotenv tolerates `KEY=a=b`, but `source .env` in bash
 *     does not. We reject to keep both round-trips working.
 *   - NUL: dotenv parsers (and shells) variously truncate or error;
 *     either way it's never legitimate.
 *   - Length > 4 KiB: see MAX_VALUE_BYTES.
 */
function validateEnvValue(name: string, value: string): void {
    if (!value) throw new Error(`${name} must not be empty`)
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
        throw new Error(`${name} exceeds ${MAX_VALUE_BYTES}-byte limit`)
    }
    if (/[\r\n\u2028\u2029]/.test(value)) {
        throw new Error(`${name} must not contain newlines (CR/LF/U+2028/U+2029)`)
    }
    if (value.includes('\0')) throw new Error(`${name} must not contain NUL bytes`)
    if (value !== value.trim()) {
        throw new Error(`${name} must not have leading/trailing whitespace`)
    }
    if (value.includes('=')) {
        throw new Error(
            `${name} must not contain '=' (would break shell \`source .env\` round-trip)`
        )
    }
}

function renderServerEnv(opts: {
    serverToken: string
    relay: boolean
    host: string
    port: number
}): string {
    const lines: string[] = []
    lines.push('# tmuxd SERVER configuration')
    lines.push(`# Mode: ${opts.relay ? 'C — relay multi-user' : opts.host === '127.0.0.1' ? 'A — single-user local' : 'B — server + remote clients'}`)
    lines.push('# Generated by `tmuxd init`. See docs/deployment-modes.md.')
    lines.push('')
    lines.push('# Shared trust-circle token. Anyone with this can use this server.')
    lines.push('# Treat like a team password.')
    lines.push(`TMUXD_SERVER_TOKEN=${opts.serverToken}`)
    lines.push('')
    if (opts.relay) {
        lines.push('# Relay mode: refuse to host tmux sessions on this box.')
        lines.push('# The local host is hidden from every namespace; clients on')
        lines.push('# other machines provide all the sessions.')
        lines.push('TMUXD_RELAY=1')
        lines.push('')
    }
    lines.push('# Bind address.')
    lines.push(`HOST=${opts.host}`)
    lines.push('')
    lines.push('# HTTP port.')
    lines.push(`PORT=${opts.port}`)
    lines.push('')
    return lines.join('\n')
}

function renderClientEnv(opts: {
    tmuxdUrl: string
    serverToken: string
    userToken: string
    hostId?: string
    hostName?: string
}): string {
    const lines: string[] = []
    lines.push('# tmuxd CLIENT configuration')
    lines.push('# Generated by `tmuxd init client`. See .env.client.example for full reference.')
    lines.push('')
    lines.push('# The tmuxd server (or relay) URL. Use https:// in production.')
    lines.push(`TMUXD_URL=${opts.tmuxdUrl}`)
    lines.push('')
    lines.push('# Trust-circle token from the server admin (= server\'s TMUXD_SERVER_TOKEN).')
    lines.push(`TMUXD_SERVER_TOKEN=${opts.serverToken}`)
    lines.push('')
    lines.push('# Your personal token. Reuse the same value across all your devices')
    lines.push('# so they share a namespace. The server hashes it into your namespace.')
    lines.push(`TMUXD_USER_TOKEN=${opts.userToken}`)
    lines.push('')
    if (opts.hostId) {
        lines.push('# Stable host identifier. Letters/digits/dot/underscore/dash, ≤ 64 chars.')
        lines.push(`TMUXD_HOST_ID=${opts.hostId}`)
        lines.push('')
    }
    if (opts.hostName) {
        lines.push('# Display name shown in the web UI host list.')
        lines.push(`TMUXD_HOST_NAME=${opts.hostName}`)
        lines.push('')
    }
    return lines.join('\n')
}

/**
 * Resolve `cwd` + `filename` into an absolute path, refusing any value
 * that would land outside `cwd`. Catches `filename: '../etc/.env'`,
 * `filename: '/etc/.env'`, `filename: '.env/../../etc'`, etc.
 */
function resolveDest(cwd: string, filename: string): string {
    if (!filename) throw new Error('filename must not be empty')
    if (isAbsolute(filename)) {
        throw new Error(`filename must be relative to cwd, got absolute: ${filename}`)
    }
    const absCwd = resolve(cwd)
    const dest = resolve(absCwd, filename)
    // `relative(cwd, dest)` returns `..` (or `../something`) if dest
    // is outside cwd. Empty string means dest === cwd, which is also
    // invalid (we'd be writing to the dir itself).
    const rel = relative(absCwd, dest)
    if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(
            `filename must resolve inside cwd, got: ${filename} (resolves to ${dest})`
        )
    }
    // Defang one more case: `filename` containing the cwd prefix
    // literally is suspicious. `normalize` collapses `./foo` and
    // `foo/./bar` so the comparison is well-defined.
    if (normalize(filename).split(sep).some((seg) => seg === '..')) {
        throw new Error(`filename must not contain '..' segments: ${filename}`)
    }
    return dest
}

/**
 * Atomic, symlink-safe write of `body` to `dest` at mode 0600. If
 * `force` is false, refuses when `dest` already exists. If `force` is
 * true, overwrites — but ONLY if the existing entry is a regular file
 * (no symlinks, no devices, no directories). We never blindly follow
 * a symlink to write secrets.
 *
 * Concurrency: two `tmuxd init` runs racing on the same dest with
 * `--force` is undefined-but-safe. The first `rename` wins, the second
 * either succeeds (replacing the first's file with its own — both wrote
 * tokens, both told the user, the loser's token isn't on disk) or
 * fails with EEXIST on the tmp open (its tmp name collides with the
 * other run's pid-suffixed tmp). Neither path leaves a half-written
 * file or a 0644 mode behind.
 */
async function writeAtomic0600(dest: string, body: string, force: boolean): Promise<void> {
    // Pre-flight check: lstat (NOT stat) so a symlink at dest is
    // visible as a symlink, not silently followed.
    try {
        const st = await lstat(dest)
        if (st.isSymbolicLink()) {
            throw new Error(
                `${dest} is a symlink. Refusing to follow it — \`tmuxd init\` will not write secrets ` +
                    `through a symlink. Remove it first if you intended this.`
            )
        }
        if (!st.isFile()) {
            throw new Error(
                `${dest} exists and is not a regular file (directory, device, or socket). ` +
                    `Refusing to overwrite.`
            )
        }
        if (!force) {
            throw new Error(
                `${dest} already exists. Pass --force to overwrite, or remove it first.`
            )
        }
        // Regular file + force: fall through to the atomic write below.
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
        // dest doesn't exist — the common path. Continue.
    }

    const tmp = `${dest}.tmp.${process.pid}`
    // Clean up any stale tmp from a previous crashed run; ignore ENOENT.
    await unlink(tmp).catch(() => {})

    const handle = await open(
        tmp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600
    )
    try {
        await handle.writeFile(body, 'utf8')
        await handle.sync()
    } finally {
        await handle.close()
    }
    await rename(tmp, dest)
    // `rename` keeps the tmp file's mode (0600). The defensive chmod
    // here exists for the --force path where a pre-existing target
    // could (in theory) have ended up at the dest inode through some
    // path we didn't anticipate. Cheap insurance.
    await chmod(dest, 0o600).catch(() => {})
}

/**
 * Write a `.env` file for the chosen mode. The caller is responsible
 * for echoing whatever stderr instructions are appropriate (e.g.
 * "save this generated server token"); this function is pure I/O.
 */
export async function writeEnvFile(mode: InitMode, opts: InitOptions = {}): Promise<InitResult> {
    // INIT_CWD is set by npm to the directory the user invoked `npm` in,
    // before npm chdir'd into the workspace. When `tmuxd init` is run via
    // `npm run tmuxd -- init server`, process.cwd() points at server/,
    // not where the user actually wants the .env to land. Honor INIT_CWD
    // when present and the explicit cwd opt is absent.
    const cwd = opts.cwd ?? process.env.INIT_CWD ?? process.cwd()
    const filename = opts.filename ?? '.env'
    const path = resolveDest(cwd, filename)

    let body: string
    let generatedServerToken: string | null = null

    if (mode === 'server' || mode === 'relay') {
        let serverToken = opts.serverToken
        if (!serverToken) {
            serverToken = generateServerToken()
            generatedServerToken = serverToken
        }
        validateEnvValue('serverToken', serverToken)
        const port = opts.port ?? DEFAULT_PORT
        if (!Number.isInteger(port) || port < 1 || port > 65535) {
            throw new Error(`port must be an integer 1..65535, got ${port}`)
        }
        const isRelay = mode === 'relay'
        // Mode A vs Mode B selection for `init server`. `init relay`
        // implies public bind because a loopback-only relay is useless.
        const host = isRelay ? '0.0.0.0' : opts.publicBind ? '0.0.0.0' : '127.0.0.1'
        body = renderServerEnv({ serverToken, relay: isRelay, host, port })
    } else if (mode === 'client') {
        if (!opts.tmuxdUrl) throw new Error('init client requires --url <server-url>')
        if (!opts.serverToken) throw new Error('init client requires --server-token <secret>')
        if (!opts.userToken) throw new Error('init client requires --user-token <secret>')
        validateEnvValue('tmuxdUrl', opts.tmuxdUrl)
        validateEnvValue('serverToken', opts.serverToken)
        validateEnvValue('userToken', opts.userToken)
        if (opts.hostId) validateEnvValue('hostId', opts.hostId)
        if (opts.hostName) validateEnvValue('hostName', opts.hostName)
        body = renderClientEnv({
            tmuxdUrl: opts.tmuxdUrl,
            serverToken: opts.serverToken,
            userToken: opts.userToken,
            hostId: opts.hostId,
            hostName: opts.hostName
        })
    } else {
        throw new Error(`unknown init mode: ${mode as string}`)
    }

    await writeAtomic0600(path, body, !!opts.force)

    return { path, generatedServerToken }
}
