import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ActionStoreError, TmuxActionStore } from './actions.js'

describe('tmux action store', () => {
    it('creates, updates, lists, and deletes actions', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'tmuxd-actions-'))
        try {
            const store = TmuxActionStore.inDataDir(dir)
            const created = await store.create({ label: 'Status', kind: 'send-text', payload: '/status', enter: true }, 10)
            assert.equal(created.label, 'Status')
            assert.equal(created.payload, '/status')
            assert.equal(created.enter, true)
            assert.equal(created.createdAt, 10)
            assert.equal((await store.list()).length, 1)

            const updated = await store.upsert(created.id, { label: 'Interrupt', kind: 'send-keys', keys: ['C-c'] }, 20)
            assert.equal(updated.id, created.id)
            assert.equal(updated.createdAt, 10)
            assert.equal(updated.updatedAt, 20)
            assert.deepEqual(updated.keys, ['C-c'])
            assert.equal((await store.get(created.id))?.kind, 'send-keys')

            assert.equal(await store.delete(created.id), true)
            assert.equal(await store.delete(created.id), false)
            assert.deepEqual(await store.list(), [])
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('rejects duplicate and incomplete actions', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'tmuxd-actions-'))
        try {
            const store = TmuxActionStore.inDataDir(dir)
            await store.create({ id: 'same', label: 'A', kind: 'send-text', payload: 'a' })
            await assert.rejects(
                () => store.create({ id: 'same', label: 'B', kind: 'send-text', payload: 'b' }),
                (err) => err instanceof ActionStoreError && err.message === 'action_exists'
            )
            await assert.rejects(() => store.create({ label: 'No payload', kind: 'send-text' }))
            await assert.rejects(() => store.create({ label: 'No keys', kind: 'send-keys' }))
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('records and limits action run history', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'tmuxd-actions-'))
        try {
            const store = TmuxActionStore.inDataDir(dir)
            const first = await store.recordRun({
                actionId: 'act-first',
                label: 'First',
                kind: 'send-text',
                hostId: 'local',
                target: 'main:0.0',
                ok: true,
                startedAt: 10,
                completedAt: 20
            })
            const second = await store.recordRun({
                actionId: 'act-second',
                label: 'Second',
                kind: 'send-keys',
                hostId: 'remote',
                target: '%8',
                ok: false,
                error: 'http_400',
                startedAt: 30,
                completedAt: 40
            })

            assert.match(first.id, /^run-/)
            assert.match(second.id, /^run-/)
            assert.deepEqual(
                (await store.listHistory()).map((run) => run.actionId),
                ['act-second', 'act-first']
            )
            assert.deepEqual(
                (await store.listHistory(1)).map((run) => run.actionId),
                ['act-second']
            )
            assert.equal((await store.listHistory())[0].error, 'http_400')
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })

    it('serializes concurrent writes so action and history updates are not lost', async () => {
        const dir = await mkdtemp(join(tmpdir(), 'tmuxd-actions-'))
        try {
            const store = TmuxActionStore.inDataDir(dir)
            await Promise.all(
                Array.from({ length: 20 }, (_, index) =>
                    store.create({
                        id: `act-${index}`,
                        label: `Action ${index}`,
                        kind: 'send-text',
                        payload: `echo ${index}`
                    })
                )
            )
            assert.equal((await store.list()).length, 20)

            await Promise.all(
                Array.from({ length: 20 }, (_, index) =>
                    store.recordRun({
                        actionId: `act-${index}`,
                        label: `Action ${index}`,
                        kind: 'send-text',
                        hostId: 'local',
                        target: 'main:0.0',
                        ok: true,
                        startedAt: index,
                        completedAt: index + 1
                    })
                )
            )
            assert.equal((await store.listHistory(100)).length, 20)
        } finally {
            await rm(dir, { recursive: true, force: true })
        }
    })
})
