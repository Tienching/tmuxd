# tmuxd

A local-first web UI for `tmux` sessions. Open your browser, sign in with one shared token, and attach to existing tmux sessions with a full xterm terminal.

![Terminal with session sidebar](docs/screenshots/03-terminal-sidebar.png)

## What it does

- Lists all tmux sessions for the server user.
- Can act as a hub for outbound tmuxd agents, so one page can show tmux sessions from multiple machines.
- Creates, attaches to, and kills tmux sessions from the web UI.
- Creates named sessions or auto-named sessions when you leave the name blank.
- Streams an interactive terminal over WebSocket using xterm.js.
- Saves pasted clipboard images to `~/.tmuxd/uploads` and pastes the saved file path into local sessions.
- Keeps a browser-local **Opened** list for fast switching between recently attached sessions.
- Provides an **Opened / All sessions** side panel on the terminal page, including a quick **New session** action.
- Starts newly-created sessions in the server user's home directory.
- Supports mobile layouts and install-to-home-screen PWA metadata.
- Adds mobile-friendly **Keys** and **Text** controls for special keys and selectable session text.
- Uses shared-token login + short-lived JWTs for the API. Single-user is bare token; multi-user adds `:<namespace>`.
- Uses short-lived one-time WebSocket tickets instead of putting the long-lived JWT in the WebSocket URL.

## Screenshots

### Login

![Login screen](docs/screenshots/01-login.png)

### Session list

![Session list](docs/screenshots/02-sessions.png)

### Terminal attach with centered title and side panel

![Terminal with sidebar](docs/screenshots/03-terminal-sidebar.png)

### Mobile session picker

![Mobile sessions](docs/screenshots/04-mobile-sessions.png)

## Requirements

- Node.js 20+
- npm
- `tmux` on `PATH`
- Linux or macOS. `node-pty` requires a POSIX PTY.

## Quick start

```bash
npm install
cp .env.example .env
# edit .env and set TMUXD_TOKEN
npm run build
npm start
```

Open the URL printed by the server, usually:

```text
http://127.0.0.1:7681
```

Sign in with the value after `TMUXD_TOKEN=` in `.env`. For multi-user deployments, append `:<your-namespace>` (see [docs/hub-mode.md](docs/hub-mode.md)).

## Configuration

`tmuxd` reads `.env` from the project root.

| Variable | Default | Description |
| --- | --- | --- |
| `TMUXD_TOKEN` | required | Shared web-login token. Bare value (`abc123`) → JWT scoped to `default` namespace (single-user). With suffix (`abc123:alice`) → JWT scoped to namespace `alice` (multi-user). One concept, two UX shapes. See [docs/hub-mode.md](docs/hub-mode.md). |
| `TMUXD_HUB_ONLY` | unset | When `1`/`true`, every local-tmux route returns 403 and the local host is hidden from `/api/hosts`. Recommended for multi-user hub deployments. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only when you understand the network exposure. |
| `PORT` | `7681` | HTTP port. |
| `TMUXD_HOME` | `.tmuxd` in CWD | Directory for generated runtime secrets (e.g. `jwt-secret`). |
| `JWT_SECRET` | generated | Optional JWT signing secret. If set manually, it must be at least 32 bytes. Removing the persisted `jwt-secret` file revokes every outstanding JWT on next restart. |
| `TMUXD_TMUX_PATH` | `tmux` on PATH | Override the tmux binary the agent invokes. Useful for non-standard tmux installs. |
| `TMUXD_AUDIT_DISABLE` | unset | When `1`, silences the structured audit log on stderr. Default behavior in production is on. |
| `TMUXD_AGENT_TOKEN` | unset | Enables `/agent/connect` with one shared agent token (binds to default namespace). Use only over trusted networks. |
| `TMUXD_AGENT_TOKENS` | unset | Preferred hub/agent auth: comma-separated entries of `[<namespace>/]<hostId>=<token>`. Binds each agent token to one `(namespace, hostId)` pair. Bare form `<hostId>=<token>` binds into the default namespace. |
| `TMUXD_AGENT_NAMESPACE` | `default` | (Agent CLI) Namespace this agent registers under. Must match the namespace pinned in the hub's `TMUXD_AGENT_TOKENS` binding, otherwise hub closes WS with 4401 and agent exits with status 2. |

