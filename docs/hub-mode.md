# Hub mode

This document describes how to deploy tmuxd as a **shared, multi-user hub**
where every user gets their own namespace without operator-side
configuration. If you only want a single-user local web UI for `tmux`,
ignore this file and follow the README quick start.

Companion docs:
- `docs/deployment-modes.md` — picking between the four shapes
  (single-user, hub+agents mixed, hub-only team, public community)
- `docs/identity-model.md` — trust-model rationale: server token vs
  user token, why hashing, threat model

This file is the operations cookbook for the hub-only multi-user shape
(Mode C in deployment-modes.md). Read either of the two above first.

## Mental model

In hub mode the shared tmuxd server is a **proxy/router only**. It hosts
no end-user tmux sessions itself. Each user runs a tmuxd **agent** on
their own client device pointed at the hub; the hub routes the user's
browser/CLI to their own agent(s). The web UI shows hosts/sessions
filtered to the logged-in user's namespace.

```
Alice's laptop ─── agent ─┐
                          ├──►  shared tmuxd hub  ◄──── Alice (server + alice user-token)
                          │
Bob's desktop  ─── agent ─┘                       ◄──── Bob   (server + bob user-token)
```

Two tokens, no operator coordination per user:

- **Server token** (`TMUXD_SERVER_TOKEN` on the hub) is the shared
  trust-circle key. Every user — and every agent — needs it. Treat it
  like a team API key.
- **User token** (`TMUXD_USER_TOKEN` on every client device) is each
  person's personal identity. The hub computes
  `namespace = sha256(userToken).slice(0, 16)` from it on every
  request. The hub does **not** store user tokens.

There is no static `TMUXD_AGENT_TOKENS=alice/laptop=…` registration
anymore. Agents self-declare on connect; the hub trusts the math
(server token gates the door, user token decides whose room you walk
into) and keys all in-memory state by the hashed namespace.

## Setup

### 1. Configure the hub

```bash
# .env on the hub box
TMUXD_SERVER_TOKEN=replace-with-a-long-random-secret
TMUXD_HUB_ONLY=1

HOST=0.0.0.0
PORT=7681
```

That's the entire hub config. `TMUXD_HUB_ONLY=1` disables every
local-tmux route; the sysadmin who maintains the box should SSH in
directly to use tmux there. Start the hub:

```bash
npm install
npm run build
npm start
```

The first user-namespace appears the moment any user logs in or any
agent connects — no further server changes.

### 2. Hand each user the server token

```
TMUXD_SERVER_TOKEN=<the-long-random-secret-from-step-1>
```

Send it through whatever channel you use for team secrets (1Password,
shared vault, wire-format you trust). This is the only thing the
operator hands out — adding a user is "give them the server token,
tell them where the hub lives."

### 3. Each user picks (or generates) a user token

On Alice's laptop:

```bash
# Generate a fresh random user token (32 bytes, 64 hex chars).
# tmuxd login --user-token-generate prints it to stderr — save it
# to a password manager. Whoever has this token IS you on the hub.
npm run tmuxd -- login \
  --hub https://hub.example.com \
  --server-token "$TMUXD_SERVER_TOKEN" \
  --user-token-generate
# → tmuxd: generated user token (save this somewhere safe — it IS your identity):
# →   d1a2c8...0f9b
# → logged in to https://hub.example.com as namespace=1c3f5b8a1e6d9f02; JWT TTL 12h0m
# → credentials saved to /home/alice/.tmuxd/cli/credentials.json (mode 0600)
```

After that one-time generation, Alice's `TMUXD_USER_TOKEN` is whatever
she saved. She uses the same value on every device that should appear
under the same identity. (Phone, work laptop, home desktop, CI runner
— same token everywhere.)

Bob does the same, gets a different token, lands in a different
namespace.

### 4. Start the agents

On Alice's laptop, the agent connects with the same two tokens:

```bash
TMUXD_HUB_URL=https://hub.example.com \
TMUXD_SERVER_TOKEN=<the-server-token> \
TMUXD_USER_TOKEN=<alice's-user-token-from-step-3> \
TMUXD_HOST_ID=laptop \
TMUXD_HOST_NAME="Alice Laptop" \
  npm run agent
```

Or with explicit flags:

```bash
npm run agent -- \
  --hub https://hub.example.com \
  --server-token "$TMUXD_SERVER_TOKEN" \
  --user-token  "$TMUXD_USER_TOKEN" \
  --host-id laptop \
  --host-name "Alice Laptop"
```

