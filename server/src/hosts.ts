import { LOCAL_HOST_ID, type HostInfo } from '@tmuxd/shared'

const VERSION = '0.1.0'

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
