import { describe, expect, it } from 'vitest'
import { ExecutionPlan, PlanStep, TaskStatus, createQuery } from '../src/model.js'
import {
  createExecutionError,
  createNodeExecutionRequest,
  createNodeResult,
  ExecutorKind,
  ExecutionErrorType,
  NodeResultStatus,
} from '../src/executor-contracts.js'
import type { NodeExecutionRequest, NodeResult } from '../src/executor-contracts.js'
import { AsyncExecutionScheduler, createConcurrencyLimits } from '../src/async-scheduler.js'
import type { NodeRequestBuilder } from '../src/async-scheduler.js'

/** Build a plan from a dependency map {node_id: [dep_ids]}. */
function buildPlan(deps: Record<string, string[]>): ExecutionPlan {
  const queries = Object.entries(deps).map(([nodeId, dependencyIds]) =>
    createQuery({ id: nodeId, content: nodeId, skill: 'qa', dependsOn: dependencyIds }),
  )
  return new ExecutionPlan({
    originalTask: 'task',
    steps: queries.map((query) => new PlanStep(query)),
    dagEdges: queries.flatMap((query) =>
      query.dependsOn.map((dependency) => [dependency, query.id] as [string, string]),
    ),
  })
}

function requestFor(nodeId: string, modelId = 'model'): NodeExecutionRequest {
  return createNodeExecutionRequest({
    runId: 'run',
    nodeId,
    executorKind: ExecutorKind.DIRECT_LLM,
    prompt: nodeId,
    modelId,
  })
}

/** Build requests whose dependency outputs mirror the plan results. */
function buildRequestFromPlan(plan: ExecutionPlan): NodeRequestBuilder {
  const steps = new Map(plan.steps.map((step) => [step.query.id, step]))

  return (nodeId: string): NodeExecutionRequest => {
    const request = requestFor(nodeId)
    const step = steps.get(nodeId)
    if (step === undefined) return request
    return createNodeExecutionRequest({
      ...request,
      dependencyOutputs: Object.fromEntries(
        step.query.dependsOn.map((dep) => {
          const depStep = steps.get(dep)
          return [dep, depStep === undefined ? '' : String(depStep.result)]
        }),
      ),
    })
  }
}

/** Records start order and concurrent execution depth of every node. */
class TrackingExecutor {
  readonly delay: number
  readonly fail: Set<string>
  readonly started: string[] = []
  active = 0
  maxActive = 0
  modelActive: Record<string, number> = {}
  modelMaxActive: Record<string, number> = {}

  constructor(options: { delay?: number; fail?: string[] } = {}) {
    this.delay = options.delay ?? 0
    this.fail = new Set(options.fail ?? [])
  }

  async executeOne(request: NodeExecutionRequest): Promise<NodeResult> {
    this.started.push(request.nodeId)
    const model = request.modelId ?? 'unknown'
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    this.modelActive[model] = (this.modelActive[model] ?? 0) + 1
    this.modelMaxActive[model] = Math.max(this.modelMaxActive[model] ?? 0, this.modelActive[model])
    try {
      if (this.delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delay))
      }
      if (this.fail.has(request.nodeId)) {
        return createNodeResult({
          runId: request.runId,
          nodeId: request.nodeId,
          executorKind: request.executorKind,
          status: NodeResultStatus.FAILED,
          modelId: request.modelId,
          error: createExecutionError({
            errorType: ExecutionErrorType.PROVIDER_ERROR,
            message: 'boom',
            retryable: true,
          }),
        })
      }
      return createNodeResult({
        runId: request.runId,
        nodeId: request.nodeId,
        executorKind: request.executorKind,
        status: NodeResultStatus.SUCCEEDED,
        modelId: request.modelId,
        content: `ok-${request.nodeId}`,
      })
    } finally {
      this.active -= 1
      this.modelActive[model] -= 1
    }
  }
}

function statuses(plan: ExecutionPlan): Record<string, TaskStatus> {
  return Object.fromEntries(plan.steps.map((step) => [step.query.id, step.status]))
}

