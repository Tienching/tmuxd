# Changelog

Notable user-visible changes. Internal refactors and bug fixes that
don't change the wire contract or operator-facing surface live in git
history; this file tracks the things you'd want to know before
upgrading a deployment.

## Unreleased

### ⚠️ Breaking — vocabulary rename

The three roles in tmuxd have been renamed across code, docs, env vars,
and audit events. Old names removed, no compat shim.

- **"hub" → "server"** — the box running `npm start`.
- **"hub-only mode" → "relay"** — a server with `TMUXD_RELAY=1` set.
  (Same binary, same routes; refuses to host tmux sessions itself.)
- **"agent" → "client"** — the outbound process that exposes a
  machine's local tmux to a remote server.

#### Wire-level changes (operator action required)

| Old | New |
|---|---|
| `GET /agent/connect` | `GET /client/connect` |
| `GET /api/agent/snapshot` | `GET /api/client/snapshot` |
| audit event `agent_register` | `client_register` |
| audit event `agent_rejected` | `client_rejected` |
| audit event `agent_disconnect` | `client_disconnect` |
| audit reason `agent_error` | `client_error` |
| audit reason `agent_timeout` | `client_timeout` |
| audit reason `agent_disconnected` | `client_disconnected` |
| `npm run agent` | `npm run client` |
| `.env.agent.example` | `.env.client.example` |
| `docs/hub-mode.md` | `docs/relay-deployment.md` |

**SIEM / log-aggregation operators**: any rule keyed on `agent_register`,
`agent_disconnect`, or `agent_rejected` will silently stop firing on
the next deploy. Update your filters before upgrading. There is **no
dual-emit period** — the next release emits only the new names.

The `--hub <url>` CLI flag has been kept as a back-compat alias for
the new canonical `--server <url>`. Both work; new code should use
`--server`.

The env-var equivalent for `--server` / `--hub` is `TMUXD_URL`
(unchanged from before the rename — it never had `HUB` in its name).

### New: `tmuxd init {server,relay,client}`

A bootstrap subcommand that writes a `.env` for the chosen deployment
shape. Rather than copying `.env.example` and hand-editing.

- `tmuxd init server` — Mode A (loopback) by default; `--public` for
  Mode B. Generates a fresh `TMUXD_SERVER_TOKEN` and prints it once
  to stderr (also written to `.env`; recover with `grep
  ^TMUXD_SERVER_TOKEN= .env`).
- `tmuxd init relay` — Mode C (`TMUXD_RELAY=1`, `HOST=0.0.0.0`).
- `tmuxd init client` — outbound `.env` for a client box; requires
  `--url`, `--server-token`, `--user-token` (or env-var equivalents).
- `--force` to overwrite an existing `.env`. Symlinks at the target
  path are rejected (no exception, even with `--force`) — `tmuxd
  init` will not write secrets through a symlink.
- `--server-token-from-env` to explicitly opt into reusing
  `TMUXD_SERVER_TOKEN` from your shell. Without this flag (or
  `--server-token`), bare `init server` errors out when
  `TMUXD_SERVER_TOKEN` is set in the environment — silent reuse of
  an ambient token would defeat the "mint a fresh trust-circle
  key" intent of `init`.

### CLI label: `KIND` column

`tmuxd list-hosts` previously printed `agent` for non-local hosts.
It now prints `client`. Scripts that grep on `^agent$` in that column
need to update.

### Token / `.env` write-path hardening

`tmuxd init` now writes `.env` via `O_NOFOLLOW|O_CREAT|O_EXCL` to a
tmp file, fsyncs, renames over the destination, and explicit-chmods
to 0600. This closes:

- A symlink-redirect attack where a co-tenant pre-creates `.env` as a
  dangling symlink and the operator's freshly minted server token
  ends up at the attacker's path.
- A mode regression where `--force` on a pre-existing 0644 file kept
  the looser mode.

`writeEnvFile` also rejects values with `=`, NUL, Unicode line
separators, leading/trailing whitespace, or > 4 KiB — anything that
could break shell `source .env` round-trip or smuggle a fake `KEY=`
line.
