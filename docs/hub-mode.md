# Hub mode

This document describes how to deploy tmuxd as a **shared, multi-user hub**
with HAPI-style namespace isolation. If you only want a single-user local
web UI for `tmux`, ignore this file and follow the README quick start.

## Mental model

In hub mode the shared tmuxd server is a **proxy/router only**. It hosts
no end-user tmux sessions itself. Each user runs a tmuxd **agent** on
their own client device pointed at the hub; the hub routes the user's
browser to their own agent(s). The web UI shows hosts/sessions filtered
to the logged-in user's namespace.

```
Alice's laptop ─── agent ─┐
                          ├──►  shared tmuxd hub  ◄──── Alice (token:alice)
                          │
Bob's desktop  ─── agent ─┘                       ◄──── Bob   (token:bob)
```

There is one auth concept across the whole product:

- `TMUXD_TOKEN=<secret>` — the shared web-login token.
- Login body is always `{ token: "<secret>" }` for single-user, or
  `{ token: "<secret>:<namespace>" }` for multi-user. Bare token (no
  `:`) lands the user in the `default` namespace; `<secret>:alice`
  lands them in namespace `alice`.

**Critical:** namespace is a per-user *label*, not an auth boundary
against anyone who already holds `TMUXD_TOKEN`. See "Threat model"
below before deploying to anyone you'd not hand a house key.

## Setup

### 1. Configure the hub

```bash
# .env on the hub box
TMUXD_TOKEN=replace-with-a-long-random-secret
TMUXD_HUB_ONLY=1
TMUXD_AGENT_TOKENS=alice/laptop=replace-with-alice-agent-token,bob/desktop=replace-with-bob-agent-token

HOST=0.0.0.0
PORT=7681
```

`TMUXD_HUB_ONLY=1` disables every local-tmux route. The sysadmin who
maintains the box should SSH in directly to use tmux there; non-admins
cannot create local tmux through tmuxd.

### 2. Hand each user their bits

| User  | Agent token (raw secret)                | Web login string             |
| ----- | --------------------------------------- | ---------------------------- |
| Alice | `replace-with-alice-agent-token`        | `<TMUXD_TOKEN>:alice`        |
| Bob   | `replace-with-bob-agent-token`          | `<TMUXD_TOKEN>:bob`          |

Note the asymmetry: agents authenticate with the **raw** per-user token;
the web client logs in with `<TMUXD_TOKEN>:<namespace>`. The hub's
`TMUXD_AGENT_TOKENS` parser turns the per-user agent token into a
binding pinned to `(namespace, hostId)`.

### 3. Start the agents

On Alice's laptop (from a checkout of this repo):

```bash
TMUXD_HUB_URL=https://hub.example.com \
TMUXD_AGENT_TOKEN=replace-with-alice-agent-token \
TMUXD_AGENT_NAMESPACE=alice \
TMUXD_AGENT_ID=laptop \
TMUXD_AGENT_NAME="Alice Laptop" \
  npm run agent
```

Or with explicit flags:

```bash
npm run agent -- \
  --hub https://hub.example.com \
  --token replace-with-alice-agent-token \
  --namespace alice \
  --id laptop \
  --name "Alice Laptop"
```

`TMUXD_AGENT_NAMESPACE` must match the namespace pinned in the hub's
`TMUXD_AGENT_TOKENS`. If it does not, the hub closes the WebSocket with
code `4401 agent_namespace_mismatch` and the agent CLI exits with code
`2` and a one-line hint pointing at the flag.

Bob's machine is symmetric: `TMUXD_AGENT_NAMESPACE=bob`,
`TMUXD_AGENT_ID=desktop`, etc.

### 4. Use it from any terminal

Once Alice's agent is running, Alice can read and control her sessions
from any terminal — laptop, phone via SSH, CI runner — using the
`tmuxd` CLI. The CLI is a first-class HTTP client and mirrors `tmux`'s
own command vocabulary, so there's nothing new to learn beyond the
target syntax `-t <host>[:<session>[:<window>.<pane>]]`.

```bash
# One-time login on Alice's terminal. Note the `:alice` suffix on the token.
npm run tmuxd -- login --hub https://hub.example.com \
  --access-token "$TMUXD_TOKEN:alice"
# → "logged in to https://hub.example.com as namespace=alice; JWT TTL 12h0m"
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
# As bob, log in and try to peek at alice's host: must 404.
npm run tmuxd -- login --hub https://hub.example.com --access-token "$TMUXD_TOKEN:bob"
npm run tmuxd -- list-sessions -t laptop
# tmuxd: host_not_found (https://hub.example.com/api/hosts/laptop/sessions)
# (exit code 3)
```

