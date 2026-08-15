import { describe, expect, it } from 'vitest'
import { ExecutionPlan, PlanStep, TaskStatus, createQuery } from '../src/model.js'
import {
  createNodeExecutionRequest,
  createNodeResult,
  ExecutorKind,
  NodeResultStatus,
} from '../src/executor-contracts.js'
import type { NodeExecutionRequest, NodeResult } from '../src/executor-contracts.js'
import { AsyncExecutionScheduler, createConcurrencyLimits } from '../src/async-scheduler.js'
import { DeterministicSchedulingKernel, SchedulingDecisionError } from '../src/scheduling-kernel.js'
import type { SchedulingDecision } from '../src/scheduling-kernel.js'

function buildPlan(): ExecutionPlan {
  const plan = new ExecutionPlan({
    originalTask: 'task',
    steps: [
      new PlanStep(createQuery({ id: 'a', content: 'A', skill: 'research' })),
      new PlanStep(createQuery({ id: 'b', content: 'B', skill: 'research' })),
      new PlanStep(createQuery({ id: 'c', content: 'C', skill: 'writing' })),
    ],
  })
  plan.analysis = {
    topoLevels: {},
    parallelGroups: [],
    criticalPath: [],
    priorities: { a: 1, b: 2, c: 3 },
  }
  return plan
}

function decision(...nodeIds: string[]): SchedulingDecision {
  return {
    selectedNodeIds: nodeIds,
    reason: 'advance critical path',
    confidence: 0.9,
  }
}

describe('deterministic scheduling kernel', () => {
  it('fallback respects global and per-model limits', () => {
    const kernel = new DeterministicSchedulingKernel()
    const snapshot = kernel.snapshot(buildPlan(), {
      runId: 'run-1',
      goalId: 'goal-1',
      planId: 'plan-1',
      nodeModels: { a: 'm1', b: 'm1', c: 'm2' },
      limits: createConcurrencyLimits({
        globalLimit: 2,
        modelLimits: { m1: 1, m2: 1 },
      }),
    })

    const fallback = kernel.fallback(snapshot)

    expect(fallback.selectedNodeIds).toEqual(['a', 'c'])
  })

  it('an invalid decision does not partially mutate the plan', () => {
    const plan = buildPlan()
    const kernel = new DeterministicSchedulingKernel()

    const attempt = () =>
      kernel.commit(plan, decision('a', 'ghost'), {
        runId: 'run-1',
        goalId: 'goal-1',
        planId: 'plan-1',
      })

    expect(attempt).toThrow(SchedulingDecisionError)
    expect(attempt).toThrow(/not ready/)
    expect(plan.steps.every((step) => step.status === TaskStatus.PENDING)).toBe(true)
  })

  it('atomically commits selected nodes to running', () => {
    const plan = buildPlan()
    const kernel = new DeterministicSchedulingKernel()

    const committed = kernel.commit(plan, decision('b', 'a'), {
      runId: 'run-1',
      goalId: 'goal-1',
      planId: 'plan-1',
    })

    const statuses = Object.fromEntries(plan.steps.map((step) => [step.query.id, step.status]))
    expect(statuses).toEqual({
      a: TaskStatus.RUNNING,
      b: TaskStatus.RUNNING,
      c: TaskStatus.PENDING,
    })
    expect(committed.transitions.map((item) => [item.nodeId, item.fromStatus, item.toStatus])).toEqual([
      ['b', TaskStatus.PENDING, TaskStatus.READY],
      ['b', TaskStatus.READY, TaskStatus.RUNNING],
      ['a', TaskStatus.PENDING, TaskStatus.READY],
      ['a', TaskStatus.READY, TaskStatus.RUNNING],
    ])
  })

  it('async scheduler executes a precommitted wave without retransition', async () => {
    const plan = buildPlan()
    const kernel = new DeterministicSchedulingKernel()
    kernel.commit(plan, decision('a'), {
      runId: 'run-1',
      goalId: 'goal-1',
      planId: 'plan-1',
    })
    const scheduler = new AsyncExecutionScheduler()
    scheduler.bind(plan)

    const buildRequest = (nodeId: string): NodeExecutionRequest =>
      createNodeExecutionRequest({
        runId: 'run-1',
        goalId: 'goal-1',
        planId: 'plan-1',
        nodeId,
        executorKind: ExecutorKind.WORKER_AGENT,
        prompt: nodeId,
        modelId: 'm1',
      })

    const executeOne = async (request: NodeExecutionRequest): Promise<NodeResult> =>
      createNodeResult({
        runId: request.runId,
        nodeId: request.nodeId,
        executorKind: request.executorKind,
        status: NodeResultStatus.SUCCEEDED,
        modelId: request.modelId,
        content: 'done',
      })

    const results = await scheduler.executeCommittedWave(['a'], { buildRequest, executeOne })
    scheduler.settle(results[0]!)

    expect(results[0]?.status).toBe(NodeResultStatus.SUCCEEDED)
    expect(plan.steps[0]?.status).toBe(TaskStatus.SUCCEEDED)
  })
})
