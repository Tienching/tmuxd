# tmuxd

A local-first web UI for `tmux` sessions. Open your browser, sign in with one password, and attach to existing tmux sessions with a full xterm terminal.

![Terminal with session sidebar](docs/screenshots/03-terminal-sidebar.png)

## What it does

- Lists all tmux sessions for the server user.
- Creates, attaches to, and kills tmux sessions from the web UI.
- Streams an interactive terminal over WebSocket using xterm.js.
- Keeps a browser-local **Opened** list for fast switching between recently attached sessions.
- Provides an **All sessions** side panel on the terminal page.
- Supports mobile layouts and install-to-home-screen PWA metadata.
- Uses password login + short-lived JWTs for the API.
- Uses short-lived one-time WebSocket tickets instead of putting the long-lived JWT in the WebSocket URL.

## Screenshots

### Login

![Login screen](docs/screenshots/01-login.png)

### Session list

![Session list](docs/screenshots/02-sessions.png)

### Terminal attach with side panel

![Terminal with sidebar](docs/screenshots/03-terminal-sidebar.png)

### Mobile layout

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

## Using the app

### Sign in

1. Visit the server URL.
2. Enter the password from `.env`.
3. Click **Sign in**.

### Create a session

1. On the sessions page, enter a name using letters, digits, `.`, `_`, or `-`.
2. Click **Create**.
3. Click **Attach** to open the terminal.

### Attach and switch sessions

On the terminal page:

- **Opened** shows sessions opened in this browser.
- **All sessions** shows live tmux sessions from the server.
- Click any session name to switch.
- Click `×` next to an opened session to remove it from the browser-local list.
- Click **Hide** to collapse the side panel; click **Sessions** to show it again.

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
- PTY child environment strips `TMUXD_PASSWORD` and `JWT_SECRET`.

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
- Create/duplicate/bad-name/delete session flows.
- WebSocket attach, resize, ping/pong, input echo, UTF-8 roundtrip.
- Multi-client shared attach.
- Graceful shutdown with a live WebSocket.
- Production web build smoke test.

## Project structure

```text
server/   Hono HTTP API, WebSocket upgrade, tmux/PTY bridge
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
