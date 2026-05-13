# tmuxd Hub / Agent Design

> **Status: superseded.** This was the original design for the multi-host
> feature. The vocabulary has since been retired:
>
> - "hub" → "server" (the box running `npm start`)
> - "hub-only" → "relay" (a server with `TMUXD_RELAY=1`)
> - "agent" → "client" (the outbound process exposing local tmux)
>
> The wire path `/agent/connect` was renamed to `/client/connect`,
> audit events `agent_*` are now `client_*`, the npm script `npm run
> agent` is now `npm run client`, and the env template `.env.agent.example`
> is now `.env.client.example`.
>
> See the current docs: `docs/deployment-modes.md`,
> `docs/relay-deployment.md`, `docs/identity-model.md`. The structural
> argument and the "outbound WebSocket from the worker box" decision
> below are still accurate; only the names changed.

Status: implemented v1

Branch: `feature/hub-agent-design`

Goal: let one browser page show and control tmux sessions from multiple machines.

## Summary

Today tmuxd is server-local:

```text
browser -> tmuxd server -> local tmux
```

The implemented feature adds a hub and outbound agents:

```text
browser -> tmuxd hub
             ^
             |
      tmuxd agent on laptop/server/mac -> local tmux
```

The hub serves the web UI. Agents run on other machines and make outbound connections to the hub. The browser never needs direct network access to those machines.

This is the right shape for mobile use: the phone opens one URL, then sees `local/main`, `desktop/autopilot`, `server-a/logs`, and other tmux sessions in the same workspace.

## Goals

- Keep the current single-machine mode working exactly as it does now.
- Add a hub mode that aggregates sessions from multiple connected agents.
- Add an agent mode that connects outbound to the hub and exposes that machine's tmux sessions.
- Let workspace panes attach to different machines at the same time.
- Reuse the current terminal, quick keys, text capture, session picker, and split UI.
- Avoid requiring inbound ports on agent machines.
- Make the first version safe enough to run on a private network or behind HTTPS.

## Non-goals for v1

- Multi-user RBAC. One browser login controls all connected agents in v1.
- SSH-native agentless mode.
- High availability hub clustering.
- Full file transfer.
- Per-command audit replay.
- Running arbitrary shells outside tmux.

## Product behavior

### Single-machine mode

Current behavior stays:

```bash
TMUXD_TOKEN=... HOST=0.0.0.0 PORT=17683 npm start
```

Internally this is the `serve` mode. It has one built-in target named `local`.

### Hub mode

The hub owns the web UI and browser auth:

```bash
tmuxd hub --host 0.0.0.0 --port 17683
```

The hub shows:

```text
Hosts
  local       online   3 sessions
  desktop     online   5 sessions
  server-a    offline  last seen 2m ago

Sessions
  local/main
  desktop/autopilot
  server-a/logs
```

### Agent mode

Each remote machine runs:

```bash
tmuxd agent --hub wss://hub.example.com --token <agent-token> --name desktop
```

The agent connects out to the hub. It does not open an HTTP port by default.

### Workspace panes

A pane target changes from only a session name:

```ts
{ sessionName: 'main' }
```

to a host plus session:

```ts
{ target: { hostId: 'desktop', sessionName: 'main' } }
```

The title becomes:

```text
desktop / main
```

Split chooser groups sessions by host and still includes **New**.

## Architecture

```text
web UI
  |
  | HTTP API + browser WS
  v
hub server
  | local target adapter
  | remote target registry
  |
  +--> local tmux
  |
  +== agent control WS == agent on desktop -> desktop tmux
  |
  +== agent control WS == agent on server-a -> server-a tmux
```

The hub sees every session as a `TargetSession`:

```ts
interface HostInfo {
  id: string
  name: string
  status: 'online' | 'offline'
  isLocal: boolean
  version: string
  lastSeenAt: number
  capabilities: HostCapability[]
}

interface TargetSession extends TmuxSession {
  hostId: string
  hostName: string
}
```

The key design choice: browser WebSockets still connect only to the hub. The hub forwards terminal streams to local tmux or to a remote agent.

## Server target abstraction

Introduce a target interface in the server package:

```ts
interface TmuxTarget {
  host: HostInfo
  listSessions(): Promise<TmuxSession[]>
  createSession(name: string): Promise<void>
  killSession(name: string): Promise<void>
  captureSession(name: string): Promise<CaptureResponse>
  attachSession(opts: AttachOptions): Promise<TerminalStream>
}
```

`LocalTmuxTarget` wraps the current `tmux.ts` and `ptyManager.ts` functions.

`RemoteAgentTarget` wraps an online agent connection.

Routes use a `TargetRegistry` instead of calling `listSessions()` or `attachTmuxPty()` directly.

## HTTP API shape

Keep current endpoints as local-only compatibility aliases:

```text
GET    /api/sessions
POST   /api/sessions
DELETE /api/sessions/:name
GET    /api/sessions/:name/capture
GET    /ws/:name
```

