#!/usr/bin/env node
/**
 * tmuxd CLI — first-class HTTP-API client for tmuxd servers.
 *
 * The mental model intentionally mirrors `tmux`:
 *
 *   tmuxd list-sessions [-t HOST]
 *   tmuxd new-session   [-t HOST] [-s NAME]
 *   tmuxd kill-session  -t HOST:SESSION
 *   tmuxd list-panes    [-t HOST:SESSION]
 *   tmuxd capture-pane  -t HOST:TARGET [--lines N] [-B BYTES]
 *   tmuxd send-keys     -t HOST:TARGET KEY...
 *   tmuxd send-text     -t HOST:TARGET [--enter] TEXT...
 *   tmuxd pane-status   -t HOST:TARGET
 *
 * Plus a few CLI-only verbs:
 *
 *   tmuxd init {server|relay|client} [...]
 *   tmuxd login   --server URL --server-token SECRET --user-token SECRET
 *   tmuxd whoami
 *   tmuxd logout  [--server URL]
 *   tmuxd list-hosts
 *   tmuxd snapshot [--capture] [--limit N]
 *
 * The two-token model:
 *   - `--server-token` (env: TMUXD_SERVER_TOKEN) is the shared trust-circle
 *     token that authorizes you to use this server at all.
 *   - `--user-token` (env: TMUXD_USER_TOKEN) is *your* personal token. The
 *     server derives `namespace = sha256(userToken).slice(0, 16)` from it.
 *
 * The "where is the server" flag has three accepted spellings — `--server`
 * (canonical), `--hub` (back-compat alias from the pre-rename era), and
 * `--url` (used by `init client`, where `--server` would collide with the
 * subcommand name in the user's mental model). All three resolve to the
 * same field via getHubFlag().
 *
 * `--user-token-generate` flag prints a fresh random token (32 random
 * bytes hex) for first-time setup, so users don't have to invent their
 * own entropy.
 *
 * See docs/identity-model.md.
 */
import { readFile, lstat } from 'node:fs/promises'
import {
    clearCredentials,
    credentialsPath,
    loadCredentials,
    saveCredentials,
    type SavedCred
} from './cliCredentials.js'
import { writeEnvFile, type InitMode } from './cliInit.js'
import {
    authResponseSchema,
    generateUserToken,
    hostsResponseSchema,
    sessionsResponseSchema,
    hostScopedSessionsResponseSchema,
    panesResponseSchema,
    hostScopedPanesResponseSchema,
    tmuxPaneCaptureSchema,
    tmuxPaneStatusSchema,
    okResponseSchema,
    type AuthResponse,
    type HostInfo as SharedHostInfo,
    type TargetSession,
    type TargetPane,
    type TmuxPaneCapture,
    type TmuxPaneStatus
} from '@tmuxd/shared'

const VERSION = '0.1.0'

// ---------------------------------------------------------------------------
// arg parsing — extends the simple style from server/src/client.ts
// ---------------------------------------------------------------------------

interface ParsedArgs {
    /** Subcommand (e.g. `list-sessions`). */
    cmd: string | null
    /** Long flags with values: `--name foo` → `{name: 'foo'}`. Booleans → '1'. */
    flags: Record<string, string>
    /** Positional args after the subcommand. */
    positional: string[]
}

/**
 * Long-flag names that don't take a value. Anything else with a `--`
 * prefix needs an explicit value (next arg or `--key=value`); we never
 * heuristically treat "next token starts with -" as "the flag is a
 * boolean", because that path silently swallows legitimate dash-prefixed
 * values like `--text -draft`.
 */
const BOOLEAN_FLAGS = new Set([
    'help',
    'enter',
    'json',
    'capture',
    'version',
    'user-token-generate',
    'force',
    'public',
    'server-token-from-env'
])

/**
 * Short-flag → long-flag mapping for value-taking single-letter flags.
 * Only short flags that map cleanly to tmux's own conventions live here:
 *   -t target   (tmux: `-t target`)
 *   -s name     (tmux: `-s session-name` on new-session)
 *   -B maxBytes (tmuxd-only; we don't reuse tmux's -B which means buffer)
 *
 * Note: tmux's `-S` means "start-line" in capture-pane. We previously
 * mapped it to `--lines` which collided with tmux muscle memory (review
 * caught it). `--lines` is now the only spelling — no short alias.
 */
const SHORT_VALUE_FLAGS: Record<string, string> = {
    '-t': 'target',
    '-s': 'name',
    '-B': 'max-bytes'
}

function parseArgs(argv: string[]): ParsedArgs {
    const flags: Record<string, string> = {}
    const positional: string[] = []
    let cmd: string | null = null
    let i = 0
    // Pull off the subcommand first; flags before it are global (only -h/-V today).
    while (i < argv.length) {
        const arg = argv[i]
        if (arg === '-h' || arg === '--help') {
            flags.help = '1'
            i++
            continue
        }
        if (arg === '-V' || arg === '--version') {
            flags.version = '1'
            i++
            continue
        }
        if (arg.startsWith('-')) {
            // No global value-flags currently; ignore until we hit the subcommand.
            i++
            continue
        }
        cmd = arg
        i++
        break
    }
    // Once we hit `--` everything after is a positional, even if it
    // starts with `-`. Mirrors POSIX getopt and tmux.
    let endOfOptions = false
    while (i < argv.length) {
        const arg = argv[i]
        if (endOfOptions) {
            positional.push(arg)
            i++
            continue
        }
        if (arg === '--') {
            endOfOptions = true
            i++
            continue
        }
        if (arg === '-h' || arg === '--help') {
            flags.help = '1'
            i++
            continue
        }
        // Short value-flags
        const shortLong = SHORT_VALUE_FLAGS[arg]
        if (shortLong) {
            const next = argv[i + 1]
            if (next === undefined) throw usageError(`flag ${arg} requires a value`)
            flags[shortLong] = next
            i += 2
            continue
        }
        // Long flag with explicit `=value`
        if (arg.startsWith('--') && arg.includes('=')) {
            const eq = arg.indexOf('=')
            flags[arg.slice(2, eq)] = arg.slice(eq + 1)
            i++
            continue
        }
        // Long flag, value-taking or boolean
        if (arg.startsWith('--')) {
            const key = arg.slice(2)
            if (BOOLEAN_FLAGS.has(key)) {
                flags[key] = '1'
                i++
                continue
            }
            const next = argv[i + 1]
            if (next === undefined) {
                throw usageError(`flag ${arg} requires a value (use --${key}=<value> or quote dash-prefixed values)`)
            }
            // Note: we deliberately do NOT skip `next.startsWith('-')` here.
            // A user passing `--text -draft` should get `text=-draft`, not
            // `text=true` followed by an unrecognized `-draft`. If they
            // really want a boolean flag they should use `--key` alone or
            // `--key=value` syntax — which is unambiguous.
            flags[key] = next
            i += 2
            continue
        }
        positional.push(arg)
        i++
    }
    return { cmd, flags, positional }
}

class UsageError extends Error {
    constructor(msg: string) {
        super(msg)
        this.name = 'UsageError'
    }
}

function usageError(msg: string): UsageError {
    return new UsageError(msg)
}

/**
 * Resolve the "where is the tmuxd server" flag. The canonical name is
 * `--server <url>`; `--hub <url>` is a back-compat alias from the
 * pre-rename era and `--url` is what `init client` uses (because
 * `--server` would collide with the subcommand's `init server` name in
 * the user's mental model). All three resolve to the same field.
 *
 * Order: --server > --hub > --url. We never combine them — if more
 * than one is set, the first wins silently, which is consistent with
 * how the rest of the CLI treats redundant flags.
 */
function getHubFlag(args: ParsedArgs): string | undefined {
    return args.flags.server || args.flags.hub || args.flags.url
}

// ---------------------------------------------------------------------------
// target parsing — `host`, `host:session`, `host:session:0.0`, `host:%paneId`
// ---------------------------------------------------------------------------

interface ParsedTarget {
    hostId: string
    sessionName: string | null
    /** The pane portion: `0.0`, `:0.0`, or `%paneId`. */
    paneTarget: string | null
}

