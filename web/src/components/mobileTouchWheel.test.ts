import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import type { Terminal } from '@xterm/xterm'
import { installMobileTouchWheelBridge } from './mobileTouchWheel'

class TestWheelEvent extends Event {
    static readonly DOM_DELTA_PIXEL = 0

    readonly clientX: number
    readonly clientY: number
    readonly deltaMode: number
    readonly deltaY: number

    constructor(type: string, init: WheelEventInit) {
        super(type, init)
        this.clientX = init.clientX ?? 0
        this.clientY = init.clientY ?? 0
        this.deltaMode = init.deltaMode ?? TestWheelEvent.DOM_DELTA_PIXEL
        this.deltaY = init.deltaY ?? 0
    }
}

const originalWheelEvent = globalThis.WheelEvent

before(() => {
    Object.defineProperty(globalThis, 'WheelEvent', {
        configurable: true,
        value: TestWheelEvent
    })
})

after(() => {
    Object.defineProperty(globalThis, 'WheelEvent', {
        configurable: true,
        value: originalWheelEvent
    })
})

describe('installMobileTouchWheelBridge', () => {
    it('turns a one-finger vertical drag into a wheel event at the touch point', () => {
        const element = new EventTarget()
        const terminal = { element } as unknown as Terminal
        const bridge = installMobileTouchWheelBridge(terminal)
        const wheels: TestWheelEvent[] = []
        let downstreamTouchMoveCount = 0

        element.addEventListener('wheel', (ev) => {
            wheels.push(ev as TestWheelEvent)
        })
        element.addEventListener('touchmove', () => {
            downstreamTouchMoveCount++
        })

        element.dispatchEvent(touchEvent('touchstart', [{ clientX: 10, clientY: 100 }]))
        const move = touchEvent('touchmove', [{ clientX: 12, clientY: 75 }])
        element.dispatchEvent(move)

        assert.equal(wheels.length, 1)
        assert.equal(wheels[0].deltaY, 25)
        assert.equal(wheels[0].deltaMode, TestWheelEvent.DOM_DELTA_PIXEL)
        assert.equal(wheels[0].clientX, 12)
        assert.equal(wheels[0].clientY, 75)
        assert.equal(move.defaultPrevented, true)
        assert.equal(downstreamTouchMoveCount, 0)

        bridge.dispose()
    })

    it('ignores multi-touch gestures', () => {
        const element = new EventTarget()
        const terminal = { element } as unknown as Terminal
        const bridge = installMobileTouchWheelBridge(terminal)
        let wheelCount = 0

        element.addEventListener('wheel', () => {
            wheelCount++
        })

        element.dispatchEvent(touchEvent('touchstart', [
            { clientX: 10, clientY: 100 },
            { clientX: 20, clientY: 100 }
        ]))
        const move = touchEvent('touchmove', [{ clientX: 10, clientY: 70 }])
        element.dispatchEvent(move)

        assert.equal(wheelCount, 0)
        assert.equal(move.defaultPrevented, false)

        bridge.dispose()
    })
})

function touchEvent(type: string, touches: Array<{ clientX: number; clientY: number }>): TouchEvent {
    const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent
    Object.defineProperty(event, 'touches', {
        value: touches,
        configurable: true
    })
    return event
}
