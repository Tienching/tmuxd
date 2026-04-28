import type { Terminal, IDisposable } from '@xterm/xterm'

/**
 * xterm.js handles wheel scrolling well, including tmux mouse mode. On mobile,
 * a one-finger drag emits touch events instead, so bridge the gesture into the
 * same wheel path.
 */
export function installMobileTouchWheelBridge(terminal: Terminal): IDisposable {
    const element = terminal.element
    if (!element) return { dispose() {} }

    let lastTouch: { x: number; y: number } | null = null

    const onTouchStart = (ev: TouchEvent) => {
        if (ev.touches.length !== 1) {
            lastTouch = null
            return
        }
        const touch = ev.touches[0]
        lastTouch = { x: touch.clientX, y: touch.clientY }
    }

    const onTouchMove = (ev: TouchEvent) => {
        if (ev.touches.length !== 1 || !lastTouch) {
            lastTouch = null
            return
        }

        const touch = ev.touches[0]
        const deltaY = lastTouch.y - touch.clientY
        lastTouch = { x: touch.clientX, y: touch.clientY }

        if (deltaY === 0) return

        element.dispatchEvent(
            new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                clientX: touch.clientX,
                clientY: touch.clientY,
                deltaMode: WheelEvent.DOM_DELTA_PIXEL,
                deltaY,
                altKey: ev.altKey,
                ctrlKey: ev.ctrlKey,
                metaKey: ev.metaKey,
                shiftKey: ev.shiftKey
            })
        )

        ev.preventDefault()
        ev.stopImmediatePropagation()
        ev.stopPropagation()
    }

    const resetTouch = () => {
        lastTouch = null
    }

    element.addEventListener('touchstart', onTouchStart, { capture: true, passive: true })
    element.addEventListener('touchmove', onTouchMove, { capture: true, passive: false })
    element.addEventListener('touchend', resetTouch, { capture: true, passive: true })
    element.addEventListener('touchcancel', resetTouch, { capture: true, passive: true })

    return {
        dispose() {
            element.removeEventListener('touchstart', onTouchStart, { capture: true })
            element.removeEventListener('touchmove', onTouchMove, { capture: true })
            element.removeEventListener('touchend', resetTouch, { capture: true })
            element.removeEventListener('touchcancel', resetTouch, { capture: true })
        }
    }
}
