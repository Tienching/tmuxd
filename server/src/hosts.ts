import { LOCAL_HOST_ID, type HostInfo } from '@tmuxd/shared'

const VERSION = '0.1.0'

/**
 * Module-level switch tracking whether the local host is reachable through
 * tmuxd routes. Defaults to true (single-user / non-hub-only mode). When
 * `TMUXD_RELAY=1`, `index.ts` calls `setLocalHostEnabled(false)` at boot
 * so every `isLocalHost`-dispatch branch in the routes returns 403 and
 * `getLocalHost()` is omitted from snapshots.
 *
 * The flag is mutable so tests can flip it without re-parsing env vars; in
 * production it is set exactly once at startup.
 */
let localHostEnabledFlag = true

export function setLocalHostEnabled(enabled: boolean): void {
    localHostEnabledFlag = enabled
}

export function localHostEnabled(): boolean {
    return localHostEnabledFlag
}

export function getLocalHost(): HostInfo {
    return {
        id: LOCAL_HOST_ID,
        name: 'Local',
        status: 'online',
        isLocal: true,
        version: VERSION,
        lastSeenAt: Date.now(),
        capabilities: ['list', 'create', 'kill', 'capture', 'attach', 'panes', 'input']
    }
}

export function isLocalHost(hostId: string): boolean {
    return hostId === LOCAL_HOST_ID
}
