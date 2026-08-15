import { describe, expect, it } from 'vitest'
import { ExecutionPlan, PlanStep, TaskStatus, createQuery } from '../src/model.js'
import { EventDrivenScheduler } from '../src/event-scheduler.js'
import { NodeTransitionError } from '../src/state-machine.js'

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

/** Start and finish one node, returning newly ready downstream ids. */
function runToSuccess(scheduler: EventDrivenScheduler, nodeId: string): string[] {
  scheduler.start(nodeId)
  return scheduler.notify(nodeId, TaskStatus.SUCCEEDED)
}

describe('activation', () => {
  it('activates root nodes to ready', () => {
    const plan = buildPlan({ a: [], b: ['a'], c: [] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)

    const ready = scheduler.activate()

    expect(new Set(ready)).toEqual(new Set(['a', 'c']))
    expect(scheduler.statusOf('a')).toBe(TaskStatus.READY)
    expect(scheduler.statusOf('b')).toBe(TaskStatus.PENDING)
    expect(scheduler.statusOf('c')).toBe(TaskStatus.READY)
  })

  it('activate is one time, not a scan', () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)

    const first = scheduler.activate()
    const second = scheduler.activate()

    expect(first).toEqual(['a'])
    expect(second).toEqual([])
  })
})

describe('dependency propagation', () => {
  it('upstream completion triggers downstream ready', () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()

    const ready = runToSuccess(scheduler, 'a')

    expect(ready).toEqual(['b'])
    expect(scheduler.statusOf('a')).toBe(TaskStatus.SUCCEEDED)
    expect(scheduler.statusOf('b')).toBe(TaskStatus.READY)
  })

  it('chain propagates one level per event', () => {
    const plan = buildPlan({ a: [], b: ['a'], c: ['b'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()

    expect(runToSuccess(scheduler, 'a')).toEqual(['b'])
    expect(scheduler.statusOf('c')).toBe(TaskStatus.PENDING)

    expect(runToSuccess(scheduler, 'b')).toEqual(['c'])
    expect(scheduler.statusOf('c')).toBe(TaskStatus.READY)
  })

  it('multi-dependency waits for all parents', () => {
    const plan = buildPlan({ a: [], b: [], c: ['a', 'b'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()

    expect(runToSuccess(scheduler, 'a')).toEqual([])
    expect(scheduler.statusOf('c')).toBe(TaskStatus.PENDING)

    expect(runToSuccess(scheduler, 'b')).toEqual(['c'])
    expect(scheduler.statusOf('c')).toBe(TaskStatus.READY)
  })

  it('failed dependency blocks downstream', () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()

    scheduler.start('a')
    const ready = scheduler.notify('a', TaskStatus.FAILED)

    expect(ready).toEqual([])
    expect(scheduler.statusOf('a')).toBe(TaskStatus.FAILED)
    expect(scheduler.statusOf('b')).toBe(TaskStatus.BLOCKED)
  })

  it('blocked propagates to descendants', () => {
    const plan = buildPlan({ a: [], b: ['a'], c: ['b'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()

    scheduler.start('a')
    scheduler.notify('a', TaskStatus.FAILED)

    expect(scheduler.statusOf('b')).toBe(TaskStatus.BLOCKED)
    expect(scheduler.statusOf('c')).toBe(TaskStatus.BLOCKED)
  })

  it('unaffected nodes keep state', () => {
    const plan = buildPlan({ a: [], b: ['a'], x: [], y: ['x'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()

    runToSuccess(scheduler, 'a')

    // x/y are untouched by the a -> b propagation.
    expect(scheduler.statusOf('x')).toBe(TaskStatus.READY)
    expect(scheduler.statusOf('y')).toBe(TaskStatus.PENDING)
  })
})

describe('cancellation', () => {
  it('cancels a pending node', () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)

    scheduler.cancel('b')

    expect(scheduler.statusOf('b')).toBe(TaskStatus.CANCELLED)
  })

  it('cancelling a running node blocks downstream', () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()
    scheduler.start('a')

    scheduler.cancel('a')

    expect(scheduler.statusOf('a')).toBe(TaskStatus.CANCELLED)
    expect(scheduler.statusOf('b')).toBe(TaskStatus.BLOCKED)
  })

  it('notifies cancelled after start', () => {
    const plan = buildPlan({ a: [] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()
    scheduler.start('a')

    scheduler.notify('a', TaskStatus.CANCELLED)

    expect(scheduler.statusOf('a')).toBe(TaskStatus.CANCELLED)
  })

  it('a terminal node cannot be cancelled', () => {
    const plan = buildPlan({ a: [] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()
    runToSuccess(scheduler, 'a')

    expect(() => scheduler.cancel('a')).toThrow(NodeTransitionError)
    expect(() => scheduler.cancel('a')).toThrow(/terminal/)
  })
})

describe('guards', () => {
  it('notify requires a terminal status', () => {
    const plan = buildPlan({ a: [] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()
    scheduler.start('a')

    expect(() => scheduler.notify('a', TaskStatus.RUNNING)).toThrow(NodeTransitionError)
    expect(() => scheduler.notify('a', TaskStatus.RUNNING)).toThrow(/terminal status/)
  })

  it('notify requires running before success', () => {
    const plan = buildPlan({ a: [] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()

    expect(() => scheduler.notify('a', TaskStatus.SUCCEEDED)).toThrow(NodeTransitionError)
    expect(() => scheduler.notify('a', TaskStatus.SUCCEEDED)).toThrow(/illegal node transition/)
  })

  it('duplicate terminal notify is idempotent', () => {
    const plan = buildPlan({ a: [] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()
    runToSuccess(scheduler, 'a')

    expect(scheduler.notify('a', TaskStatus.SUCCEEDED)).toEqual([])
  })

  it('conflicting terminal notify is rejected', () => {
    const plan = buildPlan({ a: [] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()
    runToSuccess(scheduler, 'a')

    expect(() => scheduler.notify('a', TaskStatus.FAILED)).toThrow(NodeTransitionError)
    expect(() => scheduler.notify('a', TaskStatus.FAILED)).toThrow(/already terminal/)
  })

  it('unknown node raises not-bound error', () => {
    const plan = buildPlan({ a: [] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)

    expect(() => scheduler.statusOf('ghost')).toThrow(/not bound/)
  })

  it('bind rejects unknown dependency', () => {
    const query = createQuery({ id: 'a', content: 'a', skill: 'qa', dependsOn: ['ghost'] })
    const plan = new ExecutionPlan({
      originalTask: 'task',
      steps: [new PlanStep(query)],
    })
    const scheduler = new EventDrivenScheduler()

    expect(() => scheduler.bind(plan)).toThrow(/unknown node/)
  })
})

describe('audit history', () => {
  it('records every transition', () => {
    const plan = buildPlan({ a: [], b: ['a'] })
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(plan)
    scheduler.activate()
    runToSuccess(scheduler, 'a')

    const recorded = scheduler.history.map((item) => [item.nodeId, item.fromStatus, item.toStatus])

    expect(recorded).toEqual([
      ['a', TaskStatus.PENDING, TaskStatus.READY],
      ['a', TaskStatus.READY, TaskStatus.RUNNING],
      ['a', TaskStatus.RUNNING, TaskStatus.SUCCEEDED],
      ['b', TaskStatus.PENDING, TaskStatus.READY],
    ])
  })
})
