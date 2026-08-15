/**
 * Bounded exponential retry with deployment and model fallback targets.
 *
 * TypeScript port of the Router's `src/executor/retry.py`. Semantics match the
 * Python reference 1:1: at most `maxRetries + 1` attempts, backup
 * deployment/model request variants appended after the original target, one
 * audit record per attempt, exponential backoff capped at `maxDelaySeconds`,
 * and `retry_exhausted` metadata on the final (non-SUCCEEDED) result.
 *
 * Metadata and record keys stay snake_case to match the Python reference, since
 * they are observable through `NodeResult.metadata` (`retry_attempts`,
 * `retry_exhausted`, `idempotency_key`, ...).
 */

import { setTimeout as sleepMs } from 'node:timers/promises'
import type { NodeExecutionRequest, NodeResult } from './executor-contracts.js'
import { NodeResultStatus, nodeResultWith } from './executor-contracts.js'

/** Per-node retry ceiling and exponential backoff parameters. */
export interface RetryPolicy {
  maxRetries: number
  baseDelaySeconds: number
  maxDelaySeconds: number
}

/** Create a RetryPolicy with Python defaults (0 / 1 / 30) and non-negative checks. */
export function createRetryPolicy(init?: Partial<RetryPolicy>): RetryPolicy {
  const maxRetries = init?.maxRetries ?? 0
  const baseDelaySeconds = init?.baseDelaySeconds ?? 1
  const maxDelaySeconds = init?.maxDelaySeconds ?? 30
  if (maxRetries < 0) {
    throw new Error('max_retries must be non-negative')
  }
  if (baseDelaySeconds < 0) {
    throw new Error('base_delay_seconds must be non-negative')
  }
  if (maxDelaySeconds < 0) {
    throw new Error('max_delay_seconds must be non-negative')
  }
  return { maxRetries, baseDelaySeconds, maxDelaySeconds }
}

/** Ordered alternatives used after retrying the original target. */
export interface RetryTargets {
  backupDeploymentId: string | null
  backupModelId: string | null
}

/** Create a RetryTargets with both fallbacks unset (matching Python defaults). */
export function createRetryTargets(init?: Partial<RetryTargets>): RetryTargets {
  return {
    backupDeploymentId: init?.backupDeploymentId ?? null,
    backupModelId: init?.backupModelId ?? null,
  }
}

/** Minimal structural contract for any runner producing a NodeResult. */
export interface RunnerLike {
  execute(request: NodeExecutionRequest): Promise<NodeResult>
}

/** Default sleep: convert seconds to milliseconds and await a timer. */
const defaultSleep = (seconds: number): Promise<void> => sleepMs(seconds * 1000)

/**
 * Wrap any runner returning NodeResult with auditable bounded retries.
 * Mirrors `RetryingExecutorRunner` in `src/executor/retry.py`.
 */
export class RetryingExecutorRunner {
  private readonly _runner: RunnerLike
  private readonly _policy: RetryPolicy
  private readonly _sleep: (seconds: number) => Promise<void>

  constructor(
    runner: RunnerLike,
    options?: {
      policy?: RetryPolicy
      sleep?: (seconds: number) => Promise<void>
    },
  ) {
    this._runner = runner
    this._policy = options?.policy ?? createRetryPolicy()
    this._sleep = options?.sleep ?? defaultSleep
  }

  async execute(
    request: NodeExecutionRequest,
    options?: { targets?: RetryTargets },
  ): Promise<NodeResult> {
    const attempts = this._requests(request, options?.targets ?? createRetryTargets())
    const records: Array<Record<string, unknown>> = []
    let last: NodeResult | null = null
    for (let index = 1; index <= attempts.length; index += 1) {
      const attemptRequest = attempts[index - 1]!
      last = await this._runner.execute(attemptRequest)
      const record: Record<string, unknown> = {
        attempt: index,
        model_id: attemptRequest.modelId,
        deployment_id: attemptRequest.deploymentId,
        status: last.status,
        error_type: last.error !== null ? last.error.errorType : null,
        error_code: last.error !== null ? last.error.code : null,
      }
      for (const field of [
        'idempotency_key',
        'execution_attempt_id',
        'execution_attempt_number',
        'idempotency_reused',
      ] as const) {
        if (field in last.metadata) {
          record[field] = last.metadata[field]
        }
      }
      records.push(record)
      if (last.status === NodeResultStatus.SUCCEEDED) {
        return nodeResultWith(last, {
          metadata: { ...last.metadata, retry_attempts: records },
        })
      }
      if (last.error === null || !last.error.retryable) {
        break
      }
      if (index < attempts.length) {
        const delay = Math.min(
          this._policy.maxDelaySeconds,
          this._policy.baseDelaySeconds * 2 ** (index - 1),
        )
        if (delay > 0) {
          await this._sleep(delay)
        }
      }
    }
    if (last === null) {
      throw new Error('retry loop did not execute any attempts')
    }
    return nodeResultWith(last, {
      metadata: {
        ...last.metadata,
        retry_attempts: records,
        retry_exhausted: records.length === this._policy.maxRetries + 1,
      },
    })
  }

  /**
   * Build the ordered attempt list: original target, a duplicate when more than
   * one attempt is allowed, the backup deployment variant, then the backup
   * model variant; pad with the last variant up to `maxRetries + 1`.
   */
  private _requests(
    request: NodeExecutionRequest,
    targets: RetryTargets,
  ): NodeExecutionRequest[] {
    const maximum = this._policy.maxRetries + 1
    const requests: NodeExecutionRequest[] = [request]
    if (maximum > 1) {
      requests.push(request)
    }
    if (targets.backupDeploymentId !== null) {
      requests.push({ ...request, deploymentId: targets.backupDeploymentId })
    }
    if (targets.backupModelId !== null) {
      requests.push({ ...request, modelId: targets.backupModelId, deploymentId: null })
    }
    while (requests.length < maximum) {
      requests.push(requests[requests.length - 1]!)
    }
    return requests.slice(0, maximum)
  }
}
