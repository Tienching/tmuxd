import { useState } from 'react'
import { applyQuickModifiers, MOBILE_QUICK_KEY_ROWS, type QuickKey } from './quickKeys'

export function MobileQuickKeys({
    onInput,
    onCopy,
    onImage,
    onActions,
    copyLoading = false
}: {
    onInput: (input: string) => void
    onCopy?: () => void
    onImage?: () => void
    onActions?: () => void
    copyLoading?: boolean
}) {
    const [open, setOpen] = useState(false)
    const [ctrlActive, setCtrlActive] = useState(false)
    const [altActive, setAltActive] = useState(false)
    const [shiftActive, setShiftActive] = useState(false)

    const handleKey = (key: QuickKey) => {
        if (key.modifier === 'ctrl') {
            setCtrlActive((value) => !value)
            return
        }
        if (key.modifier === 'alt') {
            setAltActive((value) => !value)
            return
        }
        if (key.modifier === 'shift') {
            setShiftActive((value) => !value)
            return
        }
        if (!key.input) return

        onInput(applyQuickModifiers(key.input, { ctrl: ctrlActive, alt: altActive, shift: shiftActive }))
        if (ctrlActive) setCtrlActive(false)
        if (altActive) setAltActive(false)
        if (shiftActive) setShiftActive(false)
    }

    const modifierActive = (key: QuickKey): boolean =>
        (key.modifier === 'ctrl' && ctrlActive) || (key.modifier === 'alt' && altActive) || (key.modifier === 'shift' && shiftActive)

    return (
        <div className="border-t border-neutral-800 bg-neutral-950 p-1 pb-[calc(env(safe-area-inset-bottom)+0.25rem)] md:hidden">
            <div
                className={onCopy || onImage || onActions ? 'grid gap-1' : ''}
                style={{ gridTemplateColumns: `repeat(${1 + (onCopy ? 1 : 0) + (onImage ? 1 : 0) + (onActions ? 1 : 0)}, minmax(0, 1fr))` }}
            >
                <button
                    type="button"
                    className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs font-medium text-neutral-100 active:bg-neutral-700"
                    aria-expanded={open}
                    onClick={() => setOpen((value) => !value)}
                >
                    {open ? 'Hide keys' : 'Keys'}
                </button>
                {onCopy && (
                    <button
                        type="button"
                        className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs font-medium text-neutral-100 active:bg-neutral-700 disabled:opacity-50"
                        disabled={copyLoading}
                        onClick={onCopy}
                    >
                        {copyLoading ? 'Text…' : 'Text'}
                    </button>
                )}
                {onImage && (
                    <button
                        type="button"
                        className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs font-medium text-neutral-100 active:bg-neutral-700"
                        onClick={onImage}
                    >
                        Image
                    </button>
                )}
                {onActions && (
                    <button
                        type="button"
                        className="w-full rounded border border-neutral-800 bg-neutral-900 px-2 py-1.5 text-xs font-medium text-neutral-100 active:bg-neutral-700"
                        onClick={onActions}
                    >
                        Actions
                    </button>
                )}
            </div>
            {open && (
                <div className="mt-1 space-y-1">
                    {MOBILE_QUICK_KEY_ROWS.map((row, rowIndex) => (
                        <div
                            key={`quick-row-${rowIndex}`}
                            className="grid gap-1"
                            style={{ gridTemplateColumns: `repeat(${row.length}, minmax(0, 1fr))` }}
                        >
                            {row.map((key) => (
                                <button
                                    key={`${key.label}-${key.title}`}
                                    type="button"
                                    className={`rounded border px-1 py-1.5 text-center text-[11px] font-medium active:bg-neutral-700 ${
                                        modifierActive(key)
                                            ? 'border-emerald-500 bg-emerald-900/60 text-emerald-100'
                                            : 'border-neutral-800 bg-neutral-900 text-neutral-100'
                                    }`}
                                    title={key.title}
                                    aria-label={key.title}
                                    aria-pressed={key.modifier ? modifierActive(key) : undefined}
                                    onClick={() => handleKey(key)}
                                >
                                    {key.label}
                                </button>
                            ))}
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
