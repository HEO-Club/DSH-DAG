/**
 * DAG run controller: one run compiles the proposal, then drives
 * dag-core's `runPlan` with sub-agent execution, deterministic validation,
 * optional LLM fusion and observe-only dag/* events.
 */

import {
  createConcurrencyLimits,
  createRetryPolicy,
  NodeResultValidator,
  NodeResultStatus,
  randomHex,
  runPlan,
  TaskGraphCompiler,
} from 'dsh-dag-core'
import type { DagCoreEvent, RunStatus } from 'dsh-dag-core'
import { createFusionExecutor } from './fusion-executor.js'
import { DagEvents } from './events.js'
import { createSubagentNodeExecutor } from './node-executor.js'
import type { DagConfig } from './config.js'
import type { DAGStartRequest, HarnessContext } from './contracts.js'

export interface DAGRunMeta {
  runId: string
  planId: string
  objective: string
  nodeCount: number
  createdAt: string
}

export interface DAGNodeFailure {
  nodeId: string
  status: string
  error: string
}

export interface DAGRunResultData {
  runId: string
  planId: string
  status: RunStatus
  completionReason: string
  /** The fused final answer text. */
  value: string
  nodeCount: number
  /** Sub-agent child runs started (nodes + optional fusion). */
  agentsStarted: number
  failures: DAGNodeFailure[]
  /** Observe-only lifecycle events of this run. */
  events: DagCoreEvent[]
}

/** One holder-owned DAG run. */
export class DAGRun {
  readonly id: string
  readonly meta: DAGRunMeta
  readonly result: Promise<DAGRunResultData>
  private readonly controller: AbortController
  private disposed = false

  constructor(meta: DAGRunMeta, result: Promise<DAGRunResultData>, controller: AbortController) {
    this.id = meta.runId
    this.meta = meta
    this.result = result
    this.controller = controller
  }

  /** Cancel the run: pending nodes are cancelled, children quiesce. */
  cancel(reason?: string): void {
    if (!this.controller.signal.aborted) {
      this.controller.abort(reason ?? 'DAG run cancelled')
    }
  }

  /** Cancel, wait for quiescence and release resources. Idempotent. */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort('DAG run disposed')
    try {
      await this.result
    } catch {
      // contained: the run promise never rejects by contract
    }
  }
}

export interface StartDagRunOptions {
  ctx: HarnessContext
  config: DagConfig
  request: DAGStartRequest
}

/**
 * Compile the proposal and start a DAG run.
 *
 * @throws PlanningError when the proposal fails deterministic validation
 *         (the caller surfaces the structured issues; no run is created).
 */
export function startDagRun(options: StartDagRunOptions): DAGRun {
  const { ctx, config, request } = options
  const proposal = request.proposal
  const controller = new AbortController()
  const runId = request.options?.idempotencyKey
    ? `dag_${request.options.idempotencyKey}`
    : `dag_${randomHex(8)}`

  const plan = new TaskGraphCompiler().compile(proposal)
  const nodeCount = plan.steps.length
  const events: DagCoreEvent[] = []
  let agentsStarted = 0

  const session = config.emitSessionEvents ? request.parent.session : null
  const dagEvents = new DagEvents(ctx, session, config.emitSessionEvents)

  const executor = createSubagentNodeExecutor({
    ctx,
    config,
    runId,
    planId: proposal.planId,
    proposal,
    plan,
    parent: request.parent,
    maxResultChars: config.maxResultChars,
    onAgentStart: () => {
      agentsStarted += 1
    },
  })

  const limits = createConcurrencyLimits({
    globalLimit: request.options?.globalLimit ?? config.globalLimit,
    modelLimits: config.perModelLimits,
  })
  const retryPolicy = createRetryPolicy({
    maxRetries: request.options?.maxRetries ?? config.retryPolicy.maxRetries,
    baseDelaySeconds: config.retryPolicy.baseDelaySeconds,
    maxDelaySeconds: config.retryPolicy.maxDelaySeconds,
  })

  const fusionMode = request.options?.fusion ?? config.fusion
  const llmFuse =
    fusionMode === 'none'
      ? null
      : createFusionExecutor({
          ctx,
          config,
          parent: request.parent,
          onAgentStart: () => {
            agentsStarted += 1
          },
        })

  const objective = proposal.objective
  const resultPromise = runPlan(proposal, {
    runId,
    plan,
    limits,
    retryPolicy,
    nodeTimeoutMs: request.options?.nodeTimeoutMs ?? config.nodeTimeoutSeconds * 1000,
    maxTotalNodes: request.options?.maxTotalNodes ?? config.maxTotalNodes,
    buildRequest: executor.buildRequest,
    executeOne: executor.executeOne,
    validator: new NodeResultValidator(),
    llmFuse,
    fusion: fusionMode,
    signal: controller.signal,
    onEvent: (event) => {
      events.push(event)
      emitDagEvent(dagEvents, event, objective)
    },
  }).then((outcome): DAGRunResultData => {
    const failures = outcome.nodeResults
      .filter((result) => result.status !== NodeResultStatus.SUCCEEDED)
      .map((result) => ({
        nodeId: result.nodeId,
        status: result.status,
        error: result.error?.message ?? result.status,
      }))
    return {
      runId: outcome.runId,
      planId: outcome.planId,
      status: outcome.status,
      completionReason: outcome.completionReason,
      value: outcome.finalAnswer.answer,
      nodeCount,
      agentsStarted,
      failures,
      events: [...events],
    }
  })

  const meta: DAGRunMeta = {
    runId,
    planId: proposal.planId,
    objective: proposal.objective,
    nodeCount,
    createdAt: new Date().toISOString(),
  }
  return new DAGRun(meta, resultPromise, controller)
}

function emitDagEvent(dagEvents: DagEvents, event: DagCoreEvent, objective: string): void {
  switch (event.type) {
    case 'dag/run-start':
      dagEvents.emit('dag/run-start', {
        runId: event.runId,
        planId: event.planId,
        objective,
        nodeCount: event.nodeCount,
      })
      break
    case 'dag/node-start':
      dagEvents.emit('dag/node-start', { runId: event.runId, nodeId: event.nodeId })
      break
    case 'dag/node-end':
      dagEvents.emit('dag/node-end', { runId: event.runId, nodeId: event.nodeId, status: event.status })
      break
    case 'dag/retry':
      dagEvents.emit('dag/retry', { runId: event.runId, nodeId: event.nodeId, attempt: event.attempt })
      break
    case 'dag/run-end':
      dagEvents.emit('dag/run-end', { runId: event.runId, status: event.status, completionReason: '' })
      break
  }
}
