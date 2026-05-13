# Identity model

This document explains how tmuxd thinks about "who are you" — the trust
relationship between the server, the people who use it, and the clients
those people run on their own boxes. Code in `shared/src/identity.ts`,
`server/src/auth.ts`, `server/src/clientRegistry.ts`, and
`server/src/cli.ts` all point at this file as the rationale.

## The two tokens

```
┌───────────────────────────────────────────────────────────┐
│  TMUXD_SERVER_TOKEN  — shared by everyone in the circle.  │
│                        Issued once per deployment.        │
│                        Authorizes use of the server.      │
│                                                           │
│  TMUXD_USER_TOKEN    — personal. One per identity.        │
│                        Hashed into a namespace.           │
│                        Identifies *who* you are.          │
└───────────────────────────────────────────────────────────┘
```

Every actor that talks to the server — the web UI, the `tmuxd` CLI, an
outbound `tmuxd` client — presents **both** tokens:

| Caller | Server token | User token |
|---|---|---|
| Web/CLI login (`POST /api/auth`) | `serverToken` field in JSON body | `userToken` field in JSON body |
| Client WS upgrade (`/client/connect`) | `?serverToken=…` query param | `?userToken=…` query param |

The server:
1. Constant-time-compares the server token against `TMUXD_SERVER_TOKEN`.
   Wrong token → 401 Unauthorized, no further processing.
2. Computes `namespace = sha256(userToken).slice(0, 16)` (16 lowercase
   hex chars, 64 bits of entropy).
3. Stamps the resulting authentication token (JWT for HTTP, in-memory
   record for WS) with that namespace.

The server never persists user tokens. They live only in memory long
enough to compute the hash, then go out of scope.

## Why two separate concepts

A single token would have to mean both "are you allowed in" and "who
are you". Conflating those locks the deployment into one of two bad
shapes:

- **Per-user secrets configured server-side.** Adding a user requires
  editing `.env` on the server and restarting. (This was the old
  `TMUXD_AGENT_TOKENS=alice/laptop=…` approach. It scales like writing
  every customer's name on a wall.)
- **One shared password for everyone.** No way to tell users apart;
  every web client lands in the same namespace; clients collide.

Splitting them gives:

- **Onboarding without server changes.** A new user picks a user token
  on their own box (or runs `tmuxd login --user-token-generate`), logs
  in. The server doesn't need a config change. As long as they know
  the server token, they're in.
- **Stable identity without operator coordination.** `sha256(userToken)`
  is deterministic, so the same user token from the same person
  produces the same namespace on every device, every login session,
  every server upgrade.
- **Compatible with corporate SSO later.** Phase 2 can derive the user
  token from a verified-by-SSO identifier (employee ID, email, SAML
  subject) and pipe it through the same `computeNamespace`. The wire
  contract doesn't change.

## What the namespace gives you (and what it doesn't)

The namespace is **isolation between users who already share the
trust circle**. Specifically:

- Every persistent record (saved actions, client registrations, JWTs,
  WS tickets) carries the namespace it was minted under.
- Every read API filters its results by the calling JWT's namespace.
- Cross-namespace probes (Alice asking for `/hosts/bob-laptop/sessions`)
  return 404 — same code path the API uses for "host doesn't exist".
- Same hostId in two namespaces is two distinct records. Alice's
  `laptop` and Bob's `laptop` coexist; reads from one namespace never
  see the other.

What it does **not** give you:

- It is **not** authentication against people who hold the server
  token. Anyone with `TMUXD_SERVER_TOKEN` can pick any user token and
  log into the namespace it derives. If you want resistance to "Bob
  knows the team key but tries to log in as Alice", you need a real
  user store — phase 2.
- It is **not** an authorization system. There are no roles, no ACLs.
  Inside a namespace, the JWT-bearer can do everything the server
  exposes for that namespace.

In other words: the server token is the trust boundary, the user
token is the convention boundary.

## Threat model

> "Who can do what against whom?"

| Adversary | Can | Cannot |
|---|---|---|
| Stranger off the internet | Send `/health` requests; receive 401 from everything else. | Read or write anything in any namespace. |
| Has the **server token only** | Log in as any namespace they pick (by inventing a user token). See clients that registered with the *same* user token they invented. | See any namespace whose user token they don't know. (Hashes are one-way.) |
| Has **server + a specific user token** | Full read/write inside that user's namespace. | Cross into other namespaces. |
| Has compromised the server itself | Everything for everyone. The server token rotation tool below is the only mitigation. | — |

Design implications:
- **Treat the server token like a team API key.** Anyone you give it
  to can pose as any persona on the server. Don't paste it into Slack.
- **Treat the user token like an SSH private key.** Whoever has it
  *is* you on every server that uses the same `sha256(userToken)` =
  namespace mapping.
- **Rotation:**
  - Rotating the **server token** evicts everyone who hasn't gotten
    the new one. Old JWTs (issued under the old server token) still
    pass `verifyJwt` until their TTL expires (12h default), because
    JWT signing uses an independent secret. To kill all live sessions
    immediately, also delete `$TMUXD_HOME/jwt-secret` (or set
    `JWT_SECRET=` to a fresh value) and restart.
  - Rotating a **user token** changes that user's namespace.
    Everything they had under the old namespace becomes invisible to
    them (and to anyone else). This is the right move when the user
    suspects their token leaked. The old records still exist on disk,
    keyed under the old namespace; they will sit dormant until a
    server operator garbage-collects them.

## Wire contract

### `POST /api/auth`

Request body (JSON):

```json
{
  "serverToken": "<TMUXD_SERVER_TOKEN>",
  "userToken":   "<personal user token>"
}
```

Response (200):

```json
{
  "token":     "<JWT>",
  "expiresAt": 1778611693,
  "namespace": "1c3f5b8a1e6d9f02"
}
```

Errors:
- 400 `invalid_body` — body missing fields, malformed JSON, or
  non-string values.
- 401 `invalid_token` — server token wrong (constant-time compared).

### Client WebSocket: `GET /client/connect`

Query string:

```
?serverToken=<TMUXD_SERVER_TOKEN>&userToken=<personal user token>
```

We pass tokens via query string — not the `Authorization` header —
because intermediate proxies sometimes strip `Authorization` on
`Upgrade` requests. The connection upgrades immediately to a TLS-
protected WebSocket (assuming `wss://`); the URL is not durably
logged by tmuxd itself. Operators are responsible for not pointing
reverse-proxy access logs at the upgrade path.

After a successful upgrade, the client sends a `hello` frame with
`{ id, name, version, capabilities }`. The server stamps the registered
host record with `namespace = sha256(userToken).slice(0, 16)` derived
from the upgrade's query.

Reject paths:
- HTTP 401 at upgrade: missing `serverToken`, missing `userToken`, or
  server token mismatch. The client's `connectOnce` catches this and
  exits with code 2 (FatalConfigError) — there is no point retrying.
- WS close 1008 `host_already_connected` after the upgrade succeeds:
  another client in the same namespace already claims this hostId.
  Same exit-code-2 path.

### JWT shape

```json
{ "ns": "1c3f5b8a1e6d9f02", "iat": 1778568493, "exp": 1778611693 }
```

`ns` is the only namespace claim. Routes consume it via the
`requireNamespace` middleware; the registry consumes it via
`hasHost(namespace, hostId)` and friends.

## Shapes you can build on top of this

The trust-circle size is a continuum (see "Distributing the server
token" in `docs/deployment-modes.md`); these are points on it.

- **Single-user.** The "default" deployment: one server token, one
  user token. The user token is implicit (a fixed string in `.env`,
  or generated once with `tmuxd login --user-token-generate`).
- **Small team, no SSO.** One server token in 1Password, every member
  picks their own user token (or generates one). Onboarding is "tell
  them the server token + show them how to run `tmuxd login`."
- **Wider audience with a signup gate.** Server token distributed via
  an approval-gated flow (CAPTCHA / email confirmation / GitHub
  OAuth). Same server config as the small-team shape; the gate lives
  in the distribution layer, not the server. Namespace separation
  becomes the primary barrier between holders, so this is appropriate
  only for use cases where "anyone in the circle could in principle
  reach anyone else's namespace if they knew the user token" is
  acceptable.
- **Corporate SSO** (phase 2). Server computes the user token by
  HMAC-ing the SSO subject ID. The user token is never typed; it's
  derived from "the user who just authed via SSO." The wire contract
  is unchanged: server still receives `userToken` from the auth flow,
  still computes the same `sha256` namespace.

A note on truly **public** distribution (server token in a README):
the server itself doesn't care, but at scale you'll hit problems the
trust model can't solve — resource abuse, no per-user eviction,
rotation locks out legitimate users along with attackers. Add a
signup gate even for "public" demos, or run the server behind an
authenticating reverse proxy.

## Why sha256 and 16 hex chars

- **One-way.** A leaked namespace cannot be reversed into the user
  token that produced it. (Brute force is bounded only by user-token
  entropy, which is the user's responsibility — `--user-token-generate`
  produces 256 bits, which is comfortably out of reach.)
- **Stable.** Same input always produces the same output, so a user
  who re-clones their setup on a new device gets the same namespace.
- **Short.** 16 hex chars (64 bits of entropy) is enough that even
  a team of 10⁶ users has a collision probability under 2⁻³², which
  is fine. Users who care about collisions can use longer
  user tokens — the input space is unbounded.
- **Printable.** Lowercase hex makes namespaces safe in URLs, JWTs,
  filenames, log lines, audit records.

The constants live in `shared/src/identity.ts`. If we ever change
them, every JWT in flight becomes invisible to its old namespace —
plan a migration window or a dual-read.
