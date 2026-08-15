/**
 * End-to-end DAG run runner.
 *
 * Mirrors the Router's staged runtime composition (`src/runtime/staged.py`
 * `_execute_ready` → `_validate_nodes` → `_retry_nodes` → `_finalize`), but
 * as a single deterministic call: compile → wave execution (with per-node
 * timeout) → node validation → bounded retry with validation feedback →
 * result fusion. Run status is `completed | partial | failed | cancelled`.
 *
 * dag-core stays framework-free: `buildRequest` / `executeOne` / `validator` /
 * `llmFuse` are injected by the caller (the DSH adapter injects sub-agent
 * execution and DSH-backed validation/fusion).
 */

import { AsyncExecutionScheduler } from './async-scheduler.js'
import type { ConcurrencyLimits } from './async-scheduler.js'
import { TaskGraphCompiler } from './compiler.js'
import { dedupNodeResults } from './dedup.js'
import {
  createExecutionError,
  createNodeExecutionRequest,
  createNodeResult,
  ExecutionErrorType,
  NodeResultStatus,
} from './executor-contracts.js'
import type { NodeExecutionRequest, NodeResult } from './executor-contracts.js'
import { fuse } from './fusion.js'
import type { FusionLlmFuse } from './fusion.js'
import { createExecutionResult, createFinalAnswer, randomHex, TaskStatus } from './model.js'
import type { ExecutionPlan, ExecutionResult, FinalAnswer } from './model.js'
import { NodeResultValidator, ValidationStatus } from './node-validator.js'
import type { ValidationResult } from './node-validator.js'
import type { TaskGraphProposal } from './proposal.js'
import { createRetryPolicy } from './retry.js'
import type { RetryPolicy } from './retry.js'

export type RunStatus = 'completed' | 'partial' | 'failed' | 'cancelled'

/**
 * Executes one node request. The optional signal is the composed
 * run-cancel + per-node-timeout signal owned by the runner.
 */
export type DagNodeExecutor = (request: NodeExecutionRequest, signal?: AbortSignal) => Promise<NodeResult>

/** Observe-only lifecycle events emitted by a DAG run (no live handles). */
export type DagCoreEvent =
  | { type: 'dag/run-start'; runId: string; planId: string; nodeCount: number }
  | { type: 'dag/node-start'; runId: string; nodeId: string }
  | { type: 'dag/node-end'; runId: string; nodeId: string; status: NodeResult['status'] }
  | { type: 'dag/retry'; runId: string; nodeId: string; attempt: number }
  | { type: 'dag/run-end'; runId: string; status: RunStatus }

export interface RunResult {
  runId: string
  planId: string
  status: RunStatus
  completionReason: string
  finalAnswer: FinalAnswer
  nodeResults: NodeResult[]
  executionResults: ExecutionResult[]
  retryCounts: Record<string, number>
  stuckReason: string | null
}

export interface RunPlanOptions {
  /** Optional explicit run id; defaults to a generated `run_<hex>` id. */
  runId?: string
  /**
   * Optional precompiled plan. When omitted, the proposal is compiled by this
   * call. Pass a caller-owned plan to share node state (dependency outputs are
   * read from the plan's settled step results by `buildRequest`).
   */
  plan?: ExecutionPlan
  /** Global + per-model concurrency limits (0 = unlimited). */
  limits?: ConcurrencyLimits
  /** Per-node retry policy. Defaults to no retries. */
  retryPolicy?: RetryPolicy
  /** Per-node timeout in milliseconds; 0 disables. */
  nodeTimeoutMs?: number
  /** Hard cap on total nodes; exceeding it fails the run before execution. */
  maxTotalNodes?: number
  /** Hard cap on the number of scheduling waves. */
  maxWaves?: number
  /** Maps one node id to its execution request (dependency injection happens here). */
  buildRequest: (nodeId: string) => NodeExecutionRequest
  /** Executes one request and returns a terminal NodeResult. */
  executeOne: DagNodeExecutor
  /** Optional deterministic node-result validator. */
  validator?: NodeResultValidator | null
  /** Optional LLM fusion callback used when multiple results need joining. */
  llmFuse?: FusionLlmFuse | null
  /** 'auto': single result passes through, multiple results fuse when llmFuse exists. */
  fusion?: 'auto' | 'llm' | 'none'
  /** Abort signal: aborts cancel pending nodes and mark the run cancelled. */
  signal?: AbortSignal | null
  /** Observe-only lifecycle callback. */
  onEvent?: (event: DagCoreEvent) => void
}

