/**
 * Async event-driven execution scheduler with concurrency and priority control.
 *
 * TypeScript port of the Router's `src/planner/async_scheduler.py` (1:1).
 * The scheduler composes the deterministic {@link EventDrivenScheduler} with a
 * promise-based execution layer. Nodes are started through validated state
 * transitions (PENDING -> READY -> RUNNING), executed concurrently under
 * global and per-model {@link Limiter} semaphores, and their terminal outcomes
 * are propagated downstream with ``notify()`` so dependent nodes become READY
 * or BLOCKED. There is no ready queue and no periodic scan of the whole DAG.
 *
 * `asyncio.Semaphore` is replaced by the promise-based `Limiter`;
 * `asyncio.gather` is replaced by `Promise.all`.
 */

import { ExecutionPlan, PlanStep, TaskStatus } from './model.js'
import type { NodeExecutionRequest, NodeResult } from './executor-contracts.js'
import { NodeResultStatus } from './executor-contracts.js'
import { EventDrivenScheduler } from './event-scheduler.js'

/** Terminal outcomes that keep a PENDING node from ever running. */
const BLOCKING_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.FAILED,
  TaskStatus.BLOCKED,
  TaskStatus.CANCELLED,
])

/** Global and per-model concurrency limits; zero means unlimited. */
export interface ConcurrencyLimits {
  globalLimit: number
  modelLimits: Record<string, number>
}

export interface ConcurrencyLimitsInit {
  globalLimit?: number
  modelLimits?: Record<string, number>
}

/** Create ConcurrencyLimits with non-negative validation (defaults: 0 / {}). */
export function createConcurrencyLimits(init: ConcurrencyLimitsInit = {}): ConcurrencyLimits {
  const globalLimit = init.globalLimit ?? 0
  if (globalLimit < 0) {
    throw new Error('global concurrency limit must be non-negative')
  }
  const modelLimits: Record<string, number> = { ...(init.modelLimits ?? {}) }
  for (const limit of Object.values(modelLimits)) {
    if (limit < 0) {
      throw new Error('model concurrency limits must be non-negative')
    }
  }
  return { globalLimit, modelLimits }
}

/** Maps one node id to its execution request. */
export type NodeRequestBuilder = (nodeId: string) => NodeExecutionRequest

/** Executes one request and returns its terminal NodeResult. */
export type NodeExecutor = (request: NodeExecutionRequest) => Promise<NodeResult>

/**
 * Promise-based semaphore (asyncio.Semaphore port).
 *
 * Acquire blocks while the limit is exhausted; release wakes the oldest
 * waiter (FIFO) or returns the permit to the pool. Created only with a
 * positive limit by the scheduler (limit <= 0 means "no limiter").
 */
export class Limiter {
  private _permits: number
  private readonly _waiters: Array<() => void> = []

  constructor(limit: number) {
    if (limit <= 0) {
      throw new Error('Limiter requires a positive concurrency limit')
    }
    this._permits = limit
  }

  /** Wait until a permit is available and take it. */
  async acquire(): Promise<void> {
    if (this._permits > 0) {
      this._permits -= 1
      return
    }
    await new Promise<void>((resolve) => {
      this._waiters.push(resolve)
    })
  }

  /** Return a permit, handing it to the oldest waiter if one is queued. */
  release(): void {
    const waiter = this._waiters.shift()
    if (waiter !== undefined) {
      waiter()
    } else {
      this._permits += 1
    }
  }
}

/** Execute ready nodes concurrently with priority and concurrency control. */
export class AsyncExecutionScheduler {
  private readonly _limits: ConcurrencyLimits
  private readonly _events = new EventDrivenScheduler()
  private _plan: ExecutionPlan | null = null
  private _steps: Record<string, PlanStep> = {}
  private _globalLimiter: Limiter | null = null
  private _modelLimiters: Record<string, Limiter> = {}

  constructor(options: { limits?: ConcurrencyLimits } = {}) {
    this._limits = options.limits ?? createConcurrencyLimits({})
  }

  /** The underlying event scheduler; exposed for parity with the Python
   * test suite, which drives activation directly via ``scheduler._events``. */
  get events(): EventDrivenScheduler {
    return this._events
  }

