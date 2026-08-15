/**
 * Typed-gateway result fusion used by the staged runtime.
 *
 * TypeScript port of the Router's `src/fusion/typed.py`, simplified to the
 * dag-core boundary: the Router-only `LLMGateway` / `ChatCompletionRequest`
 * plumbing is replaced by a plain `llmFuse` callback that turns task + node
 * results (+ optional failures) into the final answer string. `runId`,
 * `goalId`, and `planId` are accepted for parity but carry no behavior here.
 */

import type { ExecutionResult, FinalAnswer } from './model.js'
import { createFinalAnswer } from './model.js'

/** Fuse successful node-result projections into the final answer text. */
export type FusionLlmFuse = (
  task: string,
  results: ExecutionResult[],
  failures: ExecutionResult[],
) => Promise<string>

/** System prompt for merging multiple sub-node results into a final answer. */
export const FUSION_SYSTEM_PROMPT: string =
  'You are the result fusion engine for a multi-agent task. Merge the ' +
  'individual node results into one coherent final answer that directly ' +
  'addresses the user task. Preserve all facts and cite which sub-result each ' +
  'part came from; resolve contradictions explicitly; and never invent ' +
  'information that is not present in the node results. If some nodes failed, ' +
  'acknowledge the gaps without fabricating content.'

/**
 * Fuse successful node-result projections into a FinalAnswer.
 *
 * - zero results: static failure answer;
 * - one result: pass-through of that result's content;
 * - N results: delegate to `llmFuse` when provided, otherwise join
 *   `"[queryId] content"` lines with a blank line.
 */
export async function fuse(
  task: string,
  results: ExecutionResult[],
  options?: {
    failures?: ExecutionResult[] | null
    llmFuse?: FusionLlmFuse | null
    runId?: string | null
    goalId?: string | null
    planId?: string | null
  },
): Promise<FinalAnswer> {
  if (results.length === 0) {
    return createFinalAnswer({ task, answer: 'No successful results were produced.' })
  }
  if (results.length === 1) {
    return createFinalAnswer({ task, answer: results[0]!.content, subResults: results })
  }
  let answer: string
  if (options?.llmFuse !== undefined && options.llmFuse !== null) {
    answer = await options.llmFuse(task, results, options.failures ?? [])
  } else {
    answer = results.map((item) => `[${item.queryId}] ${item.content}`).join('\n\n')
  }
  return createFinalAnswer({ task, answer, subResults: results })
}
