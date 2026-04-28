import { api } from '../api/client'
import { makeNewSessionName } from './newSessionName'

type CreateSessionFn = (name: string) => Promise<unknown>
type SuffixFn = () => string

export async function createSessionWithOptionalName(
    inputName = '',
    createSession: CreateSessionFn = api.createSession,
    date = new Date(),
    suffix: SuffixFn = randomSuffix
): Promise<string> {
    const trimmed = inputName.trim()
    if (trimmed) {
        await createSession(trimmed)
        return trimmed
    }

    let lastError: unknown = null
    for (let attempt = 0; attempt < 4; attempt++) {
        const name = makeNewSessionName(date, attempt === 0 ? '' : suffix())
        try {
            await createSession(name)
            return name
        } catch (err) {
            lastError = err
            if (!(err instanceof Error) || err.message !== 'session_exists') break
        }
    }
    throw lastError ?? new Error('failed_to_create_session')
}

function randomSuffix(): string {
    return Math.random().toString(36).slice(2, 5)
}
