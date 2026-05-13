import { z } from 'zod'

const MAX_WS_INPUT_PAYLOAD = 64 * 1024
const MAX_AGENT_TEXT_PAYLOAD = 64 * 1024
const MAX_CAPTURE_LINES = 10_000
const MAX_CAPTURE_BYTES = 384 * 1024
const MAX_SESSION_NAME_LENGTH = 64
const MAX_SESSION_TARGET_NAME_LENGTH = 256
const base64Schema = z
    .string()
    .max(MAX_WS_INPUT_PAYLOAD)
    .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Invalid base64 payload')

/** Valid tmux session name — argv-safe, filesystem-safe. */
export const sessionNameSchema = z
    .string()
    .min(1)
    .max(MAX_SESSION_NAME_LENGTH)
    .regex(/^[A-Za-z0-9._-]+$/, 'Invalid session name')

/**
 * Session names for existing tmux sessions.
 *
 * tmux allows richer names (including spaces), while tmuxd's own create flow
 * keeps names argv-safe separately. This schema validates names that are
 * intended for reference only.
 */
const isUnsafeSessionTargetNameChar = (value: string): boolean =>
    /[\0\r\n;|&$`%:\\\\]/.test(value) || value.startsWith('-')

export const sessionTargetNameSchema = z
    .string()
    .min(1)
    .max(MAX_SESSION_TARGET_NAME_LENGTH)
    .refine((value) => value.length === value.trim().length, 'Invalid session name')
    .refine((value) => !isUnsafeSessionTargetNameChar(value), 'Invalid session name')

const isSafeSessionTargetName = (value: string): boolean => sessionTargetNameSchema.safeParse(value).success
const isPaneIdTarget = (value: string): boolean => /^%\d+$/.test(value)

export const hostIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Invalid host id')

/**
 * Valid namespace identifier.
 *
 * Namespaces are derived from user tokens via `computeNamespace()` in
 * `identity.ts` — 16 lowercase hex characters (64 bits of a sha256
 * digest). The regex enforces that shape everywhere a namespace flows
 * through a schema (JWT ns claim, agent WS handshake, audit records,
 * credentials file), so anything that doesn't look like a computed
 * namespace is rejected early.
 */
export const namespaceSchema = z
    .string()
    .length(16)
    .regex(/^[a-f0-9]{16}$/, 'Invalid namespace')

export const tmuxPaneTargetSchema = z
    .string()
    .min(1)
    .max(96)
    .superRefine((target, ctx) => {
        if (isPaneIdTarget(target)) return
        if (!target.includes(':')) {
            if (isSafeSessionTargetName(target)) return
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [],
                message: 'Invalid tmux pane target'
            })
            return
        }
        const colonIndex = target.lastIndexOf(':')
        if (colonIndex <= 0 || colonIndex === target.length - 1) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [],
                message: 'Invalid tmux pane target'
            })
            return
        }
        const sessionName = target.slice(0, colonIndex)
        const windowSpec = target.slice(colonIndex + 1)
        if (!isSafeSessionTargetName(sessionName) || !/^[0-9]+(?:\.[0-9]+)?$/.test(windowSpec)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [],
                message: 'Invalid tmux pane target'
            })
            return
        }
    })

export const tmuxKeySchema = z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z0-9_-]+$/, 'Invalid tmux key')
    .refine((key) => !key.startsWith('-'), 'tmux key must not start with -')

export const tmuxActionIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Invalid action id')

/**
 * Login body.
 *
 * The client POSTs two tokens:
 *   - serverToken: the shared trust-circle token (= TMUXD_SERVER_TOKEN
 *     on the hub). Required for every request; only holders of this
 *     token may use the hub as a relay.
 *   - userToken: the client's personal token. The hub does NOT store
 *     this; it derives a stable namespace via sha256(userToken) and
 *     stamps that namespace onto the JWT.
 *
 * Both tokens are opaque strings; only length is bounded to prevent
 * absurd payloads.
 *
 * See `docs/identity-model.md`.
 */
export const loginSchema = z
    .object({
        serverToken: z.string().min(1).max(1024),
        userToken: z.string().min(1).max(1024)
    })
    // .strict() makes us reject any extra fields outright. The intent is
    // to make stale-client breakage *loud* rather than silent: a client
    // that still sends `{token: "secret:alice", serverToken: "...",
    // userToken: "..."}` (mixing old + new shapes) gets a clear 400
    // pointing at the wrong shape, instead of being silently accepted
    // and looking like it works in dev but failing once the legacy
    // field gets sanitized later. The cost is zero forwards-compat
    // tolerance — every additive change to the auth body has to land
    // in this schema first.
    .strict()

export const createSessionSchema = z.object({
    name: sessionNameSchema
})

export const sessionTargetSchema = z.object({
    hostId: hostIdSchema,
    sessionName: sessionTargetNameSchema
})

export const wsTicketRequestSchema = sessionTargetSchema

export const paneCaptureQuerySchema = z.object({
    lines: z.coerce.number().int().min(1).max(MAX_CAPTURE_LINES).optional(),
    maxBytes: z.coerce.number().int().min(1024).max(MAX_CAPTURE_BYTES).optional()
})

export const snapshotQuerySchema = paneCaptureQuerySchema.extend({
    capture: z
        .union([z.literal('1'), z.literal('true'), z.literal('yes'), z.literal('0'), z.literal('false'), z.literal('no')])
        .optional(),
    captureLimit: z.coerce.number().int().min(0).max(32).optional()
})

export const sendTextRequestSchema = z.object({
    text: z.string().min(1).max(MAX_AGENT_TEXT_PAYLOAD),
    enter: z.boolean().optional()
})

export const sendKeysRequestSchema = z.object({
    keys: z.array(tmuxKeySchema).min(1).max(32)
})

const tmuxActionDraftBaseSchema = z.object({
    id: tmuxActionIdSchema.optional(),
    label: z.string().trim().min(1).max(48),
    description: z.string().trim().max(240).optional(),
    kind: z.enum(['send-text', 'send-keys']).default('send-text'),
    payload: z.string().max(MAX_AGENT_TEXT_PAYLOAD).optional(),
    enter: z.boolean().optional(),
    keys: z.array(tmuxKeySchema).min(1).max(32).optional()
})

function validateTmuxActionShape(
    value: { kind: 'send-text' | 'send-keys'; payload?: string; keys?: string[] },
    ctx: z.RefinementCtx
): void {
    if (value.kind === 'send-text') {
        if (!value.payload?.length) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ['payload'],
                message: 'payload is required for send-text actions'
            })
        }
    } else if (!value.keys?.length) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['keys'],
            message: 'keys are required for send-keys actions'
        })
    }
}

