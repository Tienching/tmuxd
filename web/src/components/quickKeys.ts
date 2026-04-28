export interface QuickKey {
    label: string
    input?: string
    title: string
    modifier?: 'ctrl' | 'alt' | 'shift'
}

export const MOBILE_QUICK_KEY_ROWS: QuickKey[][] = [
    [
        { label: 'Esc', input: '\u001b', title: 'Escape' },
        { label: 'Tab', input: '\t', title: 'Tab' },
        { label: 'Ctrl', title: 'Toggle Ctrl modifier', modifier: 'ctrl' },
        { label: 'Alt', title: 'Toggle Alt modifier', modifier: 'alt' },
        { label: 'Shift', title: 'Toggle Shift modifier', modifier: 'shift' },
        { label: 'Bksp', input: '\u007f', title: 'Backspace' }
    ],
    [
        { label: '1', input: '1', title: 'Number 1' },
        { label: '2', input: '2', title: 'Number 2' },
        { label: '3', input: '3', title: 'Number 3' },
        { label: '4', input: '4', title: 'Number 4' },
        { label: '5', input: '5', title: 'Number 5' },
        { label: '6', input: '6', title: 'Number 6' },
        { label: '7', input: '7', title: 'Number 7' },
        { label: '8', input: '8', title: 'Number 8' },
        { label: '9', input: '9', title: 'Number 9' },
        { label: '0', input: '0', title: 'Number 0' }
    ],
    [
        { label: 'q', input: 'q', title: 'Letter q' },
        { label: 'w', input: 'w', title: 'Letter w' },
        { label: 'e', input: 'e', title: 'Letter e' },
        { label: 'r', input: 'r', title: 'Letter r' },
        { label: 't', input: 't', title: 'Letter t' },
        { label: 'y', input: 'y', title: 'Letter y' },
        { label: 'u', input: 'u', title: 'Letter u' },
        { label: 'i', input: 'i', title: 'Letter i' },
        { label: 'o', input: 'o', title: 'Letter o' },
        { label: 'p', input: 'p', title: 'Letter p' }
    ],
    [
        { label: 'a', input: 'a', title: 'Letter a' },
        { label: 's', input: 's', title: 'Letter s' },
        { label: 'd', input: 'd', title: 'Letter d' },
        { label: 'f', input: 'f', title: 'Letter f' },
        { label: 'g', input: 'g', title: 'Letter g' },
        { label: 'h', input: 'h', title: 'Letter h' },
        { label: 'j', input: 'j', title: 'Letter j' },
        { label: 'k', input: 'k', title: 'Letter k' },
        { label: 'l', input: 'l', title: 'Letter l' }
    ],
    [
        { label: 'z', input: 'z', title: 'Letter z' },
        { label: 'x', input: 'x', title: 'Letter x' },
        { label: 'c', input: 'c', title: 'Letter c' },
        { label: 'v', input: 'v', title: 'Letter v' },
        { label: 'b', input: 'b', title: 'Letter b' },
        { label: 'n', input: 'n', title: 'Letter n' },
        { label: 'm', input: 'm', title: 'Letter m' }
    ],
    [
        { label: '←', input: '\u001b[D', title: 'Arrow left' },
        { label: '↑', input: '\u001b[A', title: 'Arrow up' },
        { label: '↓', input: '\u001b[B', title: 'Arrow down' },
        { label: '→', input: '\u001b[C', title: 'Arrow right' },
        { label: 'PgUp', input: '\u001b[5~', title: 'Page up' },
        { label: 'PgDn', input: '\u001b[6~', title: 'Page down' }
    ],
    [
        { label: '/', input: '/', title: 'Slash' },
        { label: '-', input: '-', title: 'Hyphen' },
        { label: '_', input: '_', title: 'Underscore' },
        { label: '|', input: '|', title: 'Pipe' },
        { label: '~', input: '~', title: 'Tilde' },
        { label: '$', input: '$', title: 'Dollar sign' },
        { label: '.', input: '.', title: 'Dot' },
        { label: ':', input: ':', title: 'Colon' },
        { label: ';', input: ';', title: 'Semicolon' },
        { label: '=', input: '=', title: 'Equals' }
    ],
    [
        { label: "'", input: "'", title: 'Single quote' },
        { label: '"', input: '"', title: 'Double quote' },
        { label: '`', input: '`', title: 'Backtick' },
        { label: '\\', input: '\\', title: 'Backslash' },
        { label: '[', input: '[', title: 'Left bracket' },
        { label: ']', input: ']', title: 'Right bracket' },
        { label: '{', input: '{', title: 'Left brace' },
        { label: '}', input: '}', title: 'Right brace' },
        { label: '(', input: '(', title: 'Left parenthesis' },
        { label: ')', input: ')', title: 'Right parenthesis' }
    ],
    [
        { label: 'Space', input: ' ', title: 'Space' },
        { label: 'Enter', input: '\r', title: 'Enter' }
    ]
]

export interface QuickModifiers {
    ctrl: boolean
    alt: boolean
    shift: boolean
}

export function applyQuickModifiers(input: string, modifiers: QuickModifiers): string {
    let next = input
    if (modifiers.shift && next.length === 1) {
        next = shiftInput(next)
    }
    if (modifiers.ctrl && next.length === 1) {
        const code = next.toUpperCase().charCodeAt(0)
        if (code >= 64 && code <= 95) {
            next = String.fromCharCode(code - 64)
        }
    }
    if (modifiers.alt) {
        next = `\u001b${next}`
    }
    return next
}

const SHIFT_INPUTS: Record<string, string> = {
    '1': '!',
    '2': '@',
    '3': '#',
    '4': '$',
    '5': '%',
    '6': '^',
    '7': '&',
    '8': '*',
    '9': '(',
    '0': ')',
    '-': '_',
    '=': '+',
    '[': '{',
    ']': '}',
    ';': ':',
    "'": '"',
    ',': '<',
    '.': '>',
    '/': '?',
    '`': '~',
    '\\': '|'
}

function shiftInput(input: string): string {
    if (/^[a-z]$/.test(input)) return input.toUpperCase()
    return SHIFT_INPUTS[input] ?? input
}

export function encodeTerminalInputPayload(input: string): string {
    const bytes = new TextEncoder().encode(input)
    let binary = ''
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
    return btoa(binary)
}
