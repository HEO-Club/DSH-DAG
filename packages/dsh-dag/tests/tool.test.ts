/**
 * Tool contract tests: structured schema errors without creating a run,
 * canonical envelope, non-completed statuses surface as errors, disposal.
 */

import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { registerDagTool } from '../src/tool.js'
import type { DAGRunController } from '../src/dag-service.js'
import type { DAGRun, DAGRunResultData } from '../src/dag-run.js'
import type { DagConfig } from '../src/config.js'
import { createFakeSystemPrompt, createFakeTools, makeParent, singleNodeProposal } from './fixtures.js'
import type { HarnessContext } from '../src/contracts.js'

function makeConfig(): DagConfig {
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
  }
}

interface ControllerStub {
  startCalls: number
  disposed: boolean
  outcome: DAGRunResultData
}

function stubController(outcome: DAGRunResultData): ControllerStub & DAGRunController {
  const stub: ControllerStub & Partial<DAGRunController> = {
    startCalls: 0,
    disposed: false,
    outcome,
    start() {
      this.startCalls += 1
      const run: Partial<DAGRun> = {
        id: outcome.runId,
        meta: {
          runId: outcome.runId,
          planId: outcome.planId,
          objective: 'task',
          nodeCount: outcome.nodeCount,
          createdAt: new Date().toISOString(),
        },
        result: Promise.resolve(outcome),
        cancel: () => {},
        dispose: async () => {
          stub.disposed = true
        },
      }
      return run as DAGRun
    },
  }
  return stub as ControllerStub & DAGRunController
}

function mountTool(controller: DAGRunController): { tool: ToolDefinition; dispose: () => void } {
  let tool: ToolDefinition | undefined
  const ctx = {
    tools: { register: (definition: ToolDefinition) => { tool = definition; return () => {} } },
    systemPrompt: createFakeSystemPrompt(),
  } as unknown as HarnessContext
  const dispose = registerDagTool(ctx, makeConfig(), controller)
  if (tool === undefined) throw new Error('tool was not registered')
  return { tool, dispose }
}

function execContext() {
  return { agent: makeParent(), signal: new AbortController().signal } as never
}

describe('dag_run tool', () => {
  it('rejects a malformed proposal with structured shape issues and creates no run', async () => {
    const controller = stubController({ runId: 'x', planId: 'p', status: 'completed', completionReason: 'r', value: 'v', nodeCount: 1, agentsStarted: 1, failures: [], events: [] })
    const { tool, dispose } = mountTool(controller)
    try {
      await expect(tool.execute({ proposal: { planId: 'bad id!', objective: '', nodes: [] } }, execContext())).rejects.toThrow(
        /proposal shape validation failed/,
      )
      expect(controller.startCalls).toBe(0)
    } finally {
      dispose()
    }
  })

  it('rejects a cyclic proposal with graph validation issues and creates no run', async () => {
    const controller = stubController({ runId: 'x', planId: 'p', status: 'completed', completionReason: 'r', value: 'v', nodeCount: 1, agentsStarted: 1, failures: [], events: [] })
    const { tool, dispose } = mountTool(controller)
    try {
      const cyclic = {
        schemaVersion: '1.0',
        planId: 'cycle',
        objective: 'cycle',
        nodes: [
          { nodeId: 'a', title: 'A', prompt: 'a', dependsOn: ['b'], capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
          { nodeId: 'b', title: 'B', prompt: 'b', dependsOn: ['a'], capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
        ],
      }
      await expect(tool.execute({ proposal: cyclic }, execContext())).rejects.toThrow(/deterministic graph validation/)
      expect(controller.startCalls).toBe(0)
    } finally {
      dispose()
    }
  })

  it('returns the canonical envelope for a completed run and disposes it', async () => {
    const outcome: DAGRunResultData = { runId: 'dag_1', planId: 'single', status: 'completed', completionReason: 'All planned nodes completed successfully', value: 'the answer', nodeCount: 1, agentsStarted: 1, failures: [], events: [] }
    const controller = stubController(outcome)
    const { tool, dispose } = mountTool(controller)
    try {
      const result = await tool.execute({ proposal: singleNodeProposal() }, execContext())
      expect(result).toMatchObject({ runId: 'dag_1', status: 'completed', value: 'the answer', nodeCount: 1 })
      expect(controller.disposed).toBe(true)
    } finally {
      dispose()
    }
  })

  it('surfaces a non-completed status as an error (never success)', async () => {
    const outcome: DAGRunResultData = { runId: 'dag_2', planId: 'single', status: 'failed', completionReason: 'No successful node results were produced', value: 'No successful results were produced.', nodeCount: 1, agentsStarted: 1, failures: [{ nodeId: 'only', status: 'failed', error: 'node execution failed' }], events: [] }
    const controller = stubController(outcome)
    const { tool, dispose } = mountTool(controller)
    try {
      await expect(tool.execute({ proposal: singleNodeProposal() }, execContext())).rejects.toThrow(/status 'failed'/)
      expect(controller.disposed).toBe(true)
    } finally {
      dispose()
    }
  })
})
