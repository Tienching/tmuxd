import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveOpenSessionHostNames, type OpenSession } from './openSessions'
import type { HostInfo, TargetSession } from '@tmuxd/shared'

describe('resolveOpenSessionHostNames', () => {
    it('uses live session host names for already-opened remote sessions', () => {
        const opened: OpenSession[] = [
            {
                name: 'main',
                hostId: 'remote-client',
                hostName: 'remote-client',
                lastOpenedAt: 1
            }
        ]
        const live: TargetSession[] = [
            {
                name: 'main',
                hostId: 'remote-client',
                hostName: 'Remote Client',
                windows: 1,
                attached: false,
                attachedClients: 0,
                created: 1,
                activity: 1
            }
        ]

        assert.deepEqual(resolveOpenSessionHostNames(opened, live), [
            {
                ...opened[0],
                hostName: 'Remote Client'
            }
        ])
    })

    it('falls back to host metadata when the exact session is not in the live list', () => {
        const opened: OpenSession[] = [{ name: 'main', hostId: 'remote-client', hostName: 'remote-client', lastOpenedAt: 1 }]
        const hosts: HostInfo[] = [
            {
                id: 'remote-client',
                name: 'Remote Client',
                status: 'online',
                isLocal: false,
                version: '0.1.0',
                lastSeenAt: 1,
                capabilities: ['list']
            }
        ]

        assert.equal(resolveOpenSessionHostNames(opened, [], hosts)[0].hostName, 'Remote Client')
    })
})
