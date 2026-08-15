/**
 * Tests for unified execution errors and bounded fallback retries.
 *
 * TypeScript port of `tests/test_retry_policy.py`.
 */

import { describe, expect, it } from 'vitest'
import type { NodeExecutionRequest, NodeResult } from '../src/executor-contracts.js'
import {
  ExecutionErrorType,
  ExecutorKind,
  NodeResultStatus,
  createExecutionError,
  createNodeExecutionRequest,
  createNodeResult,
  executionErrorFromException,
} from '../src/executor-contracts.js'
import type { RunnerLike } from '../src/retry.js'
import {
  RetryingExecutorRunner,
  createRetryPolicy,
  createRetryTargets,
} from '../src/retry.js'

function request(): NodeExecutionRequest {
  return createNodeExecutionRequest({
    runId: 'run-1',
    nodeId: 'node-1',
    executorKind: ExecutorKind.DIRECT_LLM,
    prompt: 'work',
    modelId: 'primary',
    deploymentId: 'primary-deployment',
  })
}

function failed(req: NodeExecutionRequest, errorType: ExecutionErrorType): NodeResult {
  return createNodeResult({
    runId: req.runId,
    nodeId: req.nodeId,
    executorKind: req.executorKind,
    status: NodeResultStatus.FAILED,
    modelId: req.modelId,
    error: createExecutionError({
      errorType,
      message: 'temporary failure',
      retryable: true,
    }),
  })
}

class SequencedRunner implements RunnerLike {
  requests: NodeExecutionRequest[] = []

  async execute(req: NodeExecutionRequest): Promise<NodeResult> {
    this.requests.push(req)
    if (this.requests.length < 4) {
      return failed(req, ExecutionErrorType.RATE_LIMIT)
    }
    return createNodeResult({
      runId: req.runId,
      nodeId: req.nodeId,
      executorKind: req.executorKind,
      status: NodeResultStatus.SUCCEEDED,
      modelId: req.modelId,
      content: 'done',
    })
  }
}

describe('RetryingExecutorRunner', () => {
  it('retries the original, then backup deployment, then backup model', async () => {
    const runner = new SequencedRunner()
    const delays: number[] = []
    const recordSleep = async (delay: number): Promise<void> => {
      delays.push(delay)
    }
    const retrying = new RetryingExecutorRunner(runner, {
      policy: createRetryPolicy({ maxRetries: 3, baseDelaySeconds: 1, maxDelaySeconds: 10 }),
      sleep: recordSleep,
    })
    const result = await retrying.execute(request(), {
      targets: createRetryTargets({
        backupDeploymentId: 'backup-deployment',
        backupModelId: 'backup-model',
      }),
    })

    expect(result.status).toBe(NodeResultStatus.SUCCEEDED)
    expect(runner.requests.map((item) => [item.modelId, item.deploymentId])).toEqual([
      ['primary', 'primary-deployment'],
      ['primary', 'primary-deployment'],
      ['primary', 'backup-deployment'],
      ['backup-model', null],
    ])
    expect(delays).toEqual([1, 2, 4])
    expect(result.metadata['retry_attempts']).toHaveLength(4)
  })

  it('stops on a non-retryable error without leaking exception context', () => {
    const error = executionErrorFromException({
      errorType: ExecutionErrorType.PERMISSION,
      retryable: false,
    })

    expect(error.retryable).toBe(false)
    expect(error.message).toBe('execution was denied by permission policy')
    const serialized = JSON.stringify(error)
    expect(serialized).not.toContain('PermissionError')
    expect(serialized).not.toContain('raw_exception')
    expect(serialized).not.toContain('stack_trace')
  })

  it('returns the failed result with attempt history when retries are exhausted', async () => {
    const runner = new SequencedRunner()
    const retrying = new RetryingExecutorRunner(runner, {
      policy: createRetryPolicy({ maxRetries: 1, baseDelaySeconds: 0 }),
    })

    const result = await retrying.execute(request())

    expect(result.status).toBe(NodeResultStatus.FAILED)
    expect(result.metadata['retry_exhausted']).toBe(true)
    expect(result.metadata['retry_attempts']).toHaveLength(2)
  })

  it('records execution attempt identity in the retry history', async () => {
    class AttemptAwareRunner implements RunnerLike {
      async execute(req: NodeExecutionRequest): Promise<NodeResult> {
        return createNodeResult({
          runId: req.runId,
          nodeId: req.nodeId,
          executorKind: req.executorKind,
          status: NodeResultStatus.SUCCEEDED,
          content: 'done',
          metadata: {
            idempotency_key: 'key-1',
            execution_attempt_id: 'attempt-1',
            execution_attempt_number: 1,
            idempotency_reused: false,
          },
        })
      }
    }

    const result = await new RetryingExecutorRunner(new AttemptAwareRunner()).execute(request())
    const attempts = result.metadata['retry_attempts'] as Array<Record<string, unknown>>
    const record = attempts[0]!

    expect(record['idempotency_key']).toBe('key-1')
    expect(record['execution_attempt_id']).toBe('attempt-1')
    expect(record['execution_attempt_number']).toBe(1)
    expect(record['idempotency_reused']).toBe(false)
  })
})
