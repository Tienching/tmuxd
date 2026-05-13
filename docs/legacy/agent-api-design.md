# Agent-facing tmux API design

> **Status: superseded.** This document was the original design for the
> programmatic tmux API surface (panes, input, actions). The vocabulary
> has been retired: "outbound tmuxd agent" is now "outbound tmuxd
> client", the `/agent/snapshot` route is now `/client/snapshot`, and
> the `tmuxd-agent` audit events are now `client_*`. The current
> contract lives in `server/src/routes/sessions.ts` (programmatic
> routes) and `docs/identity-model.md` (auth surface). Kept for
> historical context.

## Context

The Hermes `tmux` skill treats tmux as an agent-control substrate: list sessions and panes, capture recent output, send literal input/special keys, and cautiously advance interactive prompts. `tmuxd` already provides a browser terminal and hub/agent remote hosts, so the right abstraction is not another shell wrapper; it is an authenticated JSON API that exposes the same tmux primitives across local and remote hosts.

## Design principles

1. **One API for local and remote hosts** — all host-aware routes use `/api/hosts/:hostId/...`; `local` is just the built-in host.
2. **Pane-level inspection** — session lists are too coarse for coding agents; agents need current command, cwd, pane activity, dimensions, mode state, stable `%pane_id` targets, and bounded scrollback.
3. **Literal input before shell commands** — text uses `tmux send-keys -l` and special keys are validated argv tokens. The API never shells out through interpolated strings.
4. **Reusable action definitions, not background automation yet** — action CRUD and immediate run are implemented now; cron/watchdog semantics can be layered later without changing target/input primitives.
5. **Capability-gated remotes** — old outbound tmuxd agents remain compatible, while new agents advertise `panes` and `input` for the expanded protocol.

## Route contract

All routes require the same bearer JWT used by the web UI.

### Inspect panes

`GET /api/hosts/:hostId/panes?session=<name>` lists panes on a host. The response is:

```json
{
  "panes": [
    {
      "hostId": "local",
      "hostName": "Local",
      "target": "main:0.0",
      "sessionName": "main",
      "windowIndex": 0,
      "windowName": "zsh",
      "windowActive": true,
      "paneIndex": 0,
      "paneId": "%1",
      "paneActive": true,
      "paneDead": false,
      "currentCommand": "bash",
      "currentPath": "/home/ubuntu",
      "title": "bash",
      "width": 120,
      "height": 40,
      "paneInMode": false,
      "scrollPosition": 0,
      "historySize": 2000
    }
  ]
}
```

`GET /api/sessions/:name/panes` is the local-host convenience equivalent. `GET /api/hosts/:hostId/sessions/:name/panes` is the host-aware session helper and works for both `local` and remote hosts.

### Capture bounded scrollback

`GET /api/hosts/:hostId/panes/:target/capture?lines=200&maxBytes=262144` captures recent pane text. `target` accepts `session`, `session:window`, `session:window.pane`, or a stable tmux `%pane_id`; callers URL-encode `:` and `%` when needed. Captures include `truncated` and `maxBytes`; when truncation is needed, tmuxd keeps the newest UTF-8-safe tail of the capture.

```json
{
  "target": "%7",
  "text": "...latest output...",
  "truncated": false,
  "maxBytes": 262144,
  "paneInMode": false,
  "scrollPosition": 0,
  "historySize": 2000,
  "paneHeight": 40
}
```

### Classify pane status

`GET /api/hosts/:hostId/panes/:target/status?lines=200&maxBytes=262144` captures a pane and returns a lightweight heuristic classification:

```json
{
  "target": "main:0.0",
  "state": "permission_prompt",
  "signals": ["proceed_prompt", "yes_no_prompt"],
  "summary": "Pane appears to be waiting for permission: proceed_prompt, yes_no_prompt.",
  "checkedAt": 1778252400000,
  "pane": { "target": "main:0.0" },
  "capture": { "target": "main:0.0", "text": "Do you want to proceed? Yes/No\n" },
  "activity": {
    "light": "yellow",
    "unread": true,
    "changed": true,
    "seq": 3,
    "reason": "output",
    "updatedAt": 1778252399000,
    "checkedAt": 1778252400000
  }
}
```

