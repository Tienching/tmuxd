import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { TmuxSession } from '@tmuxd/shared'
import { sessionNameSchema } from '@tmuxd/shared'

const execFileAsync = promisify(execFile)

const LIST_FORMAT = '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}'
const CAPTURE_METADATA_FORMAT = '#{pane_in_mode}\t#{scroll_position}\t#{history_size}\t#{pane_height}'

export interface TmuxCapture {
    text: string
    paneInMode: boolean
    scrollPosition: number
    historySize: number
    paneHeight: number
}

export async function listSessions(): Promise<TmuxSession[]> {
    try {
        const { stdout } = await execFileAsync('tmux', ['list-sessions', '-F', LIST_FORMAT], {
            encoding: 'utf8'
        })
        return parseListOutput(stdout)
    } catch (err: unknown) {
        // tmux exits with code 1 and prints "no server running" when there are no sessions.
        const msg = err instanceof Error ? err.message : String(err)
        if (/no server running/i.test(msg) || /no sessions/i.test(msg)) {
            return []
        }
        throw err
    }
}

export function parseListOutput(output: string): TmuxSession[] {
    const sessions: TmuxSession[] = []
    for (const raw of output.split('\n')) {
        const line = raw.trim()
        if (!line) continue
        const parts = line.split('\t')
        if (parts.length < 5) continue
        const [name, winStr, attStr, createdStr, activityStr] = parts
        const session = {
            name,
            windows: Number.parseInt(winStr, 10) || 0,
            attached: Number.parseInt(attStr, 10) > 0,
            created: Number.parseInt(createdStr, 10) || 0,
            activity: Number.parseInt(activityStr, 10) || 0
        } satisfies TmuxSession
        sessions.push(session)
    }
    return sessions
}

export function validateSessionName(name: string): string {
    const parsed = sessionNameSchema.safeParse(name)
    if (!parsed.success) {
        throw new Error(`Invalid session name: ${parsed.error.issues[0]?.message ?? 'bad name'}`)
    }
    return parsed.data
}

export async function sessionExists(name: string): Promise<boolean> {
    const safe = validateSessionName(name)
    try {
        await execFileAsync('tmux', ['has-session', '-t', safe], { encoding: 'utf8' })
        return true
    } catch {
        return false
    }
}

export async function createSession(name: string): Promise<void> {
    const safe = validateSessionName(name)
    if (await sessionExists(safe)) {
        throw new Error('Session already exists')
    }
    await execFileAsync('tmux', ['new-session', '-d', '-s', safe, '-c', homedir()], { encoding: 'utf8' })
}

export async function killSession(name: string): Promise<void> {
    const safe = validateSessionName(name)
    await execFileAsync('tmux', ['kill-session', '-t', safe], { encoding: 'utf8' })
}

export async function captureSession(name: string): Promise<TmuxCapture> {
    const safe = validateSessionName(name)
    const metadata = await execFileAsync('tmux', ['display-message', '-p', '-t', safe, CAPTURE_METADATA_FORMAT], {
        encoding: 'utf8'
    })
    const capture = await execFileAsync('tmux', ['capture-pane', '-p', '-t', safe, '-S', '-'], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
    })
    return { text: capture.stdout, ...parseCaptureMetadata(metadata.stdout) }
}

export function parseCaptureMetadata(output: string): Omit<TmuxCapture, 'text'> {
    const [paneInMode, scrollPosition, historySize, paneHeight] = output.trimEnd().split('\t')
    return {
        paneInMode: paneInMode === '1',
        scrollPosition: Number.parseInt(scrollPosition || '0', 10) || 0,
        historySize: Number.parseInt(historySize || '0', 10) || 0,
        paneHeight: Number.parseInt(paneHeight || '0', 10) || 0
    }
}
