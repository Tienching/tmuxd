export type WorkspaceDirection = 'row' | 'column'

export interface WorkspacePane {
    type: 'pane'
    id: string
    sessionName: string
}

export interface WorkspaceSplit {
    type: 'split'
    id: string
    direction: WorkspaceDirection
    ratio: number
    first: WorkspaceNode
    second: WorkspaceNode
}

export type WorkspaceNode = WorkspacePane | WorkspaceSplit

const MIN_RATIO = 0.15
const MAX_RATIO = 0.85

export function createWorkspaceId(prefix: 'pane' | 'split' = 'pane'): string {
    const random =
        typeof crypto !== 'undefined' && 'randomUUID' in crypto
            ? crypto.randomUUID()
            : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return `${prefix}-${random}`
}

export function createWorkspacePane(sessionName: string, id = createWorkspaceId('pane')): WorkspacePane {
    return { type: 'pane', id, sessionName }
}

export function listWorkspacePanes(node: WorkspaceNode): WorkspacePane[] {
    if (node.type === 'pane') return [node]
    return [...listWorkspacePanes(node.first), ...listWorkspacePanes(node.second)]
}

export function findWorkspacePane(node: WorkspaceNode, paneId: string): WorkspacePane | null {
    if (node.type === 'pane') return node.id === paneId ? node : null
    return findWorkspacePane(node.first, paneId) ?? findWorkspacePane(node.second, paneId)
}

export function splitWorkspacePane(
    node: WorkspaceNode,
    paneId: string,
    direction: WorkspaceDirection,
    newSessionName: string,
    newPaneId = createWorkspaceId('pane'),
    splitId = createWorkspaceId('split')
): WorkspaceNode {
    if (node.type === 'pane') {
        if (node.id !== paneId) return node
        return {
            type: 'split',
            id: splitId,
            direction,
            ratio: 0.5,
            first: node,
            second: createWorkspacePane(newSessionName, newPaneId)
        }
    }

    const first = splitWorkspacePane(node.first, paneId, direction, newSessionName, newPaneId, splitId)
    if (first !== node.first) return { ...node, first }

    const second = splitWorkspacePane(node.second, paneId, direction, newSessionName, newPaneId, splitId)
    if (second !== node.second) return { ...node, second }

    return node
}

export function setWorkspacePaneSession(node: WorkspaceNode, paneId: string, sessionName: string): WorkspaceNode {
    if (node.type === 'pane') {
        return node.id === paneId ? { ...node, sessionName } : node
    }

    const first = setWorkspacePaneSession(node.first, paneId, sessionName)
    const second = setWorkspacePaneSession(node.second, paneId, sessionName)
    return first === node.first && second === node.second ? node : { ...node, first, second }
}

export function closeWorkspacePane(node: WorkspaceNode, paneId: string): WorkspaceNode | null {
    if (node.type === 'pane') return node.id === paneId ? null : node

    const first = closeWorkspacePane(node.first, paneId)
    const second = closeWorkspacePane(node.second, paneId)

    if (!first && !second) return null
    if (!first) return second
    if (!second) return first
    return first === node.first && second === node.second ? node : { ...node, first, second }
}

export function updateWorkspaceSplitRatio(node: WorkspaceNode, splitId: string, ratio: number): WorkspaceNode {
    if (node.type === 'pane') return node

    const nextRatio = clampRatio(ratio)
    const first = updateWorkspaceSplitRatio(node.first, splitId, ratio)
    const second = updateWorkspaceSplitRatio(node.second, splitId, ratio)

    if (node.id === splitId) return { ...node, ratio: nextRatio, first, second }
    return first === node.first && second === node.second ? node : { ...node, first, second }
}

export function parseWorkspaceLayout(value: unknown): WorkspaceNode | null {
    const node = parseNode(value, 0)
    if (!node) return null
    return listWorkspacePanes(node).length > 0 ? node : null
}

function parseNode(value: unknown, depth: number): WorkspaceNode | null {
    if (depth > 8 || !isRecord(value)) return null

    if (value.type === 'pane') {
        if (typeof value.id !== 'string' || typeof value.sessionName !== 'string') return null
        const sessionName = value.sessionName.trim()
        if (!value.id || !sessionName) return null
        return createWorkspacePane(sessionName, value.id)
    }

    if (value.type === 'split') {
        if (typeof value.id !== 'string' || !value.id) return null
        if (value.direction !== 'row' && value.direction !== 'column') return null
        const first = parseNode(value.first, depth + 1)
        const second = parseNode(value.second, depth + 1)
        if (!first && !second) return null
        if (!first) return second
        if (!second) return first
        return {
            type: 'split',
            id: value.id,
            direction: value.direction,
            ratio: clampRatio(typeof value.ratio === 'number' ? value.ratio : 0.5),
            first,
            second
        }
    }

    return null
}

function clampRatio(ratio: number): number {
    if (!Number.isFinite(ratio)) return 0.5
    return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null
}
