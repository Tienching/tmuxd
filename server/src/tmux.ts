import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import type { TmuxPane, TmuxPaneCapture, TmuxSession } from '@tmuxd/shared'
import { sessionNameSchema, sessionTargetNameSchema, tmuxKeySchema, tmuxPaneTargetSchema } from '@tmuxd/shared'

const execFileAsync = promisify(execFile)

const LIST_FORMAT = '#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_created}\t#{session_activity}'
const PANE_FIELD_SEPARATOR = '\x1f'
const PANE_RECORD_SEPARATOR = '\x1e'
const PANE_LIST_FORMAT = [
    '#{session_name}',
    '#{window_index}',
    '#{window_name}',
    '#{window_active}',
    '#{pane_index}',
    '#{pane_id}',
    '#{pane_active}',
    '#{pane_dead}',
    '#{pane_current_command}',
    '#{pane_current_path}',
    '#{pane_title}',
    '#{pane_width}',
    '#{pane_height}',
    '#{pane_in_mode}',
    '#{scroll_position}',
    '#{history_size}',
    '#{session_attached}',
    '#{session_activity}',
    '#{window_activity}'
].join(PANE_FIELD_SEPARATOR) + PANE_RECORD_SEPARATOR
const CAPTURE_METADATA_FORMAT = '#{pane_in_mode}\t#{scroll_position}\t#{history_size}\t#{pane_height}'
const DEFAULT_CAPTURE_LINES = 200
const DEFAULT_CAPTURE_MAX_BYTES = 256 * 1024
const MAX_CAPTURE_MAX_BYTES = 384 * 1024

export interface TmuxCapture {
    text: string
    paneInMode: boolean
    scrollPosition: number
    historySize: number
    paneHeight: number
}

