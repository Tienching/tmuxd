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

export const loginSchema = z.object({
    password: z.string().min(1).max(512)
})

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
