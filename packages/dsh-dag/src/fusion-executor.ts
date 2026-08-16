/**
 * Optional LLM fusion: joins multiple successful node results into one final
 * answer through a single sub-agent call (mirrors the Router's
 * `TypedResultFusion`; the fusion prompt ships with the plugin).
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FusionLlmFuse } from 'dsh-dag-core'
import { failureSummary } from 'dsh-dag-core'
import type { DagConfig } from './config.js'
import type { HarnessContext } from './contracts.js'

export const DAG_FUSION_SYSTEM_PROMPT =
  'You are the result-fusion stage of a deterministic multi-agent DAG workflow. ' +
  'You receive one task and the successful outputs of several independently ' +
  'executed nodes. Produce ONE final user-facing answer that integrates the ' +
  'node results, resolves contradictions in favor of the most specific or ' +
  'recent evidence, and explicitly notes anything left unresolved. ' +
  'Do not invent facts that appear in no node result.'

export interface FusionExecutorOptions {
  ctx: HarnessContext
  config: DagConfig
  parent: Agent
  /** Called once per started child (for the run's agentsStarted counter). */
  onAgentStart?: () => void
}

/** Build the `llmFuse` callback used by dag-core's runPlan. */
export function createFusionExecutor(options: FusionExecutorOptions): FusionLlmFuse {
  const { ctx, config, parent } = options
  return async (task, results, failures) => {
    const parts = results.map((result) => `[${result.queryId}] ${result.content}`).join('\n\n')
    const prompt =
      `${DAG_FUSION_SYSTEM_PROMPT}\n\n` +
      `TASK: ${task}\n\n` +
      `NODE RESULTS:\n${parts}\n\n` +
      `FAILED NODES: ${failureSummary(failures)}`
    const run = await ctx.subagents.start(config.subagentProvider, {
      label: 'dag-fusion',
      prompt: [{ type: 'text', text: prompt }],
      parent,
      signal: new AbortController().signal,
    })
    options.onAgentStart?.()
    try {
      const result = await run.result
      if (result.stopReason !== 'completed') {
        throw new Error(`dag fusion call ended with stop reason '${result.stopReason}'`)
      }
      return result.output
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('')
    } finally {
      await run.dispose()
    }
  }
}