Add host-aware endpoints:

```text
GET    /api/hosts
GET    /api/hosts/:hostId/sessions
POST   /api/hosts/:hostId/sessions
DELETE /api/hosts/:hostId/sessions/:name
GET    /api/hosts/:hostId/sessions/:name/capture
POST   /api/ws-ticket
GET    /ws/:hostId/:sessionName
```

`POST /api/ws-ticket` should accept an optional target:

```json
{
  "hostId": "desktop",
  "sessionName": "main"
}
```

For backward compatibility, missing `hostId` means `local`.

## Agent protocol

Agents connect to the hub over a persistent WebSocket:

```text
GET /client/connect
Authorization: Bearer <agent-token>
```

After connect, the agent sends hello:

```json
{
  "type": "hello",
  "name": "desktop",
  "version": "0.1.0",
  "capabilities": ["list", "create", "kill", "capture", "attach"]
}
```

The hub responds with an assigned host identity:

```json
{
  "type": "hello_ack",
  "hostId": "agent_01J...",
  "heartbeatMs": 15000
}
```

### Request / response frames

Hub to agent:

```json
{ "id": "req-1", "type": "list_sessions" }
{ "id": "req-2", "type": "create_session", "name": "deploy" }
{ "id": "req-3", "type": "kill_session", "name": "deploy" }
{ "id": "req-4", "type": "capture_session", "name": "logs" }
```

Agent to hub:

```json
{ "id": "req-1", "type": "result", "ok": true, "body": { "sessions": [] } }
{ "id": "req-2", "type": "result", "ok": false, "error": "session_exists" }
```

### Terminal stream frames

The hub multiplexes terminal streams over the same agent WebSocket. Multiplexing means one connection carries multiple terminal panes, each tagged by `streamId`.

Hub to agent:

```json
{ "type": "attach", "streamId": "s1", "sessionName": "main", "cols": 120, "rows": 34 }
{ "type": "input", "streamId": "s1", "payload": "...base64..." }
{ "type": "resize", "streamId": "s1", "cols": 100, "rows": 28 }
{ "type": "detach", "streamId": "s1" }
```

Agent to hub:

```json
{ "type": "stream_ready", "streamId": "s1", "session": "main", "cols": 120, "rows": 34 }
{ "type": "stream_data", "streamId": "s1", "payload": "...base64..." }
{ "type": "stream_exit", "streamId": "s1", "code": 0, "signal": null }
{ "type": "stream_error", "streamId": "s1", "message": "attach_failed" }
```

The hub translates between browser frames and agent stream frames. Browser-facing `ClientWsMessage` and `ServerWsMessage` can stay mostly unchanged.

## Frontend changes

### Shared target model

Add types:

```ts
interface SessionTarget {
  hostId: string
  sessionName: string
}

interface WorkspacePane {
  type: 'pane'
  id: string
  target: SessionTarget
}
```

Migration rule:

```ts
// existing localStorage layout
{ sessionName: 'main' }

// new layout
{ target: { hostId: 'local', sessionName: 'main' } }
```

### Routes

Keep current local route:

```text
/attach/:name
```

Add host-aware route:

```text
/attach/:hostId/:name
```

If the user opens `/attach/main`, it means `/attach/local/main`.

### UI

- Sidebar groups sessions by host.
- Split chooser groups sessions by host.
- Pane title shows `host / session`.
- Offline hosts are visible but disabled.
- Text capture uses host-aware API.
- New session form creates on the currently selected host.

## Security model

Browser auth and agent auth are separate.

### Browser auth

Current browser token login stays:

- `TMUXD_TOKEN`
- short-lived JWT
- one-time WebSocket tickets

### Agent auth

Agents use separate tokens:

- Hub prefers per-host `TMUXD_AGENT_TOKENS=hostId=token,...`; legacy `TMUXD_AGENT_TOKEN` still supports simple single-token setups.
- Agent token is never the browser password.
- Agent token is sent in the `Authorization` header, not in the URL.
- Agents should use `wss://` outside localhost/private test setups.

### Trust boundary

A connected agent can execute tmux operations on its own machine. The hub can ask the agent to list, create, kill, capture, and attach sessions. That is powerful. Treat adding an agent like granting shell access to that machine's tmux user.

### Safeguards for v1

- Agent display name is separate from stable `hostId`; agents can provide `TMUXD_AGENT_ID`, otherwise the hub derives one from the name.
- Per-agent capability flags.
- Per-agent and global terminal stream limits.
- Heartbeat and offline timeout.
- Same session name validation as local tmuxd.
- PTY child environment still strips tmuxd secrets.
- Hub never forwards browser JWTs to agents.

## Implementation plan

### Phase 1, host-aware local model

No remote agents yet.

- Add `HostInfo`, `SessionTarget`, `TargetSession` types.
- Add `local` host to server APIs.
- Update workspace layout to store `{ hostId, sessionName }`.
- Migrate old localStorage layouts automatically.
- Add UI grouping by host, even when only `local` exists.

