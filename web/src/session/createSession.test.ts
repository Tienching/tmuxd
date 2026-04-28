import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createSessionWithOptionalName } from './createSession'

describe('createSessionWithOptionalName', () => {
    it('uses the provided session name when present', async () => {
        const names: string[] = []
        const created = await createSessionWithOptionalName('  work  ', async (name) => {
            names.push(name)
        })
        assert.equal(created, 'work')
        assert.deepEqual(names, ['work'])
    })

    it('generates a default session name when input is empty', async () => {
        const names: string[] = []
        const created = await createSessionWithOptionalName('', async (name) => {
            names.push(name)
        }, new Date(2026, 3, 28, 9, 5, 7))
        assert.equal(created, 'web-20260428-090507')
        assert.deepEqual(names, ['web-20260428-090507'])
    })

    it('retries generated names on session_exists', async () => {
        const names: string[] = []
        const created = await createSessionWithOptionalName('', async (name) => {
            names.push(name)
            if (names.length === 1) throw new Error('session_exists')
        }, new Date(2026, 3, 28, 9, 5, 7), () => 'abc')
        assert.equal(created, 'web-20260428-090507-abc')
        assert.deepEqual(names, ['web-20260428-090507', 'web-20260428-090507-abc'])
    })
})