If the second command ever returns Alice's session list, the deploy is
misconfigured — most likely a duplicate or unbound entry in
`TMUXD_AGENT_TOKENS`. The hub refuses to boot with duplicate
`(namespace, hostId)` bindings, but only with binding-level
duplicates; review your env var.

## Threat model

The namespace check is **convention isolation**, not authentication
against the people who already hold `TMUXD_TOKEN`. Specifically:

- Anyone with `TMUXD_TOKEN` can log in as any namespace they choose.
  The server validates the token with constant-time compare; it
  validates the namespace charset; it does **not** check that the
  caller is "really" alice.
- The actual blast-radius story comes from the per-user agent tokens:
  Alice's agent only registers under `(alice, laptop)`. So even if a
  rogue user logged in as `alice` in the web UI, they would see Alice's
  hosts only because Alice's agent is the one connected.
- Eviction therefore requires rotating both:
  1. `TMUXD_TOKEN` (so the evicted user can no longer log in), AND
  2. every per-user agent token in `TMUXD_AGENT_TOKENS` (so they cannot
     impersonate someone whose login they remember from before rotation).
- **Existing JWTs survive token rotation.** A JWT issued before
  rotation stays valid until its 12h TTL expires, because the JWT
  signing secret is independent of `TMUXD_TOKEN`. If you are
  evicting in anger and need to kill all live sessions immediately
  (web UI attaches and any in-flight API calls):
  - `rm $TMUXD_HOME/jwt-secret` (or set a new `JWT_SECRET=` env var to
    a 32+ byte value) AND
  - restart the hub.
  This invalidates **every** outstanding JWT, including legitimate
  users', who must log in again. For routine evictions that can wait
  out the TTL, just rotating `TMUXD_TOKEN` is enough — old JWTs
  can still hit the API but cannot be refreshed once they expire.

If you need real per-user authentication (Alice-the-user gets a
username + password and removing her doesn't rotate everyone else's
secrets), the design doc points to phase 2: a small SQLite user store
that drops in behind the same wire contract (JWT(`ns`), records stamped
with `ns`, ws-ticket(`ns`)).

## Operational notes

- **Same hostId, different namespaces are distinct records.** Alice's
  `laptop` and Bob's `laptop` do not collide. The registry keys agents
  by `(namespace, hostId)` end to end.
- **`local` is not a valid hostId for an agent.** The parser rejects
  `<ns>/local=...`.
- **Cross-namespace clipboard-image upload is not supported.** The
  server saves uploads to its own filesystem; the agent's shell runs
  on a different machine. The route returns `501
  clipboard_image_remote_unsupported`.
- **Token format inside `TMUXD_AGENT_TOKENS` is split on the first `=`.**
  Tokens may contain `=` (base64url padding works fine).
- **Duplicate bindings are rejected at startup.** Two entries with the
  same `(namespace, hostId)` pair, or two bindings sharing the same
  token, will fail boot with a clear error. Both are operator typos
  that produce ambiguous behavior; the parser refuses rather than
  silently shadowing one entry. To rotate a token, replace the entry
  in place rather than appending a duplicate.
- **Web ticket consumption is one-shot.** A wrong-target probe still
  burns the ticket — an attacker who guesses a ticket but the wrong
  hostId/sessionName cannot retry.

### Startup warning to take seriously

Hub-only mode without any agent bindings configured boots, but cannot
serve any tmux sessions:

```
[tmuxd] WARN: hub-only mode with no agent bindings configured.
Set TMUXD_AGENT_TOKENS=<ns>/<hostId>=<token>,... so agents can register,
otherwise /api/hosts will be empty for every user.
```

Pre-bind each agent in `TMUXD_AGENT_TOKENS` before starting the hub.

## Audit log (Phase 1)

Seven events are written to stderr at INFO level as single-line JSON,
prefixed with `[tmuxd:audit]`:

