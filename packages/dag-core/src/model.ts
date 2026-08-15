/**
 * Shared execution-plan, model-profile, and result contracts.
 *
 * TypeScript port of the Router's `src/core/models.py` (DAG/result half).
 * Field names are camelCase; semantics and invariants match the Python
 * reference exactly (see docs/dsh-plugin engineering spec §C.2.1).
 */

/** Execution state of one task node. */
export const TaskStatus = {
  PENDING: 'pending',
  READY: 'ready',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  BLOCKED: 'blocked',
  CANCELLED: 'cancelled',
} as const

export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus]

/** Provider-agnostic model descriptor (kept for parity; not used by the plugin). */
export interface ModelProfile {
  modelId: string
  provider: string
  maxTokens: number
  systemPrompt: string
  apiBase: string | null
  apiKeyEnv: string | null
  timeoutSeconds: number | null
  numRetries: number
}

/** A single decomposed sub-task ready for execution. */
export interface Query {
  id: string
  content: string
  skill: string
  required: boolean
  context: Record<string, unknown>
  dependsOn: string[]
  /** Type tag this node requires from upstream node outputs. */
  inputSchema: string | null
  /** Type tag this node produces for downstream consumers. */
  outputSchema: string | null
}

export interface QueryInit {
  id?: string
  content: string
  skill: string
  required?: boolean
  context?: Record<string, unknown>
  dependsOn?: string[]
  inputSchema?: string | null
  outputSchema?: string | null
}

/** Create a Query with the same defaults as the pydantic model. */
export function createQuery(init: QueryInit): Query {
  return {
    id: init.id ?? randomHex(8),
    content: init.content,
    skill: init.skill,
    required: init.required ?? true,
    context: init.context ?? {},
    dependsOn: [...(init.dependsOn ?? [])],
    inputSchema: init.inputSchema ?? null,
    outputSchema: init.outputSchema ?? null,
  }
}

/** One node in the execution DAG (mutable state holder). */
export class PlanStep {
  query: Query
  status: TaskStatus = TaskStatus.PENDING
  result: unknown = null
  error: string | null = null

  constructor(query: Query) {
    this.query = query
  }
}

/** Static scheduling insights for one validated ExecutionPlan. */
export interface ExecutionAnalysis {
  topoLevels: Record<string, number>
  parallelGroups: string[][]
  criticalPath: string[]
  priorities: Record<string, number>
}

export interface ExecutionPlanInit {
  originalTask: string
  steps: PlanStep[]
  revision?: number
  dagEdges?: Array<[string, string]>
  analysis?: ExecutionAnalysis | null
}

/** Full decomposed plan: ordered steps plus dependency graph. */
export class ExecutionPlan {
  originalTask: string
  steps: PlanStep[]
  revision: number
  dagEdges: Array<[string, string]>
  analysis: ExecutionAnalysis | null

  constructor(init: ExecutionPlanInit) {
    this.originalTask = init.originalTask
    this.steps = init.steps
    this.revision = init.revision ?? 1
    this.dagEdges = init.dagEdges ?? []
    this.analysis = init.analysis ?? null
  }

  /** Steps whose dependencies are all satisfied and that are runnable. */
  get readySteps(): PlanStep[] {
    const completedIds = new Set(
      this.steps.filter((s) => s.status === TaskStatus.SUCCEEDED).map((s) => s.query.id),
    )
    return this.steps.filter(
      (s) =>
        (s.status === TaskStatus.PENDING || s.status === TaskStatus.READY) &&
        s.query.dependsOn.every((dep) => completedIds.has(dep)),
    )
  }
}

/** Aggregated result from a single worker call. */
export interface ExecutionResult {
  queryId: string
  modelUsed: string
  content: string
  metadata: Record<string, unknown>
  artifactIds: string[]
  error: string | null
}

export interface ExecutionResultInit {
  queryId: string
  modelUsed: string
  content?: string
  metadata?: Record<string, unknown>
  artifactIds?: string[]
  error?: string | null
}

export function createExecutionResult(init: ExecutionResultInit): ExecutionResult {
  return {
    queryId: init.queryId,
    modelUsed: init.modelUsed,
    content: init.content ?? '',
    metadata: init.metadata ?? {},
    artifactIds: init.artifactIds ?? [],
    error: init.error ?? null,
  }
}

/** Fused final response from all sub-task results. */
export interface FinalAnswer {
  task: string
  answer: string
  subResults: ExecutionResult[]
  /** Query IDs dropped by the deterministic dedup fallback. */
  dedupRemovedNodeIds: string[]
}

export interface FinalAnswerInit {
  task: string
  answer: string
  subResults?: ExecutionResult[]
  dedupRemovedNodeIds?: string[]
}

export function createFinalAnswer(init: FinalAnswerInit): FinalAnswer {
  return {
    task: init.task,
    answer: init.answer,
    subResults: init.subResults ?? [],
    dedupRemovedNodeIds: init.dedupRemovedNodeIds ?? [],
  }
}

const HEX_ALPHABET = '0123456789abcdef'

/** Small dependency-free random hex string generator (used for run/node ids). */
export function randomHex(length: number): string {
  let out = ''
  for (let i = 0; i < length; i += 1) {
    out += HEX_ALPHABET[Math.floor(Math.random() * 16)]
  }
  return out
}