/**
 * Split a `-t` value into its components. tmux pane targets can themselves
 * contain `:` (`session:0.0`), so we use the *first* `:` as the host
 * boundary and let the rest re-merge into the pane target string.
 *
 *   laptop                       → {host=laptop}
 *   laptop:main                  → {host=laptop, session=main}
 *   laptop:main:0.0              → {host=laptop, session=main, pane=main:0.0}
 *   laptop:%7                    → {host=laptop, pane=%7}
 *
 * Note the redundancy on `host:session:pane`: the API endpoint
 * `/hosts/:hostId/panes/:target` wants the full session-qualified pane,
 * not just `0.0`, so we build `session:0.0` for the pane field.
 */
function parseTarget(raw: string): ParsedTarget {
    if (!raw) throw usageError('empty target value')
    const firstColon = raw.indexOf(':')
    if (firstColon === -1) {
        return { hostId: raw, sessionName: null, paneTarget: null }
    }
    const hostId = raw.slice(0, firstColon)
    const rest = raw.slice(firstColon + 1)
    if (!hostId) throw usageError(`target missing host: '${raw}'`)
    if (!rest) throw usageError(`target trailing colon: '${raw}'`)
    // Pane-id form: host:%NNN
    if (rest.startsWith('%')) {
        return { hostId, sessionName: null, paneTarget: rest }
    }
    const secondColon = rest.indexOf(':')
    if (secondColon === -1) {
        // host:session
        return { hostId, sessionName: rest, paneTarget: null }
    }
    // host:session:windowOrPane → pane target reuses session prefix
    const sessionName = rest.slice(0, secondColon)
    if (!sessionName) throw usageError(`target missing session: '${raw}'`)
    return {
        hostId,
        sessionName,
        paneTarget: rest // server expects `session:0.0`, which is exactly `rest`
    }
}

// ---------------------------------------------------------------------------
// help text
// ---------------------------------------------------------------------------

function printRootHelp(): void {
    process.stdout.write(`tmuxd ${VERSION} — control plane CLI for tmuxd servers

Usage:
  tmuxd <subcommand> [flags] [args]

Auth (one-time):
  tmuxd login   --server <url> --server-token <secret> --user-token <secret>
  tmuxd whoami
  tmuxd logout  [--server <url>]

Bootstrap a new box:
  tmuxd init server  [--public] [--port N] [--server-token VAL] [--force]
  tmuxd init relay   [--port N] [--server-token VAL] [--force]
  tmuxd init client  --url URL --server-token VAL --user-token VAL
                     [--host-id ID] [--host-name NAME] [--force]

Hosts & sessions (mirror tmux verbs):
  tmuxd list-hosts
  tmuxd list-sessions    [-t <host>]
  tmuxd new-session      [-t <host>] [-s <name>]
  tmuxd kill-session     -t <host>:<session>
  tmuxd list-panes       [-t <host>:<session>]
  tmuxd capture-pane     -t <host>:<target> [--lines <n>] [-B <bytes>]
  tmuxd send-keys        -t <host>:<target> <KEY> [<KEY> ...]
  tmuxd send-text        -t <host>:<target> [--enter] <TEXT> [<TEXT> ...]
  tmuxd pane-status      -t <host>:<target>            (state, light, summary)
  tmuxd attach-session   -t <host>:<session>           (prints web UI URL)
  tmuxd snapshot         [--capture] [--limit <n>]

Common flags:
  -t TARGET             tmux-style target. Forms: <host>, <host>:<session>,
                        <host>:<session>:<window>.<pane>, <host>:%<paneId>.
  --json                Print raw API JSON (default is human-readable).
  -h, --help            Print help. Use \`tmuxd <subcommand> --help\` for
                        subcommand-specific options.
  -V, --version         Print version and exit.
  --                    End-of-options sentinel; everything after is
                        positional even if it starts with \`-\`.

Two-token auth (login only):
  --server-token <value>      Shared trust-circle token (= TMUXD_SERVER_TOKEN
                              on the server). Get this from your server admin.
  --user-token <value>        Your personal token. The server derives
                              namespace = sha256(userToken).slice(0, 16).
                              Use --user-token-generate to make a fresh one.
  --server-token-file <path>  Read server token from a 0600 file.
  --user-token-file <path>    Read user token from a 0600 file.
  TMUXD_SERVER_TOKEN env      Fallback if --server-token absent.
  TMUXD_USER_TOKEN env        Fallback if --user-token absent.

Server URL flag:
  --server <url>              Canonical name. Where the tmuxd server lives.
                              (Aliases: --hub <url>, kept for back-compat;
                              and --url <url>, used by \`init client\`.)

Other subcommands read the JWT from ~/.tmuxd/cli/credentials.json.

Exit codes:
  0   success
  1   usage error / network / unexpected
  2   auth error (no creds, JWT expired, server rejected)
  3   target not found (host/session/pane 404)

Examples:
  # First-time login: server admin gave you SERVER_TOKEN; you make a user token.
  tmuxd login --server https://tmuxd.example.com \\
              --server-token "$SERVER_TOKEN" --user-token-generate

  # Daily use:
  tmuxd list-hosts
  tmuxd list-sessions -t laptop
  tmuxd capture-pane -t laptop:main:0.0 --lines 100
  tmuxd send-text -t laptop:main:0.0 --enter '/status'
  tmuxd send-keys -t laptop:main:0.0 C-c

See README.md and docs/identity-model.md for the trust model.
`)
}

/**
 * Per-subcommand help. Keyed by subcommand. Each block is short — the
 * root help is the master reference, but `tmuxd <verb> --help` should
 * answer "what flags work here" without making the user grep.
 */
