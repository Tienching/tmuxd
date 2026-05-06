import { z } from 'zod'

const MAX_WS_INPUT_PAYLOAD = 64 * 1024
const base64Schema = z
    .string()
    .max(MAX_WS_INPUT_PAYLOAD)
    .refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), 'Invalid base64 payload')

/** Valid tmux session name — argv-safe, filesystem-safe. */
export const sessionNameSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Invalid session name')

export const hostIdSchema = z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Invalid host id')

export const loginSchema = z.object({
    password: z.string().min(1).max(512)
})

export const createSessionSchema = z.object({
    name: sessionNameSchema
})

export const sessionTargetSchema = z.object({
    hostId: hostIdSchema,
    sessionName: sessionNameSchema
})

export const wsTicketRequestSchema = z
    .object({
        hostId: hostIdSchema.optional(),
        sessionName: sessionNameSchema.optional()
    })
    .optional()

export const clientWsMessageSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('input'), payload: base64Schema }),
    z.object({
        type: z.literal('resize'),
        cols: z.number().int().min(1).max(1000),
        rows: z.number().int().min(1).max(1000)
    }),
    z.object({ type: z.literal('ping') })
])
