/**
 * Node executor adapter: turns one DAG node into one `ctx.subagents` child
 * run. Builds the `NodeExecutionRequest` (injecting bounded dependency
 * outputs/artifacts), executes the node via the configured provider, maps the
 * child's `SubagentResult` to a terminal `NodeResult` with stable error
 * classification, and always disposes the child run.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import {
  createExecutionError,
  createNodeExecutionRequest,
  createNodeResult,
  ExecutionErrorType,
  NodeResultStatus,
} from '@evo-router/dag-core'
import type { ArtifactRef, ExecutionPlan, NodeExecutionRequest, NodeResult, TaskGraphProposal } from '@evo-router/dag-core'
import type { DagConfig } from './config.js'
import type { HarnessContext } from './contracts.js'

export interface NodeExecutorAdapter {
  buildRequest(nodeId: string): NodeExecutionRequest
  executeOne(request: NodeExecutionRequest, signal?: AbortSignal): Promise<NodeResult>
}

export interface SubagentNodeExecutorOptions {
  ctx: HarnessContext
  config: DagConfig
  runId: string
  planId: string
  proposal: TaskGraphProposal
  plan: ExecutionPlan
  parent: Agent
  /** Cap on dependency-output characters; defaults to `config.maxResultChars`. */
  maxResultChars?: number
  /** Called once per started child (for the run's agentsStarted counter). */
  onAgentStart?: () => void
}

export function createSubagentNodeExecutor(options: SubagentNodeExecutorOptions): NodeExecutorAdapter {
  const { ctx, config, runId, planId, proposal, plan, parent } = options
  const maxResultChars = options.maxResultChars ?? config.maxResultChars
  const proposalNodes = new Map(proposal.nodes.map((node) => [node.nodeId, node]))
  const stepById = new Map(plan.steps.map((step) => [step.query.id, step]))

  function buildRequest(nodeId: string): NodeExecutionRequest {
    const node = proposalNodes.get(nodeId)
    if (node === undefined) throw new Error(`dag node '${nodeId}' is not part of the proposal`)
    const dependencyOutputs: Record<string, string> = {}
    const dependencyArtifacts: Record<string, ArtifactRef[]> = {}
    for (const dependencyId of node.dependsOn) {
      const step = stepById.get(dependencyId)
      if (step === undefined) continue
      const value = step.result
      if (Array.isArray(value)) {
        dependencyArtifacts[dependencyId] = value.filter(isArtifactRef)
      } else if (value !== null && value !== undefined) {
        dependencyOutputs[dependencyId] = String(value).slice(0, maxResultChars)
      }
    }
    return createNodeExecutionRequest({
      runId,
      planId,
      nodeId,
      executorKind: node.executorKind,
      prompt: buildNodePrompt(node.prompt, dependencyOutputs),
      modelId: node.model,
      dependencyOutputs,
      dependencyArtifacts,
      allowedTools: node.toolLabels,
      outputRequirements: node.outputRequirements,
      successCriteria: node.successCriteria,
      metadata: {
        title: node.title,
        success_criteria: node.successCriteria,
        output_requirements: node.outputRequirements,
        capability_requirements: node.capabilityRequirements,
      },
    })
  }

  async function executeOne(request: NodeExecutionRequest, signal?: AbortSignal): Promise<NodeResult> {
    const childSignal = signal ?? new AbortController().signal
    const run = await ctx.subagents.start(config.subagentProvider, {
      label: `dag:${request.nodeId}`,
      prompt: [{ type: 'text', text: request.prompt }],
      parent,
      signal: childSignal,
      ...(request.modelId !== null && request.modelId !== undefined ? { agentOptions: { model: request.modelId } } : {}),
    })
    options.onAgentStart?.()
    try {
      return mapSubagentResult(request, await run.result, childSignal)
    } finally {
      await run.dispose()
    }
  }

  return { buildRequest, executeOne }
}

/** Render the node prompt with bounded dependency outputs appended. */
function buildNodePrompt(prompt: string, dependencyOutputs: Record<string, string>): string {
  const entries = Object.entries(dependencyOutputs)
  if (entries.length === 0) return prompt
  const section = entries.map(([nodeId, content]) => `[${nodeId}]\n${content}`).join('\n\n')
  return `${prompt}\n\nDependency outputs:\n${section}`
}

function mapSubagentResult(request: NodeExecutionRequest, result: SubagentResult, signal: AbortSignal): NodeResult {
  const content = result.output
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
  const base = {
    runId: request.runId,
    nodeId: request.nodeId,
    executorKind: request.executorKind,
    modelId: request.modelId,
  }
  switch (result.stopReason) {
    case 'completed':
      return createNodeResult({
        ...base,
        status: NodeResultStatus.SUCCEEDED,
        content,
        structuredOutput: result.structured ?? null,
      })
    case 'aborted': {
      const timedOut = signal.aborted && signal.reason instanceof Error && signal.reason.name === 'TimeoutError'
      return createNodeResult({
        ...base,
        status: timedOut ? NodeResultStatus.TIMED_OUT : NodeResultStatus.CANCELLED,
        error: createExecutionError({
          errorType: timedOut ? ExecutionErrorType.TIMEOUT : ExecutionErrorType.CANCELLED,
          retryable: timedOut,
        }),
      })
    }
    case 'error':
      return createNodeResult({
        ...base,
        status: NodeResultStatus.FAILED,
        error: createExecutionError({ errorType: ExecutionErrorType.PROVIDER_ERROR, retryable: true }),
      })
    case 'max-tokens':
      return createNodeResult({
        ...base,
        status: NodeResultStatus.FAILED,
        error: createExecutionError({ errorType: ExecutionErrorType.MODEL, retryable: true }),
      })
    case 'refusal':
      return createNodeResult({
        ...base,
        status: NodeResultStatus.FAILED,
        error: createExecutionError({ errorType: ExecutionErrorType.INVALID_RESPONSE, retryable: false }),
      })
    default:
      return createNodeResult({
        ...base,
        status: NodeResultStatus.FAILED,
        error: createExecutionError({ errorType: ExecutionErrorType.INTERNAL_ERROR, retryable: false }),
      })
  }
}

function isArtifactRef(value: unknown): value is ArtifactRef {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).artifactId === 'string' &&
    typeof (value as Record<string, unknown>).sha256 === 'string'
  )
}
