# Deployment modes

Four shapes you can run tmuxd in. They all share the same `.env`
vocabulary; the differences are which switches you flip and what
threat model you're signing up for.

For the trust-model rationale (why two tokens, what `namespace = sha256(userToken)`
buys you and what it doesn't), read `docs/identity-model.md` first.

## Decision tree

```
Want anyone besides yourself to use this hub?
├── No  → Mode A (single-user local)
└── Yes →
      Should the hub box itself host tmux sessions?
      ├── Yes → Mode B (hub + remote agents, mixed)
      └── No  → Mode C/D (TMUXD_HUB_ONLY=1)
                  Server token: private team key, or public?
                  ├── Private → Mode C (team deployment)
                  └── Public  → Mode D (community hub — read warnings)
```

## Mode matrix

| Mode | Use case | `TMUXD_HUB_ONLY` | `HOST` | Who needs a user token |
|---|---|---|---|---|
| **A. Single-user local** | One person, hub + tmux on the same box | unset | `127.0.0.1` | the user (web/CLI) |
| **B. Hub + remote agents** | Hub also hosts some sessions, plus agents on other boxes | unset | `0.0.0.0` | every web/CLI user **and** every agent |
| **C. Hub-only team** | Hub as pure router; sessions live on user agents | `1` | `0.0.0.0` | every user (same token for their CLI + their agent) |
| **D. Public community hub** | Anyone with the (public) server token can use the hub | `1` | `0.0.0.0` | every user generates their own |

`.env` for the hub is the same skeleton in all four; only `TMUXD_HUB_ONLY`
and `HOST` change. `TMUXD_USER_TOKEN` **never** appears in the hub's
`.env` — it lives on each user's client device.

---

## Mode A: Single-user local

The default. Hub and tmux on your laptop, only loopback access.

**Hub `.env`**:

```bash
TMUXD_SERVER_TOKEN=$(openssl rand -hex 32)
HOST=127.0.0.1
PORT=7681
```

**Use it**:
- Open `http://127.0.0.1:7681`
- Enter the server token
- Click **Generate** for a user token, save it, sign in
- The hub's local tmux is immediately visible. No agent needed.

**Threat model**: nothing reaches the box from outside loopback. The
user token here is mainly for stable identity across browsers / PWA
installs; whoever can ssh into your laptop can already do everything.

---

## Mode B: Hub + remote agents (mixed)

Hub is reachable on the network and **also** runs tmux locally; users
additionally run agents from their own boxes that register against the
hub. Web UI shows the hub's `local` host plus every connected agent's
host.

**Hub `.env`**:

```bash
TMUXD_SERVER_TOKEN=$(openssl rand -hex 32)
HOST=0.0.0.0
PORT=7681
```

**Each user's agent box** (`.env.agent.example` is the template):

```bash
TMUXD_HUB_URL=https://hub.example.com
TMUXD_SERVER_TOKEN=<same as hub>
TMUXD_USER_TOKEN=<your personal token>
TMUXD_HOST_ID=laptop
TMUXD_HOST_NAME="Alice Laptop"
```

**Use it**:
- `npm run agent` on each agent box
- Web/CLI sees `local` (hub box) + all your registered agents

⚠ **Caveat**: the hub's `local` host is visible to **every** user that
logs into the hub, regardless of their namespace. Every signed-in user
can open tmux sessions on the hub box itself. If that's not desired,
use Mode C — `TMUXD_HUB_ONLY=1` hides `local` and refuses
session-creation requests targeting the hub.

**Threat model**: same as A, plus each agent is reachable to the
namespace its user-token hashes to. Cross-namespace probes return
404; same hostId in two namespaces coexist (Alice's `laptop` ≠ Bob's
`laptop`). The hub itself runs tmux as whoever started the hub
process — so the hub box's filesystem and shell are accessible to
every signed-in user.

---

## Mode C: Hub-only team deployment ⭐

The recommended multi-user shape. Hub is pure routing/auth; **no
session is ever created on the hub box itself**. Every session lives
on a user agent.

**Hub `.env`**:

```bash
TMUXD_SERVER_TOKEN=$(openssl rand -hex 32)
TMUXD_HUB_ONLY=1
HOST=0.0.0.0
PORT=7681
```

`TMUXD_HUB_ONLY=1` makes the hub:

- 403 every `POST /api/sessions` and `POST /api/hosts/local/sessions`
  with `local_host_disabled`
- omit `local` from every namespace's `/api/hosts` response
- still happily route to any registered agent

**Each user**:

1. Operator hands out the server token (1Password, team vault, etc.).
2. User generates their own user token: `tmuxd login --hub <url> --server-token <secret> --user-token-generate`
3. User runs `npm run agent` on whichever boxes they want exposed,
   using the same user token everywhere.

**Onboarding cost**: zero hub config change for new users or new
agents. The hub never learns who they are; it just hashes whatever
user token shows up.

**Threat model**: the only people who can reach the hub at all are
those who hold the server token (treat like a team API key). Within
that circle, the namespace from `sha256(userToken)` keeps users out
of each other's sessions **as long as user tokens stay private**.
Namespace isolation is *convention isolation* — it does not defend
against a teammate who already holds the server token AND knows
another teammate's user token. For that level of isolation, you'd
need a real per-user authentication system (phase 2; see
`docs/identity-model.md`).

**Eviction**: rotate `TMUXD_SERVER_TOKEN` to lock everyone out who
hasn't received the new value. JWTs survive until 12h TTL expires;
to kill all live sessions immediately, also remove
`$TMUXD_HOME/jwt-secret` (or set `JWT_SECRET=` to a fresh value) and
restart.

---

## Mode D: Public community hub

⚠ **Read this section in full before deploying. Mode D is rarely the
right answer; it exists primarily to make the threat model boundary
unambiguous.**

Same `.env` as Mode C. The only difference is **what you do with the
server token**: you publish it. The README, a public web page, a
Slack channel anyone can join — somewhere a stranger can find it.

```bash
TMUXD_SERVER_TOKEN=public-demo-2026   # ← publicly known
TMUXD_HUB_ONLY=1
HOST=0.0.0.0
PORT=7681
```

### How does isolation still work if the server token is public?

The server token only authorizes *use of the hub*. It does not
identify you. Identity comes from your **user token**, which the
hub turns into your namespace via `sha256(userToken).slice(0, 16)`.
A stranger who reads the README can:

- Reach the hub: yes (they have the server token).
- See their own namespace: yes (whatever user token they invent).
- See **other people's** sessions: no, unless they happen to know
  someone else's user token. The hash is one-way; namespaces are
  not enumerable; cross-namespace probes return 404.

So namespace isolation in Mode D is genuine cryptographic isolation
between strangers — stronger, in some sense, than Mode C's
"convention" isolation between teammates who all hold the server
token.

### Why is Mode D still risky?

Three reasons. None of them are about isolation; they're about
*denial of service* and *user mistakes*.

1. **Resource abuse**. Anyone can use the hub as a tmux relay.
   tmuxd has no rate limits, quotas, or billing. A public hub
   pointed at a non-trivial machine *will* be used to mine
   crypto / proxy spam / host C2.

2. **Server-token rotation hurts**. The Mode C eviction story
   ("rotate the team key in 1Password") doesn't work — you'd have
   to update the public README and tell every legitimate stranger
   the new value, while attackers in the middle of an active
   session get a free TTL window.

3. **No way to evict an individual abuser**. There is no per-user
   ban list. Your only mitigations are network-layer (block their
   IP at your reverse proxy) or wholesale (rotate the server
   token, locking out everyone).

4. **Users will lose their identity**. Most strangers who hit a
   public hub will never save the user token they generated. Next
   visit they'll generate a new one, land in a fresh namespace,
   and find their old sessions invisible. That's correct behavior
   per the trust model, but it confuses everyone.

### When IS Mode D appropriate?

Honestly, almost never as-deployed. If you want a "demo anyone can
try":

- Run Mode C with the server token gated behind a signup flow
  (operator emails it after a CAPTCHA, GitHub OAuth, etc.). Sign
  up = receive server token. The flow remains "you generate your
  own user token from there."
- Add a reverse proxy with per-IP rate limiting and short JWT
  TTLs.
- Auto-prune disconnected agents and idle sessions.

If you really want strangers to share a hub, look at the phase-2
SSO path in `docs/identity-model.md` — that's where this gets
real.

---

## What you do NOT set, by mode

| Variable | A | B | C | D |
|---|---|---|---|---|
| `TMUXD_SERVER_TOKEN` | ✅ required | ✅ required | ✅ required | ✅ required (publicly known) |
| `TMUXD_HUB_ONLY` | unset | unset | `1` | `1` |
| `HOST` | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` | `0.0.0.0` |
| `PORT` | `7681` | `7681` | `7681` | `7681` |
| `TMUXD_USER_TOKEN` | **never on the hub** — lives on each user's client | | | |

---

## Agent-side `.env` (any mode that runs agents)

Use `.env.agent.example` as the template. Minimum four values:

```bash
TMUXD_HUB_URL=https://hub.example.com
TMUXD_SERVER_TOKEN=<same as hub>
TMUXD_USER_TOKEN=<your personal token>
TMUXD_HOST_ID=laptop
```

The agent does **not** read `TMUXD_HUB_ONLY`, `HOST`, `PORT`,
`JWT_SECRET`, `TMUXD_HOME`, or `TMUXD_AUDIT_DISABLE` — those are
hub-side. The agent makes a single outbound WebSocket to
`/agent/connect` and stays connected.

See `docs/hub-mode.md` for the full operations cookbook (audit
events, reconnect lifecycle, same-hostId-across-namespaces
behavior, troubleshooting).