`TMUXD_PASSWORD` and `TMUXD_BASE_TOKEN` are deprecated aliases for `TMUXD_TOKEN`, accepted with a startup warning. Rename in your `.env` at your convenience.

Example `.env`:

```env
TMUXD_TOKEN=replace-with-a-long-random-token
HOST=127.0.0.1
PORT=7681
```

Generate a strong token:

```bash
openssl rand -base64 24
```

Generate a strong JWT secret if you want to manage it yourself:

```bash
openssl rand -base64 48
```

Generate an agent token when using hub/agent mode:

```bash
openssl rand -base64 32
```

## Hub / agent mode

By default, tmuxd controls tmux on the same machine as the web server. To show tmux sessions from other machines in the same web UI, run the normal server as the hub and start one outbound agent per remote machine.

On the hub:

```bash
TMUXD_TOKEN=replace-with-a-long-random-token \
TMUXD_AGENT_TOKENS=workstation=replace-with-a-long-random-agent-token \
HOST=0.0.0.0 PORT=7681 npm start
```

On an agent machine:

```bash
TMUXD_HUB_URL=http://hub.example:7681 \
TMUXD_AGENT_TOKEN=replace-with-a-long-random-agent-token \
TMUXD_AGENT_ID=workstation \
TMUXD_AGENT_NAME=Workstation \
npm run agent
```

You can also pass agent options as flags:

```bash
npm run agent -- --hub http://hub.example:7681 --token replace-with-a-long-random-agent-token --id workstation --name Workstation
```

Notes:

- Agents make an outbound WebSocket connection to `/agent/connect`; they do not open an inbound HTTP port.
- `TMUXD_AGENT_ID` is the stable ID stored in browser workspaces and URLs. Use letters, digits, `.`, `_`, or `-`.
- `TMUXD_AGENT_NAME` is just the display name in the UI.
- Agent tokens must be sent as `Authorization: Bearer ...`; tmuxd intentionally rejects token-in-URL authentication.
- Prefer `TMUXD_AGENT_TOKENS=hostId=token,...` on the hub so each token can only register its matching `TMUXD_AGENT_ID`. `TMUXD_AGENT_TOKEN` remains available for simple single-agent compatibility.
- Use HTTPS/WSS when the hub is reachable beyond a private network.
- A connected agent advertises capabilities to the hub. Hosts with the `create` capability appear in New-session host pickers.

The home page, terminal sidebar, mobile picker, and split chooser group sessions by host. Existing local routes such as `/attach/main` still mean the hub's `local/main`; remote sessions use `/attach/:hostId/:name`.

## Multi-user hub mode

For deployments where many users share a single tmuxd hub and each
should only see their own tmux sessions, see [docs/hub-mode.md](docs/hub-mode.md).
Multi-user is the natural extension of the same single-token login:

- Login takes `<TMUXD_TOKEN>:<namespace>` (e.g. `team-secret:alice`). Bare
  `<TMUXD_TOKEN>` (no `:`) is the single-user form, which lands the user
  in the default namespace.
- Per-namespace agent registration via `TMUXD_AGENT_TOKENS=alice/laptop=...,bob/desktop=...`.
- `TMUXD_HUB_ONLY=1` to disable local-tmux routes entirely (the hub
  becomes a proxy/router only).

Read the doc before deploying — namespace is a per-user *label*, not an
auth boundary against anyone holding `TMUXD_TOKEN`.

## Using the app

### Sign in

1. Visit the server URL.
2. Enter the token from `.env` (append `:<namespace>` for multi-user).
3. Click **Sign in**.

