/**
 * Strict contracts produced by the long-task planner.
 *
 * TypeScript port of the Router's `src/planning/contracts.py`. These are the
 * plugin's *declarative workflow input schema*: the model (or any caller)
 * submits a `TaskGraphProposal`-shaped JSON object; dag-core compiles it into
 * a validated `ExecutionPlan`.
 */

import { ExecutorKind, resolveExecutorKind } from './executor-contracts.js'
import type { PlanningIssue } from './errors.js'
import { createPlanningIssue } from './errors.js'

export const TASK_GRAPH_SCHEMA_VERSION = '1.0'
export const STABLE_ID_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/

/** Planner interpretation of the user's final outcome. */
export interface GoalAnalysis {
  finalGoal: string
  deliverables: string[]
  constraints: string[]
  assumptions: string[]
}

/** Provider-neutral estimate for executing one task node. */
export interface ExecutionEstimate {
  inputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  estimatedDurationSeconds: number
  totalTokens: number
}

export function createExecutionEstimate(
  init: Partial<Omit<ExecutionEstimate, 'totalTokens'>> = {},
): ExecutionEstimate {
  const inputTokens = init.inputTokens ?? 1000
  const outputTokens = init.outputTokens ?? 1000
  return {
    inputTokens,
    outputTokens,
    estimatedCostUsd: init.estimatedCostUsd ?? 0.01,
    estimatedDurationSeconds: init.estimatedDurationSeconds ?? 30,
    totalTokens: inputTokens + outputTokens,
  }
}

/** Executable reduced-scope plan used when primary planning fails. */
export interface FallbackPlan {
  reason: string
  executableSteps: string[]
  degraded: boolean
}

export function createFallbackPlan(init: Partial<FallbackPlan> = {}): FallbackPlan {
  return {
    reason: init.reason ?? 'Execute the original objective as one reduced-scope task',
    executableSteps: init.executableSteps ?? ['Execute the original objective directly'],
    degraded: init.degraded ?? false,
  }
}

/** One upstream node output consumed by a proposed node. */
export interface InputSourceProposal {
  sourceNodeId: string
  purpose: string
}

/** One independently executable node proposed for a task graph. */
export interface TaskNodeProposal {
  nodeId: string
  title: string
  prompt: string
  dependsOn: string[]
  inputSources: InputSourceProposal[]
  capabilityRequirements: string[]
  outputRequirements: string[]
  successCriteria: string[]
  executorKind: ExecutorKind
  toolLabels: string[]
  executorRecommendation: string
  estimate: ExecutionEstimate
  /** Optional model id; absent → the child inherits the provider's default route. */
  model: string | null
}

/** Versioned, LLM-authored proposal for one acyclic task graph. */
export interface TaskGraphProposal {
  schemaVersion: '1.0'
  planId: string
  revision: number
  objective: string
  goalAnalysis: GoalAnalysis | null
  nodes: TaskNodeProposal[]
  fallbackPlan: FallbackPlan
}

/**
 * Deterministic shape validation of a raw proposal object (mirrors the
 * pydantic field validators in `src/planning/contracts.py`). Returns issues
 * with stable codes; never throws. Graph-level checks belong to the compiler.
 */
export function validateProposalShape(proposal: unknown): PlanningIssue[] {
  const issues: PlanningIssue[] = []
  if (proposal === null || typeof proposal !== 'object') {
    return [createPlanningIssue({ code: 'invalid_proposal', message: 'proposal must be an object' })]
  }
  const p = proposal as Record<string, unknown>

  if (p.schemaVersion !== TASK_GRAPH_SCHEMA_VERSION) {
    issues.push(createPlanningIssue({
      code: 'invalid_schema_version',
      message: `schema_version must be "${TASK_GRAPH_SCHEMA_VERSION}"`,
    }))
  }
  if (typeof p.planId !== 'string' || !STABLE_ID_PATTERN.test(p.planId)) {
    issues.push(createPlanningIssue({
      code: 'invalid_plan_id',
      message: 'plan_id must match ^[a-z][a-z0-9_-]{0,63}$',
    }))
  }
  if (typeof p.revision === 'number' && p.revision < 1) {
    issues.push(createPlanningIssue({ code: 'invalid_revision', message: 'revision must be >= 1' }))
  }
  if (typeof p.objective !== 'string' || p.objective.trim() === '') {
    issues.push(createPlanningIssue({ code: 'blank_objective', message: 'objective must not be blank' }))
  }
  if (!Array.isArray(p.nodes) || p.nodes.length === 0) {
    issues.push(createPlanningIssue({ code: 'empty_nodes', message: 'proposal must declare at least one node' }))
    return issues
  }
  for (const rawNode of p.nodes as unknown[]) {
    issues.push(...validateNodeShape(rawNode))
  }
  return issues
}

