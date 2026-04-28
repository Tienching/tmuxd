export function getScrollTopForTmuxPosition(
    scrollHeight: number,
    clientHeight: number,
    lineHeight: number,
    scrollPosition: number
): number {
    const maxScroll = Math.max(0, scrollHeight - clientHeight)
    const offsetFromBottom = Math.max(0, scrollPosition || 0) * Math.max(1, lineHeight || 1)
    return clamp(maxScroll - offsetFromBottom, 0, maxScroll)
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value))
}