export const tmuxActionDraftSchema = tmuxActionDraftBaseSchema.superRefine(validateTmuxActionShape)

export const tmuxActionSchema = tmuxActionDraftBaseSchema
    .extend({
        id: tmuxActionIdSchema,
        createdAt: z.number().int().min(0),
        updatedAt: z.number().int().min(0)
    })
    .superRefine(validateTmuxActionShape)

export const clientWsMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('input'), payload: base64Schema }),
    z.object({
        type: z.literal('resize'),
        cols: z.number().int().min(1).max(1000),
        rows: z.number().int().min(1).max(1000)
    }),
    z.object({ type: z.literal('ping') })
])

// ---------------------------------------------------------------------------
// Wire-contract response schemas. These are validated client-side (CLI,
// future SDKs) so that a server bug returning a malformed payload fails
// loudly with "wire contract violation" instead of crashing on a
// `.map()` call. Each schema is `.passthrough()` so adding a new
// optional field to the server doesn't break existing clients — only
// the field set we *consume* must be present and typed correctly.
//
// Keep these lenient on enums (`z.string()` for state/light) so the CLI
// doesn't reject a future server's new state. The CLI's narrowing
// happens at the print/format layer where it needs to decide what to
// show; runtime validation here is about catching wire bugs, not
// imposing an exhaustive enum lock.
// ---------------------------------------------------------------------------

export const authResponseSchema = z
    .object({
        token: z.string().min(1),
        expiresAt: z.number().int().positive()
    })
    .passthrough()

