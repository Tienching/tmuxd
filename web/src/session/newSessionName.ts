export function makeNewSessionName(date = new Date(), suffix = ''): string {
    const stamp = [
        date.getFullYear(),
        pad(date.getMonth() + 1),
        pad(date.getDate())
    ].join('')
    const time = [pad(date.getHours()), pad(date.getMinutes()), pad(date.getSeconds())].join('')
    return suffix ? `web-${stamp}-${time}-${suffix}` : `web-${stamp}-${time}`
}

function pad(value: number): string {
    return String(value).padStart(2, '0')
}
