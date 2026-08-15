/**
 * Node executor adapter tests: prompt assembly (dependency injection, bounded
 * outputs), sub-agent error mapping, and dispose-on-all-paths.
 */

import { describe, expect, it } from 'vitest'
import { createTaskGraphProposal, TaskGraphCompiler } from '@evo-router/dag-core'
import type { ExecutionPlan, TaskGraphProposal } from '@evo-router/dag-core'
import { ExecutionErrorType, NodeResultStatus } from '@evo-router/dag-core'
import { createSubagentNodeExecutor } from '../src/node-executor.js'
import type { DagConfig } from '../src/config.js'
import { createFakeSubagents, makeParent } from './fixtures.js'

function makeConfig(overrides: Partial<DagConfig> = {}): DagConfig {
  return {
    toolName: 'dag_run',
    subagentProvider: 'fake',
    globalLimit: 4,
    perModelLimits: {},
    retryPolicy: { maxRetries: 2, baseDelaySeconds: 1, maxDelaySeconds: 30 },
    nodeTimeoutSeconds: 300,
    maxTotalNodes: 32,
    maxResultChars: 100,
    fusion: 'auto',
    emitSessionEvents: false,
    ...overrides,
  }
}

function buildProposalAndPlan(specs: Array<{ nodeId: string; prompt: string; dependsOn?: string[] }>): {
  proposal: TaskGraphProposal
  plan: ExecutionPlan
} {
  const proposal = createTaskGraphProposal({
    planId: 'p',
    objective: 'o',
    nodes: specs.map((spec) => ({
      nodeId: spec.nodeId,
      title: spec.nodeId.toUpperCase(),
      prompt: spec.prompt,
      dependsOn: spec.dependsOn ?? [],
      inputSources: (spec.dependsOn ?? []).map((dependencyId) => ({
        sourceNodeId: dependencyId,
        purpose: `use ${dependencyId}`,
      })),
      capabilityRequirements: ['general'],
      outputRequirements: ['out'],
      successCriteria: ['ok'],
      executorKind: 'runtime',
    })),
  })
  return { proposal, plan: new TaskGraphCompiler().compile(proposal) }
}

function makeExecutor(
  spec: { nodeId: string; prompt: string; dependsOn?: string[] },
  scripts: Parameters<typeof createFakeSubagents>[0],
  overrides: Partial<DagConfig> = {},
) {
  const { proposal, plan } = buildProposalAndPlan([spec])
  const fakeSubagents = createFakeSubagents(scripts)
  const executor = createSubagentNodeExecutor({
    ctx: { subagents: fakeSubagents } as never,
    config: makeConfig(overrides),
    runId: 'run_1',
    planId: 'p',
    proposal,
    plan,
    parent: makeParent(),
  })
  return { executor, fakeSubagents, proposal, plan }
}

describe('createSubagentNodeExecutor', () => {
  it('injects dependency outputs into the node prompt (bounded)', () => {
    const { proposal, plan } = buildProposalAndPlan([
      { nodeId: 'a', prompt: 'do a' },
      { nodeId: 'b', prompt: 'do b', dependsOn: ['a'] },
    ])
    // Simulate a's output already settled, longer than maxResultChars
    plan.steps[0].status = 'succeeded'
    plan.steps[0].result = 'A' + 'x'.repeat(500)
    const fakeSubagents = createFakeSubagents({ b: { output: 'b done' } })
    const executor = createSubagentNodeExecutor({
      ctx: { subagents: fakeSubagents } as never,
      config: makeConfig({ maxResultChars: 100 }),
      runId: 'run_1',
      planId: 'p',
      proposal,
      plan,
      parent: makeParent(),
      maxResultChars: 100,
    })
    const request = executor.buildRequest('b')
    expect(request.dependencyOutputs.a).toHaveLength(100)
    expect(request.prompt).toContain('Dependency outputs:')
    expect(request.prompt).toContain('[a]')
  })

  it('maps completed stop reason to a succeeded NodeResult with content', async () => {
    const { executor } = makeExecutor(
      { nodeId: 'n1', prompt: 'do n1' },
      { n1: { output: 'node output', structured: { ok: true } } },
    )
    const result = await executor.executeOne(executor.buildRequest('n1'))
    expect(result.status).toBe(NodeResultStatus.SUCCEEDED)
    expect(result.content).toBe('node output')
    expect(result.structuredOutput).toEqual({ ok: true })
  })

  it.each([
    ['error', NodeResultStatus.FAILED, ExecutionErrorType.PROVIDER_ERROR, true],
    ['max-tokens', NodeResultStatus.FAILED, ExecutionErrorType.MODEL, true],
    ['refusal', NodeResultStatus.FAILED, ExecutionErrorType.INVALID_RESPONSE, false],
  ] as const)('maps stop reason %s to a classified failure', async (stopReason, status, errorType, retryable) => {
    const { executor } = makeExecutor(
      { nodeId: 'n1', prompt: 'do n1' },
      { n1: { output: 'partial', stopReason } },
    )
    const result = await executor.executeOne(executor.buildRequest('n1'))
    expect(result.status).toBe(status)
    expect(result.error?.errorType).toBe(errorType)
    expect(result.error?.retryable).toBe(retryable)
  })

  it('disposes the child run after settlement', async () => {
    const { executor, fakeSubagents } = makeExecutor(
      { nodeId: 'n1', prompt: 'do n1' },
      { n1: { output: 'done' } },
    )
    await executor.executeOne(executor.buildRequest('n1'))
    expect(fakeSubagents.disposedLabels).toContain('dag:n1')
  })
})