/**
 * Compile, schedule, execute, validate, retry and fuse one proposal.
 *
 * @throws PlanningError when the proposal fails deterministic validation
 *         (callers surface the structured issues; no run is created).
 */
export async function runPlan(proposal: TaskGraphProposal, options: RunPlanOptions): Promise<RunResult> {
  const runId = options.runId ?? `run_${randomHex(12)}`
  const plan = options.plan ?? new TaskGraphCompiler().compile(proposal)
  const maxTotalNodes = options.maxTotalNodes ?? Number.POSITIVE_INFINITY

  if (plan.steps.length > maxTotalNodes) {
    const finalAnswer = createFinalAnswer({
      task: proposal.objective,
      answer: `Run rejected: node count ${plan.steps.length} exceeds max total nodes ${maxTotalNodes}`,
    })
    return {
      runId,
      planId: proposal.planId,
      status: 'failed',
      completionReason: `exceeded max total nodes (${plan.steps.length} > ${maxTotalNodes})`,
      finalAnswer,
      nodeResults: [],
      executionResults: [],
      retryCounts: {},
      stuckReason: null,
    }
  }

  const scheduler = new AsyncExecutionScheduler({ limits: options.limits })
  scheduler.bind(plan)

  const requests = new Map<string, NodeExecutionRequest>()
  const nodeResults: NodeResult[] = []
  const executionResults: ExecutionResult[] = []
  const retryCounts: Record<string, number> = {}
  const retryPolicy = options.retryPolicy ?? createRetryPolicy()
  const nodeTimeoutMs = options.nodeTimeoutMs ?? 0
  const runSignal = options.signal ?? null
  const timeoutSignal = nodeTimeoutMs > 0 ? AbortSignal.timeout(nodeTimeoutMs) : null
  const executionSignal =
    runSignal !== null && timeoutSignal !== null
      ? AbortSignal.any([runSignal, timeoutSignal])
      : (runSignal ?? timeoutSignal) ?? undefined

  const priorityOf = (nodeId: string): number => plan.analysis?.priorities[nodeId] ?? 0
  const readyIds = (): string[] =>
    plan.readySteps
      .map((step) => step.query.id)
      .sort((a, b) => priorityOf(a) - priorityOf(b))

  const buildRequest = (nodeId: string): NodeExecutionRequest => {
    const request = options.buildRequest(nodeId)
    requests.set(nodeId, request)
    return request
  }

  const guardedExecute = async (request: NodeExecutionRequest): Promise<NodeResult> => {
    try {
      return await options.executeOne(request, executionSignal)
    } catch (error) {
      const timedOut = timeoutSignal !== null && timeoutSignal.aborted
      const cancelled = runSignal !== null && runSignal.aborted
      const aborted = timedOut || cancelled
      return createNodeResult({
        runId: request.runId,
        nodeId: request.nodeId,
        executorKind: request.executorKind,
        status: timedOut
          ? NodeResultStatus.TIMED_OUT
          : cancelled
            ? NodeResultStatus.CANCELLED
            : NodeResultStatus.FAILED,
        modelId: request.modelId,
        error: createExecutionError({
          errorType: timedOut
            ? ExecutionErrorType.TIMEOUT
            : cancelled
              ? ExecutionErrorType.CANCELLED
              : ExecutionErrorType.INTERNAL_ERROR,
          retryable: timedOut,
          code: null,
        }),
      })
    }
  }

  const toExecutionResult = (result: NodeResult): ExecutionResult =>
    createExecutionResult({
      queryId: result.nodeId,
      modelUsed: result.modelId ?? 'unknown',
      content: result.content,
      metadata: result.metadata,
      artifactIds: result.artifacts.map((artifact) => artifact.artifactId),
      error: result.error?.message ?? null,
    })

  const settleResult = (result: NodeResult): void => {
    scheduler.settle(result)
    nodeResults.push(result)
    if (result.status === NodeResultStatus.SUCCEEDED) {
      executionResults.push(toExecutionResult(result))
    }
  }

  const canRetry = (result: NodeResult, retriesUsed: number): boolean => {
    if (retriesUsed >= retryPolicy.maxRetries) return false
    if (result.status === NodeResultStatus.SUCCEEDED) return true
    return result.error !== null && result.error.retryable
  }

  const buildRetryRequest = (
    request: NodeExecutionRequest,
    retryNumber: number,
    report: ValidationResult,
  ): NodeExecutionRequest => {
    const codes = report.errors.map((error) => error.code).join(', ')
    const suggestions = report.repairSuggestions.map((item) => `- ${item}`).join('\n')
    let feedback = `\n\nValidation retry ${retryNumber}. Correct these validation failures: ${codes || 'execution_failed'}.`
    if (suggestions) feedback += `\n${suggestions}`
    return createNodeExecutionRequest({
      ...request,
      prompt: request.prompt + feedback,
      idempotencyKey: null,
    })
  }

  const toValidationFailure = (result: NodeResult, report: ValidationResult): NodeResult => {
    if (result.status !== NodeResultStatus.SUCCEEDED) return result
    return createNodeResult({
      runId: result.runId,
      nodeId: result.nodeId,
      executorKind: result.executorKind,
      status: NodeResultStatus.FAILED,
      modelId: result.modelId,
      error: createExecutionError({
        errorType: ExecutionErrorType.VALIDATION,
        retryable: false,
        code: 'validation_failed',
        details: { error_codes: report.errors.map((error) => error.code) },
      }),
    })
  }

  // Returns 'settled' when the node reached a terminal state, 'retry' when a
  // bounded retryable retry was queued.
  const handleResult = (result: NodeResult): 'settled' | 'retry' => {
    const request = requests.get(result.nodeId)
    if (request === undefined) {
      throw new Error(`no execution request recorded for node '${result.nodeId}'`)
    }
    const report = options.validator !== null && options.validator !== undefined
      ? options.validator.validate(request, result)
      : null
    if (report === null || report.status === ValidationStatus.PASSED) {
      settleResult(result)
      return 'settled'
    }
    const used = retryCounts[result.nodeId] ?? 0
    if (canRetry(result, used)) {
      const retryNumber = used + 1
      retryCounts[result.nodeId] = retryNumber
      const retryRequest = buildRetryRequest(request, retryNumber, report)
      requests.set(result.nodeId, retryRequest)
      options.onEvent?.({ type: 'dag/retry', runId, nodeId: result.nodeId, attempt: retryNumber })
      return 'retry'
    }
    settleResult(toValidationFailure(result, report))
    return 'settled'
  }

  const backoff = (retryNumber: number): number =>
    Math.min(retryPolicy.maxDelaySeconds, retryPolicy.baseDelaySeconds * 2 ** (retryNumber - 1))
  const sleep = (seconds: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, seconds * 1000))

  options.onEvent?.({ type: 'dag/run-start', runId, planId: proposal.planId, nodeCount: plan.steps.length })

  let waveIds = readyIds()
  let stuckReason: string | null = null
  let waves = 0
  const maxWaves = options.maxWaves ?? Number.POSITIVE_INFINITY

  while (waveIds.length > 0) {
    // A run cancelled before or during a wave must not start new nodes.
    if (runSignal !== null && runSignal.aborted) {
      for (const step of plan.steps) {
        if (step.status === TaskStatus.PENDING || step.status === TaskStatus.READY) {
          scheduler.cancel(step.query.id, 'run aborted')
        }
      }
      stuckReason = null
      break
    }
    waves += 1
    if (waves > maxWaves) {
      stuckReason = `execution stuck: max waves (${maxWaves}) exceeded`
      break
    }
    for (const nodeId of waveIds) {
      options.onEvent?.({ type: 'dag/node-start', runId, nodeId })
    }
    const results = await scheduler.executeWave(waveIds, {
      buildRequest,
      executeOne: guardedExecute,
    })
    for (const result of results) {
      options.onEvent?.({ type: 'dag/node-end', runId, nodeId: result.nodeId, status: result.status })
    }

    let retryQueue: NodeExecutionRequest[] = []
    for (const result of results) {
      if (handleResult(result) === 'retry') {
        const request = requests.get(result.nodeId)
        if (request !== undefined) retryQueue.push(request)
      }
    }

    while (retryQueue.length > 0) {
      const batch = retryQueue
      retryQueue = []
      const delay = batch.reduce(
        (maximum, request) => Math.max(maximum, backoff(retryCounts[request.nodeId] ?? 1)),
        0,
      )
      if (delay > 0) await sleep(delay)
      const retried = await scheduler.retryWave(batch, { executeOne: guardedExecute })
      for (const result of retried) {
        options.onEvent?.({ type: 'dag/node-end', runId, nodeId: result.nodeId, status: result.status })
        if (handleResult(result) === 'retry') {
          const request = requests.get(result.nodeId)
          if (request !== undefined) retryQueue.push(request)
        }
      }
    }

    if (runSignal !== null && runSignal.aborted) {
      for (const step of plan.steps) {
        if (step.status === TaskStatus.PENDING || step.status === TaskStatus.READY) {
          scheduler.cancel(step.query.id, 'run aborted')
        }
      }
      stuckReason = null
      break
    }

    waveIds = readyIds()
    const stuck = scheduler.stuckReason()
    if (stuck !== null) {
      stuckReason = stuck
      break
    }
  }

  const finalize = async (): Promise<{ status: RunStatus; reason: string; answer: FinalAnswer }> => {
    const failures = nodeResults
      .filter((result) => result.status !== NodeResultStatus.SUCCEEDED)
      .map(toExecutionResult)
    const successes = executionResults.filter((result) => result.error === null)
    const aborted = runSignal !== null && runSignal.aborted

    if (aborted) {
      return {
        status: 'cancelled',
        reason: 'Run was cancelled',
        answer: createFinalAnswer({ task: proposal.objective, answer: 'Run was cancelled before completion.' }),
      }
    }
    if (successes.length === 0) {
      return {
        status: 'failed',
        reason: 'No successful node results were produced',
        answer: createFinalAnswer({ task: proposal.objective, answer: 'No successful results were produced.' }),
      }
    }
    const fusionMode = options.fusion ?? 'auto'
    const useLlm =
      fusionMode === 'llm' || (fusionMode === 'auto' && successes.length > 1 && options.llmFuse !== null && options.llmFuse !== undefined)
    let answer: FinalAnswer
    if (useLlm) {
      answer = await fuse(proposal.objective, successes, {
        failures,
        llmFuse: options.llmFuse ?? undefined,
        runId,
        planId: proposal.planId,
      })
    } else {
      const kept = dedupNodeResults(successes)
      answer = createFinalAnswer({
        task: proposal.objective,
        answer: kept[0].map((result) => `[${result.queryId}] ${result.content}`).join('\n\n'),
        subResults: kept[0],
        dedupRemovedNodeIds: kept[1],
      })
    }
    if (failures.length > 0) {
      const note =
        `\n\n[Router note] This run is incomplete: ${failures.length} node(s) did not complete successfully. ` +
        `Failed nodes: ${failures.map((item) => `${item.queryId}: ${item.error ?? 'failed without an error message'}`).join('; ')}. ` +
        'The final answer was synthesized from the available successful nodes.'
      return {
        status: 'partial',
        reason: 'Final answer synthesized from available successful nodes',
        answer: { ...answer, answer: answer.answer + note },
      }
    }
    return { status: 'completed', reason: 'All planned nodes completed successfully', answer }
  }

  const outcome = await finalize()
  options.onEvent?.({ type: 'dag/run-end', runId, status: outcome.status })

  return {
    runId,
    planId: proposal.planId,
    status: outcome.status,
    completionReason: outcome.reason,
    finalAnswer: outcome.answer,
    nodeResults,
    executionResults,
    retryCounts,
    stuckReason,
  }
}