function validateNodeShape(rawNode: unknown): PlanningIssue[] {
  const issues: PlanningIssue[] = []
  if (rawNode === null || typeof rawNode !== 'object') {
    return [createPlanningIssue({ code: 'invalid_node', message: 'each node must be an object' })]
  }
  const node = rawNode as Record<string, unknown>
  const nodeId = typeof node.nodeId === 'string' ? node.nodeId : '<unknown>'

  if (typeof node.nodeId !== 'string' || !STABLE_ID_PATTERN.test(node.nodeId)) {
    issues.push(createPlanningIssue({
      code: 'invalid_node_id',
      message: `node_id must match ^[a-z][a-z0-9_-]{0,63}$`,
      nodeIds: [nodeId],
    }))
  }
  if (typeof node.title !== 'string' || node.title.trim() === '') {
    issues.push(createPlanningIssue({ code: 'blank_node_title', message: 'node title must not be blank', nodeIds: [nodeId] }))
  }
  if (typeof node.prompt !== 'string' || node.prompt.trim() === '') {
    issues.push(createPlanningIssue({ code: 'blank_node_prompt', message: 'node prompt must not be blank', nodeIds: [nodeId] }))
  }
  for (const field of ['dependsOn', 'inputSources', 'capabilityRequirements', 'outputRequirements', 'successCriteria', 'toolLabels'] as const) {
    if (node[field] !== undefined && !Array.isArray(node[field])) {
      issues.push(createPlanningIssue({
        code: `invalid_${toSnake(field)}`,
        message: `node '${nodeId}' field '${field}' must be an array`,
        nodeIds: [nodeId],
      }))
    }
  }
  if (Array.isArray(node.dependsOn)) {
    for (const dep of node.dependsOn) {
      if (typeof dep !== 'string' || !STABLE_ID_PATTERN.test(dep)) {
        issues.push(createPlanningIssue({
          code: 'invalid_dependency_id',
          message: `dependency ids must use stable lowercase identifiers`,
          nodeIds: [nodeId],
        }))
        break
      }
    }
  }
  for (const field of ['capabilityRequirements', 'outputRequirements', 'successCriteria', 'toolLabels'] as const) {
    const values = node[field] as unknown[] | undefined
    if (Array.isArray(values) && (values.some((v) => typeof v !== 'string' || v.trim() === '') || new Set(values).size !== values.length)) {
      issues.push(createPlanningIssue({
        code: 'invalid_requirement_list',
        message: `requirements and labels must not be blank or duplicated`,
        nodeIds: [nodeId],
      }))
    }
  }
  if (Array.isArray(node.inputSources)) {
    for (const source of node.inputSources) {
      if (source === null || typeof source !== 'object') {
        issues.push(createPlanningIssue({ code: 'invalid_input_source', message: `input sources must be objects`, nodeIds: [nodeId] }))
        continue
      }
      const src = source as Record<string, unknown>
      if (typeof src.sourceNodeId !== 'string' || !STABLE_ID_PATTERN.test(src.sourceNodeId)) {
        issues.push(createPlanningIssue({ code: 'invalid_input_source', message: `input source node ids must match ^[a-z][a-z0-9_-]{0,63}$`, nodeIds: [nodeId] }))
      }
      if (typeof src.purpose !== 'string' || src.purpose.trim() === '') {
        issues.push(createPlanningIssue({ code: 'blank_input_purpose', message: `input source purpose must not be blank`, nodeIds: [nodeId] }))
      }
    }
  }
  if (node.executorKind !== undefined) {
    if (typeof node.executorKind !== 'string') {
      issues.push(createPlanningIssue({ code: 'invalid_executor_kind', message: `executor_kind must be a string`, nodeIds: [nodeId] }))
    } else {
      resolveExecutorKind(node.executorKind) // validates alias mapping
    }
  }
  return issues
}

function toSnake(value: string): string {
  return value.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)
}

/** Normalize a raw node object into a typed TaskNodeProposal (defaults applied). */
export function normalizeTaskNode(rawNode: Record<string, unknown>): TaskNodeProposal {
  const dependsOn = Array.isArray(rawNode.dependsOn) ? (rawNode.dependsOn as string[]) : []
  const inputSources = Array.isArray(rawNode.inputSources)
    ? (rawNode.inputSources as Array<{ sourceNodeId: string; purpose: string }>)
    : []
  const rawEstimate = (rawNode.estimate ?? {}) as Record<string, unknown>
  return {
    nodeId: rawNode.nodeId as string,
    title: rawNode.title as string,
    prompt: rawNode.prompt as string,
    dependsOn,
    inputSources,
    capabilityRequirements: (rawNode.capabilityRequirements as string[]) ?? [],
    outputRequirements: (rawNode.outputRequirements as string[]) ?? [],
    successCriteria: (rawNode.successCriteria as string[]) ?? [],
    executorKind: resolveExecutorKind(rawNode.executorKind as string),
    toolLabels: (rawNode.toolLabels as string[]) ?? [],
    executorRecommendation: (rawNode.executorRecommendation as string) ?? 'Use the declared executor kind',
    model: (rawNode.model as string | null | undefined) ?? null,
    estimate: createExecutionEstimate({
      inputTokens: rawEstimate.inputTokens as number | undefined,
      outputTokens: rawEstimate.outputTokens as number | undefined,
      estimatedCostUsd: rawEstimate.estimatedCostUsd as number | undefined,
      estimatedDurationSeconds: rawEstimate.estimatedDurationSeconds as number | undefined,
    }),
  }
}