const SUBCOMMAND_HELP: Record<string, string> = {
    login: `tmuxd login — authenticate to a tmuxd server

Usage:
  tmuxd login --server <url> --server-token <secret> --user-token <secret>
  tmuxd login --server <url> --server-token <secret> --user-token-generate

Required:
  --server <url>             Server base URL, e.g. https://tmuxd.example.com
                             (Alias: --hub <url>, kept for back-compat.)
  --server-token <value>     Shared trust-circle token (= TMUXD_SERVER_TOKEN
                             on the server). Get this from your server admin.
  --user-token <value>       Your personal identity. The hub derives
                             namespace = sha256(userToken).slice(0, 16).
                             OR --user-token-generate to make a fresh one
                             on first login.

Optional (alternatives to the flags above):
  --server-token-file <path> Read server token from a 0600 file.
  --user-token-file <path>   Read user token from a 0600 file.
  --user-token-generate      Generate a fresh random user token (printed
                             once to stderr) and use it. Save the printed
                             value somewhere safe — it IS your identity;
                             whoever has it can act as you.

Env-var fallbacks:
  TMUXD_SERVER_TOKEN         Fallback for --server-token.
  TMUXD_USER_TOKEN           Fallback for --user-token.

The JWT (and the two tokens, for re-login on JWT expiry) are saved to
~/.tmuxd/cli/credentials.json (mode 0600).
`,
    logout: `tmuxd logout — clear stored credentials

Usage:
  tmuxd logout [--hub <url>]

Without --hub, removes the default (last-logged-in) hub's entry.
`,
    whoami: `tmuxd whoami — show the current login

Usage:
  tmuxd whoami [--hub <url>] [--json]

Prints hub URL, namespace, JWT TTL. Exit 0 if valid; exit 2 if no
credentials are saved or the JWT has expired.
`,
    'list-hosts': `tmuxd list-hosts — list hosts visible to this namespace

Usage:
  tmuxd list-hosts [--json]
`,
    'list-sessions': `tmuxd list-sessions — list sessions on one or all hosts

Usage:
  tmuxd list-sessions [-t <host>] [--json]

Without -t, aggregates across all hosts visible to your namespace.
`,
    'new-session': `tmuxd new-session — create a new tmux session

Usage:
  tmuxd new-session [-t <host>] [-s <name>]

Without -s, the server picks an auto-name (e.g. web-20260512-090507).
Without -t, creates on the local host (refused on hub-only deployments).
`,
    'kill-session': `tmuxd kill-session — kill a tmux session

Usage:
  tmuxd kill-session -t <host>:<session>
`,
    'list-panes': `tmuxd list-panes — list panes on a host or session

Usage:
  tmuxd list-panes [-t <host>[:<session>]] [--json]

Without -t, aggregates across all hosts.
`,
    'capture-pane': `tmuxd capture-pane — read pane scrollback

Usage:
  tmuxd capture-pane -t <host>:<target> [--lines <n>] [-B <bytes>] [--json]

  --lines <n>          Number of newest lines to capture (default: server-set).
                       Note: tmux's own \`-S\` means "start-line" with negative
                       values; tmuxd does not expose \`-S\` to avoid confusion.
  -B, --max-bytes <n>  Truncate to newest N UTF-8-safe bytes.
`,
    'pane-status': `tmuxd pane-status — pane state, activity light, and summary

Usage:
  tmuxd pane-status -t <host>:<target> [--json]

Reports a one-line classification of the pane (idle / running /
needs_input / permission_prompt / copy_mode / dead) plus the activity
light (gray / green / yellow / red) used by the web UI's session list.
This is what an outside agent should poll to decide whether to send
input or to leave a pane alone.
`,
    'display-message': `tmuxd display-message — DEPRECATED alias for pane-status

The verb is hijacked: in tmux, \`display-message\` formats a status
string. tmuxd repurposes it for pane-state classification, which is
confusing. The canonical verb is now \`pane-status\`. This alias still
works (with a stderr deprecation notice) but will be removed in a
future release.

Usage:
  tmuxd display-message -t <host>:<target>      # equivalent to pane-status
`,
    'send-keys': `tmuxd send-keys — send tmux key tokens to a pane

Usage:
  tmuxd send-keys -t <host>:<target> <KEY> [<KEY> ...]

Keys are tmux key names: C-c, C-d, Enter, Escape, Up, Down, etc. Server
validates each key; arbitrary text is rejected (use \`send-text\`).
`,
    'send-text': `tmuxd send-text — send literal text to a pane

Usage:
  tmuxd send-text -t <host>:<target> [--enter] <TEXT> [<TEXT> ...]

Multiple positionals are joined with a single space. \`--enter\` appends
a Return after the text. Use \`--\` to pass dash-prefixed text:
  tmuxd send-text -t laptop:main -- --help
`,
    'attach-session': `tmuxd attach-session — print the web UI deep-link for a session

Usage:
  tmuxd attach-session -t <host>:<session> [--json]

In-CLI raw-TTY attach is not yet implemented (the WebSocket plumbing
needed for a faithful interactive terminal — SIGWINCH, ping/pong,
xterm-256color negotiation — is a larger piece of work). For now the
verb writes a working web-UI URL to stdout so you can pipe it through
\`xdg-open\` (Linux) or \`open\` (macOS), or paste into a browser that
is already logged in to the hub.

Examples:
  open "$(tmuxd attach-session -t laptop:main)"
  xdg-open "$(tmuxd attach-session -t laptop:main)"
`,
    snapshot: `tmuxd snapshot — full inventory across all visible hosts

Usage:
  tmuxd snapshot [--capture] [--limit <n>] [--lines <n>] [-B <bytes>]

Always emits JSON; pipe to jq for ad-hoc filtering.
`,
    init: `tmuxd init — bootstrap a .env for one of three deployment shapes

Usage:
  tmuxd init server  [--public] [--port <n>] [--server-token <value>] [--force]
  tmuxd init relay   [--port <n>] [--server-token <value>] [--force]
  tmuxd init client  --url <server-url> --server-token <value> --user-token <value>
                     [--host-id <id>] [--host-name <name>] [--force]

Modes:
  server   tmuxd box that hosts its own tmux. Defaults to Mode A
           (HOST=127.0.0.1, single-user local). Pass --public for Mode B
           (HOST=0.0.0.0, server + remote clients mixed).
  relay    Mode C: TMUXD_RELAY=1, HOST=0.0.0.0. Pure router/auth box;
           sessions live on user clients only.
  client   Outbound client .env (TMUXD_URL + the two tokens + optional
           host id/name). No HOST/PORT/JWT_SECRET/etc.

Common flags:
  --force          Overwrite an existing .env in CWD (default: refuse).
  --port <n>       HTTP port for server / relay (default: 7681).
  --server-token <value>
                   For init server / init relay: skip auto-generation
                   and use this exact value. (Default: generate
                   openssl-rand-hex 32-byte token, print once to stderr.)
  --server-token-from-env
                   For init server / init relay: explicitly opt into
                   reusing TMUXD_SERVER_TOKEN from your shell, instead
                   of generating a fresh one. Without this flag (or
                   --server-token), bare \`init server\` errors out
                   when TMUXD_SERVER_TOKEN is set in the environment
                   — silent reuse of an ambient token would defeat
                   the "mint a fresh trust-circle key" intent of
                   \`init\`.

Auto-generated server tokens are printed ONCE to stderr in the
 \`tmuxd: generated server token (save this somewhere safe...)\` form.
The same token is also written to .env, so if you lose the stderr
scrollback you can recover with \`grep ^TMUXD_SERVER_TOKEN= .env\`.

The .env file is written to CWD with mode 0600. Symlinks at the
target path are rejected (no exception, even with --force) — \`tmuxd
init\` will not write secrets through a symlink.

Examples:
  # Single-user local server on this laptop:
  tmuxd init server

  # Public-facing server that also hosts tmux:
  tmuxd init server --public --port 7681

  # Pure relay (recommended multi-user shape):
  tmuxd init relay

  # Client config for Alice's laptop:
  tmuxd init client --url https://tmuxd.example.com \\
    --server-token "$TMUXD_SERVER_TOKEN" \\
    --user-token   "$ALICE_USER_TOKEN" \\
    --host-id laptop --host-name "Alice Laptop"
`
}