### New session

On the sessions page:

1. Optionally enter a name using letters, digits, `.`, `_`, or `-`.
2. Choose the host next to the session name. It defaults to **Local** when available.
3. Click **New**.
4. If the name is blank, tmuxd creates an auto-named session such as `web-20260428-090507`.
5. Click **Attach** to open the terminal.

New sessions start in the selected host user's home directory.

### Attach and switch sessions

On the terminal page:

- The centered title shows the current session name.
- **Opened** shows sessions opened in this browser.
- **Opened** and **Not opened** are grouped by host.
- Session rows and workspace pane headers use a small status light: gray = connecting/unknown, green = read/normal, yellow = unread activity, red = closed/error.
- **New** creates a named or auto-named session on the selected host and attaches to it.
- Click any session name to switch.
- Click `×` next to an opened session to remove it from the browser-local list.
- Click **Hide** to collapse the side panel; click **Sessions** to show it again.

On mobile:

- Tap the session name in the top bar to open the session picker.
- Use **New** from the picker to create and attach to a new session.
- Use **Keys** for mobile-friendly terminal keys and modifiers.
- Use **Text** to open selectable tmux session text. The text view is positioned from tmux's current scroll position.
- Use **Image** when browser image paste is not available; it uploads an image file and pastes its path.
- Use **Actions** to create browser-local custom buttons that send predefined text to the active pane.

### Custom actions and timers

The terminal page has an **Actions** panel on desktop and mobile.

- Create custom actions with a short label and payload.
- Click an action to run its configured trigger against the active pane.
- Optional trigger settings can run an action immediately, after a delay, or at a local date/time.
- Optional timer settings can repeat an action every N seconds after the first trigger, with an optional repeat count.
- Timers are bound to the pane/session that was active when started.
- Timers stop when the pane closes, its target changes, the websocket closes/errors, or the page unloads.
- Starting a timer whose payload contains Enter/newline asks for confirmation because it may execute shell commands.

Custom actions are stored in the browser's localStorage. They are not synced between browsers and do not run in the background after the page is closed.

### Agent-facing tmux API

Other local agents can use tmuxd as a JSON control plane for both **Local** and hub/agent remote tmux hosts. This mirrors the common `tmux` skill workflow: list panes, capture bounded scrollback, send literal text or special keys, and reuse named actions.

All endpoints require the normal web JWT:

```bash
TOKEN=$(curl -s http://127.0.0.1:7681/api/auth \
  -H 'content-type: application/json' \
  -d '{"token":"..."}' | jq -r .token)
```

Pane inspection:

```bash
# All panes on a host, optionally restricted to one session.
curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7681/api/hosts/local/panes?session=main'

# Equivalent host-aware session helper.
curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7681/api/hosts/local/sessions/main/panes'

# Capture the newest 120 joined lines from a pane target, retaining at most 64 KiB.
curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7681/api/hosts/local/panes/main%3A0.0/capture?lines=120&maxBytes=65536'

# Stable tmux pane ids such as %7 can also be used; URL-encode % as %25.
curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7681/api/hosts/local/panes/%257/capture?lines=80'

# Classify whether a pane looks idle, running, waiting for input, in a permission prompt, etc.
curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7681/api/hosts/local/panes/main%3A0.0/status?lines=120&maxBytes=65536'

# Clear the sticky unread light after you have looked at the pane.
curl -X POST -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7681/api/hosts/local/panes/main%3A0.0/activity/read'

# One aggregate snapshot for agents that need a quick inventory.
curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7681/api/agent/snapshot?capture=1&captureLimit=4'
```

Pane captures return `truncated` and `maxBytes`. When truncation is needed, tmuxd keeps the newest UTF-8-safe tail of the capture so status checks still see the latest prompt. Pane status responses also include a small sticky `activity` light: `green` = read/normal, `yellow` = unread output changed, `red` = tracked pane closed. Polling status does not clear unread; clear it explicitly with `POST /api/hosts/:hostId/panes/:target/activity/read`.

