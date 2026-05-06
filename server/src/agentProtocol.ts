import { z } from 'zod'
import { hostIdSchema, sessionNameSchema } from '@tmuxd/shared'

const capabilitySchema = z.enum(['list', 'create', 'kill', 'capture', 'attach'])
const requestIdSchema = z.string().min(1).max(128)
const streamIdSchema = z.string().min(1).max(128)
const base64Schema = z.string().max(64 * 1024).refine((value) => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value))

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
    z.object({ type: z.literal('stream_ready'), streamId: streamIdSchema, session: sessionNameSchema, cols: z.number().int().min(1).max(1000), rows: z.number().int().min(1).max(1000) }),
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
    | { type: 'attach'; streamId: string; session: string; cols: number; rows: number }
    | { type: 'input'; streamId: string; payload: string }
    | { type: 'resize'; streamId: string; cols: number; rows: number }
    | { type: 'detach'; streamId: string }
    | { type: 'ping' }
