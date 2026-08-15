/**
 * The `dag_run` model-facing tool: declarative multi-agent DAG execution.
 *
 * Lifecycle mirrors `dsh-tool-workflow`: proposal validation happens
 * synchronously (structured, model-correctable errors; no run created),
 * `execute` starts a run, awaits its result in `try/finally { dispose }`,
 * bridges `exec.signal` → run cancellation, and non-`completed` statuses
 * surface as errors (never as success).
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  normalizeProposal,
  PlanningError,
  proposalJsonSchema,
  TaskGraphCompiler,
  validateProposalShape,
} from '@evo-router/dag-core'
import type { PlanningIssue } from '@evo-router/dag-core'
import type { DagConfig } from './config.js'
import type { DAGRunController } from './dag-service.js'
import type { DAGRunResultData } from './dag-run.js'
import type { HarnessContext } from './contracts.js'

export const DAG_TOOL_SECTION_ORDER = 150

/** Tool guidance: use only for explicit multi-agent DAG workflows. */
export function dagToolGuidance(toolName: string): string {
  return (
    `You have the ${toolName} tool for declarative, deterministic multi-agent DAG workflows. ` +
    `Use it ONLY when the task genuinely decomposes into several independent or ` +
    `dependency-ordered sub-tasks that should run in parallel and be aggregated. ` +
    `You decide single-agent vs multi-agent: do NOT call ${toolName} for ordinary ` +
    `single-turn work. When you call it, supply the full workflow specification: ` +
    `objective, nodes (each with id, title, prompt, dependsOn, inputSources, ` +
    `outputRequirements, successCriteria, optional model), and optional ` +
    `concurrency/retry/fusion options. Malformed proposals return structured, ` +
    `correctable validation errors without creating a run.`
  )
}

const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    runId: { type: 'string', required: true },
    status: { type: 'string', required: true, enum: ['completed', 'partial', 'failed', 'cancelled'] },
    value: { type: 'string', required: true },
    nodeCount: { type: 'integer', required: true },
    agentsStarted: { type: 'integer', required: true },
    failures: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          nodeId: { type: 'string', required: true },
          status: { type: 'string', required: true },
          error: { type: 'string', required: true },
        },
      },
    },
  },
} as const

/** Register the tool + guidance section; returns the disposer. */
export function registerDagTool(ctx: HarnessContext, config: DagConfig, controller: DAGRunController): () => void {
  const tool = defineTool({
    name: config.toolName,
    description:
      'Deterministically run a multi-agent DAG workflow: you supply the declarative task graph (nodes with dependencies, prompts, success criteria, optional per-node model), the plugin compiles and validates it, schedules ready nodes in parallel under concurrency limits, retries bounded failures, and fuses the successful node results into one final answer. Use only for explicit multi-agent DAG workflows.',
    parameters: {
      proposal: {
        type: 'object',
        required: true,
        additionalProperties: true,
        description:
          'The TaskGraphProposal (JSON): { planId: string, objective: string, nodes: [{ nodeId, title, prompt, dependsOn?: string[], inputSources?: [{sourceNodeId, purpose}], capabilityRequirements: string[], outputRequirements: string[], successCriteria: string[], executorKind?: "direct_llm" | "runtime" | "worker_agent", toolLabels?: string[], model?: string }], options?: { concurrency?, retry?, fusion? } }. Every dependsOn entry must declare a matching inputSources entry. Full schema: ' + JSON.stringify(proposalJsonSchema),
        properties: {
          planId: { type: 'string', required: true },
          objective: { type: 'string', required: true },
          nodes: { type: 'array', required: true },
        },
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `DAG run ${value.runId} finished with status '${value.status}' ` +
            `(${value.nodeCount} nodes, ${value.agentsStarted} agents started).\n${value.value}`,
        },
      ],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const rawProposal = (args as { proposal: unknown }).proposal
      const shapeIssues = validateProposalShape(rawProposal)
      if (shapeIssues.length > 0) {
        throw new Error(renderIssues(`${config.toolName}: proposal shape validation failed`, shapeIssues))
      }
      const proposal = normalizeProposal(rawProposal as Record<string, unknown>)
      // Deterministic graph validation happens before any run is created.
      try {
        new TaskGraphCompiler().compile(proposal)
      } catch (error) {
        if (error instanceof PlanningError) {
          throw new Error(renderIssues(`${config.toolName}: proposal failed deterministic graph validation`, error.issues))
        }
        throw error
      }
      if (exec.agent === undefined) {
        throw new Error(`${config.toolName} requires a calling agent (exec.agent was undefined)`)
      }
      const run = controller.start({ proposal, parent: exec.agent })
      try {
        const outcome = await run.result
        if (outcome.status !== 'completed') {
          throw new Error(
            `dag run ${outcome.runId} ended with status '${outcome.status}': ${outcome.completionReason}\n${outcome.value}`,
          )
        }
        return canonicalOutcome(outcome)
      } finally {
        await run.dispose()
      }
    },
  })
  const disposeTool = ctx.tools.register(tool)
  const disposeSection = ctx.systemPrompt.section({
    name: `tool:${config.toolName}`,
    order: DAG_TOOL_SECTION_ORDER,
    text: dagToolGuidance(config.toolName),
  })
  return () => {
    disposeSection()
    disposeTool()
  }
}

function canonicalOutcome(outcome: DAGRunResultData): {
  runId: string
  status: 'completed' | 'partial' | 'failed' | 'cancelled'
  value: string
  nodeCount: number
  agentsStarted: number
  failures: Array<{ nodeId: string; status: string; error: string }>
} {
  return {
    runId: outcome.runId,
    status: outcome.status,
    value: outcome.value,
    nodeCount: outcome.nodeCount,
    agentsStarted: outcome.agentsStarted,
    failures: outcome.failures,
  }
}

function renderIssues(headline: string, issues: PlanningIssue[]): string {
  const details = issues.map((issue) => `- [${issue.code}] ${issue.message}`).join('\n')
  return `${headline}:\n${details}`
}
