/**
 * DAG run controller tests: full run lifecycle under a real cordis Context
 * with a fake sub-agent provider (deterministic, no network).
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { DAGRunController } from '../src/dag-service.js'
import type { DagConfig } from '../src/config.js'
import {
  createFakeSubagents,
  createFakeSystemPrompt,
  createFakeTools,
  diamondProposal,
  failureProposal,
  makeParent,
  singleNodeProposal,
} from './fixtures.js'
import type { SubagentStartRequest } from '@deepseek-ai/dsh-subagent'

function makeConfig(overrides: Partial<DagConfig> = {}): DagConfig {
  return {
    toolName: 'dag_run',
    subagentProvider: 'fake',
    globalLimit: 4,
    perModelLimits: {},
    retryPolicy: { maxRetries: 0, baseDelaySeconds: 0, maxDelaySeconds: 30 },
    nodeTimeoutSeconds: 300,
    maxTotalNodes: 32,
    maxResultChars: 1000,
    fusion: 'none',
    emitSessionEvents: false,
    ...overrides,
  }
}

function harness(scripts: Parameters<typeof createFakeSubagents>[0]) {
  const ctx = new Context()
  const subagents = createFakeSubagents(scripts)
  ctx.provide('tools', createFakeTools() as never)
  ctx.provide('subagents', subagents as never)
  ctx.provide('systemPrompt', createFakeSystemPrompt() as never)
  return { ctx, subagents }
}

/** A sub-agent shim whose children settle only when their signal aborts. */
function createHangingSubagent() {
  const started: string[] = []
  return {
    started,
    async start(_name: string, request: SubagentStartRequest) {
      const label = request.label ?? 'unknown'
      started.push(label)
      return {
        id: label as never,
        localAgent: undefined,
        result: new Promise((resolve) => {
          const onAbort = (): void => resolve({ output: [], stopReason: 'aborted' })
          if (request.signal.aborted) {
            onAbort()
            return
          }
          request.signal.addEventListener('abort', onAbort, { once: true })
        }),
        dispose: async () => {},
      }
    },
    registerProvider: () => () => {},
    getProvider: () => undefined,
    list: () => [],
  }
}

describe('DAGRunController', () => {
  it('runs a diamond DAG to completion with one child per node', async () => {
    const { ctx, subagents } = harness({
      root: { output: 'ok: root done' },
      left: { output: 'ok: left done' },
      right: { output: 'ok: right done' },
      merge: { output: 'ok: merged' },
    })
    const controller = new DAGRunController(ctx, makeConfig())
    const run = controller.start({ proposal: diamondProposal(), parent: makeParent() })
    const outcome = await run.result
    expect(outcome.status).toBe('completed')
    expect(outcome.nodeCount).toBe(4)
    expect(outcome.agentsStarted).toBe(4)
    expect(outcome.value).toContain('merged')
    for (const nodeId of ['root', 'left', 'right', 'merge']) {
      expect(subagents.started.some((call) => call.label === `dag:${nodeId}`)).toBe(true)
    }
    expect(subagents.disposedLabels).toHaveLength(4)
  })

  it('propagates failure to BLOCKED children and reports partial', async () => {
    const { ctx, subagents } = harness({
      ok: { output: 'ok done' },
      bad: { output: '', stopReason: 'error' },
    })
    const controller = new DAGRunController(ctx, makeConfig())
    const run = controller.start({ proposal: failureProposal(), parent: makeParent() })
    const outcome = await run.result
    expect(outcome.status).toBe('partial')
    const bad = outcome.failures.find((failure) => failure.nodeId === 'bad')
    expect(bad).toBeDefined()
    expect(subagents.started.some((call) => call.label === 'dag:child')).toBe(false)
  })

  it('passes the per-node model to the child agentOptions', async () => {
    const { ctx, subagents } = harness({
      ok: { output: 'ok done' },
      bad: { output: '', stopReason: 'error' },
    })
    const controller = new DAGRunController(ctx, makeConfig())
    const run = controller.start({ proposal: failureProposal(), parent: makeParent() })
    await run.result
    const bad = subagents.started.find((call) => call.label === 'dag:bad')
    expect(bad?.model).toBe('model-b')
  })

  it('fuses multiple successful results via one extra child when fusion is auto', async () => {
    const { ctx, subagents } = harness({
      root: { output: 'ok: root done' },
      left: { output: 'ok: left done' },
      right: { output: 'ok: right done' },
      merge: { output: 'ok: merged' },
    })
    const controller = new DAGRunController(ctx, makeConfig({ fusion: 'auto' }))
    const run = controller.start({ proposal: diamondProposal(), parent: makeParent() })
    const outcome = await run.result
    expect(outcome.status).toBe('completed')
    expect(subagents.started.some((call) => call.label === 'dag-fusion')).toBe(true)
    // 4 nodes + 1 fusion call
    expect(outcome.agentsStarted).toBe(5)
  })

  it('cancel() aborts in-flight children and settles the run as cancelled', async () => {
    const ctx = new Context()
    const hanging = createHangingSubagent()
    ctx.provide('tools', createFakeTools() as never)
    ctx.provide('subagents', hanging as never)
    ctx.provide('systemPrompt', createFakeSystemPrompt() as never)
    const controller = new DAGRunController(ctx, makeConfig())
    const run = controller.start({ proposal: singleNodeProposal(), parent: makeParent() })
    run.cancel('test cancellation')
    const outcome = await run.result
    expect(outcome.status).toBe('cancelled')
    expect(hanging.started).toContain('dag:only')
  })
})
