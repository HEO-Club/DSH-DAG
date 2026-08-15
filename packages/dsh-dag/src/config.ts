/**
 * Plugin configuration (schemastery-validated).
 */

import z from '@deepseek-ai/schemastery'

export interface RetryPolicyConfig {
  maxRetries: number
  baseDelaySeconds: number
  maxDelaySeconds: number
}

export interface DagConfig {
  /** Model-facing tool name. */
  toolName: string
  /** ctx.subagents provider used for every node (and optional fusion) call. */
  subagentProvider: string
  /** Global node concurrency limit; 0 = unlimited. */
  globalLimit: number
  /** Per-model node concurrency limits; 0 = unlimited for that model. */
  perModelLimits: Record<string, number>
  /** Per-node retry ceiling and exponential backoff parameters. */
  retryPolicy: RetryPolicyConfig
  /** Per-node timeout in seconds; 0 disables. */
  nodeTimeoutSeconds: number
  /** Hard cap on total nodes per run. */
  maxTotalNodes: number
  /** Cap on dependency-output characters injected into downstream prompts. */
  maxResultChars: number
  /** 'auto': single result passes through, multiple results fuse via LLM. */
  fusion: 'auto' | 'llm' | 'none'
  /** Whether to project dag/* records into the calling Agent's Session. */
  emitSessionEvents: boolean
}

export const Config = z.object({
  toolName: z.string().default('dag_run'),
  subagentProvider: z.string().default('spawn'),
  globalLimit: z.natural().default(4),
  perModelLimits: z.dict(z.natural()).default({}),
  retryPolicy: z
    .object({
      maxRetries: z.natural().default(2),
      baseDelaySeconds: z.number().min(0).default(1),
      maxDelaySeconds: z.number().min(0).default(30),
    })
    .default({ maxRetries: 2, baseDelaySeconds: 1, maxDelaySeconds: 30 }),
  nodeTimeoutSeconds: z.number().min(0).default(300),
  maxTotalNodes: z.natural().default(32),
  maxResultChars: z.natural().default(100_000),
  fusion: z.union(['auto', 'llm', 'none']).default('auto'),
  emitSessionEvents: z.boolean().default(true),
})