describe('concurrent execution', () => {
  it('executes independent nodes concurrently', async () => {
    const plan = buildPlan({ a: [], b: [], c: [] })
    const executor = new TrackingExecutor({ delay: 20 })
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    const results = await scheduler.execute(['a', 'b', 'c'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(executor.maxActive).toBe(3)
    expect(new Set(results.map((result) => result.nodeId))).toEqual(new Set(['a', 'b', 'c']))
    expect(results.every((result) => result.status === NodeResultStatus.SUCCEEDED)).toBe(true)
    expect(statuses(plan)).toEqual({
      a: TaskStatus.SUCCEEDED,
      b: TaskStatus.SUCCEEDED,
      c: TaskStatus.SUCCEEDED,
    })
  })

  it('caps concurrent execution with a global limit', async () => {
    const plan = buildPlan({ a: [], b: [], c: [], d: [] })
    const executor = new TrackingExecutor({ delay: 20 })
    const scheduler = new AsyncExecutionScheduler({
      limits: createConcurrencyLimits({ globalLimit: 2 }),
    })
    scheduler.bind(plan)

    await scheduler.execute(['a', 'b', 'c', 'd'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(executor.maxActive).toBe(2)
    expect(executor.started).toHaveLength(4)
    expect(plan.steps.every((step) => step.status === TaskStatus.SUCCEEDED)).toBe(true)
  })

  it('caps concurrent requests per model', async () => {
    const plan = buildPlan({ a: [], b: [], c: [], d: [] })
    const executor = new TrackingExecutor({ delay: 20 })
    const scheduler = new AsyncExecutionScheduler({
      limits: createConcurrencyLimits({ modelLimits: { m1: 1, m2: 1 } }),
    })
    scheduler.bind(plan)

    const build = (nodeId: string): NodeExecutionRequest => {
      const model = nodeId === 'a' || nodeId === 'b' ? 'm1' : 'm2'
      return requestFor(nodeId, model)
    }

    await scheduler.execute(['a', 'b', 'c', 'd'], {
      buildRequest: build,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(executor.modelMaxActive).toEqual({ m1: 1, m2: 1 })
    expect(plan.steps.every((step) => step.status === TaskStatus.SUCCEEDED)).toBe(true)
  })
})

describe('priority scheduling', () => {
  it('starts the higher-priority node first when limited', async () => {
    const plan = buildPlan({ low: [], high: [] })
    plan.analysis = { topoLevels: {}, parallelGroups: [], criticalPath: [], priorities: { high: 1, low: 10 } }
    const executor = new TrackingExecutor({ delay: 20 })
    const scheduler = new AsyncExecutionScheduler({
      limits: createConcurrencyLimits({ globalLimit: 1 }),
    })
    scheduler.bind(plan)

    await scheduler.execute(['low', 'high'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(executor.started).toEqual(['high', 'low'])
  })

  it('analysis priorities drive default ordering', async () => {
    // Critical-path nodes receive priority 1; the parallel leaf receives 2
    // (mirrors DAGAnalyzer output for a -> b with the parallel leaf x).
    const plan = buildPlan({ a: [], x: [], b: ['a'] })
    plan.analysis = { topoLevels: {}, parallelGroups: [], criticalPath: [], priorities: { a: 1, b: 1, x: 2 } }
    const executor = new TrackingExecutor({ delay: 20 })
    const scheduler = new AsyncExecutionScheduler({
      limits: createConcurrencyLimits({ globalLimit: 1 }),
    })
    scheduler.bind(plan)

    await scheduler.execute(['x', 'a'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
      maxWaves: 1,
    })

    expect(executor.started).toEqual(['a', 'x'])
  })
})

describe('downstream propagation', () => {
  it('drains a chain in one execute', async () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const executor = new TrackingExecutor()
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    const results = await scheduler.execute(['a'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(new Set(results.map((result) => result.nodeId))).toEqual(new Set(['a', 'b']))
    expect(statuses(plan)).toEqual({
      a: TaskStatus.SUCCEEDED,
      b: TaskStatus.SUCCEEDED,
    })
    expect(scheduler.stuckReason()).toBeNull()
  })

  it('drains a branching DAG in one execute', async () => {
    const plan = buildPlan({ a: [], b: ['a'], c: ['a'] })
    const executor = new TrackingExecutor()
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    const results = await scheduler.execute(['a'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(new Set(results.map((result) => result.nodeId))).toEqual(new Set(['a', 'b', 'c']))
    expect(statuses(plan)).toEqual({
      a: TaskStatus.SUCCEEDED,
      b: TaskStatus.SUCCEEDED,
      c: TaskStatus.SUCCEEDED,
    })
  })

  it('downstream wave receives upstream outputs', async () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const seen: Record<string, Record<string, string>> = {}

    const build = (nodeId: string): NodeExecutionRequest => {
      const request = buildRequestFromPlan(plan)(nodeId)
      seen[nodeId] = { ...request.dependencyOutputs }
      return request
    }

    const executor = new TrackingExecutor()
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    await scheduler.execute(['a'], {
      buildRequest: build,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(seen['a']).toEqual({})
    expect(seen['b']).toEqual({ a: 'ok-a' })
  })

  it('a failure stops the drain and blocks descendants', async () => {
    const plan = buildPlan({ a: [], b: ['a'], c: ['b'] })
    const executor = new TrackingExecutor({ fail: ['b'] })
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    const results = await scheduler.execute(['a'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(new Set(results.map((result) => result.nodeId))).toEqual(new Set(['a', 'b']))
    expect(executor.started).not.toContain('c')
    expect(statuses(plan)).toEqual({
      a: TaskStatus.SUCCEEDED,
      b: TaskStatus.FAILED,
      c: TaskStatus.BLOCKED,
    })
  })

  it('max waves caps the drain', async () => {
    const plan = buildPlan({ a: [], b: ['a'], c: ['b'] })
    const executor = new TrackingExecutor()
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    const results = await scheduler.execute(['a'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
      maxWaves: 1,
    })

    expect(new Set(results.map((result) => result.nodeId))).toEqual(new Set(['a']))
    expect(statuses(plan)).toEqual({
      a: TaskStatus.SUCCEEDED,
      b: TaskStatus.READY,
      c: TaskStatus.PENDING,
    })
  })

  it('a failed dependency blocks downstream', async () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const executor = new TrackingExecutor({ fail: ['a'] })
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    const results = await scheduler.execute(['a'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(results[0]?.status).toBe(NodeResultStatus.FAILED)
    expect(statuses(plan)).toEqual({
      a: TaskStatus.FAILED,
      b: TaskStatus.BLOCKED,
    })
    const stepA = plan.steps.find((step) => step.query.id === 'a')
    expect(stepA?.error).toBe('boom')
  })
})

describe('stuck detection', () => {
  it('reports stuck when pending nodes cannot run', () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    const reason = scheduler.stuckReason()

    expect(reason).not.toBeNull()
    expect(reason).toContain('stuck')
  })

  it('is not stuck while nodes are ready', () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)
    scheduler.events.activate()

    expect(scheduler.stuckReason()).toBeNull()
  })

  it('is not stuck after a failure blocks all pending', async () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const executor = new TrackingExecutor({ fail: ['a'] })
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    await scheduler.execute(['a'], {
      buildRequest: requestFor,
      executeOne: executor.executeOne.bind(executor),
    })

    expect(scheduler.stuckReason()).toBeNull()
  })
})

describe('concurrency limits', () => {
  it('rejects a negative global limit', () => {
    expect(() => createConcurrencyLimits({ globalLimit: -1 })).toThrow()
  })

  it('rejects a negative model limit', () => {
    expect(() => createConcurrencyLimits({ modelLimits: { m1: -1 } })).toThrow()
  })
})