  /** Attach one plan and build dependency indexes and limiters. */
  bind(plan: ExecutionPlan): void {
    this._plan = plan
    this._steps = {}
    for (const step of plan.steps) {
      this._steps[step.query.id] = step
    }
    this._events.bind(plan)
    this._globalLimiter = this._limits.globalLimit > 0 ? new Limiter(this._limits.globalLimit) : null
    this._modelLimiters = {}
    for (const [modelId, limit] of Object.entries(this._limits.modelLimits)) {
      if (limit > 0) {
        this._modelLimiters[modelId] = new Limiter(limit)
      }
    }
  }

  /** Return the execution priority of one node; lower runs first. */
  priorityOf(nodeId: string): number {
    const analysis = this._plan === null ? null : this._plan.analysis
    if (analysis !== null && Object.keys(analysis.priorities).length > 0) {
      return analysis.priorities[nodeId] ?? 0
    }
    return 0
  }

  /**
   * Drain the runnable frontier of the plan concurrently.
   *
   * The first wave executes ``nodeIds``; every finished node settles through
   * the event scheduler and propagates to its downstream nodes, and each node
   * that becomes READY is executed in the next wave. Execution stops when no
   * node is READY, so one call runs the whole DAG without extra Router
   * decision rounds.
   *
   * @param nodeIds First-wave nodes to execute, in ready order.
   * @param options buildRequest maps one node id to its execution request;
   *        executeOne executes one request and returns its NodeResult;
   *        maxWaves is an optional hard cap on the number of waves.
   * @returns Results from every executed wave, wave by wave.
   */
  async execute(
    nodeIds: string[],
    options: { buildRequest: NodeRequestBuilder; executeOne: NodeExecutor; maxWaves?: number },
  ): Promise<NodeResult[]> {
    if (this._plan === null) {
      throw new Error('AsyncExecutionScheduler.bind() must be called before execute()')
    }
    const allResults: NodeResult[] = []
    let waveIds = [...nodeIds].sort((a, b) => this.priorityOf(a) - this.priorityOf(b))
    let waves = 0
    while (waveIds.length > 0) {
      waves += 1
      if (options.maxWaves !== undefined && waves > options.maxWaves) break
      const results = await Promise.all(
        waveIds.map((nodeId) => this._runOne(nodeId, options.buildRequest, options.executeOne)),
      )
      for (const result of results) {
        this._settle(result)
        allResults.push(result)
      }
      waveIds = this._readyIds().sort((a, b) => this.priorityOf(a) - this.priorityOf(b))
    }
    return allResults
  }

  /** Execute exactly one ready frontier without settling node outcomes. */
  async executeWave(
    nodeIds: string[],
    options: { buildRequest: NodeRequestBuilder; executeOne: NodeExecutor },
  ): Promise<NodeResult[]> {
    if (this._plan === null) {
      throw new Error('AsyncExecutionScheduler.bind() must be called before execute_wave()')
    }
    const waveIds = [...nodeIds].sort((a, b) => this.priorityOf(a) - this.priorityOf(b))
    return Promise.all(
      waveIds.map((nodeId) => this._runOne(nodeId, options.buildRequest, options.executeOne)),
    )
  }

  /** Execute nodes already atomically committed to RUNNING by the kernel. */
  async executeCommittedWave(
    nodeIds: string[],
    options: { buildRequest: NodeRequestBuilder; executeOne: NodeExecutor },
  ): Promise<NodeResult[]> {
    if (this._plan === null) {
      throw new Error('AsyncExecutionScheduler.bind() must be called before execution')
    }
    const waveIds = [...nodeIds].sort((a, b) => this.priorityOf(a) - this.priorityOf(b))
    for (const nodeId of waveIds) {
      const step = this._requireStep(nodeId)
      if (step.status !== TaskStatus.RUNNING) {
        throw new Error(`committed execution expects RUNNING node '${nodeId}'`)
      }
    }
    return Promise.all(
      waveIds.map((nodeId) => this._runCommittedOne(nodeId, options.buildRequest, options.executeOne)),
    )
  }

  /** Execute one retry attempt for nodes already in RUNNING state. */
  async retryWave(
    requests: NodeExecutionRequest[],
    options: { executeOne: NodeExecutor },
  ): Promise<NodeResult[]> {
    return Promise.all(requests.map((request) => this._retryOne(request, options.executeOne)))
  }

  /** Commit one validated terminal result and propagate dependencies. */
  settle(result: NodeResult): void {
    this._settle(result)
  }

  /** Cancel one non-terminal node through the event scheduler (delegation). */
  cancel(nodeId: string, reason?: string): string[] {
    return this._events.cancel(nodeId, reason)
  }