function printSubcommandHelp(cmd: string): void {
    const text = SUBCOMMAND_HELP[cmd]
    if (text) {
        process.stdout.write(text)
    } else {
        printRootHelp()
    }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

interface ApiOptions<T> {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    body?: unknown
    /** Set when the caller wants 404 to throw NotFoundError instead of generic ApiError. */
    treat404AsNotFound?: boolean
    /**
     * Optional zod schema validating the success response body. When
     * provided, parse failures throw ApiError(0, 'wire_contract_violation')
     * — pointing at the server bug rather than letting the caller crash
     * on a `.map()` of `null`. When absent, the body is returned as `T`
     * with no runtime checks (snapshot uses this).
     */
    schema?: { safeParse(input: unknown): { success: true; data: T } | { success: false; error: { issues: { path: (string | number)[]; message: string }[] } } }
}

class ApiError extends Error {
    constructor(public status: number, public code: string, msg: string) {
        super(msg)
        this.name = 'ApiError'
    }
}

class AuthError extends Error {
    constructor(msg: string) {
        super(msg)
        this.name = 'AuthError'
    }
}

class NotFoundError extends Error {
    constructor(msg: string) {
        super(msg)
        this.name = 'NotFoundError'
    }
}

async function api<T>(cred: SavedCred, path: string, opts: ApiOptions<T> = {}): Promise<T> {
    const method = opts.method ?? 'GET'
    const url = cred.tmuxdUrl.replace(/\/+$/, '') + path
    const headers: Record<string, string> = {
        Authorization: `Bearer ${cred.jwt}`
    }
    let body: string | undefined
    if (opts.body !== undefined) {
        headers['content-type'] = 'application/json'
        body = JSON.stringify(opts.body)
    }
    let res: Response
    try {
        res = await fetch(url, { method, headers, body })
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new ApiError(0, 'network_error', `failed to reach ${url}: ${reason}`)
    }
    if (res.status === 204) {
        // typed as T to keep the call site simple; caller asks for `void`.
        return undefined as T
    }
    let parsed: unknown = null
    const text = await res.text()
    if (text) {
        try {
            parsed = JSON.parse(text)
        } catch {
            // non-JSON body — keep it as text in the error path
        }
    }
    if (!res.ok) {
        const code = (parsed && typeof parsed === 'object' && 'error' in (parsed as Record<string, unknown>)
            ? String((parsed as { error: unknown }).error)
            : `http_${res.status}`)
        const msg = (parsed && typeof parsed === 'object' && 'message' in (parsed as Record<string, unknown>)
            ? String((parsed as { message: unknown }).message)
            : code)
        if (res.status === 401) {
            throw new AuthError(
                `JWT rejected (${code}). Run \`tmuxd login --server ${cred.tmuxdUrl} --server-token ... --user-token ...\` again.`
            )
        }
        if (res.status === 404 && opts.treat404AsNotFound) {
            throw new NotFoundError(`${msg} (${url})`)
        }
        throw new ApiError(res.status, code, `${method} ${path} → ${res.status} ${code}: ${msg}`)
    }
    if (opts.schema) {
        const validated = opts.schema.safeParse(parsed)
        if (!validated.success) {
            // Hub returned 2xx but the body shape doesn't match what
            // tmuxd's wire contract documents. Surface this loudly so
            // a server-side bug doesn't manifest as a confusing
            // .map()-of-undefined crash 30 lines later in the caller.
            const detail = validated.error.issues
                .slice(0, 3)
                .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                .join('; ')
            throw new ApiError(
                res.status,
                'wire_contract_violation',
                `${method} ${path} returned a body that does not match the expected wire contract: ${detail}`
            )
        }
        return validated.data
    }
    return parsed as T
}

// ---------------------------------------------------------------------------
// credential loading helper
// ---------------------------------------------------------------------------

async function requireCred(tmuxdUrl?: string): Promise<SavedCred> {
    const cred = await loadCredentials(tmuxdUrl)
    if (!cred) {
        throw new AuthError(
            tmuxdUrl
                ? `no credentials for ${tmuxdUrl}. Run \`tmuxd login --server ${tmuxdUrl} --server-token ... --user-token ...\` first.`
                : `no credentials saved. Run \`tmuxd login --server <url> --server-token ... --user-token ...\` first.`
        )
    }
    const now = Math.floor(Date.now() / 1000)
    if (cred.expiresAt <= now) {
        throw new AuthError(
            `JWT for ${cred.tmuxdUrl} expired ${now - cred.expiresAt}s ago. ` +
                `Run \`tmuxd login --server ${cred.tmuxdUrl} --server-token ... --user-token ...\` to renew.`
        )
    }
    return cred
}

// ---------------------------------------------------------------------------
// output helpers
// ---------------------------------------------------------------------------

function printJson(value: unknown): void {
    process.stdout.write(JSON.stringify(value, null, 2) + '\n')
}

interface Column<T> {
    header: string
    pick: (row: T) => string
}

function printTable<T>(rows: T[], cols: Column<T>[]): void {
    if (rows.length === 0) {
        process.stdout.write('(none)\n')
        return
    }
    const matrix = [cols.map((c) => c.header), ...rows.map((row) => cols.map((c) => c.pick(row)))]
    const widths = cols.map((_, ci) => Math.max(...matrix.map((row) => row[ci].length)))
    for (const row of matrix) {
        const line = row.map((cell, ci) => cell.padEnd(widths[ci])).join('  ').trimEnd()
        process.stdout.write(line + '\n')
    }
}

// ---------------------------------------------------------------------------
// response shapes — imported from @tmuxd/shared so the CLI fails to compile
// (rather than silently drifts) when the wire contract changes.
// ---------------------------------------------------------------------------

type HostInfo = SharedHostInfo
type SessionInfo = TargetSession
type PaneInfo = TargetPane
type CaptureResponse = TmuxPaneCapture
type PaneStatusResponse = TmuxPaneStatus

/**
 * Resolve a token (server or user) from one of:
 *   1. --<name> flag value
 *   2. --<name>-file <path>: file mode-checked the same way credentials.json is
 *   3. <env-var-name> env var
 *
 * Returns null if no source is set; throws if a configured source is
 * unreadable / mode-leaky.
 */
async function readSecretInput(
    flags: Record<string, string>,
    flagName: string,
    fileFlagName: string,
    envName: string
): Promise<string | null> {
    if (flags[flagName]) return flags[flagName]
    const file = flags[fileFlagName]
    if (file) {
        // Refuse to load a token file that's group/world readable. Mirror
        // the cliCredentials.ts mode-0600 stance so users get one
        // consistent hardening story across everything that touches
        // secrets.
        let st
        try {
            st = await lstat(file)
        } catch (err) {
            const reason = err instanceof Error ? err.message : String(err)
            throw usageError(`cannot read --${fileFlagName} ${file}: ${reason}`)
        }
        if (st.isSymbolicLink()) {
            throw usageError(
                `--${fileFlagName} ${file} is a symlink. Refusing to follow ` +
                    `(point at the real file).`
            )
        }
        if (!st.isFile()) {
            throw usageError(`--${fileFlagName} ${file} is not a regular file.`)
        }
        const mode = st.mode & 0o777
        if ((mode & 0o077) !== 0) {
            const got = mode.toString(8).padStart(3, '0')
            throw usageError(
                `--${fileFlagName} ${file} mode is ${got}, must be 0600 (or stricter). ` +
                    `Run: chmod 600 ${file}`
            )
        }
        const raw = await readFile(file, 'utf8')
        return raw.replace(/\r?\n$/, '')
    }
    const env = process.env[envName]?.trim()
    if (env) return env
    return null
}

async function cmdLogin(args: ParsedArgs): Promise<number> {
    const tmuxdUrl = getHubFlag(args)?.replace(/\/+$/, '')
    if (!tmuxdUrl) {
        throw usageError('login requires --hub <url>')
    }
    const serverToken = await readSecretInput(
        args.flags,
        'server-token',
        'server-token-file',
        'TMUXD_SERVER_TOKEN'
    )
    if (!serverToken) {
        throw usageError(
            'login requires --server-token <secret> ' +
                '(or --server-token-file <path>, or TMUXD_SERVER_TOKEN env). ' +
                'This is the shared team token from your hub admin.'
        )
    }
    // --user-token-generate is the first-time-setup escape hatch: mint
    // a fresh personal identity, print it to stderr, persist it as the
    // login credential. It MUST take precedence over env / flag / file
    // sources, otherwise a stale TMUXD_USER_TOKEN in the user's shell
    // (e.g. inherited from .env, or set on a previous identity) will
    // silently shadow the generate request — the user gets the OLD
    // identity, the hub stamps them into the OLD namespace, and the
    // intent ("give me a new identity") is dropped on the floor with
    // no warning. That's the bug the API review caught.
    //
    // We also refuse outright if --user-token-generate is combined
    // with an explicit --user-token / --user-token-file, because the
    // user's intent is genuinely ambiguous and silently picking either
    // one is wrong. Env vars are tolerated (they're often "ambient"
    // and the user may not even remember setting them) — we just log
    // that we ignored them.
    let userToken: string | null
    if (args.flags['user-token-generate']) {
        if (args.flags['user-token'] || args.flags['user-token-file']) {
            throw usageError(
                '--user-token-generate cannot be combined with --user-token / ' +
                    '--user-token-file. Pick one: generate a fresh identity, OR ' +
                    'authenticate with an existing one.'
            )
        }
        if (process.env.TMUXD_USER_TOKEN?.trim()) {
            // Don't silently honor it; don't silently override it; tell
            // the user we're overriding so they don't end up confused
            // about which identity they just logged in as.
            process.stderr.write(
                `tmuxd: --user-token-generate is set, ignoring TMUXD_USER_TOKEN env var.\n`
            )
        }
        userToken = generateUserToken()
        process.stderr.write(
            `tmuxd: generated user token (save this somewhere safe — it IS your identity):\n` +
                `\n` +
                `    ${userToken}\n` +
                `\n` +
                `IMPORTANT: this token IS your permanent identity on this hub. To see\n` +
                `the same sessions from another device (laptop, phone, agent box), set\n` +
                `the SAME token there — do not run --user-token-generate again on each\n` +
                `device, or you will land in a different namespace and your sessions\n` +
                `will be invisible. Save the token in a password manager, then on each\n` +
                `subsequent device:\n` +
                `\n` +
                `    tmuxd login --server ${tmuxdUrl} --server-token ... \\\n` +
                `                --user-token <the value above>\n` +
                `\n` +
                `Or set TMUXD_USER_TOKEN=<value> in that machine's shell environment.\n`
        )
    } else {
        userToken = await readSecretInput(
            args.flags,
            'user-token',
            'user-token-file',
            'TMUXD_USER_TOKEN'
        )
    }
    if (!userToken) {
        throw usageError(
            'login requires --user-token <secret> (or --user-token-file <path>, ' +
                'or TMUXD_USER_TOKEN env, or --user-token-generate for first-time setup). ' +
                'This is your personal token; the hub uses sha256(userToken) as your namespace.'
        )
    }

    // Warn if the user is sending a JWT-bearing request over plain http://
    // to a non-loopback host. Refusing outright is too aggressive for
    // labs/internal-network deployments, but every operator should know
    // their JWT is sniffable on the path. Localhost stays silent because
    // the only attacker who can sniff loopback already owns the box.
    warnInsecureHubScheme(tmuxdUrl)
    const url = tmuxdUrl + '/api/auth'
    let res: Response
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serverToken, userToken })
        })
    } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        throw new ApiError(0, 'network_error', `failed to reach ${url}: ${reason}`)
    }
    const text = await res.text()
    let body: { token?: string; expiresAt?: number; namespace?: string; error?: string } = {}
    if (text) {
        try {
            body = JSON.parse(text)
        } catch {
            body = {}
        }
    }
    if (!res.ok) {
        if (res.status === 401) {
            throw new AuthError(`hub rejected the tokens (${body.error ?? `http_${res.status}`}).`)
        }
        throw new ApiError(res.status, body.error ?? `http_${res.status}`, `login failed: ${text || res.statusText}`)
    }
    if (!body.token || !body.expiresAt || !body.namespace) {
        throw new ApiError(res.status, 'invalid_response', 'login response missing token / expiresAt / namespace')
    }
    await saveCredentials({
        tmuxdUrl,
        jwt: body.token,
        expiresAt: body.expiresAt,
        namespace: body.namespace,
        // Persist the user/server tokens so we can re-login automatically
        // when the JWT expires. They're already in ~/.tmuxd/cli/credentials.json
        // (mode 0600) — same threat model as the JWT itself.
        serverToken,
        userToken
    })
    const ttl = body.expiresAt - Math.floor(Date.now() / 1000)
    process.stdout.write(
        `logged in to ${tmuxdUrl} as namespace=${body.namespace}; JWT TTL ${formatDuration(ttl)}\n` +
            `credentials saved to ${credentialsPath()} (mode 0600)\n`
    )
    return 0
}