/** Normalize a raw proposal object into a typed TaskGraphProposal. */
export function normalizeProposal(raw: Record<string, unknown>): TaskGraphProposal {
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    planId: raw.planId as string,
    revision: (raw.revision as number) ?? 1,
    objective: raw.objective as string,
    goalAnalysis: (raw.goalAnalysis as GoalAnalysis | null) ?? null,
    nodes: ((raw.nodes as Record<string, unknown>[]) ?? []).map(normalizeTaskNode),
    fallbackPlan: createFallbackPlan((raw.fallbackPlan as Partial<FallbackPlan> | undefined) ?? {}),
  }
}

/** Convenience factory for tests and programmatic callers. */
export function createTaskGraphProposal(init: {
  planId: string
  objective: string
  nodes: Array<Partial<TaskNodeProposal> & { nodeId: string; title: string; prompt: string }>
  revision?: number
  goalAnalysis?: GoalAnalysis | null
  fallbackPlan?: FallbackPlan
}): TaskGraphProposal {
  return {
    schemaVersion: TASK_GRAPH_SCHEMA_VERSION,
    planId: init.planId,
    revision: init.revision ?? 1,
    objective: init.objective,
    goalAnalysis: init.goalAnalysis ?? null,
    nodes: init.nodes.map((node) => ({
      nodeId: node.nodeId,
      title: node.title,
      prompt: node.prompt,
      dependsOn: node.dependsOn ?? [],
      inputSources: node.inputSources ?? [],
      capabilityRequirements: node.capabilityRequirements ?? ['general'],
      outputRequirements: node.outputRequirements ?? ['Complete user-facing answer'],
      successCriteria: node.successCriteria ?? ['Answer is complete'],
      executorKind: node.executorKind ?? ExecutorKind.RUNTIME,
      toolLabels: node.toolLabels ?? [],
      executorRecommendation: node.executorRecommendation ?? 'Use the declared executor kind',
      model: node.model ?? null,
      estimate: node.estimate ?? createExecutionEstimate(),
    })),
    fallbackPlan: init.fallbackPlan ?? createFallbackPlan(),
  }
}

/**
 * JSON Schema (draft-07) for the `dag_run` tool parameters — the declarative
 * workflow input contract the model submits.
 */
export const proposalJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['planId', 'objective', 'nodes'],
  properties: {
    schemaVersion: { const: TASK_GRAPH_SCHEMA_VERSION },
    planId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
    revision: { type: 'integer', minimum: 1 },
    objective: { type: 'string', minLength: 1 },
    goalAnalysis: {
      type: 'object',
      additionalProperties: false,
      required: ['finalGoal', 'deliverables'],
      properties: {
        finalGoal: { type: 'string', minLength: 1 },
        deliverables: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        constraints: { type: 'array', items: { type: 'string', minLength: 1 } },
        assumptions: { type: 'array', items: { type: 'string', minLength: 1 } },
      },
    },
    nodes: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['nodeId', 'title', 'prompt', 'capabilityRequirements', 'outputRequirements', 'successCriteria', 'executorKind'],
        properties: {
          nodeId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
          title: { type: 'string', minLength: 1 },
          prompt: { type: 'string', minLength: 1 },
          dependsOn: { type: 'array', items: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' } },
          inputSources: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['sourceNodeId', 'purpose'],
              properties: {
                sourceNodeId: { type: 'string', pattern: '^[a-z][a-z0-9_-]{0,63}$' },
                purpose: { type: 'string', minLength: 1 },
              },
            },
          },
          capabilityRequirements: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          outputRequirements: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          successCriteria: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
          executorKind: { type: 'string', enum: ['direct_llm', 'runtime', 'worker_agent'] },
          model: { type: 'string', minLength: 1 },
          toolLabels: { type: 'array', items: { type: 'string', minLength: 1 } },
          executorRecommendation: { type: 'string', minLength: 1 },
          estimate: {
            type: 'object',
            additionalProperties: false,
            properties: {
              inputTokens: { type: 'integer', minimum: 0 },
              outputTokens: { type: 'integer', minimum: 0 },
              estimatedCostUsd: { type: 'number', minimum: 0 },
              estimatedDurationSeconds: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    },
    fallbackPlan: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: { type: 'string', minLength: 1 },
        executableSteps: { type: 'array', minItems: 1, items: { type: 'string', minLength: 1 } },
        degraded: { type: 'boolean' },
      },
    },
  },
} as const
