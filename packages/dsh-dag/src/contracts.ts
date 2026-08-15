/**
 * Typed HarnessContext and public service contracts for the dsh-dag plugin.
 *
 * The concrete service surfaces (`tools`, `subagents`, `systemPrompt`) are
 * declared by their owning @deepseek-ai packages via cordis Context module
 * augmentation; `HarnessContext` is the union the plugin consumes.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { TaskGraphProposal } from '@evo-router/dag-core'

/** The plugin's service view of the DSH host context. */
export type HarnessContext = Context

/** Programmatic entry contract for `ctx.dag.start()`. */
export interface DAGStartRequest {
  /** The declarative workflow specification (validated + compiled by dag-core). */
  proposal: TaskGraphProposal
  /** The agent that owns the run (spawns every node sub-agent). */
  parent: Agent
  /** Per-run overrides applied on top of the plugin config. */
  options?: {
    /** Caller-supplied correlation key echoed in run events. */
    idempotencyKey?: string
    /** Per-node timeout in milliseconds (0 disables). */
    nodeTimeoutMs?: number
    /** Hard cap on total nodes. */
    maxTotalNodes?: number
    /** Fusion mode override. */
    fusion?: 'auto' | 'llm' | 'none'
    /** Global concurrency override (0 = unlimited). */
    globalLimit?: number
    /** Per-node retry ceiling override. */
    maxRetries?: number
  }
}