async function cmdLogout(args: ParsedArgs): Promise<number> {
    const cred = await loadCredentials(getHubFlag(args))
    if (!cred) {
        process.stdout.write('no credentials to clear\n')
        return 0
    }
    await clearCredentials(cred.tmuxdUrl)
    process.stdout.write(`cleared credentials for ${cred.tmuxdUrl}\n`)
    return 0
}

async function cmdWhoami(args: ParsedArgs): Promise<number> {
    const cred = await loadCredentials(getHubFlag(args))
    if (!cred) {
        // Per the documented exit-code contract, "no credentials" is an auth
        // error → exit 2. Routing through AuthError keeps the message style
        // consistent with the rest of the auth surface and matches what users
        // see from `tmuxd list-hosts` etc. when they've never logged in.
        throw new AuthError(
            getHubFlag(args)
                ? `not logged in to ${getHubFlag(args)}. Run \`tmuxd login --server ${getHubFlag(args)} --server-token ... --user-token ...\`.`
                : 'not logged in. Run `tmuxd login --server <url> --server-token ... --user-token ...`.'
        )
    }
    const ttl = cred.expiresAt - Math.floor(Date.now() / 1000)
    if (args.flags.json) {
        printJson({
            tmuxdUrl: cred.tmuxdUrl,
            namespace: cred.namespace,
            expiresAt: cred.expiresAt,
            ttlSeconds: ttl,
            credentialsPath: credentialsPath()
        })
        return 0
    }
    process.stdout.write(
        `hub:        ${cred.tmuxdUrl}\n` +
            `namespace:  ${cred.namespace}\n` +
            `JWT TTL:    ${formatDuration(ttl)}${ttl < 1800 ? ' (re-login soon)' : ''}\n` +
            `creds file: ${credentialsPath()}\n`
    )
    // Expired JWT → still prints the diagnostic above but exits 2 so scripts
    // can detect the condition without parsing stdout.
    if (ttl <= 0) {
        throw new AuthError(`JWT for ${cred.tmuxdUrl} has expired. Run \`tmuxd login\` again.`)
    }
    return 0
}

async function cmdListHosts(args: ParsedArgs): Promise<number> {
    const cred = await requireCred(getHubFlag(args))
    const { hosts } = await api(cred, '/api/hosts', { schema: hostsResponseSchema })
    if (args.flags.json) {
        printJson(hosts)
        return 0
    }
    printTable(hosts, [
        { header: 'HOST', pick: (h) => h.id },
        { header: 'NAME', pick: (h) => h.name },
        { header: 'STATUS', pick: (h) => h.status },
        { header: 'KIND', pick: (h) => (h.isLocal ? 'local' : 'client') },
        { header: 'CAPS', pick: (h) => (h.capabilities ?? []).join(',') }
    ])
    return 0
}

async function cmdListSessions(args: ParsedArgs): Promise<number> {
    const cred = await requireCred(getHubFlag(args))
    const target = args.flags.target ? parseTarget(args.flags.target) : null
    let sessions: SessionInfo[]
    if (target) {
        const { sessions: list } = await api(
            cred,
            `/api/hosts/${encodeURIComponent(target.hostId)}/sessions`,
            { treat404AsNotFound: true, schema: hostScopedSessionsResponseSchema }
        )
        sessions = list
    } else {
        // No -t: aggregate across all hosts. We deliberately tolerate per-host
        // failures so that one offline agent doesn't blank-out the whole
        // table — but every error other than "host disappeared between
        // /api/hosts and the per-host call" gets a stderr warning so the
        // operator can see they're looking at a partial result.
        const { hosts } = await api(cred, '/api/hosts', { schema: hostsResponseSchema })
        sessions = []
        for (const host of hosts) {
            try {
                const { sessions: list } = await api(
                    cred,
                    `/api/hosts/${encodeURIComponent(host.id)}/sessions`,
                    { treat404AsNotFound: true, schema: hostScopedSessionsResponseSchema }
                )
                sessions.push(...list.map((s) => ({ ...s, hostId: host.id, hostName: host.name })))
            } catch (err) {
                warnAggregateHostFailure('list-sessions', host.id, err)
            }
        }
    }
    if (args.flags.json) {
        printJson(sessions)
        return 0
    }
    printTable(sessions, [
        { header: 'HOST', pick: (s) => s.hostId ?? '?' },
        { header: 'SESSION', pick: (s) => s.name },
        { header: 'WINDOWS', pick: (s) => String(s.windows) },
        { header: 'ATTACHED', pick: (s) => (s.attached ? `yes (${s.attachedClients})` : 'no') },
        { header: 'ACTIVITY', pick: (s) => formatRelative(s.activity) }
    ])
    return 0
}

