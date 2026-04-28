import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
    closeWorkspacePane,
    createWorkspacePane,
    findWorkspacePane,
    listWorkspacePanes,
    parseWorkspaceLayout,
    setWorkspacePaneSession,
    splitWorkspacePane,
    updateWorkspaceSplitRatio,
    type WorkspaceNode
} from './layout'

describe('workspace layout', () => {
    it('splits a pane and lists both sessions', () => {
        const root = createWorkspacePane('main', 'pane-a')
        const split = splitWorkspacePane(root, 'pane-a', 'row', 'web-1', 'pane-b', 'split-a')

        assert.deepEqual(
            listWorkspacePanes(split).map((pane) => [pane.id, pane.sessionName]),
            [
                ['pane-a', 'main'],
                ['pane-b', 'web-1']
            ]
        )
        assert.equal(split.type, 'split')
        if (split.type === 'split') assert.equal(split.direction, 'row')
    })

    it('replaces only the selected pane session', () => {
        const root = splitWorkspacePane(createWorkspacePane('main', 'pane-a'), 'pane-a', 'column', 'side', 'pane-b', 'split-a')
        const next = setWorkspacePaneSession(root, 'pane-b', 'logs')

        assert.equal(findWorkspacePane(next, 'pane-a')?.sessionName, 'main')
        assert.equal(findWorkspacePane(next, 'pane-b')?.sessionName, 'logs')
    })

    it('closes a pane and promotes its sibling', () => {
        const root = splitWorkspacePane(createWorkspacePane('main', 'pane-a'), 'pane-a', 'row', 'side', 'pane-b', 'split-a')
        const next = closeWorkspacePane(root, 'pane-b')

        assert.deepEqual(listWorkspacePanes(next as WorkspaceNode).map((pane) => pane.id), ['pane-a'])
    })

    it('clamps split ratios when resizing', () => {
        const root = splitWorkspacePane(createWorkspacePane('main', 'pane-a'), 'pane-a', 'row', 'side', 'pane-b', 'split-a')
        const small = updateWorkspaceSplitRatio(root, 'split-a', 0.01)
        const large = updateWorkspaceSplitRatio(root, 'split-a', 0.99)

        assert.equal(small.type, 'split')
        assert.equal(large.type, 'split')
        if (small.type === 'split') assert.equal(small.ratio, 0.15)
        if (large.type === 'split') assert.equal(large.ratio, 0.85)
    })

    it('parses persisted layouts and drops invalid branches', () => {
        const parsed = parseWorkspaceLayout({
            type: 'split',
            id: 'split-a',
            direction: 'row',
            ratio: 2,
            first: { type: 'pane', id: 'pane-a', sessionName: 'main' },
            second: { type: 'pane', id: '', sessionName: '' }
        })

        assert.deepEqual(listWorkspacePanes(parsed as WorkspaceNode).map((pane) => pane.sessionName), ['main'])
    })
})
