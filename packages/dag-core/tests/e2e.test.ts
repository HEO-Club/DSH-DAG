/**
 * End-to-end tests for dag-core's `runPlan` (spec H.2), mirroring the Router's
 * `test_agentic_e2e.py` scenarios with a fake `executeOne` — no network, no
 * real LLM.
 *
 * Every dependency must declare a matching input source (the compiler enforces
 * `dependsOn` ⇔ `inputSources` consistency, ported from the Router), and node
 * content satisfies the declared success criteria so the deterministic
 * validator passes.
 */

import { describe, expect, it } from 'vitest'
import { TaskGraphCompiler } from '../src/compiler.js'
import {
  createExecutionError,
  createNodeExecutionRequest,
  createNodeResult,
  ExecutionErrorType,
  NodeResultStatus,
} from '../src/executor-contracts.js'
import type { NodeExecutionRequest, NodeResult } from '../src/executor-contracts.js'
import { createConcurrencyLimits } from '../src/async-scheduler.js'
import { createRetryPolicy } from '../src/retry.js'
import { NodeResultValidator } from '../src/node-validator.js'
import type { ExecutionPlan, TaskGraphProposal, TaskNodeProposal } from '../src/index.js'
import { createTaskGraphProposal } from '../src/proposal.js'
import { runPlan } from '../src/run.js'

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

interface NodeSpec extends Partial<TaskNodeProposal> {
  nodeId: string
  title: string
  prompt: string
}

/** Build a proposal; every dependsOn automatically gains a matching input source. */
function makeProposal(planId: string, objective: string, nodes: NodeSpec[]): TaskGraphProposal {
  return createTaskGraphProposal({
    planId,
    objective,
    nodes: nodes.map((node) => ({
      ...node,
      inputSources: (node.dependsOn ?? []).map((dependencyId) => ({
        sourceNodeId: dependencyId,
        purpose: `use output of ${dependencyId}`,
      })),
    })),
  })
}

/** Minimal buildRequest that injects dependency outputs (like the adapter). */
function makeBuildRequest(plan: ExecutionPlan) {
  const stepById = new Map(plan.steps.map((step) => [step.query.id, step]))
  return (nodeId: string): NodeExecutionRequest => {
    const step = stepById.get(nodeId)
    if (step === undefined) throw new Error(`unknown node ${nodeId}`)
    const dependencyOutputs: Record<string, string> = {}
    for (const dep of step.query.dependsOn) {
      const depStep = stepById.get(dep)
      if (depStep !== undefined && depStep.result !== null && depStep.result !== undefined) {
        dependencyOutputs[dep] = String(depStep.result)
      }
    }
    const entries = Object.entries(dependencyOutputs)
    const prompt =
      entries.length === 0
        ? step.query.content
        : `${step.query.content}\n\nDependency outputs:\n${entries
            .map(([dependencyId, content]) => `[${dependencyId}]\n${content}`)
            .join('\n\n')}`
    return createNodeExecutionRequest({
      runId: 'e2e',
      nodeId,
      executorKind: 'runtime',
      prompt,
      dependencyOutputs,
      metadata: { success_criteria: [] },
    })
  }
}

function successResult(request: NodeExecutionRequest): NodeResult {
  return createNodeResult({
    runId: request.runId,
    nodeId: request.nodeId,
    executorKind: request.executorKind,
    status: NodeResultStatus.SUCCEEDED,
    content: `ok: result of ${request.nodeId}`,
  })
}

/** Tracks max concurrent in-flight executions. */
function concurrencyTracker() {
  let active = 0
  let maxActive = 0
  return {
    wrap(execute: (request: NodeExecutionRequest) => Promise<NodeResult>) {
      return async (request: NodeExecutionRequest): Promise<NodeResult> => {
        active += 1
        maxActive = Math.max(maxActive, active)
        try {
          return await execute(request)
        } finally {
          active -= 1
        }
      }
    },
    get maxActive() {
      return maxActive
    },
  }
}

function compile(proposal: TaskGraphProposal): ExecutionPlan {
  return new TaskGraphCompiler().compile(proposal)
}

const defaultOptions = {
  validator: new NodeResultValidator(),
  fusion: 'none' as const,
}

