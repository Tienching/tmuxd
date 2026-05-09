import type { TmuxPane, TmuxPaneActivity, TmuxPaneCapture, TmuxPaneState, TmuxPaneStatus } from '@tmuxd/shared'
import { sessionTargetNameSchema } from '@tmuxd/shared'

const RUNNING_PATTERNS: Array<[string, RegExp]> = [
    ['working', /\bworking\b/i],
    ['running', /\brunning\b/i],
    ['building', /\b(building|compiling|bundling)\b/i],
    ['testing', /\b(testing|tests? running)\b/i],
    ['installing', /\b(installing|downloading)\b/i]
]

const PERMISSION_PATTERNS: Array<[string, RegExp]> = [
    ['permission', /\b(permission|requires confirmation|approval required)\b/i],
    ['proceed_prompt', /do you want to (proceed|continue)|continue\?/i],
    ['risk_prompt', /high risk operation detected/i],
    ['yes_no_prompt', /\b(yes\s*\/\s*no|y\/n)\b/i],
    ['numbered_choice', /(?:^|\n)\s*(?:❯\s*)?\d+[.)]\s+.+/]
]

const NEEDS_INPUT_PATTERNS: Array<[string, RegExp]> = [
    ['press_enter', /press enter/i],
    ['select_option', /\b(select|choose|pick)\b.+\b(option|number)\b/i],
    ['esc_to_exit', /esc to exit/i],
    ['prompt_cursor', /(?:^|\n)\s*[❯>]\s*$/]
]

export function classifyPaneStatus(input: {
    target: string
    pane?: TmuxPane | null
    capture: TmuxPaneCapture
    activity?: TmuxPaneActivity
    now?: number
}): TmuxPaneStatus {
    const signals: string[] = []
    const text = lastText(input.capture.text, 6000)
    const pane = input.pane ?? undefined
    let state: TmuxPaneState = 'idle'

    if (pane?.paneDead) {
        state = 'dead'
        signals.push('pane_dead')
    } else if (input.capture.paneInMode) {
        state = 'copy_mode'
        signals.push('copy_mode')
    } else {
        for (const [signal, pattern] of PERMISSION_PATTERNS) {
            if (pattern.test(text)) signals.push(signal)
        }
        if (signals.length) {
            state = 'permission_prompt'
        } else {
            for (const [signal, pattern] of NEEDS_INPUT_PATTERNS) {
                if (pattern.test(text)) signals.push(signal)
            }
            if (signals.length) {
                state = 'needs_input'
            } else {
                for (const [signal, pattern] of RUNNING_PATTERNS) {
                    if (pattern.test(text)) signals.push(signal)
                }
                if (signals.length) state = 'running'
            }
        }
    }

    return {
        target: input.target,
        state,
        signals,
        summary: summarize(state, signals),
        checkedAt: input.now ?? Date.now(),
        pane,
        capture: input.capture,
        ...(input.activity ? { activity: input.activity } : {})
    }
}

export function findPaneForTarget(panes: TmuxPane[], target: string): TmuxPane | null {
    const exact = panes.find((pane) => pane.target === target || pane.paneId === target)
    if (exact) return exact

    const parsedWindowTarget = splitSessionWindowTarget(target)
    if (parsedWindowTarget) {
        const { sessionName, windowIndex, paneIndex } = parsedWindowTarget
        return (
            panes.find(
                (pane) =>
                    pane.sessionName === sessionName &&
                    pane.windowIndex === windowIndex &&
                    (paneIndex === undefined ? true : pane.paneIndex === paneIndex) &&
                    pane.paneActive
            ) ??
            panes.find(
                (pane) =>
                    pane.sessionName === sessionName &&
                    pane.windowIndex === windowIndex &&
                    (paneIndex === undefined ? true : pane.paneIndex === paneIndex)
            ) ??
            null
        )
    }

    if (sessionTargetNameSchema.safeParse(target).success) {
        return (
            panes.find((pane) => pane.sessionName === target && pane.windowActive && pane.paneActive) ??
            panes.find((pane) => pane.sessionName === target && pane.windowActive) ??
            panes.find((pane) => pane.sessionName === target && pane.paneActive) ??
            panes.find((pane) => pane.sessionName === target) ??
            null
        )
    }

    return null
}

function splitSessionWindowTarget(target: string): { sessionName: string; windowIndex: number; paneIndex?: number } | null {
    const splitIndex = target.lastIndexOf(':')
    if (splitIndex <= 0) return null
    const sessionName = target.slice(0, splitIndex)
    const windowSpec = target.slice(splitIndex + 1)
    if (!sessionTargetNameSchema.safeParse(sessionName).success || !/^[0-9]+(?:\.[0-9]+)?$/.test(windowSpec)) {
        return null
    }
    const [windowPart, panePart, ...rest] = windowSpec.split('.')
    if (panePart && rest.length > 0) return null
    if (!/^[0-9]+$/.test(windowPart)) return null
    const windowIndex = Number.parseInt(windowPart, 10)
    if (!Number.isFinite(windowIndex)) return null
    if (!panePart) return { sessionName, windowIndex }
    const paneIndex = Number.parseInt(panePart, 10)
    return Number.isFinite(paneIndex) ? { sessionName, windowIndex, paneIndex } : null
}

function lastText(text: string, maxChars: number): string {
    return text.length <= maxChars ? text : text.slice(text.length - maxChars)
}

function summarize(state: TmuxPaneState, signals: string[]): string {
    if (state === 'idle') return 'No known running or input-needed signals detected.'
    if (state === 'dead') return 'Pane is marked dead by tmux.'
    if (state === 'copy_mode') return 'Pane is in tmux copy mode.'
    if (state === 'permission_prompt') return `Pane appears to be waiting for permission: ${signals.join(', ')}.`
    if (state === 'needs_input') return `Pane appears to be waiting for input: ${signals.join(', ')}.`
    return `Pane appears active: ${signals.join(', ')}.`
}
