# Deployment modes

Three shapes you can run tmuxd in. They share the same `.env`
vocabulary; the differences are which switches you flip and what
the threat surface looks like.

For the trust-model rationale (why two tokens, what `namespace = sha256(userToken)`
buys you and what it doesn't), read `docs/identity-model.md` first.

## Decision tree

```
Want anyone besides yourself to use this hub?
├── No  → Mode A: single-user local
└── Yes →
      Should the hub box itself host tmux sessions?
      ├── Yes → Mode B: hub + remote agents (mixed)
      └── No  → Mode C: hub-only multi-user ⭐
```

## Mode matrix

| Mode | Use case | `TMUXD_HUB_ONLY` | `HOST` | Who needs a user token |
|---|---|---|---|---|
| **A. Single-user local** | One person, hub + tmux on the same box | unset | `127.0.0.1` | the user (web/CLI) |
| **B. Hub + remote agents** | Hub also hosts some sessions, plus agents on other boxes | unset | `0.0.0.0` | every web/CLI user **and** every agent |
| **C. Hub-only multi-user** | Hub as pure router; sessions live on user agents | `1` | `0.0.0.0` | every user (same token for their CLI + their agent) |

`.env` for the hub is the same skeleton in all three; only `TMUXD_HUB_ONLY`
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

## Mode C: Hub-only multi-user ⭐

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

1. Operator hands out the server token (see "Distributing the server token" below).
2. User generates their own user token: `tmuxd login --hub <url> --server-token <secret> --user-token-generate`
3. User runs `npm run agent` on whichever boxes they want exposed,
   using the same user token everywhere.

**Onboarding cost**: zero hub config change for new users or new
agents. The hub never learns who they are; it just hashes whatever
user token shows up.

**Threat model**: the only people who can reach the hub at all are
those who hold the server token. Within that circle, the namespace
from `sha256(userToken)` keeps users out of each other's sessions
**as long as user tokens stay private**. The strength of namespace
isolation depends on whether you trust the people who hold the
server token — see "Distributing the server token" below.

**Eviction**: rotate `TMUXD_SERVER_TOKEN` to lock everyone out who
hasn't received the new value. JWTs survive until 12h TTL expires;
to kill all live sessions immediately, also remove
`$TMUXD_HOME/jwt-secret` (or set `JWT_SECRET=` to a fresh value) and
restart.

---

## Distributing the server token

This is an **operational** choice, not a mode. The hub's behavior is
identical regardless of how the server token gets to its eventual
holders. What changes is who's in the trust circle.

The choice is a continuum:

| Distribution | Trust circle size | Isolation strength |
|---|---|---|
| 1Password / team vault, 5 people | small, mutually trusting | "convention isolation" — strangers blocked at the door, teammates *could* impersonate but won't |
| New-hire onboarding email, 50 people | medium, professionally accountable | same as above; bigger circle, weaker assumptions |
| Approval-gated signup (CAPTCHA, GitHub OAuth, manual review) | medium-large, partial trust | namespace becomes the only effective barrier between holders |
| Public README / homepage | unbounded | anyone can reach the hub; namespace isolation is pure cryptographic separation between strangers |

**Two important properties of the namespace gate**:

1. **It IS a real cryptographic barrier between strangers.** A user
   with their own user token cannot enumerate, guess, or compute
   another user's namespace. The hash is one-way; cross-namespace
   probes return 404. Two strangers on the same hub are genuinely
   isolated as long as neither knows the other's user token.

2. **It is NOT a barrier between people who already share the
   server token.** If Bob holds the server token, namespace
   isolation does not stop Bob from logging in with whatever user
   token he wants. It stops him from *seeing Alice's namespace*
   only because he doesn't know Alice's user token, not because
   the system actively authenticates "Bob is not Alice." For real
   per-user authentication, see the phase-2 SSO path in
   `docs/identity-model.md`.

**Practical defaults**:

- Closed team (≤ N people you'd give an SSH key to): pass the server
  token through whatever channel you already trust for team secrets.
- Wider audience: gate distribution behind something — at minimum a
  signup form with email confirmation, ideally an auth provider.
- Public hub with the token in a README: only for ephemeral demos /
  workshops / hackathons. Public hubs have **no defense against
  resource abuse** (no rate limits, quotas, or per-user eviction);
  expect them to be used as relays for things you don't want to
  host. Add a reverse-proxy rate limit at minimum, and prefer a
  signup gate even for "public" demos.

---

## How user tokens are actually handled

Common misconception: user tokens are encrypted/hashed before use,
like website passwords. They're **not** — and the design is
deliberate, not a leak.

```
┌─ Client (your laptop / phone / agent box) ──────────────────────┐
│                                                                 │
│   CLI:    ~/.tmuxd/cli/credentials.json   (plaintext, mode 0600)│
│   Web:    localStorage[tmuxd:userToken]    (plaintext)          │
│   Agent:  TMUXD_USER_TOKEN env var         (plaintext)          │
│                                                                 │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                          │  HTTP body / WS query string (plaintext)
                          │  ←─ TLS encrypts this on the wire
                          ▼
┌─ Hub ───────────────────────────────────────────────────────────┐
│                                                                 │
│   Receives raw userToken                                        │
│       ↓                                                         │
│   namespace = sha256(userToken).slice(0, 16)                    │
│       ↓                                                         │
│   JWT / registry / ws-ticket all carry only the hashed namespace│
│       ↓                                                         │
│   Raw userToken goes out of scope; hub NEVER persists it        │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**vs a normal password system:**

| | Normal website password | tmuxd user token |
|---|---|---|
| Client storage | OS keychain / browser autofill (plaintext) | plaintext file or localStorage |
| Wire format | plaintext over HTTPS | plaintext over HTTPS |
| Server storage | bcrypt/argon2 hash in DB | **not stored** — hashed once to derive namespace, then dropped |
| What identifies you | password + DB lookup | the user token IS the identity |

The model is closer to **API keys / SSH private keys** than to
passwords:

- The token *is* the credential. There's no "password reset" flow
  because there's nothing to look up.
- Whoever holds the token IS the identity it points at.
- Losing the file means losing the identity (and any sessions tied
  to its namespace).

**What this means in practice:**

- Treat user tokens like SSH private keys: 0600 file mode, never in
  Slack, never committed to git, OS-level disk encryption ideally.
- Use HTTPS in any non-loopback deployment. The CLI prints a stderr
  warning when `--hub http://...` points at a non-loopback host.
- A compromised client = identity loss for that user. A compromised
  hub does NOT one-shot leak every user's token, because the hub
  doesn't have them — at most an attacker reads the live JWT list
  (which carries namespaces, not raw tokens) until JWTs rotate.

---

## What you do NOT set, by mode

| Variable | A | B | C |
|---|---|---|---|
| `TMUXD_SERVER_TOKEN` | ✅ required | ✅ required | ✅ required |
| `TMUXD_HUB_ONLY` | unset | unset | `1` |
| `HOST` | `127.0.0.1` | `0.0.0.0` | `0.0.0.0` |
| `PORT` | `7681` | `7681` | `7681` |
| `TMUXD_USER_TOKEN` | **never on the hub** — lives on each user's client | | |

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