describe('runPlan E2E (H.2)', () => {
  it('diamond DAG: independent leaves run in parallel, merge waits for both', async () => {
    const proposal = makeProposal('diamond', 'diamond task', [
      { nodeId: 'root', title: 'Root', prompt: 'produce root' },
      { nodeId: 'left', title: 'Left', prompt: 'produce left', dependsOn: ['root'] },
      { nodeId: 'right', title: 'Right', prompt: 'produce right', dependsOn: ['root'] },
      { nodeId: 'merge', title: 'Merge', prompt: 'merge', dependsOn: ['left', 'right'] },
    ])
    const plan = compile(proposal)
    const tracker = concurrencyTracker()
    const executed: string[] = []
    const outcome = await runPlan(proposal, {
      ...defaultOptions,
      plan,
      buildRequest: makeBuildRequest(plan),
      executeOne: tracker.wrap(async (request) => {
        executed.push(request.nodeId)
        await tick()
        return successResult(request)
      }),
    })
    expect(outcome.status).toBe('completed')
    // left/right ran concurrently
    expect(tracker.maxActive).toBeGreaterThanOrEqual(2)
    // merge ran after both leaves
    expect(executed.indexOf('left')).toBeGreaterThan(-1)
    expect(executed.indexOf('right')).toBeGreaterThan(-1)
    expect(executed.indexOf('merge')).toBeGreaterThan(Math.max(executed.indexOf('left'), executed.indexOf('right')))
  })

  it('chain DAG: strict ordering and dependency output injected into downstream prompt', async () => {
    const proposal = makeProposal('chain', 'chain task', [
      { nodeId: 'a', title: 'A', prompt: 'do a' },
      { nodeId: 'b', title: 'B', prompt: 'do b', dependsOn: ['a'] },
      { nodeId: 'c', title: 'C', prompt: 'do c', dependsOn: ['b'] },
    ])
    const plan = compile(proposal)
    const seenPrompts: string[] = []
    const outcome = await runPlan(proposal, {
      ...defaultOptions,
      plan,
      buildRequest: (nodeId) => {
        const request = makeBuildRequest(plan)(nodeId)
        seenPrompts.push(request.prompt)
        return request
      },
      executeOne: async (request) => {
        await tick()
        return createNodeResult({
          runId: request.runId,
          nodeId: request.nodeId,
          executorKind: request.executorKind,
          status: NodeResultStatus.SUCCEEDED,
          content: `ok: content from ${request.nodeId}`,
        })
      },
    })
    expect(outcome.status).toBe('completed')
    // b's prompt contained a's output; c's prompt contained b's output
    expect(seenPrompts[1]).toContain('content from a')
    expect(seenPrompts[2]).toContain('content from b')
  })

  it('failure blocks downstream nodes; run status partial when another node succeeded', async () => {
    const proposal = makeProposal('block', 'block task', [
      { nodeId: 'ok', title: 'Ok', prompt: 'do ok' },
      { nodeId: 'bad', title: 'Bad', prompt: 'do bad' },
      { nodeId: 'child', title: 'Child', prompt: 'do child', dependsOn: ['bad'] },
    ])
    const plan = compile(proposal)
    const executed: string[] = []
    const outcome = await runPlan(proposal, {
      ...defaultOptions,
      plan,
      buildRequest: makeBuildRequest(plan),
      executeOne: async (request) => {
        executed.push(request.nodeId)
        await tick()
        if (request.nodeId === 'bad') {
          return createNodeResult({
            runId: request.runId,
            nodeId: request.nodeId,
            executorKind: request.executorKind,
            status: NodeResultStatus.FAILED,
            error: createExecutionError({ errorType: ExecutionErrorType.PROVIDER_ERROR, retryable: false }),
          })
        }
        return successResult(request)
      },
    })
    expect(outcome.status).toBe('partial')
    // child was BLOCKED and never executed
    expect(executed).not.toContain('child')
    expect(outcome.nodeResults.some((r) => r.nodeId === 'bad' && r.status === NodeResultStatus.FAILED)).toBe(true)
  })

  it('retry-exhausted node fails; transient retryable failure succeeds after N-1 attempts', async () => {
    const proposal = makeProposal('retry', 'retry task', [
      { nodeId: 'flaky', title: 'Flaky', prompt: 'do flaky' },
      { nodeId: 'hopeless', title: 'Hopeless', prompt: 'do hopeless' },
    ])
    const plan = compile(proposal)
    const attempts = new Map<string, number>()
    const outcome = await runPlan(proposal, {
      ...defaultOptions,
      plan,
      retryPolicy: createRetryPolicy({ maxRetries: 2, baseDelaySeconds: 0 }),
      buildRequest: makeBuildRequest(plan),
      executeOne: async (request) => {
        const count = (attempts.get(request.nodeId) ?? 0) + 1
        attempts.set(request.nodeId, count)
        await tick()
        if (request.nodeId === 'flaky') {
          if (count < 2) {
            return createNodeResult({
              runId: request.runId,
              nodeId: request.nodeId,
              executorKind: request.executorKind,
              status: NodeResultStatus.FAILED,
              error: createExecutionError({ errorType: ExecutionErrorType.PROVIDER_ERROR, retryable: true }),
            })
          }
          return createNodeResult({
            runId: request.runId,
            nodeId: request.nodeId,
            executorKind: request.executorKind,
            status: NodeResultStatus.SUCCEEDED,
            content: 'ok: flaky recovered',
          })
        }
        // hopeless always fails with a retryable error → retry-exhausted
        return createNodeResult({
          runId: request.runId,
          nodeId: request.nodeId,
          executorKind: request.executorKind,
          status: NodeResultStatus.FAILED,
          error: createExecutionError({ errorType: ExecutionErrorType.PROVIDER_ERROR, retryable: true }),
        })
      },
    })
    expect(attempts.get('flaky')).toBe(2) // succeeded after 1 retry
    expect(attempts.get('hopeless')).toBe(3) // maxRetries=2 → 3 attempts
    expect(outcome.status).toBe('partial')
    const flaky = outcome.nodeResults.find((r) => r.nodeId === 'flaky')
    expect(flaky?.status).toBe(NodeResultStatus.SUCCEEDED)
    const hopeless = outcome.nodeResults.find((r) => r.nodeId === 'hopeless')
    expect(hopeless?.status).toBe(NodeResultStatus.FAILED)
  })

  it('per-node timeout produces timed_out and is handled by the retry policy', async () => {
    const proposal = makeProposal('timeout', 'timeout task', [{ nodeId: 'slow', title: 'Slow', prompt: 'do slow' }])
    const plan = compile(proposal)
    let timedOut = false
    const outcome = await runPlan(proposal, {
      ...defaultOptions,
      plan,
      retryPolicy: createRetryPolicy({ maxRetries: 1, baseDelaySeconds: 0 }),
      nodeTimeoutMs: 50,
      buildRequest: makeBuildRequest(plan),
      executeOne: (request, signal) =>
        new Promise<NodeResult>((_resolve, reject) => {
          const onAbort = (): void => {
            timedOut = true
            reject(new Error('aborted'))
          }
          if (signal?.aborted === true) {
            onAbort()
            return
          }
          signal?.addEventListener('abort', onAbort, { once: true })
        }),
    })
    expect(timedOut).toBe(true)
    expect(outcome.status).toBe('failed')
    const node = outcome.nodeResults.find((r) => r.nodeId === 'slow')
    // After retry exhaustion the last terminal outcome is preserved (timed_out).
    expect(node?.status).toBe(NodeResultStatus.TIMED_OUT)
    expect(node?.error?.errorType).toBe(ExecutionErrorType.TIMEOUT)
  })

  it('concurrency limit: at most K nodes in flight', async () => {
    const proposal = makeProposal(
      'conc',
      'concurrency task',
      ['n1', 'n2', 'n3', 'n4'].map((nodeId) => ({ nodeId, title: nodeId, prompt: `do ${nodeId}` })),
    )
    const plan = compile(proposal)
    const tracker = concurrencyTracker()
    const outcome = await runPlan(proposal, {
      ...defaultOptions,
      plan,
      limits: createConcurrencyLimits({ globalLimit: 2 }),
      buildRequest: makeBuildRequest(plan),
      executeOne: tracker.wrap(async (request) => {
        await tick(10)
        return successResult(request)
      }),
    })
    expect(outcome.status).toBe('completed')
    expect(tracker.maxActive).toBeLessThanOrEqual(2)
  })

  it('all succeed → completed with fused final value', async () => {
    const proposal = makeProposal('all', 'all task', [
      { nodeId: 'x', title: 'X', prompt: 'do x' },
      { nodeId: 'y', title: 'Y', prompt: 'do y', dependsOn: ['x'] },
    ])
    const plan = compile(proposal)
    const outcome = await runPlan(proposal, {
      ...defaultOptions,
      plan,
      buildRequest: makeBuildRequest(plan),
      executeOne: async (request) => {
        await tick()
        return successResult(request)
      },
    })
    expect(outcome.status).toBe('completed')
    expect(outcome.finalAnswer.answer).toContain('result of x')
    expect(outcome.finalAnswer.answer).toContain('result of y')
  })
})