```
[tmuxd:audit] {"ts":"2026-05-11T10:29:55.001Z","event":"login_success","namespace":"alice","remoteAddr":"192.0.2.5"}
[tmuxd:audit] {"ts":"2026-05-11T10:29:58.412Z","event":"login_failure","namespace":"alice","remoteAddr":"203.0.113.9","reason":"token_mismatch"}
[tmuxd:audit] {"ts":"2026-05-11T10:29:59.108Z","event":"auth_failure","namespace":"","remoteAddr":"203.0.113.9","reason":"invalid_jwt"}
[tmuxd:audit] {"ts":"2026-05-11T10:30:14.012Z","event":"agent_register","namespace":"alice","hostId":"laptop","name":"Alice Laptop","remoteAddr":"198.51.100.42"}
[tmuxd:audit] {"ts":"2026-05-11T10:30:14.180Z","event":"agent_rejected","namespace":"eve","hostId":"laptop","name":"Eve Disguised","remoteAddr":"203.0.113.9","reason":"namespace_mismatch: binding=alice"}
[tmuxd:audit] {"ts":"2026-05-11T10:31:02.881Z","event":"ws_attach","namespace":"alice","hostId":"laptop","sessionName":"main","remoteAddr":"192.0.2.5"}
[tmuxd:audit] {"ts":"2026-05-11T11:02:33.117Z","event":"agent_disconnect","namespace":"alice","hostId":"laptop","reason":"agent_disconnected"}
```

- **`login_success`** fires after JWT issuance. The `namespace` field
  identifies who logged in; `remoteAddr` is best-effort from CF /
  X-Forwarded-For headers, falling through to the raw socket peer
  address for direct connections (only `'unknown'` when both fail).
- **`login_failure`** fires on every rejected `/api/auth` request. The
  `reason` field is one of `rate_limited`, `invalid_body`,
  `invalid_token_shape`, `token_mismatch`. The `namespace` is
  best-effort: it's the namespace the attacker tried to log into (the
  token was wrong, but the `:ns` suffix is still the forensic signal);
  empty when the body itself was unparseable.
- **`auth_failure`** fires on every rejected `/api/*` request that lacked
  a valid bearer JWT. `reason` is `missing_token` (no Authorization
  header) or `invalid_jwt` (tampered or expired). Distinct from
  `login_failure` (which is for `/api/auth` only). Use this to spot
  brute-forcing the API surface vs the login endpoint.
- **`agent_register`** fires when an agent successfully completes hello
  and is added to the registry. Use it to confirm that the right agent
  came up under the right namespace. Carries `remoteAddr` so you can
  see where the agent connected from.
- **`agent_rejected`** fires when an agent's WS connected with a valid
  token but its hello frame was refused — most importantly, namespace
  mismatch. `reason` is one of `missing_hello`, `invalid_hello`,
  `not_authenticated`, `host_already_connected`, `host_id_token_mismatch`,
  or `namespace_mismatch: binding=<ns>`. Carries `remoteAddr` of the
  agent process so you can identify a misbehaving box. This is the
  forensic signal for "an agent showed up trying to claim a namespace
  it isn't pinned to" — either misconfiguration or active probing.
- **`agent_disconnect`** pairs with `agent_register`. Fires when the
  agent's WS closes — `reason` carries one of `agent_disconnected`
  (clean WS close from the agent side), `agent_error` (transport error),
  `agent_timeout` (the hub stopped seeing heartbeats), or
  `server_shutdown` (the hub is going down). Answers "when did Bob's
  agent die last night?" without a separate log stream.
- **`ws_attach`** fires when the WS upgrade gate accepts an attach
  request. Use it to answer "who attached to my session at 3am" — the
  log line carries namespace + remote IP + sessionName.

Set `TMUXD_AUDIT_DISABLE=1` to silence the log (e.g. in tests). Phase 2
will replace this with a structured audit table; the events fired here
are the ones to keep.

## Single-user mode

Single-user is the no-namespace special case of the same auth flow. Set
`TMUXD_TOKEN`, do not set `TMUXD_HUB_ONLY`, and either:

- Skip `TMUXD_AGENT_TOKENS` entirely (only local tmux on the hub box), OR
- Set `TMUXD_AGENT_TOKEN=<single-secret>` for one agent (binds to default
  namespace).

Users log in with the bare token (no `:namespace` suffix). The JWT is
stamped with namespace `default`. The web UI does not display a
namespace badge in this mode (since `default` is the implicit default).

## Migration from older configs

`TMUXD_PASSWORD` and `TMUXD_BASE_TOKEN` are accepted as deprecated
aliases for `TMUXD_TOKEN`, with a startup warning:

```
[tmuxd] TMUXD_PASSWORD is deprecated; please rename to TMUXD_TOKEN. Single-user login is the same value with no `:namespace` suffix.
```

Rename in your `.env` and the warning goes away. The wire contract does
not change — both old configs result in the same JWT shape.

## Phase 2 forward path

When this gets swapped for a real per-user user store, **the wire
contract does not change**. JWT(`ns`), records stamped with `ns`,
ws-ticket(`ns`) — same shapes. The only thing that changes is *where*
the namespace string comes from: typed by the client today, looked up
from a `users` row tomorrow.