States are `idle`, `running`, `needs_input`, `permission_prompt`, `copy_mode`, and `dead`. `activity` is intentionally small: `green` means read/normal, `yellow` means unread output changed since the last read mark, `red` means the tracked pane closed, and `gray` is reserved for unknown/connecting clients. `GET /status` never clears unread state; callers clear it explicitly with `POST /api/hosts/:hostId/panes/:target/activity/read`.

### Aggregate snapshot

`GET /api/client/snapshot?capture=1&captureLimit=8&lines=120&maxBytes=65536` returns one inventory for local and connected remote hosts:

```json
{
  "generatedAt": 1778252400000,
  "hosts": [],
  "sessions": [],
  "panes": [],
  "statuses": [],
  "errors": []
}
```

`capture` is optional and defaults off. With capture enabled, tmuxd classifies at most `captureLimit` panes and includes the same `activity` object for each status so a quick inventory does not accidentally capture every pane on a large hub.

### Mark pane activity read

`POST /api/hosts/:hostId/panes/:target/activity/read` clears the sticky unread light for the current tracked pane sequence without sending input to tmux.

```json
{ "ok": true, "activity": { "light": "green", "unread": false, "seq": 3 } }
```

### Send input

`POST /api/hosts/:hostId/panes/:target/input`

```json
{ "text": "/status", "enter": true }
```

`text` is bounded to 64 KiB. When `enter` is true, Enter is sent as a second tmux operation to avoid multiline/paste ambiguity.

`POST /api/hosts/:hostId/panes/:target/keys`

```json
{ "keys": ["C-c", "Enter"] }
```

Keys are bounded and match `[A-Za-z0-9_-]+`.

### Configure and run actions

Actions live in `TMUXD_HOME/actions.json` and are intentionally server-side so agents can create them and other clients can discover them.

- `GET /api/actions`
- `GET /api/actions/history?limit=100`
- `POST /api/actions`
- `PUT /api/actions/:id`
- `DELETE /api/actions/:id`
- `POST /api/hosts/:hostId/panes/:target/actions/:actionId/run`

Action shape:

```json
{
  "id": "act-status",
  "label": "Status",
  "description": "Ask an agent pane for status",
  "kind": "send-text",
  "payload": "/status",
  "enter": true,
  "createdAt": 1778252400000,
  "updatedAt": 1778252400000
}
```

`kind: "send-keys"` uses `keys` instead of `payload`.

Immediate action runs append an audit record to `TMUXD_HOME/actions-history.json` with action id, label, kind, host id, target, success/failure, timestamps, and a bounded error string.

## Remote-agent protocol

New hub → outbound-agent request messages:

- `list_panes { id, session? }`
- `capture_pane { id, target, lines?, maxBytes? }`
- `send_text { id, target, text, enter? }`
- `send_keys { id, target, keys }`

New capabilities:

- `panes` — list/capture panes.
- `input` — send literal text and special keys.

The hub maps unsupported old agents to HTTP `405 capability_not_supported`.

Agents that omit `capabilities` are treated as legacy agents with only `list`, `create`, `kill`, `capture`, and `attach`; they do not implicitly get `panes` or `input`.

## Safety model

The API does not make tmuxd safer than browser terminal access: any authenticated user can control the server user's tmux panes. It does, however, keep the control plane predictable:

- bearer JWT required;
- remote agents use bearer tokens and outbound-only WebSockets;
- target/session/action/key schemas reject whitespace, separators, and shell metacharacters;
- all tmux calls use `execFile` argv arrays;
- captures and payloads are bounded.
- capture truncation keeps the newest tail rather than the oldest prefix, reducing the chance that status classification misses the current prompt.

## Future extensions

- Server-side scheduled/watchdog actions with explicit risk policy.
- Optional sync bridge between browser-local custom actions and server actions.
- UI surface for server-side action history.
- Structured prompt/action policies for high-risk confirmation flows.