export interface CapturePaneOptions {
    lines?: number
    maxBytes?: number
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
            attachedClients: toNonNegativeInt(attStr),
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

export function validateSessionTargetName(name: string): string {
    const parsed = sessionTargetNameSchema.safeParse(name)
    if (!parsed.success) {
        throw new Error(`Invalid session target: ${parsed.error.issues[0]?.message ?? 'bad name'}`)
    }
    return parsed.data
}

export function validatePaneTarget(target: string): string {
    const parsed = tmuxPaneTargetSchema.safeParse(target)
    if (!parsed.success) {
        throw new Error(`Invalid tmux pane target: ${parsed.error.issues[0]?.message ?? 'bad target'}`)
    }
    return parsed.data
}

export function validateTmuxKey(key: string): string {
    const parsed = tmuxKeySchema.safeParse(key)
    if (!parsed.success) {
        throw new Error(`Invalid tmux key: ${parsed.error.issues[0]?.message ?? 'bad key'}`)
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
    const safe = validateSessionTargetName(name)
    await execFileAsync('tmux', ['kill-session', '-t', safe], { encoding: 'utf8' })
}

export async function sendTextToSession(name: string, text: string): Promise<void> {
    const safe = validateSessionTargetName(name)
    await execFileAsync('tmux', ['send-keys', '-t', safe, '-l', text], { encoding: 'utf8' })
}

export async function listPanes(sessionName?: string): Promise<TmuxPane[]> {
    const args = ['list-panes', '-F', PANE_LIST_FORMAT]
    if (sessionName) {
        args.push('-t', validateSessionTargetName(sessionName))
    } else {
        args.push('-a')
    }
    try {
        const { stdout } = await execFileAsync('tmux', args, { encoding: 'utf8' })
        return parsePaneListOutput(stdout)
    } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        if (/no server running/i.test(msg) || /no sessions/i.test(msg)) {
            return []
        }
        throw err
    }
}

export function parsePaneListOutput(output: string): TmuxPane[] {
    const panes: TmuxPane[] = []
    const rows = output.includes(PANE_RECORD_SEPARATOR) ? output.split(PANE_RECORD_SEPARATOR) : output.split('\n')
    for (const record of rows) {
        const raw = record.replace(/^\n/, '').replace(/\n$/, '')
        if (!raw.trim()) continue
        const parts = raw.split(raw.includes(PANE_FIELD_SEPARATOR) ? PANE_FIELD_SEPARATOR : '\t')
        if (parts.length < 16) continue
        const [
            sessionName,
            windowIndex,
            windowName,
            windowActive,
            paneIndex,
            paneId,
            paneActive,
            paneDead,
            currentCommand,
            currentPath,
            title,
            width,
            height,
            paneInMode,
            scrollPosition,
            historySize,
            sessionAttached,
            sessionActivity,
            windowActivity
        ] = parts
        const win = toNonNegativeInt(windowIndex)
        const pane = toNonNegativeInt(paneIndex)
        const attachedClients = toNonNegativeInt(sessionAttached ?? '')
        panes.push({
            target: `${sessionName}:${win}.${pane}`,
            sessionName,
            windowIndex: win,
            windowName,
            windowActive: windowActive === '1',
            paneIndex: pane,
            paneId,
            paneActive: paneActive === '1',
            paneDead: paneDead === '1',
            currentCommand,
            currentPath,
            title,
            width: toNonNegativeInt(width),
            height: toNonNegativeInt(height),
            paneInMode: paneInMode === '1',
            scrollPosition: toNonNegativeInt(scrollPosition),
            historySize: toNonNegativeInt(historySize),
            sessionAttached: attachedClients > 0,
            sessionAttachedClients: attachedClients,
            sessionActivity: toNonNegativeInt(sessionActivity ?? ''),
            windowActivity: toNonNegativeInt(windowActivity ?? '')
        })
    }
    return panes
}

export async function capturePane(target: string, options: number | CapturePaneOptions = {}): Promise<TmuxPaneCapture> {
    const safe = validatePaneTarget(target)
    const { lines, maxBytes } = normalizeCaptureOptions(options)
    const metadata = await execFileAsync('tmux', ['display-message', '-p', '-t', safe, CAPTURE_METADATA_FORMAT], {
        encoding: 'utf8'
    })
    const capture = await execFileAsync('tmux', ['capture-pane', '-p', '-J', '-t', safe, '-S', `-${lines}`], {
        encoding: 'utf8',
        maxBuffer: 20 * 1024 * 1024
    })
    const truncated = truncateUtf8(capture.stdout, maxBytes)
    return {
        target: safe,
        text: truncated.text,
        truncated: truncated.truncated,
        maxBytes,
        ...parseCaptureMetadata(metadata.stdout)
    }
}

export async function sendTextToTarget(target: string, text: string, enter = false): Promise<void> {
    const safe = validatePaneTarget(target)
    await execFileAsync('tmux', ['send-keys', '-t', safe, '-l', '--', text], { encoding: 'utf8' })
    if (enter) {
        await execFileAsync('tmux', ['send-keys', '-t', safe, 'Enter'], { encoding: 'utf8' })
    }
}

export async function sendKeysToTarget(target: string, keys: string[]): Promise<void> {
    const safe = validatePaneTarget(target)
    const safeKeys = keys.map(validateTmuxKey)
    await execFileAsync('tmux', ['send-keys', '-t', safe, '--', ...safeKeys], { encoding: 'utf8' })
}

export async function captureSession(name: string): Promise<TmuxCapture> {
    const safe = validateSessionTargetName(name)
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

function toNonNegativeInt(value: string): number {
    const parsed = Number.parseInt(value || '0', 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

function clampCaptureLines(value: number): number {
    if (!Number.isInteger(value) || value < 1) return DEFAULT_CAPTURE_LINES
    return Math.min(value, 10_000)
}

function normalizeCaptureOptions(options: number | CapturePaneOptions): { lines: number; maxBytes: number } {
    if (typeof options === 'number') {
        return { lines: clampCaptureLines(options), maxBytes: DEFAULT_CAPTURE_MAX_BYTES }
    }
    return {
        lines: clampCaptureLines(options.lines ?? DEFAULT_CAPTURE_LINES),
        maxBytes: clampCaptureBytes(options.maxBytes ?? DEFAULT_CAPTURE_MAX_BYTES)
    }
}

function clampCaptureBytes(value: number): number {
    if (!Number.isInteger(value) || value < 1024) return DEFAULT_CAPTURE_MAX_BYTES
    return Math.min(value, MAX_CAPTURE_MAX_BYTES)
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return { text, truncated: false }
    let low = 0
    let high = text.length
    while (low < high) {
        const mid = Math.floor((low + high) / 2)
        if (Buffer.byteLength(text.slice(mid), 'utf8') <= maxBytes) {
            high = mid
        } else {
            low = mid + 1
        }
    }
    return { text: text.slice(adjustUtf16Start(text, low)), truncated: true }
}

function adjustUtf16Start(text: string, index: number): number {
    if (index <= 0 || index >= text.length) return index
    const current = text.charCodeAt(index)
    const previous = text.charCodeAt(index - 1)
    const isLowSurrogate = current >= 0xdc00 && current <= 0xdfff
    const isHighSurrogate = previous >= 0xd800 && previous <= 0xdbff
    return isLowSurrogate && isHighSurrogate ? index + 1 : index
}