  /** Return nodes currently marked READY by event propagation. */
  private _readyIds(): string[] {
    return Object.entries(this._steps)
      .filter(([, step]) => step.status === TaskStatus.READY)
      .map(([nodeId]) => nodeId)
  }

  /** Describe why execution cannot continue, or null when it can. */
  stuckReason(): string | null {
    const pending = Object.entries(this._steps)
      .filter(([, step]) => step.status === TaskStatus.PENDING)
      .map(([nodeId]) => nodeId)
    if (pending.length === 0) return null
    const runningOrReady = Object.values(this._steps).some(
      (step) => step.status === TaskStatus.RUNNING || step.status === TaskStatus.READY,
    )
    if (runningOrReady) return null
    const blocked = pending.filter((nodeId) => {
      const step = this._steps[nodeId]
      if (step === undefined) return false
      return step.query.dependsOn.some((dep) => {
        const depStep = this._steps[dep]
        return depStep !== undefined && BLOCKING_STATUSES.has(depStep.status)
      })
    })
    if (blocked.length > 0) {
      return `execution stuck: pending nodes blocked by failed dependencies: ${[...blocked].sort().join(', ')}`
    }
    return `execution stuck: pending nodes cannot become runnable: ${[...pending].sort().join(', ')}`
  }

  private async _runOne(
    nodeId: string,
    buildRequest: NodeRequestBuilder,
    executeOne: NodeExecutor,
  ): Promise<NodeResult> {
    const request = buildRequest(nodeId)
    const limiters = this._limitersFor(request.modelId)
    for (const limiter of limiters) await limiter.acquire()
    try {
      this._ensureReady(nodeId)
      this._events.start(nodeId)
      return await executeOne(request)
    } finally {
      for (const limiter of limiters) limiter.release()
    }
  }

  private async _retryOne(request: NodeExecutionRequest, executeOne: NodeExecutor): Promise<NodeResult> {
    const step = this._requireStep(request.nodeId)
    if (step.status !== TaskStatus.RUNNING) {
      throw new Error(`retry expects RUNNING node '${request.nodeId}', got '${step.status}'`)
    }
    const limiters = this._limitersFor(request.modelId)
    for (const limiter of limiters) await limiter.acquire()
    try {
      return await executeOne(request)
    } finally {
      for (const limiter of limiters) limiter.release()
    }
  }

  private async _runCommittedOne(
    nodeId: string,
    buildRequest: NodeRequestBuilder,
    executeOne: NodeExecutor,
  ): Promise<NodeResult> {
    const request = buildRequest(nodeId)
    const limiters = this._limitersFor(request.modelId)
    for (const limiter of limiters) await limiter.acquire()
    try {
      return await executeOne(request)
    } finally {
      for (const limiter of limiters) limiter.release()
    }
  }

  private _limitersFor(modelId: string | null): Limiter[] {
    const limiters: Limiter[] = []
    if (this._globalLimiter !== null) limiters.push(this._globalLimiter)
    if (modelId !== null) {
      const limiter = this._modelLimiters[modelId]
      if (limiter !== undefined) limiters.push(limiter)
    }
    return limiters
  }

  private _ensureReady(nodeId: string): void {
    const step = this._requireStep(nodeId)
    if (step.status === TaskStatus.PENDING) {
      this._events.ready(nodeId, 'selected for execution')
    }
  }

  /** Record one terminal result on its step and propagate downstream. */
  private _settle(result: NodeResult): void {
    const step = this._requireStep(result.nodeId)
    if (result.status === NodeResultStatus.SUCCEEDED) {
      this._events.notify(result.nodeId, TaskStatus.SUCCEEDED)
      step.result = result.artifacts.length > 0 ? [...result.artifacts] : result.content
    } else if (result.status === NodeResultStatus.CANCELLED) {
      this._events.notify(result.nodeId, TaskStatus.CANCELLED)
      step.error = errorMessage(result)
    } else {
      this._events.notify(result.nodeId, TaskStatus.FAILED)
      step.error = errorMessage(result)
    }
  }

  private _requireStep(nodeId: string): PlanStep {
    const step = this._steps[nodeId]
    if (step === undefined) {
      throw new Error(`node '${nodeId}' is not bound to this scheduler`)
    }
    return step
  }
}

function errorMessage(result: NodeResult): string {
  if (result.error !== null) return result.error.message
  return result.status
}