The agent lands in `namespace = sha256(TMUXD_USER_TOKEN).slice(0, 16)`,
which is the same namespace the CLI/web logs into using that user
token. Bob's machine is symmetric: same server token, his own user
token, his own choice of `TMUXD_HOST_ID`.

If the server token is wrong, the hub closes the upgrade with HTTP 401
and the agent exits with code 2 (FatalConfigError; the agent prints a
hint pointing at `TMUXD_SERVER_TOKEN`).

### 5. Use it from any terminal

Once Alice's agent is running, Alice can read and control her sessions
from any terminal — laptop, phone via SSH, CI runner — using the
`tmuxd` CLI. The CLI mirrors `tmux`'s own command vocabulary; the only
new concept is `-t <host>[:<session>[:<window>.<pane>]]`.

```bash
# One-time login on Alice's terminal.
npm run tmuxd -- login --hub https://hub.example.com \
  --server-token "$TMUXD_SERVER_TOKEN" \
  --user-token  "$TMUXD_USER_TOKEN"
# → "logged in to https://hub.example.com as namespace=1c3f5b8a1e6d9f02; JWT TTL 12h0m"
# → "credentials saved to /home/alice/.tmuxd/cli/credentials.json (mode 0600)"

# Daily use — same verbs as tmux, just with `-t <host>:` in front.
npm run tmuxd -- list-hosts
npm run tmuxd -- list-sessions -t laptop
npm run tmuxd -- capture-pane  -t laptop:main:0.0 --lines 100
npm run tmuxd -- send-text     -t laptop:main:0.0 --enter '/status'
npm run tmuxd -- whoami       # shows JWT TTL; <30m → "(re-login soon)"
```

The CLI *only* sees Alice's hosts, even though every namespace's agents
register against the same hub. This is the same `(namespace, hostId)`
isolation the API enforces — driven through the same JWT(`ns`) +
`requireNamespace` + `hasHost(ns, hostId)` chokepoints used by the web
UI. A quick way to confirm isolation works on a new deploy:

```bash
# As bob, log in with HIS user token and try to peek at alice's host: must 404.
npm run tmuxd -- login --hub https://hub.example.com \
  --server-token "$TMUXD_SERVER_TOKEN" \
  --user-token  "$BOB_USER_TOKEN"
npm run tmuxd -- list-sessions -t laptop
# tmuxd: not_found (https://hub.example.com/api/hosts/laptop/sessions)
# (exit code 3)
```

If the second command ever returns Alice's session list, the deploy is
misconfigured — most likely Alice and Bob ended up sharing a user token.

## Threat model (summary)

The full version lives in `docs/identity-model.md`. The 30-second
version:

- **Server token = trust circle entry.** Anyone with it can pose as any
  persona by inventing or guessing a user token. Don't share it
  carelessly.
- **User token = identity.** Whoever has it IS you on the hub. Treat
  like an SSH private key.
- **Namespace isolation is convention.** It keeps users out of each
  other's sessions, but only as long as user tokens stay secret. It is
  **not** authentication against people who already hold the server
  token.
- **Eviction:** rotate `TMUXD_SERVER_TOKEN` to lock everyone out who
  hasn't received the new value. Old JWTs survive until 12h TTL
  expires; for immediate kill, also delete `$TMUXD_HOME/jwt-secret`
  (or set `JWT_SECRET=` to a fresh 32+ byte value) and restart.

## Operational notes

- **Same hostId, different namespaces are distinct records.** Alice's
  `laptop` and Bob's `laptop` do not collide. The registry keys agents
  by `(namespace, hostId)` end to end.
- **`local` is not a valid hostId for an agent.** The hub rejects
  agent hellos that try to claim it.
- **Cross-namespace clipboard-image upload is not supported.** The
  server saves uploads to its own filesystem; the agent's shell runs
  on a different machine. The route returns
  `501 clipboard_image_remote_unsupported`.
- **Duplicate hostId within one namespace is rejected at hello time.**
  If Alice tries to start two agents both calling themselves `laptop`,
  the second one's WS closes with `1008 host_already_connected` and
  the agent exits 2. Pick a different `--host-id` or stop the other
  agent first.
- **Web ticket consumption is one-shot.** A wrong-target probe still
  burns the ticket — an attacker who guesses a ticket but the wrong
  hostId/sessionName cannot retry.

## Audit log

Seven events are written to stderr at INFO level as single-line JSON,
prefixed with `[tmuxd:audit]`:

```
[tmuxd:audit] {"ts":"2026-05-12T10:29:55.001Z","event":"login_success","namespace":"1c3f5b8a1e6d9f02","remoteAddr":"192.0.2.5"}
[tmuxd:audit] {"ts":"2026-05-12T10:29:58.412Z","event":"login_failure","namespace":"","remoteAddr":"203.0.113.9","reason":"invalid_token"}
[tmuxd:audit] {"ts":"2026-05-12T10:29:59.108Z","event":"auth_failure","namespace":"","remoteAddr":"203.0.113.9","reason":"invalid_jwt"}
[tmuxd:audit] {"ts":"2026-05-12T10:30:14.012Z","event":"agent_register","namespace":"1c3f5b8a1e6d9f02","hostId":"laptop","name":"Alice Laptop","remoteAddr":"198.51.100.42"}
[tmuxd:audit] {"ts":"2026-05-12T10:30:14.180Z","event":"agent_rejected","namespace":"","hostId":"laptop","name":"Eve Disguised","remoteAddr":"203.0.113.9","reason":"invalid_hello"}
[tmuxd:audit] {"ts":"2026-05-12T10:31:02.881Z","event":"ws_attach","namespace":"1c3f5b8a1e6d9f02","hostId":"laptop","sessionName":"main","remoteAddr":"192.0.2.5"}
[tmuxd:audit] {"ts":"2026-05-12T11:02:33.117Z","event":"agent_disconnect","namespace":"1c3f5b8a1e6d9f02","hostId":"laptop","reason":"agent_disconnected"}
```

- **`login_success`** fires after JWT issuance. The `namespace` field
  is the hashed namespace the user logged into. `remoteAddr` is
  best-effort from CF / X-Forwarded-For headers, falling through to
  the raw socket peer for direct connections.
- **`login_failure`** fires on every rejected `/api/auth` request.
  `reason` is one of `rate_limited`, `invalid_body`, `invalid_token`.
  The `namespace` is empty by design — we don't reveal which user
  token an attacker guessed at, only that *some* attempt failed.
- **`auth_failure`** fires on every rejected `/api/*` request that
  lacked a valid bearer JWT. `reason` is `missing_token` or
  `invalid_jwt`. Distinct from `login_failure` (which is for
  `/api/auth` only). Use this to spot brute-forcing the API surface
  vs the login endpoint.
- **`agent_register`** fires when an agent successfully completes
  hello. Use it to confirm that the right agent came up under the
  right namespace. Carries `remoteAddr` so you can see where the
  agent connected from.
- **`agent_rejected`** fires when an agent connected with a valid
  server token but its hello frame was refused. `reason` is one of
  `missing_hello`, `invalid_hello`, `not_authenticated`,
  `host_already_connected`, or `invalid_host_id`. Carries
  `remoteAddr` of the agent process. (Wrong-server-token rejections
  happen at the upgrade layer and never reach this audit channel —
  they show up as 401 in the access log of the front proxy.)
- **`agent_disconnect`** pairs with `agent_register`. `reason`
  carries one of `agent_disconnected` (clean WS close from the
  agent), `agent_error` (transport error), `agent_timeout` (the hub
  stopped seeing heartbeats), or `server_shutdown`.
- **`ws_attach`** fires when the WS upgrade gate accepts an attach
  request. Use it to answer "who attached to my session at 3am" —
  the log line carries namespace + remote IP + sessionName.

Set `TMUXD_AUDIT_DISABLE=1` to silence the log (e.g. in tests).

## Single-user mode

Single-user is the no-multi-user-coordination special case. Set
`TMUXD_SERVER_TOKEN` and a fixed `TMUXD_USER_TOKEN`, do not set
`TMUXD_HUB_ONLY`. The agent (if any) connects with the same two
tokens. The web UI / CLI logs in with the same two tokens. There's
exactly one namespace because there's only one user token in play.

If you want even less ceremony for purely-local use:

- Run `tmuxd login --user-token-generate` once on your laptop.
- Save the generated token to `.env` as `TMUXD_USER_TOKEN`.
- Forget the namespace exists.

## Phase 2 forward path

When this gets swapped for SSO-backed identity, **the wire contract
does not change**. JWT(`ns`), records stamped with `ns`, ws-ticket(`ns`)
— same shapes. The only thing that changes is *where* the user
token comes from: typed by the client today, derived from a verified
SSO subject tomorrow (e.g. `userToken = HMAC(secret, ssoSubjectId)`).
The `computeNamespace` step stays. Existing per-user data carries
forward as long as the SSO-derived user token deterministically maps
to the same namespace the user already used.