Input primitives:

```bash
# Literal text is sent with `tmux send-keys -l`; Enter is sent separately.
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"/status","enter":true}' \
  'http://127.0.0.1:7681/api/hosts/local/panes/main/input'

# Special tmux keys are validated and sent as argv, not through a shell.
curl -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"keys":["C-c","Enter"]}' \
  'http://127.0.0.1:7681/api/hosts/local/panes/main/keys'
```

Reusable server-side actions are stored in `TMUXD_HOME/actions.json`:

```bash
ACTION_ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"label":"Status","kind":"send-text","payload":"/status","enter":true}' \
  http://127.0.0.1:7681/api/actions | jq -r .action.id)

curl -X POST -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:7681/api/hosts/local/panes/main/actions/$ACTION_ID/run"

curl -H "Authorization: Bearer $TOKEN" \
  'http://127.0.0.1:7681/api/actions/history?limit=20'
```

Remote hosts use the same routes with their host id, for example `/api/hosts/workstation/panes`. New tmuxd outbound agents advertise `panes` and `input` capabilities; older agents continue to work for session list/create/capture/attach but return `capability_not_supported` for these newer endpoints.

### Command-line client (`tmuxd`)

If you'd rather not hand-roll `curl` against the API, tmuxd ships a CLI that
mirrors the real `tmux` command grammar. Verbs and target syntax are the same
ones you already know — the only addition is `-t HOST:…` because tmuxd lives
above many tmux servers.

```bash
# One-time login. Bare token = single-user; `<token>:<ns>` = multi-user hub.
npm run tmuxd -- login --hub http://127.0.0.1:7681 \
  --access-token "$TMUXD_TOKEN"

# Or for a multi-user hub:
npm run tmuxd -- login --hub https://hub.example.com \
  --access-token "$TMUXD_TOKEN:alice"

# Same verbs as tmux:
npm run tmuxd -- list-hosts
npm run tmuxd -- list-sessions -t laptop
npm run tmuxd -- new-session   -t laptop -s scratch
npm run tmuxd -- list-panes    -t laptop:scratch
npm run tmuxd -- capture-pane  -t laptop:scratch:0.0 --lines 80
npm run tmuxd -- send-text     -t laptop:scratch:0.0 --enter 'echo hi'
npm run tmuxd -- send-keys     -t laptop:scratch:0.0 C-c
npm run tmuxd -- pane-status   -t laptop:scratch:0.0   # state + light + summary
npm run tmuxd -- attach-session -t laptop:scratch      # prints web UI URL
npm run tmuxd -- kill-session  -t laptop:scratch
npm run tmuxd -- whoami
npm run tmuxd -- logout
```

Notes:

- `--access-token` only appears on `login`; everything else reads the JWT from
  `~/.tmuxd/cli/credentials.json` (mode 0600). The CLI refuses to read the
  file if any group/world bit is set on it.
- The `-t` flag follows tmux conventions: `-t host`, `-t host:session`,
  `-t host:session:0.0`, or `-t host:%paneId`.
- `--json` on any subcommand prints raw API JSON, suitable for piping to `jq`
  or driving from another agent.
- JWTs live for 12 hours. `tmuxd whoami` shows time-to-expiry; on 401 the CLI
  prints a one-line hint pointing at `tmuxd login` again. There is no silent
  re-auth.
- For a global install (`tmuxd ...` without `npm run`), see the bin entry in
  `server/package.json`.

### Clipboard images

When you paste an image into a **Local** terminal session, tmuxd saves it under `~/.tmuxd/uploads` on the server and pastes the shell-quoted file path into the terminal. This makes screenshots available to shell commands and terminal editors as normal files.

If your browser does not expose clipboard images to web pages, use the **Image** button in the terminal UI to choose an image file manually.

