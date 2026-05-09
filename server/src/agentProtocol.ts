import { z } from 'zod'
import { hostIdSchema, sessionNameSchema, sessionTargetNameSchema, tmuxKeySchema, tmuxPaneTargetSchema } from '@tmuxd/shared'

const capabilitySchema = z.enum(['list', 'create', 'kill', 'capture', 'attach', 'panes', 'input'])
const requestIdSchema = z.string().min(1).max(128)
const streamIdSchema = z.string().min(1).max(128)
const base64Schema = z.string().max(64 * 1024).refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value))
const textPayloadSchema = z.string().min(1).max(64 * 1024)
const captureLinesSchema = z.number().int().min(1).max(10_000)
const captureBytesSchema = z.number().int().min(1024).max(384 * 1024)

export const agentHelloSchema = z.object({
    type: z.literal('hello'),
    id: hostIdSchema.optional(),
    name: z.string().min(1).max(64),
    version: z.string().min(1).max(64).optional(),
    capabilities: z.array(capabilitySchema).max(8).optional()
})

const agentResultSchema = z.union([
    z.object({ type: z.literal('result'), id: requestIdSchema, ok: z.literal(true), body: z.unknown().optional() }),
    z.object({ type: z.literal('result'), id: requestIdSchema, ok: z.literal(false), error: z.string().min(1).max(1024) })
])

export const agentClientMessageSchema = z.union([
    agentHelloSchema,
    agentResultSchema,
    z.object({ type: z.literal('stream_ready'), streamId: streamIdSchema, session: sessionTargetNameSchema, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
    z.object({ type: z.literal('stream_data'), streamId: streamIdSchema, payload: base64Schema }),
    z.object({ type: z.literal('stream_exit'), streamId: streamIdSchema, code: z.number().int().nullable(), signal: z.string().nullable() }),
    z.object({ type: z.literal('stream_error'), streamId: streamIdSchema, message: z.string().min(1).max(1024) }),
    z.object({ type: z.literal('pong') })
])

export type AgentHelloMessage = z.infer<typeof agentHelloSchema>
export type AgentClientMessage = z.infer<typeof agentClientMessageSchema>

export type AgentServerMessage =
    | { type: 'hello_ack'; hostId: string; heartbeatMs: number }
    | { type: 'list_sessions'; id: string }
    | { type: 'create_session'; id: string; name: string }
    | { type: 'kill_session'; id: string; name: string }
    | { type: 'capture_session'; id: string; name: string }
    | { type: 'list_panes'; id: string; session?: string }
    | { type: 'capture_pane'; id: string; target: string; lines?: number; maxBytes?: number }
    | { type: 'send_text'; id: string; target: string; text: string; enter?: boolean }
    | { type: 'send_keys'; id: string; target: string; keys: string[] }
    | { type: 'attach'; streamId: string; session: string; cols: number; rows: number }
    | { type: 'input'; streamId: string; payload: string }
    | { type: 'resize'; streamId: string; cols: number; rows: number }
    | { type: 'detach'; streamId: string }
    | { type: 'ping' }

export const agentServerMessageSchema = z.union([
    z.object({ type: z.literal('hello_ack'), hostId: hostIdSchema, heartbeatMs: z.number().int().min(1000) }),
    z.object({ type: z.literal('list_sessions'), id: requestIdSchema }),
    z.object({ type: z.literal('create_session'), id: requestIdSchema, name: sessionNameSchema }),
    z.object({ type: z.literal('kill_session'), id: requestIdSchema, name: sessionTargetNameSchema }),
    z.object({ type: z.literal('capture_session'), id: requestIdSchema, name: sessionTargetNameSchema }),
    z.object({ type: z.literal('list_panes'), id: requestIdSchema, session: sessionTargetNameSchema.optional() }),
    z.object({
        type: z.literal('capture_pane'),
        id: requestIdSchema,
        target: tmuxPaneTargetSchema,
        lines: captureLinesSchema.optional(),
        maxBytes: captureBytesSchema.optional()
    }),
    z.object({ type: z.literal('send_text'), id: requestIdSchema, target: tmuxPaneTargetSchema, text: textPayloadSchema, enter: z.boolean().optional() }),
    z.object({ type: z.literal('send_keys'), id: requestIdSchema, target: tmuxPaneTargetSchema, keys: z.array(tmuxKeySchema).min(1).max(32) }),
    z.object({ type: z.literal('attach'), streamId: streamIdSchema, session: sessionTargetNameSchema, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
    z.object({ type: z.literal('input'), streamId: streamIdSchema, payload: base64Schema }),
    z.object({ type: z.literal('resize'), streamId: streamIdSchema, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
    z.object({ type: z.literal('detach'), streamId: streamIdSchema }),
    z.object({ type: z.literal('ping') })
])
