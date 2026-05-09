import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmuxActionDraftSchema, tmuxActionIdSchema, tmuxActionSchema, type TmuxAction, type TmuxActionRun } from '@tmuxd/shared'

const MAX_ACTIONS = 128
const MAX_ACTION_RUNS = 1000

export class TmuxActionStore {
    private writeQueue: Promise<void> = Promise.resolve()

    constructor(
        private readonly filePath: string,
        private readonly historyPath = join(dirname(filePath), 'actions-history.json')
    ) {}

    static inDataDir(dataDir: string): TmuxActionStore {
        return new TmuxActionStore(join(dataDir, 'actions.json'))
    }

    async list(): Promise<TmuxAction[]> {
        return this.readAll()
    }

    async get(id: string): Promise<TmuxAction | null> {
        const safe = tmuxActionIdSchema.parse(id)
        return (await this.readAll()).find((action) => action.id === safe) ?? null
    }

    async create(raw: unknown, now = Date.now()): Promise<TmuxAction> {
        const draft = tmuxActionDraftSchema.parse(raw)
        const action: TmuxAction = {
            ...draft,
            id: draft.id ?? makeActionId(),
            createdAt: now,
            updatedAt: now
        }
        return this.enqueueWrite(async () => {
            const actions = await this.readAll()
            if (actions.some((existing) => existing.id === action.id)) {
                throw new ActionStoreError('action_exists')
            }
            await this.writeAll([action, ...actions].slice(0, MAX_ACTIONS))
            return action
        })
    }

    async upsert(id: string, raw: unknown, now = Date.now()): Promise<TmuxAction> {
        const safe = tmuxActionIdSchema.parse(id)
        const draft = tmuxActionDraftSchema.parse({ ...(isRecord(raw) ? raw : {}), id: safe })
        return this.enqueueWrite(async () => {
            const actions = await this.readAll()
            const existingIndex = actions.findIndex((action) => action.id === safe)
            const createdAt = existingIndex >= 0 ? actions[existingIndex].createdAt : now
            const action: TmuxAction = {
                ...draft,
                id: safe,
                createdAt,
                updatedAt: now
            }
            if (existingIndex >= 0) {
                const next = [...actions]
                next[existingIndex] = action
                await this.writeAll(next)
            } else {
                await this.writeAll([action, ...actions].slice(0, MAX_ACTIONS))
            }
            return action
        })
    }

    async delete(id: string): Promise<boolean> {
        const safe = tmuxActionIdSchema.parse(id)
        return this.enqueueWrite(async () => {
            const actions = await this.readAll()
            const next = actions.filter((action) => action.id !== safe)
            if (next.length === actions.length) return false
            await this.writeAll(next)
            return true
        })
    }

    async listHistory(limit = 100): Promise<TmuxActionRun[]> {
        const boundedLimit = clampLimit(limit)
        return (await this.readHistory()).slice(0, boundedLimit)
    }

    async recordRun(run: Omit<TmuxActionRun, 'id'>): Promise<TmuxActionRun> {
        const stored: TmuxActionRun = {
            ...run,
            id: `run-${randomUUID().slice(0, 12)}`
        }
        return this.enqueueWrite(async () => {
            const history = await this.readHistory()
            await this.writeHistory([stored, ...history].slice(0, MAX_ACTION_RUNS))
            return stored
        })
    }

    private enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
        const run = this.writeQueue.then(fn, fn)
        this.writeQueue = run.then(
            () => undefined,
            () => undefined
        )
        return run
    }

    private async readAll(): Promise<TmuxAction[]> {
        let raw: string
        try {
            raw = await readFile(this.filePath, 'utf8')
        } catch (err) {
            if (isNotFound(err)) return []
            throw err
        }
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed
            .map((value) => tmuxActionSchema.safeParse(value))
            .filter((result): result is { success: true; data: TmuxAction } => result.success)
            .map((result) => result.data)
            .slice(0, MAX_ACTIONS)
    }

    private async writeAll(actions: TmuxAction[]): Promise<void> {
        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 })
        const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`
        await writeFile(tmp, `${JSON.stringify(actions, null, 2)}\n`, { mode: 0o600 })
        await rename(tmp, this.filePath)
    }

    private async readHistory(): Promise<TmuxActionRun[]> {
        let raw: string
        try {
            raw = await readFile(this.historyPath, 'utf8')
        } catch (err) {
            if (isNotFound(err)) return []
            throw err
        }
        const parsed = JSON.parse(raw) as unknown
        if (!Array.isArray(parsed)) return []
        return parsed
            .map((value) => normalizeRun(value))
            .filter((run): run is TmuxActionRun => Boolean(run))
            .slice(0, MAX_ACTION_RUNS)
    }

    private async writeHistory(runs: TmuxActionRun[]): Promise<void> {
        await mkdir(dirname(this.historyPath), { recursive: true, mode: 0o700 })
        const tmp = `${this.historyPath}.${process.pid}.${Date.now()}.tmp`
        await writeFile(tmp, `${JSON.stringify(runs, null, 2)}\n`, { mode: 0o600 })
        await rename(tmp, this.historyPath)
    }
}

export class ActionStoreError extends Error {
    constructor(message: string) {
        super(message)
        this.name = 'ActionStoreError'
    }
}

function makeActionId(): string {
    return `act-${randomUUID().slice(0, 8)}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNotFound(err: unknown): boolean {
    return isRecord(err) && err.code === 'ENOENT'
}

function clampLimit(value: number): number {
    if (!Number.isInteger(value) || value < 1) return 100
    return Math.min(value, MAX_ACTION_RUNS)
}

function normalizeRun(value: unknown): TmuxActionRun | null {
    if (!isRecord(value)) return null
    if (
        typeof value.id !== 'string' ||
        typeof value.actionId !== 'string' ||
        typeof value.label !== 'string' ||
        (value.kind !== 'send-text' && value.kind !== 'send-keys') ||
        typeof value.hostId !== 'string' ||
        typeof value.target !== 'string' ||
        typeof value.ok !== 'boolean' ||
        typeof value.startedAt !== 'number' ||
        typeof value.completedAt !== 'number'
    ) {
        return null
    }
    return {
        id: value.id,
        actionId: value.actionId,
        label: value.label,
        kind: value.kind,
        hostId: value.hostId,
        target: value.target,
        ok: value.ok,
        error: typeof value.error === 'string' ? value.error : undefined,
        startedAt: value.startedAt,
        completedAt: value.completedAt
    }
}