async function cmdNewSession(args: ParsedArgs): Promise<number> {
    const cred = await requireCred(getHubFlag(args))
    const targetHost = args.flags.target ? parseTarget(args.flags.target).hostId : null
    const name = args.flags.name
    const body: { name?: string } = name ? { name } : {}
    const path = targetHost
        ? `/api/hosts/${encodeURIComponent(targetHost)}/sessions`
        : '/api/sessions'
    let result: { session?: SessionInfo; ok?: boolean }
    try {
        result = await api<{ session?: SessionInfo; ok?: boolean }>(cred, path, {
            method: 'POST',
            body,
            treat404AsNotFound: true
        })
    } catch (err) {
        // 409 from `/sessions` always means name collision. The generic
        // ApiError message ("POST /api/.../sessions → 409 session_exists")
        // tells you the wire result; this rewrite tells you what to *do*.
        // Both end up at exit 1, but the operator-visible string is the
        // difference between "what does that even mean" and "rename it".
        if (err instanceof ApiError && err.status === 409) {
            const where = targetHost ? `${targetHost}` : 'local'
            const hint = name
                ? ` Pick a different -s <name> or run \`tmuxd kill-session -t ${where}:${name}\` first.`
                : ` Pick a different -s <name>.`
            throw new ApiError(
                409,
                'session_exists',
                `session ${name ?? '(unnamed)'} already exists on ${where}.${hint}`
            )
        }
        throw err
    }
    if (args.flags.json) {
        printJson(result)
        return 0
    }
    const session = result.session
    if (session) {
        process.stdout.write(`created ${targetHost ?? 'local'}:${session.name}\n`)
    } else {
        process.stdout.write(`created session on ${targetHost ?? 'local'}\n`)
    }
    return 0
}

async function cmdKillSession(args: ParsedArgs): Promise<number> {
    const target = requireTarget(args, 'kill-session', 'expected -t <host>:<session>')
    if (!target.sessionName) throw usageError('kill-session requires -t <host>:<session>')
    const cred = await requireCred(getHubFlag(args))
    await api<void>(
        cred,
        `/api/hosts/${encodeURIComponent(target.hostId)}/sessions/${encodeURIComponent(target.sessionName)}`,
        { method: 'DELETE', treat404AsNotFound: true }
    )
    if (!args.flags.json) {
        process.stdout.write(`killed ${target.hostId}:${target.sessionName}\n`)
    }
    return 0
}

async function cmdListPanes(args: ParsedArgs): Promise<number> {
    const cred = await requireCred(getHubFlag(args))
    const target = args.flags.target ? parseTarget(args.flags.target) : null
    let panes: PaneInfo[]
    if (target) {
        let path = `/api/hosts/${encodeURIComponent(target.hostId)}/panes`
        if (target.sessionName) {
            path += `?session=${encodeURIComponent(target.sessionName)}`
        }
        const { panes: list } = await api(cred, path, {
            treat404AsNotFound: true,
            schema: hostScopedPanesResponseSchema
        })
        panes = list
    } else {
        // Same per-host tolerance as cmdListSessions: one host's failure
        // shouldn't blank the table; warn instead.
        const { hosts } = await api(cred, '/api/hosts', { schema: hostsResponseSchema })
        panes = []
        for (const host of hosts) {
            try {
                const { panes: list } = await api(
                    cred,
                    `/api/hosts/${encodeURIComponent(host.id)}/panes`,
                    { treat404AsNotFound: true, schema: hostScopedPanesResponseSchema }
                )
                panes.push(...list)
            } catch (err) {
                warnAggregateHostFailure('list-panes', host.id, err)
            }
        }
    }
    if (args.flags.json) {
        printJson(panes)
        return 0
    }
    printTable(panes, [
        { header: 'HOST', pick: (p) => p.hostId ?? '?' },
        { header: 'TARGET', pick: (p) => p.target },
        { header: 'PANE', pick: (p) => p.paneId },
        { header: 'CMD', pick: (p) => p.currentCommand ?? '' },
        { header: 'PATH', pick: (p) => p.currentPath ?? '' },
        { header: 'SIZE', pick: (p) => p.width && p.height ? `${p.width}x${p.height}` : '' }
    ])
    return 0
}

async function cmdCapturePane(args: ParsedArgs): Promise<number> {
    const target = requireTarget(args, 'capture-pane', 'expected -t <host>:<target>')
    if (!target.paneTarget && !target.sessionName) {
        throw usageError('capture-pane requires a pane target like -t laptop:main:0.0 or -t laptop:%7')
    }
    const cred = await requireCred(getHubFlag(args))
    const paneTarget = target.paneTarget ?? `${target.sessionName}:0.0`
    const params = new URLSearchParams()
    if (args.flags.lines) params.set('lines', args.flags.lines)
    if (args.flags['max-bytes']) params.set('maxBytes', args.flags['max-bytes'])
    const qs = params.toString()
    const path = `/api/hosts/${encodeURIComponent(target.hostId)}/panes/${encodeURIComponent(paneTarget)}/capture${qs ? '?' + qs : ''}`
    const cap = await api(cred, path, { treat404AsNotFound: true, schema: tmuxPaneCaptureSchema })
    if (args.flags.json) {
        printJson(cap)
        return 0
    }
    process.stdout.write(cap.text)
    if (!cap.text.endsWith('\n')) process.stdout.write('\n')
    if (cap.truncated) {
        process.stderr.write(`(capture truncated to newest ${cap.maxBytes} bytes)\n`)
    }
    return 0
}

async function cmdPaneStatus(args: ParsedArgs): Promise<number> {
    // The `display-message` alias is also routed here for backwards
    // compatibility; we surface the same verb name in the error
    // strings either way (callers see the verb they typed).
    const verb = args.cmd ?? 'pane-status'
    const target = requireTarget(args, verb, `expected -t <host>:<target>`)
    if (!target.paneTarget && !target.sessionName) {
        throw usageError(`${verb} requires a pane target`)
    }
    const cred = await requireCred(getHubFlag(args))
    const paneTarget = target.paneTarget ?? `${target.sessionName}:0.0`
    const params = new URLSearchParams()
    if (args.flags.lines) params.set('lines', args.flags.lines)
    if (args.flags['max-bytes']) params.set('maxBytes', args.flags['max-bytes'])
    const qs = params.toString()
    const path = `/api/hosts/${encodeURIComponent(target.hostId)}/panes/${encodeURIComponent(paneTarget)}/status${qs ? '?' + qs : ''}`
    const status = await api(cred, path, { treat404AsNotFound: true, schema: tmuxPaneStatusSchema })
    if (args.flags.json) {
        printJson(status)
        return 0
    }
    process.stdout.write(
        `target:   ${status.target}\n` +
            `state:    ${status.state}\n` +
            `light:    ${status.activity?.light ?? 'gray'}\n` +
            (status.summary ? `summary:  ${status.summary}\n` : '')
    )
    return 0
}

/**
 * Deprecated alias. Existing scripts and the original docs called this
 * `display-message`, but in tmux that verb formats a status string —
 * the semantic mismatch was the #1 UX-review finding. The canonical
 * verb is now `pane-status`. We keep this alias so old scripts keep
 * working; consider removing in a future major release.
 */
async function cmdDisplayMessage(args: ParsedArgs): Promise<number> {
    process.stderr.write(
        'tmuxd: warning: `display-message` is a deprecated alias for `pane-status`. ' +
            'Update your scripts; this alias will be removed in a future release.\n'
    )
    return cmdPaneStatus(args)
}

async function cmdSendKeys(args: ParsedArgs): Promise<number> {
    const target = requireTarget(args, 'send-keys', 'expected -t <host>:<target>')
    if (!target.paneTarget && !target.sessionName) {
        throw usageError('send-keys requires a pane target')
    }
    if (args.positional.length === 0) {
        throw usageError('send-keys requires at least one key')
    }
    const cred = await requireCred(getHubFlag(args))
    const paneTarget = target.paneTarget ?? target.sessionName!
    const path = `/api/hosts/${encodeURIComponent(target.hostId)}/panes/${encodeURIComponent(paneTarget)}/keys`
    await api(cred, path, {
        method: 'POST',
        body: { keys: args.positional },
        treat404AsNotFound: true,
        schema: okResponseSchema
    })
    if (!args.flags.json) {
        process.stdout.write(`sent ${args.positional.length} key(s) to ${target.hostId}:${paneTarget}\n`)
    }
    return 0
}