export const hostInfoSchema = z
    .object({
        id: z.string().min(1),
        name: z.string(),
        status: z.string(),
        isLocal: z.boolean(),
        version: z.string(),
        lastSeenAt: z.number(),
        capabilities: z.array(z.string())
    })
    .passthrough()

export const hostsResponseSchema = z.object({ hosts: z.array(hostInfoSchema) }).passthrough()

const tmuxSessionFieldsSchema = z
    .object({
        name: z.string(),
        windows: z.number().int(),
        attached: z.boolean(),
        attachedClients: z.number().int(),
        created: z.number(),
        activity: z.number()
    })
    .passthrough()

export const targetSessionSchema = tmuxSessionFieldsSchema.extend({
    hostId: z.string().optional(),
    hostName: z.string().optional()
})

/**
 * Stricter shape for the `/api/hosts/:hostId/sessions` endpoint where
 * the server always populates hostId/hostName. Used by clients that
 * iterate per-host and want to avoid `?? '?'` defensive sprinkles.
 */
export const hostScopedSessionSchema = tmuxSessionFieldsSchema.extend({
    hostId: z.string().min(1),
    hostName: z.string()
})

export const sessionsResponseSchema = z
    .object({ sessions: z.array(targetSessionSchema) })
    .passthrough()

/** `/api/hosts/:hostId/sessions` shape — hostId/hostName guaranteed. */
export const hostScopedSessionsResponseSchema = z
    .object({ sessions: z.array(hostScopedSessionSchema) })
    .passthrough()

const tmuxPaneFieldsSchema = z
    .object({
        target: z.string(),
        sessionName: z.string(),
        windowIndex: z.number().int(),
        windowName: z.string(),
        windowActive: z.boolean(),
        paneIndex: z.number().int(),
        paneId: z.string(),
        paneActive: z.boolean(),
        paneDead: z.boolean(),
        currentCommand: z.string(),
        currentPath: z.string(),
        title: z.string(),
        width: z.number().int(),
        height: z.number().int(),
        paneInMode: z.boolean(),
        scrollPosition: z.number().int(),
        historySize: z.number().int(),
        sessionAttached: z.boolean(),
        sessionAttachedClients: z.number().int(),
        sessionActivity: z.number(),
        windowActivity: z.number()
    })
    .passthrough()

export const targetPaneSchema = tmuxPaneFieldsSchema.extend({
    hostId: z.string().optional(),
    hostName: z.string().optional()
})

/** `/api/hosts/:hostId/panes` shape — hostId/hostName guaranteed. */
export const hostScopedPaneSchema = tmuxPaneFieldsSchema.extend({
    hostId: z.string().min(1),
    hostName: z.string()
})

export const panesResponseSchema = z.object({ panes: z.array(targetPaneSchema) }).passthrough()

/** `/api/hosts/:hostId/panes` shape — hostId/hostName guaranteed. */
export const hostScopedPanesResponseSchema = z
    .object({ panes: z.array(hostScopedPaneSchema) })
    .passthrough()

export const tmuxPaneCaptureSchema = z
    .object({
        target: z.string(),
        text: z.string(),
        truncated: z.boolean(),
        maxBytes: z.number().int(),
        paneInMode: z.boolean(),
        scrollPosition: z.number().int(),
        historySize: z.number().int(),
        paneHeight: z.number().int()
    })
    .passthrough()

export const paneActivitySchema = z
    .object({
        light: z.string(),
        unread: z.boolean().optional(),
        changed: z.boolean().optional(),
        seq: z.number().optional(),
        reason: z.string().optional(),
        updatedAt: z.number().optional(),
        checkedAt: z.number().optional()
    })
    .passthrough()

export const tmuxPaneStatusSchema = z
    .object({
        target: z.string(),
        state: z.string(),
        signals: z.array(z.string()).optional(),
        summary: z.string(),
        checkedAt: z.number().optional(),
        capture: tmuxPaneCaptureSchema.optional(),
        activity: paneActivitySchema.optional()
    })
    .passthrough()

export const okResponseSchema = z.object({ ok: z.boolean() }).passthrough()
