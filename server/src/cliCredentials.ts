/**
 * Persistent credential store for the `tmuxd` CLI.
 *
 * One JSON file at `~/.tmuxd/cli/credentials.json` holds the JWT(s) the
 * CLI obtained from `tmuxd login`. Multi-hub aware: a user can be logged
 * into more than one hub at the same time (e.g. work + personal), and
 * each subcommand picks the right entry by `tmuxdUrl`.
 *
 * Security posture is paranoid by design: the JWT is bearer-equivalent
 * to "control over visible tmux sessions for this namespace", so:
 *
 *   - Parent dir is created at mode 0700 and re-chmod'd defensively
 *     whenever we write (to tighten any pre-existing 0755 dir).
 *   - File is written via tmp+rename for atomicity; the tmp file is
 *     opened with `O_NOFOLLOW|O_CREAT|O_EXCL` at mode 0600, so a
 *     symlink already at the path can't redirect the write.
 *   - On read, we `lstat` (no symlink follow) and refuse if the
 *     file isn't a regular file or has any group/world bit set.
 *   - The read path opens the fd, then `fstat`s it, then reads —
 *     same fd throughout, so there is no stat→read TOCTOU window.
 */
import { constants as fsConstants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SavedCred {
    tmuxdUrl: string
    jwt: string
    /** Unix seconds — matches `AuthResponse.expiresAt`. */
    expiresAt: number
    /** 16-hex namespace derived from userToken; what the JWT is scoped to. */
    namespace: string
    /**
     * The two tokens used to obtain this JWT. Persisted so the CLI can
     * silently refresh the JWT when it expires (12h) without forcing the
     * user to retype the user-token. Both are 0600-protected together
     * with the JWT — same threat model.
     */
    serverToken: string
    userToken: string
}

interface CredFile {
    version: 1
    /** tmuxdUrl chosen by `tmuxd login` last time, used when subcommands omit `--hub`. */
    default: string | null
    servers: Record<string, Omit<SavedCred, 'tmuxdUrl'>>
}

const FILE_VERSION = 1

function credsDir(): string {
    return join(homedir(), '.tmuxd', 'cli')
}

function credsPath(): string {
    return join(credsDir(), 'credentials.json')
}

/** True if any group/world bit is set in the mode. */
function isPermLeak(mode: number): boolean {
    return (mode & 0o077) !== 0
}

function isNodeNotFound(err: unknown): boolean {
    return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT'
}

async function readFileIfExists(): Promise<CredFile | null> {
    // lstat (not stat) so a symlink at the credentials path is rejected
    // up-front instead of silently followed. Combined with the
    // O_NOFOLLOW write path, this means the file can only ever be a
    // regular file we created ourselves.
    let st: Stats
    try {
        st = await lstat(credsPath())
    } catch (err) {
        if (isNodeNotFound(err)) return null
        throw err
    }
    if (!st.isFile()) {
        throw new Error(
            `credentials path is not a regular file: ${credsPath()} ` +
                `(symlink, dir, or device — refusing to read).`
        )
    }
    if (isPermLeak(st.mode & 0o777)) {
        const got = (st.mode & 0o777).toString(8).padStart(3, '0')
        throw new Error(
            `refusing to read ${credsPath()}: mode is ${got}, expected 600. ` +
                `Run \`chmod 600 ${credsPath()}\` and try again, or delete the file ` +
                `and re-run \`tmuxd login\`.`
        )
    }
    // Open + fstat + read on the same fd to close the stat→read TOCTOU
    // window. O_NOFOLLOW belt-and-suspenders even though lstat already
    // rejected symlinks above.
    let handle
    try {
        handle = await open(credsPath(), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
    } catch (err) {
        if (isNodeNotFound(err)) return null
        throw err
    }
    let raw: string
    try {
        const post = await handle.stat()
        if (!post.isFile()) {
            throw new Error(`credentials path changed type after lstat: ${credsPath()}`)
        }
        if (isPermLeak(post.mode & 0o777)) {
            // Race between lstat and open is bounded by parent dir 0700;
            // still cheap to re-check.
            const got = (post.mode & 0o777).toString(8).padStart(3, '0')
            throw new Error(`credentials mode changed to ${got} between stat and open`)
        }
        raw = await handle.readFile('utf8')
    } finally {
        await handle.close()
    }
    let parsed: unknown
    try {
        parsed = JSON.parse(raw)
    } catch {
        throw new Error(`credentials file is not valid JSON: ${credsPath()}`)
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`credentials file is malformed: ${credsPath()}`)
    }
    const obj = parsed as Partial<CredFile>
    if (obj.version !== FILE_VERSION) {
        throw new Error(
            `credentials file version mismatch: got ${String(obj.version)}, expected ${FILE_VERSION}. ` +
                `Delete ${credsPath()} and re-run \`tmuxd login\`.`
        )
    }
    if (!obj.servers || typeof obj.servers !== 'object') {
        throw new Error(`credentials file missing 'servers' map: ${credsPath()}`)
    }
    return {
        version: FILE_VERSION,
        default: typeof obj.default === 'string' ? obj.default : null,
        servers: obj.servers as CredFile['servers']
    }
}

/**
 * Tighten the parent directory's mode to 0700 if it already exists at a
 * looser mode. `mkdir(... mode:0o700)` only sets the mode on creation;
 * an existing 0755 dir is left alone. Operators sometimes have `~/.tmuxd`
 * pre-created (e.g. `uploads/` is mode 0700 already), so we touch the
 * parent dir but NOT `~/.tmuxd` itself — the latter has its own
 * conventions.
 */
async function ensureCredsDirSecure(): Promise<void> {
    await mkdir(credsDir(), { recursive: true, mode: 0o700 })
    // Defensive: if the dir pre-existed at a looser mode, tighten it.
    // Bounded scope (we only own ~/.tmuxd/cli) so we don't surprise the user.
    try {
        await chmod(credsDir(), 0o700)
    } catch {
        // Best-effort. If we can't chmod we still proceeded with mkdir;
        // the file's own 0600 mode is the load-bearing protection.
    }
}

/**
 * Atomic write: write to a tmp file with O_NOFOLLOW|O_CREAT|O_EXCL at
 * mode 0600, fsync, rename over the final path. Crash mid-write leaves
 * the previous credentials intact instead of a half-written JSON
 * corpse. `O_EXCL` means a stale tmp file blocks the write — we delete
 * it first to keep idempotent retries working.
 */
async function writeCredentialsFile(file: CredFile): Promise<void> {
    await ensureCredsDirSecure()
    const data = JSON.stringify(file, null, 2) + '\n'
    const tmp = `${credsPath()}.tmp.${process.pid}`
    // Clean up any stale tmp from a previous crashed write.
    await unlink(tmp).catch(() => {})
    const handle = await open(
        tmp,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600
    )
    try {
        await handle.writeFile(data, 'utf8')
        await handle.sync()
    } finally {
        await handle.close()
    }
    await rename(tmp, credsPath())
    // Defensive chmod on the final path. `rename` preserves the source
    // file's mode (0600), so this is belt-and-suspenders for the case
    // where a pre-existing target file had a looser mode and the kernel
    // somehow surprised us. Cheap.
    await chmod(credsPath(), 0o600).catch(() => {})
}

/**
 * Look up credentials for a hub. If `tmuxdUrl` is omitted, returns the
 * "default" entry (last-logged-in hub), or null if the file is empty.
 */
export async function loadCredentials(tmuxdUrl?: string): Promise<SavedCred | null> {
    const file = await readFileIfExists()
    if (!file) return null
    const target = tmuxdUrl ?? file.default
    if (!target) return null
    const entry = file.servers[target]
    if (!entry) return null
    return { tmuxdUrl: target, ...entry }
}

/** Save (or replace) the credential for one hub and mark it as default. */
export async function saveCredentials(cred: SavedCred): Promise<void> {
    const file = (await readFileIfExists()) ?? {
        version: FILE_VERSION,
        default: null,
        servers: {}
    }
    file.servers[cred.tmuxdUrl] = {
        jwt: cred.jwt,
        expiresAt: cred.expiresAt,
        namespace: cred.namespace,
        serverToken: cred.serverToken,
        userToken: cred.userToken
    }
    file.default = cred.tmuxdUrl
    await writeCredentialsFile(file)
}

/**
 * Remove credentials for one hub. If it was the default, pick another
 * remaining server as default (last-write-wins is good enough — the
 * map iteration order in V8 is insertion order). If the file becomes
 * empty, write an empty stub rather than deleting; the operator may
 * re-`tmuxd login` and we want the directory ready.
 */
export async function clearCredentials(tmuxdUrl: string): Promise<void> {
    const file = await readFileIfExists()
    if (!file) return
    delete file.servers[tmuxdUrl]
    if (file.default === tmuxdUrl) {
        const remaining = Object.keys(file.servers)
        file.default = remaining.length > 0 ? remaining[remaining.length - 1] : null
    }
    await writeCredentialsFile(file)
}

/** Diagnostic helper for `tmuxd whoami`. */
export function credentialsPath(): string {
    return credsPath()
}