This keeps risk low. If this phase is wrong, no network protocol has shipped yet.

### Phase 2, target registry on the server

Implemented as `AgentRegistry` plus host-aware local routes. Current local aliases remain:

```text
/api/sessions
/ws/:name
/attach/:name
```

### Phase 3, agent control channel

Implemented:

- `/client/connect` WebSocket endpoint.
- Agent bearer-token validation. Prefer `TMUXD_AGENT_TOKENS=hostId=token,...` to bind each token to one stable host ID; `TMUXD_AGENT_TOKEN` remains as a single shared-token compatibility mode.
- `list_sessions`, `create_session`, `kill_session`, and `capture_session` request/response frames.
- `server/src/client.ts` outbound Node agent entry point.

### Phase 4, remote terminal streaming

Implemented:

- Multiplexed `attach/input/resize/detach` stream frames over the agent WebSocket.
- Browser `/ws/:hostId/:sessionName` bridges to either local tmux or a connected agent.
- Browser-facing WebSocket limits, tickets, and Origin checks are preserved.

### Phase 5, npm scripts and docs

Implemented:

```bash
npm start
npm run client -- --hub http://hub.example:7681 --token <token> --id workstation --name Workstation
```

The README documents hub setup, agent setup, and security notes.

## Test plan

### Unit tests

- Workspace layout migration from `sessionName` to `target`.
- Target registry routing.
- Agent protocol schema validation.
- Agent request timeout handling.
- Offline host state transitions.

### Integration tests

Start one hub and one agent in one process tree with isolated `TMUXD_HOME`.

Validate:

- hub lists `local` and agent host.
- hub lists agent sessions.
- hub creates an agent session.
- hub captures agent scrollback.
- browser WebSocket attaches through hub to agent tmux.
- input echo works through the remote stream.
- resize is forwarded.
- agent disconnect removes the host from the active host list.

### E2E tests

Extend existing `scripts/e2e-all.mjs` with:

```text
Hub/agent suite
  PASS hub health
  PASS agent connects
  PASS hosts list includes agent
  PASS remote session create/list/delete
  PASS remote ws attach/input/resize
  PASS agent process can be stopped after remote tests
```

## Rollout strategy

1. Ship host-aware local model first.
2. Ship hub with local host only.
3. Agent connection is enabled by setting `TMUXD_AGENT_TOKENS` or `TMUXD_AGENT_TOKEN` on the hub. Remote terminal streaming and README updates are included in v1.

## Risks and decisions

### Risk: terminal stream multiplexing complexity

Multiplexing is more code than one WebSocket per pane, but it is the right design because agents only make outbound connections. Without multiplexing, each browser pane would need a new inbound path to the agent, which breaks the mobile and private-network story.

### Risk: same session attached at different sizes

This already exists with multi-client attach. Remote hosts make it more visible. Keep shared attach behavior for v1 and document that tmux may resize to the active client.

### Risk: agent token leakage

Agent tokens grant shell-level tmux control for that agent machine. Tokens are accepted only through the `Authorization: Bearer ...` header, not URL query parameters, to avoid proxy/browser log leakage. Prefer per-host `TMUXD_AGENT_TOKENS` bindings and keep all tokens secret; use HTTPS/WSS outside private networks.

### Decision: preserve current single-server default

Do not force hub concepts on people who only want one machine. The default mental model stays simple.

### Decision: use `hostId`, not hostname, as identity

Names can change. IDs should not. The UI can show `desktop`, but stored layouts should use the stable ID.

## Open questions

1. Should agent tokens be created through the web UI, a CLI command, or both?
2. Should remote session kill be enabled by default, or gated behind an agent capability?
3. Should a hub allow multiple agents with the same display name?
4. Should workspaces persist per browser only, or eventually sync on the hub?
5. Should we support direct browser-to-agent mode later for fully local LAN setups?

## Implemented status

This branch now includes the complete v1 hub/agent path:

- `local` host metadata through `GET /api/hosts`.
- Host-aware APIs under `/api/hosts/:hostId/sessions`.
- Agent auth and outbound connection at `/client/connect`.
- Remote list/create/kill/capture through the agent protocol.
- Remote terminal attach through `/ws/:hostId/:sessionName`.
- Workspace panes persist `{ hostId, sessionName }` targets and migrate old layouts.
- Home page, desktop sidebar, mobile picker, and split chooser group sessions by host.
- `npm run client` starts the outbound agent.
- E2E coverage starts a hub plus agent and validates remote create/list/capture/delete and WebSocket input.

Known v1 limits:

- One shared agent token is configured by environment variable; there is no web UI token manager yet.
- Offline agents are removed from the current host list instead of retained with historical last-seen state.
- There is no packaged `tmuxd hub` CLI yet; `npm start` is the hub/server and `npm run client` is the agent.