Remote agent sessions do not currently receive pasted image files; only local sessions can use this clipboard-image path paste.

### Mobile / install as app

The web UI includes a web app manifest and icons.

- Android Chrome: menu → **Install app** or **Add to Home screen**.
- iPhone Safari: share button → **Add to Home Screen**.

Most browsers require HTTPS for full PWA install/service-worker behavior. Plain HTTP may only create a basic home-screen shortcut unless accessed from localhost.

## Security notes

This app controls a real shell through tmux. Treat access to tmuxd as access to the server user account.

Recommended deployment:

- Keep `HOST=127.0.0.1` and use SSH tunneling:

  ```bash
  ssh -L 7681:127.0.0.1:7681 user@server
  ```

- Or put tmuxd behind an HTTPS reverse proxy such as Caddy, nginx, or Cloudflare Tunnel.
- Use a long random token.
- If hub/agent mode is enabled, use separate long random agent tokens; do not reuse the browser token.
- Restrict firewall/security-group access to trusted IPs.

Implemented safeguards:

- Token login with constant-time comparison.
- Short-lived API JWTs.
- Short-lived one-time WebSocket tickets.
- Session names are validated against `^[A-Za-z0-9._-]{1,64}$`.
- tmux commands use argv (`execFile` / `node-pty`), not shell interpolation.
- Login rate limiting.
- WebSocket Origin checks.
- WebSocket connection limits and idle timeout.
- API responses use `Cache-Control: no-store`.
- PTY child environment strips `TMUXD_TOKEN`, `TMUXD_BASE_TOKEN`, `TMUXD_PASSWORD`, `TMUXD_AGENT_TOKEN`, `TMUXD_AGENT_TOKENS`, and `JWT_SECRET`.
- Browser JWTs are never forwarded to agents; the hub talks to agents over the separate agent token channel.

## Development

Run server and Vite dev server together:

```bash
npm run dev
```

Run only the server:

```bash
npm run dev:server
```

Run only the web app:

```bash
npm run dev:web
```

Run an outbound agent:

```bash
npm run agent -- --hub http://127.0.0.1:7681 --token your-agent-token --id dev-agent --name DevAgent
```

## Validation

```bash
npm test
npm run typecheck
npm run build
npm run e2e
```

E2E coverage includes:

- Login success/failure.
- Authenticated session listing.
- New/duplicate/bad-name/delete session flows.
- New sessions starting in the server user's home directory.
- Session text capture from tmux scrollback.
- Agent-facing pane list/capture/input APIs and server-side action CRUD/run flows.
- WebSocket attach, resize, ping/pong, input echo, UTF-8 roundtrip.
- Hub/agent remote host connect, remote session create/list/capture/delete, remote pane inspection/input, and remote WebSocket attach/input.
- Multi-client shared attach.
- Graceful shutdown with a live WebSocket.
- Production web build smoke test.

## Project structure

```text
server/   Hono HTTP API, WebSocket upgrade, tmux/PTY bridge, outbound agent
shared/   TypeScript types and Zod schemas
web/      Vite + React + TanStack Router + xterm.js
scripts/  E2E validation scripts
```

## Troubleshooting

### Login says “Wrong token”

Use the value after `TMUXD_TOKEN=` in `.env`, not the variable name itself. For
multi-user deployments, append `:<your-namespace>` (e.g. `team-secret:alice`).

```bash
grep '^TMUXD_TOKEN=' .env
```

### Cannot access from another machine

Check the bind address and firewall:

```bash
ss -ltnp | grep 7681
```

For external access, `HOST=0.0.0.0` listens on all interfaces, but you should use HTTPS or SSH tunneling for safety.

### `tmux` commands fail

Confirm tmux is installed and on PATH:

```bash
tmux -V
```

### WebSocket attach fails after leaving the tab open

Idle WebSocket sessions are closed after inactivity. Refresh or attach again.

## License

MIT
