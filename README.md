# tmuxd

A local-first web UI for `tmux` sessions. Open your browser, sign in with one password, and attach to existing tmux sessions with a full xterm terminal.

![Terminal with session sidebar](docs/screenshots/03-terminal-sidebar.png)

## What it does

- Lists all tmux sessions for the server user.
- Can act as a hub for outbound tmuxd agents, so one page can show tmux sessions from multiple machines.
- Creates, attaches to, and kills tmux sessions from the web UI.
- Creates named sessions or auto-named sessions when you leave the name blank.
- Streams an interactive terminal over WebSocket using xterm.js.
- Keeps a browser-local **Opened** list for fast switching between recently attached sessions.
- Provides an **Opened / All sessions** side panel on the terminal page, including a quick **New session** action.
- Starts newly-created sessions in the server user's home directory.
- Supports mobile layouts and install-to-home-screen PWA metadata.
- Adds mobile-friendly **Keys** and **Text** controls for special keys and selectable session text.
- Uses password login + short-lived JWTs for the API.
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
# edit .env and set TMUXD_PASSWORD
npm run build
npm start
```

Open the URL printed by the server, usually:

```text
http://127.0.0.1:7681
```

Sign in with the value after `TMUXD_PASSWORD=` in `.env`.

## Configuration

`tmuxd` reads `.env` from the project root.

| Variable | Default | Description |
| --- | --- | --- |
| `TMUXD_PASSWORD` | required | Password for the web login. |
| `HOST` | `127.0.0.1` | Bind address. Use `0.0.0.0` only when you understand the network exposure. |
| `PORT` | `7681` | HTTP port. |
| `TMUXD_HOME` | `.tmuxd` in CWD | Directory for generated runtime secrets. |
| `JWT_SECRET` | generated | Optional JWT signing secret. If set manually, it must be at least 32 bytes. |
| `TMUXD_AGENT_TOKEN` | unset | Enables `/agent/connect` on the hub and authenticates agents. Use a long random value. |

Example `.env`:

```env
TMUXD_PASSWORD=replace-with-a-long-random-password
HOST=127.0.0.1
PORT=7681
```

Generate a strong password:

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
TMUXD_PASSWORD=replace-with-a-long-random-password \
TMUXD_AGENT_TOKEN=replace-with-a-long-random-agent-token \
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
- Use HTTPS/WSS when the hub is reachable beyond a private network.
- A connected agent advertises capabilities to the hub. Hosts with the `create` capability appear in New-session host pickers.

The home page, terminal sidebar, mobile picker, and split chooser group sessions by host. Existing local routes such as `/attach/main` still mean the hub's `local/main`; remote sessions use `/attach/:hostId/:name`.

## Using the app

### Sign in

1. Visit the server URL.
2. Enter the password from `.env`.
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
- **New** creates a named or auto-named session on the selected host and attaches to it.
- Click any session name to switch.
- Click `×` next to an opened session to remove it from the browser-local list.
- Click **Hide** to collapse the side panel; click **Sessions** to show it again.

On mobile:

- Tap the session name in the top bar to open the session picker.
- Use **New** from the picker to create and attach to a new session.
- Use **Keys** for mobile-friendly terminal keys and modifiers.
- Use **Text** to open selectable tmux session text. The text view is positioned from tmux's current scroll position.

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
- Use a long random password.
- If hub/agent mode is enabled, use a separate long random `TMUXD_AGENT_TOKEN`; do not reuse the browser password.
- Restrict firewall/security-group access to trusted IPs.

Implemented safeguards:

- Password login with constant-time comparison.
- Short-lived API JWTs.
- Short-lived one-time WebSocket tickets.
- Session names are validated against `^[A-Za-z0-9._-]{1,64}$`.
- tmux commands use argv (`execFile` / `node-pty`), not shell interpolation.
- Login rate limiting.
- WebSocket Origin checks.
- WebSocket connection limits and idle timeout.
- API responses use `Cache-Control: no-store`.
- PTY child environment strips `TMUXD_PASSWORD`, `TMUXD_AGENT_TOKEN`, and `JWT_SECRET`.
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
- WebSocket attach, resize, ping/pong, input echo, UTF-8 roundtrip.
- Hub/agent remote host connect, remote session create/list/capture/delete, and remote WebSocket attach/input.
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

### Login says “Wrong password”

Use the value after `TMUXD_PASSWORD=` in `.env`, not the variable name itself.

```bash
grep '^TMUXD_PASSWORD=' .env
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