async function cmdSendText(args: ParsedArgs): Promise<number> {
    const target = requireTarget(args, 'send-text', 'expected -t <host>:<target>')
    if (!target.paneTarget && !target.sessionName) {
        throw usageError('send-text requires a pane target')
    }
    if (args.positional.length === 0) {
        throw usageError('send-text requires text to send')
    }
    const cred = await requireCred(getHubFlag(args))
    const paneTarget = target.paneTarget ?? target.sessionName!
    const path = `/api/hosts/${encodeURIComponent(target.hostId)}/panes/${encodeURIComponent(paneTarget)}/input`
    const text = args.positional.join(' ')
    await api(cred, path, {
        method: 'POST',
        body: { text, enter: !!args.flags.enter },
        treat404AsNotFound: true,
        schema: okResponseSchema
    })
    if (!args.flags.json) {
        process.stdout.write(`sent ${text.length} char(s) to ${target.hostId}:${paneTarget}\n`)
    }
    return 0
}

async function cmdSnapshot(args: ParsedArgs): Promise<number> {
    const cred = await requireCred(getHubFlag(args))
    const params = new URLSearchParams()
    if (args.flags.capture) params.set('capture', '1')
    if (args.flags.limit) params.set('captureLimit', args.flags.limit)
    if (args.flags.lines) params.set('lines', args.flags.lines)
    if (args.flags['max-bytes']) params.set('maxBytes', args.flags['max-bytes'])
    const qs = params.toString()
    const path = `/api/client/snapshot${qs ? '?' + qs : ''}`
    const snap = await api<unknown>(cred, path)
    printJson(snap)
    return 0
}

/**
 * `tmuxd init <mode>` — bootstrap a .env for server / relay / client.
 * The first positional argument is the mode; everything after is flag
 * data consumed by `writeEnvFile`. We deliberately keep this thin:
 * validation, defaulting, and rendering all live in `cliInit.ts` so
 * unit tests don't need to spin up the whole CLI.
 *
 * On success:
 *   - the .env is written to CWD at mode 0600
 *   - if a server token was auto-generated (server/relay only), it
 *     gets printed to stderr ONCE with a "save this somewhere safe"
 *     warning. We never re-print, never persist, never re-derive.
 *   - stdout gets a one-liner with the path written
 */
async function cmdInit(args: ParsedArgs): Promise<number> {
    const mode = args.positional[0]
    if (!mode || (mode !== 'server' && mode !== 'relay' && mode !== 'client')) {
        throw usageError(
            `init requires one of: server | relay | client. Got: ${mode ?? '(none)'}`
        )
    }
    const force = !!args.flags.force
    const port = args.flags.port ? Number(args.flags.port) : undefined

    // Server / relay: special handling for the server-token sourcing.
    //
    // The default for `init server|relay` is "mint a fresh trust-circle
    // token, print it once to stderr." That intent gets silently
    // shadowed if the user has TMUXD_SERVER_TOKEN already exported in
    // their shell — a likely state, since they're standing up tmuxd.
    // The same shape bit us with --user-token-generate on cmdLogin (see
    // the postmortem comment block in cmdLogin); we don't repeat the
    // mistake here.
    //
    // Rule: for `init server|relay`, an env-var-only source is treated
    // as ambiguous unless the user explicitly opts in. They have three
    // unambiguous paths:
    //
    //   1. Pass --server-token <value>: use that exact token.
    //   2. Pass --server-token-from-env: explicitly opt into the env
    //      var. Useful for scripts that are passing a token they
    //      already minted via some external secret store.
    //   3. Don't set the env var: let init mint a fresh one.
    //
    // Bare `init server` with TMUXD_SERVER_TOKEN exported in the shell
    // throws a UsageError instead of silently picking either path.
    let serverToken: string | undefined
    if (mode === 'server' || mode === 'relay') {
        const flagSrc = args.flags['server-token']
        const envSrc = process.env.TMUXD_SERVER_TOKEN?.trim()
        const optedIn = !!args.flags['server-token-from-env']
        if (flagSrc && optedIn) {
            throw usageError(
                '--server-token and --server-token-from-env cannot be combined. Pick one source.'
            )
        }
        if (flagSrc) {
            serverToken = flagSrc
        } else if (optedIn) {
            if (!envSrc) {
                throw usageError(
                    '--server-token-from-env was set, but TMUXD_SERVER_TOKEN is empty in the environment.'
                )
            }
            serverToken = envSrc
        } else if (envSrc) {
            // Bare `init server|relay` with the env var set: the only
            // case where we refuse rather than guess. Tell the user
            // exactly which two outs they have.
            throw usageError(
                `TMUXD_SERVER_TOKEN is set in your environment, but neither ` +
                    `--server-token <value> nor --server-token-from-env was passed. ` +
                    `\`init ${mode}\` won't silently reuse the env var (you might be expecting ` +
                    `a fresh token to be minted). Pick one:\n` +
                    `  - Mint a fresh token: \`unset TMUXD_SERVER_TOKEN; tmuxd init ${mode}\`\n` +
                    `  - Reuse the env var:  \`tmuxd init ${mode} --server-token-from-env\`\n` +
                    `  - Pass it explicitly: \`tmuxd init ${mode} --server-token "$TMUXD_SERVER_TOKEN"\``
            )
        }
        // else: fall through — writeEnvFile mints a fresh token.
    } else {
        // mode === 'client'. The client flow EXPECTS the user to supply
        // a server token + user token; env-var fallback is the
        // ergonomic path (the user's shell may already have them
        // exported). Same fallback semantics as cmdLogin — flag wins,
        // env is ambient. No surprise here because the client init has
        // no auto-generate option.
        serverToken =
            args.flags['server-token'] || process.env.TMUXD_SERVER_TOKEN?.trim() || undefined
    }

    let result
    try {
        if (mode === 'server' || mode === 'relay') {
            result = await writeEnvFile(mode, {
                force,
                port,
                serverToken,
                publicBind: !!args.flags.public
            })
        } else {
            // mode === 'client'
            const tmuxdUrl =
                args.flags.url || getHubFlag(args) || process.env.TMUXD_URL?.trim() || undefined
            const userToken =
                args.flags['user-token'] || process.env.TMUXD_USER_TOKEN?.trim() || undefined
            if (!tmuxdUrl) {
                throw usageError(
                    'init client requires --url <server-url> (or TMUXD_URL env). ' +
                        'Example: --url https://tmuxd.example.com'
                )
            }
            if (!serverToken) {
                throw usageError(
                    'init client requires --server-token <secret> (or TMUXD_SERVER_TOKEN env). ' +
                        'Get this from your server admin.'
                )
            }
            if (!userToken) {
                throw usageError(
                    'init client requires --user-token <secret> (or TMUXD_USER_TOKEN env). ' +
                        'This is your personal token; reuse the same value across devices.'
                )
            }
            result = await writeEnvFile('client', {
                force,
                tmuxdUrl,
                serverToken,
                userToken,
                hostId: args.flags['host-id'] || undefined,
                hostName: args.flags['host-name'] || undefined
            })
        }
    } catch (err) {
        // Refuse-to-overwrite + missing-required-flag are genuine usage
        // errors — surface them as exit-1 so scripts can detect.
        if (err instanceof Error && /already exists/.test(err.message)) {
            throw usageError(err.message)
        }
        throw err
    }

    if (result.generatedServerToken) {
        process.stderr.write(
            `tmuxd: generated server token (save this somewhere safe — anyone with it\n` +
                `can use this server):\n` +
                `\n` +
                `    ${result.generatedServerToken}\n` +
                `\n` +
                `Also written to ${result.path} as TMUXD_SERVER_TOKEN; recover with\n` +
                `\`grep ^TMUXD_SERVER_TOKEN= ${result.path}\` if you lose this scrollback.\n` +
                `\n` +
                `Distribute it through whatever channel you trust for team secrets\n` +
                `(1Password, shared vault, etc). Each user pairs it with their own\n` +
                `personal user token via \`tmuxd login --user-token-generate\` on\n` +
                `their first device.\n` +
                `\n` +
                `If you ran this under a process supervisor (systemd / journald /\n` +
                `pm2 / docker logs), the token may now be in the supervisor's log.\n` +
                `Rotate it if that's not acceptable.\n`
        )
    }
    process.stdout.write(`wrote ${result.path} (mode 0600)\n`)
    return 0
}

