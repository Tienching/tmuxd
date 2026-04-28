import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyQuickModifiers, encodeTerminalInputPayload, MOBILE_QUICK_KEY_ROWS } from './quickKeys'

describe('mobile quick keys', () => {
    it('uses modifiers instead of hard-coded ctrl combos', () => {
        const keys = MOBILE_QUICK_KEY_ROWS.flat()
        assert.ok(keys.some((key) => key.modifier === 'ctrl'))
        assert.ok(keys.some((key) => key.modifier === 'shift'))
        assert.ok(keys.some((key) => key.input === 'c'))
        assert.ok(!keys.some((key) => key.label === 'C-c'))
        assert.ok(keys.some((key) => key.input === '|'))
        assert.ok(keys.some((key) => key.input === '\\'))
    })

    it('includes a full letter and number keyboard', () => {
        const inputs = new Set(MOBILE_QUICK_KEY_ROWS.flat().map((key) => key.input).filter(Boolean))
        for (const ch of 'abcdefghijklmnopqrstuvwxyz0123456789') {
            assert.ok(inputs.has(ch), `missing ${ch}`)
        }
        assert.ok(inputs.has('\u007f'), 'missing backspace')
        assert.ok(inputs.has('\r'), 'missing enter')
        assert.ok(inputs.has(' '), 'missing space')
    })

    it('applies Ctrl and Alt modifiers to key input', () => {
        assert.equal(applyQuickModifiers('c', { ctrl: true, alt: false, shift: false }), '\u0003')
        assert.equal(applyQuickModifiers('d', { ctrl: true, alt: false, shift: false }), '\u0004')
        assert.equal(applyQuickModifiers('z', { ctrl: true, alt: false, shift: false }), '\u001a')
        assert.equal(applyQuickModifiers('x', { ctrl: false, alt: true, shift: false }), '\u001bx')
        assert.equal(applyQuickModifiers('c', { ctrl: true, alt: true, shift: false }), '\u001b\u0003')
    })

    it('applies Shift to letters and symbols', () => {
        assert.equal(applyQuickModifiers('a', { ctrl: false, alt: false, shift: true }), 'A')
        assert.equal(applyQuickModifiers('1', { ctrl: false, alt: false, shift: true }), '!')
        assert.equal(applyQuickModifiers('/', { ctrl: false, alt: false, shift: true }), '?')
    })

    it('encodes terminal input as base64 utf-8', () => {
        assert.equal(decodePayload(encodeTerminalInputPayload('\u0003')), '\u0003')
        assert.equal(decodePayload(encodeTerminalInputPayload('你好')), '你好')
    })
})

function decodePayload(payload: string): string {
    const binary = atob(payload)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return new TextDecoder().decode(bytes)
}
