import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { CanvasAddon } from '@xterm/addon-canvas'
import { installMobileTouchWheelBridge } from './mobileTouchWheel'

/**
 * Ported/simplified from tencent-hapi/web/src/components/Terminal/TerminalView.tsx.
 */
export function TerminalView(props: {
    onMount?: (terminal: Terminal) => void
    onResize?: (cols: number, rows: number) => void
    className?: string
}) {
    const containerRef = useRef<HTMLDivElement | null>(null)
    const onMountRef = useRef(props.onMount)
    const onResizeRef = useRef(props.onResize)

    useEffect(() => {
        onMountRef.current = props.onMount
    }, [props.onMount])
    useEffect(() => {
        onResizeRef.current = props.onResize
    }, [props.onResize])

    useEffect(() => {
        const container = containerRef.current
        if (!container) return

        const abort = new AbortController()
        const styles = getComputedStyle(document.documentElement)
        const background = styles.getPropertyValue('--app-bg').trim() || '#000000'
        const foreground = styles.getPropertyValue('--app-fg').trim() || '#ffffff'
        const selectionBackground = styles.getPropertyValue('--app-subtle-bg').trim() || 'rgba(255,255,255,0.2)'

        const terminal = new Terminal({
            cursorBlink: true,
            fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
            fontSize: 14,
            convertEol: false,
            theme: {
                background,
                foreground,
                cursor: foreground,
                selectionBackground
            }
        })

        const fit = new FitAddon()
        const links = new WebLinksAddon()
        const canvas = new CanvasAddon()
        terminal.loadAddon(fit)
        terminal.loadAddon(links)
        terminal.loadAddon(canvas)
        terminal.open(container)
        terminal.attachCustomKeyEventHandler((event) => {
            if (isCopyShortcut(event)) return false
            if (isPasteShortcut(event)) return false
            return true
        })
        container.addEventListener('pointerdown', (event) => primeContextMenuPasteTarget(terminal, container, event), {
            capture: true,
            signal: abort.signal
        })
        const touchWheel = installMobileTouchWheelBridge(terminal)

        const observer = new ResizeObserver(() => {
            requestAnimationFrame(() => {
                try {
                    fit.fit()
                    onResizeRef.current?.(terminal.cols, terminal.rows)
                } catch {
                    /* ignore transient layout errors */
                }
            })
        })
        observer.observe(container)

        abort.signal.addEventListener('abort', () => {
            observer.disconnect()
            touchWheel.dispose()
            fit.dispose()
            links.dispose()
            canvas.dispose()
            terminal.dispose()
        })

        requestAnimationFrame(() => {
            try {
                fit.fit()
            } catch {
                /* ignore */
            }
            onResizeRef.current?.(terminal.cols, terminal.rows)
        })
        onMountRef.current?.(terminal)

        return () => abort.abort()
    }, [])

    return <div ref={containerRef} className={`h-full w-full ${props.className ?? ''}`} />
}

function isPasteShortcut(event: KeyboardEvent): boolean {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return false
    return event.key.toLowerCase() === 'v' || event.code === 'KeyV'
}

function isCopyShortcut(event: KeyboardEvent): boolean {
    if (!(event.ctrlKey || event.metaKey) || event.altKey) return false
    return event.key.toLowerCase() === 'c' || event.code === 'KeyC'
}

function primeContextMenuPasteTarget(terminal: Terminal, container: HTMLElement, event: PointerEvent): void {
    if (event.button !== 2) return
    const textarea = terminal.textarea
    if (!textarea) return
    const screen = terminal.element?.querySelector<HTMLElement>('.xterm-screen') ?? container
    const rect = screen.getBoundingClientRect()
    textarea.style.width = '20px'
    textarea.style.height = '20px'
    textarea.style.left = `${event.clientX - rect.left - 10}px`
    textarea.style.top = `${event.clientY - rect.top - 10}px`
    textarea.style.zIndex = '1000'
    textarea.focus()
}