/**
 * Stub — `attach-session` over the wire is non-trivial: WebSocket,
 * raw-TTY mode, SIGWINCH propagation, ping/pong, ticket consumption.
 * We don't ship that today, but listing the verb in --help with a 404
 * mental model is worse than this stub which points the user at the
 * web UI deep-link instead. The web UI does the real attach over the
 * exact same WebSocket the CLI would use, just rendered in xterm.js.
 *
 * Two failure modes to be specific about:
 *   - No creds → AuthError (exit 2). Same as every other verb.
 *   - Target missing → UsageError (exit 1). Tell them what -t expects.
 *
 * On success, exit 0 and write the URL to stdout (so a script can
 * pipe it into `xdg-open`/`open`). The URL format is what the web
 * UI uses today; if the web UI's URL scheme changes, this will
 * follow.
 */
async function cmdAttachSession(args: ParsedArgs): Promise<number> {
    const target = requireTarget(args, 'attach-session', 'expected -t <host>:<session>')
    if (!target.sessionName) {
        throw usageError('attach-session requires -t <host>:<session>')
    }
    const cred = await requireCred(getHubFlag(args))
    // The web UI exposes attach as `/attach/<host>/<session>` for non-local
    // hosts and `/attach/<session>` for local. We always emit the
    // host-qualified form because the CLI reaches a hub whose `local`
    // (if any) is just one host among many.
    const url = `${cred.tmuxdUrl.replace(/\/+$/, '')}/attach/${encodeURIComponent(target.hostId)}/${encodeURIComponent(target.sessionName)}`
    if (args.flags.json) {
        printJson({ attachUrl: url, hostId: target.hostId, sessionName: target.sessionName })
        return 0
    }
    process.stderr.write(
        'tmuxd: in-CLI attach is not yet implemented — opening the session\n' +
            'in the web UI is the supported path. The URL below is a working\n' +
            'deep-link; pipe through `xdg-open` (Linux) or `open` (macOS), or\n' +
            'paste into a browser already logged in to the hub.\n'
    )
    process.stdout.write(url + '\n')
    return 0
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function requireTarget(args: ParsedArgs, _cmd: string, hint: string): ParsedTarget {
    if (!args.flags.target) throw usageError(hint)
    return parseTarget(args.flags.target)
}

/**
 * Stderr-warn when the operator is about to ship a JWT over plain
 * http:// to a non-loopback host. Localhost is fine because the only
 * attacker who can sniff loopback already owns the box. Anything else
 * — including private RFC1918 ranges — gets the warning, because
 * "private network" is rarely as private as people think (Wi-Fi
 * coffeeshop, shared VPC, container-host bridge, etc).
 *
 * Set TMUXD_INSECURE_HTTP=1 to silence the warning if the operator
 * has read this comment, accepted the risk, and wants quiet logs.
 */
export function warnInsecureHubScheme(tmuxdUrl: string): void {
    if (process.env.TMUXD_INSECURE_HTTP === '1') return
    let parsed: URL
    try {
        parsed = new URL(tmuxdUrl)
    } catch {
        // Malformed URL — fetch will fail soon and surface a real error.
        return
    }
    if (parsed.protocol !== 'http:') return
    // URL parsing returns IPv6 hostnames bracketed (`[::1]`); strip
    // brackets so the loopback comparison works for both `127.0.0.1`
    // and `::1`.
    const host = parsed.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost')) {
        return
    }
    process.stderr.write(
        `tmuxd: warning: --hub uses plain http:// to ${host}. ` +
            `The JWT issued by /api/auth will be sent in cleartext on every subsequent ` +
            `request and is sniffable by anyone on the network path. ` +
            `Use https:// or an SSH tunnel for production.\n` +
            `(Set TMUXD_INSECURE_HTTP=1 to silence this warning.)\n`
    )
}

/**
 * Stderr-warn that one host failed during an aggregate query and was
 * dropped from the result. Suppressed when stdout is being piped to JSON
 * — the operator is presumably scripting, and we don't want stderr
 * scribbles polluting their tooling. They get the same observability
 * by re-running with -t HOSTID for the offending host.
 *
 * 404 (NotFoundError) is silent: it only fires when /api/hosts and the
 * per-host call disagree, which is normal during agent disconnects.
 */
function warnAggregateHostFailure(verb: string, hostId: string, err: unknown): void {
    if (err instanceof NotFoundError) return
    const reason = err instanceof Error ? err.message : String(err)
    process.stderr.write(`tmuxd: warning: ${verb} skipped host ${hostId}: ${reason}\n`)
}

function formatDuration(seconds: number): string {
    if (seconds <= 0) return 'expired'
    const h = Math.floor(seconds / 3600)
    const m = Math.floor((seconds % 3600) / 60)
    const s = seconds % 60
    if (h > 0) return `${h}h${m}m`
    if (m > 0) return `${m}m${s}s`
    return `${s}s`
}

function formatRelative(epochSeconds: number): string {
    const diff = Math.floor(Date.now() / 1000) - epochSeconds
    if (diff < 60) return `${diff}s ago`
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
    return `${Math.floor(diff / 86400)}d ago`
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const SUBCOMMANDS: Record<string, (a: ParsedArgs) => Promise<number>> = {
    login: cmdLogin,
    logout: cmdLogout,
    whoami: cmdWhoami,
    'list-hosts': cmdListHosts,
    'list-sessions': cmdListSessions,
    'new-session': cmdNewSession,
    'kill-session': cmdKillSession,
    'list-panes': cmdListPanes,
    'capture-pane': cmdCapturePane,
    'pane-status': cmdPaneStatus,
    // Deprecated alias kept for backwards compat — see cmdDisplayMessage.
    'display-message': cmdDisplayMessage,
    'send-keys': cmdSendKeys,
    'send-text': cmdSendText,
    'attach-session': cmdAttachSession,
    snapshot: cmdSnapshot,
    init: cmdInit
}

async function main(): Promise<number> {
    const args = parseArgs(process.argv.slice(2))
    if (args.flags.version) {
        process.stdout.write(`tmuxd ${VERSION}\n`)
        return 0
    }
    if (!args.cmd || args.flags.help) {
        if (args.cmd && SUBCOMMANDS[args.cmd]) {
            // `tmuxd <verb> --help` prints the subcommand block (or falls
            // back to root help if no per-subcommand block is registered).
            printSubcommandHelp(args.cmd)
            return 0
        }
        printRootHelp()
        return args.cmd ? 1 : 0
    }
    const handler = SUBCOMMANDS[args.cmd]
    if (!handler) {
        process.stderr.write(`unknown subcommand: ${args.cmd}\n`)
        printRootHelp()
        return 1
    }
    return handler(args)
}

// Only run main when invoked as a script, not when imported by tests.
// `import.meta.main` would be cleaner but isn't node-stable yet; the
// `argv[1] === fileURLToPath(import.meta.url)` check is the canonical
// ESM equivalent. Tests can `import { warnInsecureHubScheme } from './cli.ts'`
// without triggering the top-level main() side effect.
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'

function isMainModule(): boolean {
    if (!process.argv[1]) return false
    try {
        const here = fileURLToPath(import.meta.url)
        // realpath both sides to defang symlinked node_modules and `tsx` shims
        return realpathSync(process.argv[1]) === realpathSync(here)
    } catch {
        return false
    }
}

if (isMainModule()) {
    main()
        .then((code) => process.exit(code))
        .catch((err) => {
            if (err instanceof UsageError) {
                process.stderr.write(`tmuxd: ${err.message}\n`)
                process.exit(1)
            }
            if (err instanceof AuthError) {
                process.stderr.write(`tmuxd: ${err.message}\n`)
                process.exit(2)
            }
            if (err instanceof NotFoundError) {
                process.stderr.write(`tmuxd: ${err.message}\n`)
                process.exit(3)
            }
            if (err instanceof ApiError) {
                process.stderr.write(`tmuxd: ${err.message}\n`)
                process.exit(1)
            }
            const reason = err instanceof Error ? err.message : String(err)
            process.stderr.write(`tmuxd: ${reason}\n`)
            process.exit(1)
        })
}
