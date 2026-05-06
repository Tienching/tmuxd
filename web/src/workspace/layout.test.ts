import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { LOCAL_HOST_ID } from '@tmuxd/shared'
import {
    closeWorkspacePane,
    createWorkspacePane,
    findWorkspacePane,
    listWorkspacePanes,
    parseWorkspaceLayout,
    setWorkspacePaneTarget,
    splitWorkspacePane,
    updateWorkspaceSplitRatio,
    type WorkspaceNode
} from './layout'

describe('workspace layout', () => {
    it('splits a pane and lists both targets', () => {
        const root = createWorkspacePane('main', 'pane-a')
        const split = splitWorkspacePane(root, 'pane-a', 'row', { hostId: 'remote-a', sessionName: 'web-1' }, 'pane-b', 'split-a')

        assert.deepEqual(
            listWorkspacePanes(split).map((pane) => [pane.id, pane.target.hostId, pane.target.sessionName]),
            [
                ['pane-a', LOCAL_HOST_ID, 'main'],
                ['pane-b', 'remote-a', 'web-1']
            ]
        )
        assert.equal(split.type, 'split')
        if (split.type === 'split') assert.equal(split.direction, 'row')
    })

    it('replaces only the selected pane target', () => {
        const root = splitWorkspacePane(createWorkspacePane('main', 'pane-a'), 'pane-a', 'column', 'side', 'pane-b', 'split-a')
        const next = setWorkspacePaneTarget(root, 'pane-b', { hostId: 'remote-a', sessionName: 'logs' })

        assert.deepEqual(findWorkspacePane(next, 'pane-a')?.target, { hostId: LOCAL_HOST_ID, sessionName: 'main' })
        assert.deepEqual(findWorkspacePane(next, 'pane-b')?.target, { hostId: 'remote-a', sessionName: 'logs' })
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

    it('parses persisted target layouts and drops invalid branches', () => {
        const parsed = parseWorkspaceLayout({
            type: 'split',
            id: 'split-a',
            direction: 'row',
            ratio: 2,
            first: { type: 'pane', id: 'pane-a', target: { hostId: 'remote-a', sessionName: 'main' } },
            second: { type: 'pane', id: '', sessionName: '' }
        })

        assert.deepEqual(listWorkspacePanes(parsed as WorkspaceNode).map((pane) => pane.target), [{ hostId: 'remote-a', sessionName: 'main' }])
    })

    it('migrates old sessionName-only panes to local targets', () => {
        const parsed = parseWorkspaceLayout({ type: 'pane', id: 'pane-a', sessionName: 'main' })

        assert.deepEqual(listWorkspacePanes(parsed as WorkspaceNode).map((pane) => pane.target), [
            { hostId: LOCAL_HOST_ID, sessionName: 'main' }
        ])
    })
})
