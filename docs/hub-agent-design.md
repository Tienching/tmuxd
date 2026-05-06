# tmuxd Hub / Agent Design

Status: draft v1, Phase 1 implemented

Branch: `feature/hub-agent-design`

Goal: let one browser page show and control tmux sessions from multiple machines.

## Summary

Today tmuxd is server-local:

```text
browser -> tmuxd server -> local tmux
```

The proposed feature adds a hub and outbound agents:

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
TMUXD_PASSWORD=... HOST=0.0.0.0 PORT=17683 npm start
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
GET /agent/connect
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

Current browser password login stays:

- `TMUXD_PASSWORD`
- short-lived JWT
- one-time WebSocket tickets

### Agent auth

Agents use separate tokens:

- Hub stores agent token hashes in `TMUXD_HOME`.
- Agent token is never the browser password.
- Agent token is sent in the `Authorization` header, not in the URL.
- Agents should use `wss://` outside localhost/private test setups.

### Trust boundary

A connected agent can execute tmux operations on its own machine. The hub can ask the agent to list, create, kill, capture, and attach sessions. That is powerful. Treat adding an agent like granting shell access to that machine's tmux user.

### Safeguards for v1

- Agent name is display-only. Hub assigns stable `hostId`.
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

- Introduce `TmuxTarget` and `TargetRegistry`.
- Move current local tmux calls behind `LocalTmuxTarget`.
- Change host-aware routes to use the registry.
- Keep old `/api/sessions` and `/ws/:name` as local aliases.

### Phase 3, agent control channel

- Add `/agent/connect` WebSocket endpoint.
- Add agent auth token validation.
- Add `AgentRegistry` with online/offline state.
- Implement `list_sessions`, `create_session`, `kill_session`, and `capture_session` over the agent protocol.
- Add a small Node agent entry point that reuses current tmux helpers.

### Phase 4, remote terminal streaming

- Add multiplexed `attach/input/resize/detach` stream frames.
- Bridge browser `/ws/:hostId/:sessionName` to local or remote target.
- Preserve current backpressure limits on browser WebSocket.
- Add agent-side stream limits and cleanup.

### Phase 5, CLI and docs

- Add explicit commands or npm scripts for:

  ```bash
  tmuxd serve
  tmuxd hub
  tmuxd agent
  ```

- Document hub setup, agent setup, reverse proxy, and security notes.
- Add screenshots for host grouping and multi-host workspace.

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
- agent disconnect marks host offline.

### E2E tests

Extend existing `scripts/e2e-all.mjs` with:

```text
Hub/agent suite
  PASS hub health
  PASS agent connects
  PASS hosts list includes agent
  PASS remote session create/list/delete
  PASS remote ws attach/input/resize
  PASS agent disconnect disables remote host
```

## Rollout strategy

1. Ship host-aware local model first.
2. Ship hub with local host only.
3. Add agent connection behind an env flag:

   ```env
   TMUXD_AGENT_ENABLED=1
   ```

4. Enable remote terminal streaming after API control paths pass.
5. Update README and screenshots.

## Risks and decisions

### Risk: terminal stream multiplexing complexity

Multiplexing is more code than one WebSocket per pane, but it is the right design because agents only make outbound connections. Without multiplexing, each browser pane would need a new inbound path to the agent, which breaks the mobile and private-network story.

### Risk: same session attached at different sizes

This already exists with multi-client attach. Remote hosts make it more visible. Keep shared attach behavior for v1 and document that tmux may resize to the active client.

### Risk: agent token leakage

Agent tokens grant shell-level tmux control for that agent machine. Store hashes on the hub, never show tokens after creation, and recommend HTTPS.

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

## Recommended next step

Phase 1 is now implemented on this branch:

- `local` host metadata is exposed through `GET /api/hosts`.
- Host-aware local session APIs are available under `/api/hosts/local/sessions`.
- Host-aware browser attach is available at `/ws/local/:sessionName`.
- Workspace panes now persist `{ hostId, sessionName }` targets and migrate old `sessionName`-only layouts.
- Browser-local opened sessions now store host metadata.
- The existing `/api/sessions`, `/ws/:sessionName`, and `/attach/:sessionName` paths remain compatible.

The next implementation step is Phase 2:

```text
target registry on the server, still no remote networking yet
```

That will put local tmux behind the same interface remote agents will use later.
