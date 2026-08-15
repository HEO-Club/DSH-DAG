/**
 * Typed contracts shared by node executors and their callers.
 *
 * TypeScript port of the Router's `src/executor/contracts.py`. The Router-only
 * coupling to `ModelCallPurpose` and `RequestAttachment` is dropped; the two
 * extension slots (`callPurpose`, `attachments`) stay optional and are never
 * interpreted by dag-core.
 */

/** Supported node execution strategies. */
export const ExecutorKind = {
  DIRECT_LLM: 'direct_llm',
  RUNTIME: 'runtime',
  WORKER_AGENT: 'runtime',
} as const

export type ExecutorKind = (typeof ExecutorKind)[keyof typeof ExecutorKind]

/**
 * Resolve a raw string to an ExecutorKind. Mirrors the Python enum's
 * `_missing_` alias: `'worker_agent'` maps to `RUNTIME`.
 */
export function resolveExecutorKind(value: string): ExecutorKind {
  if (value === 'worker_agent') return ExecutorKind.RUNTIME
  if (value === 'runtime') return ExecutorKind.RUNTIME
  if (value === 'direct_llm') return ExecutorKind.DIRECT_LLM
  return ExecutorKind.RUNTIME
}

/** Terminal outcome of one node execution attempt. */
export const NodeResultStatus = {
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  TIMED_OUT: 'timed_out',
  CANCELLED: 'cancelled',
} as const

export type NodeResultStatus = (typeof NodeResultStatus)[keyof typeof NodeResultStatus]

/** Stable error categories used by recovery policies. */
export const ExecutionErrorType = {
  INVALID_REQUEST: 'invalid_request',
  EXECUTOR_UNAVAILABLE: 'executor_unavailable',
  PROVIDER_ERROR: 'provider_error',
  INVALID_RESPONSE: 'invalid_response',
  TIMEOUT: 'timeout',
  CANCELLED: 'cancelled',
  INTERNAL_ERROR: 'internal_error',
  MODEL: 'model',
  NETWORK: 'network',
  RATE_LIMIT: 'rate_limit',
  TOOL: 'tool',
  RUNTIME: 'runtime',
  WORKER_AGENT: 'runtime',
  DAG: 'dag',
  VALIDATION: 'validation',
  BUDGET: 'budget',
  PERMISSION: 'permission',
  IDEMPOTENCY: 'idempotency',
  ARTIFACT: 'artifact',
} as const

export type ExecutionErrorType = (typeof ExecutionErrorType)[keyof typeof ExecutionErrorType]

/** Stable non-secret message for an external failure category. */
const PUBLIC_ERROR_MESSAGES: Record<ExecutionErrorType, string> = {
  [ExecutionErrorType.INVALID_REQUEST]: 'execution request is invalid',
  [ExecutionErrorType.EXECUTOR_UNAVAILABLE]: 'executor is unavailable',
  [ExecutionErrorType.PROVIDER_ERROR]: 'model provider call failed',
  [ExecutionErrorType.INVALID_RESPONSE]: 'executor returned an invalid response',
  [ExecutionErrorType.TIMEOUT]: 'node execution timed out',
  [ExecutionErrorType.CANCELLED]: 'node execution was cancelled',
  [ExecutionErrorType.INTERNAL_ERROR]: 'executor failed unexpectedly',
  [ExecutionErrorType.MODEL]: 'model execution failed',
  [ExecutionErrorType.NETWORK]: 'network request failed',
  [ExecutionErrorType.RATE_LIMIT]: 'provider rate limit was reached',
  [ExecutionErrorType.TOOL]: 'tool execution failed',
  [ExecutionErrorType.RUNTIME]: 'runtime execution failed',
  [ExecutionErrorType.DAG]: 'task graph operation failed',
  [ExecutionErrorType.VALIDATION]: 'node result validation failed',
  [ExecutionErrorType.BUDGET]: 'execution budget denied the request',
  [ExecutionErrorType.PERMISSION]: 'execution was denied by permission policy',
  [ExecutionErrorType.IDEMPOTENCY]: 'execution attempt persistence failed',
  [ExecutionErrorType.ARTIFACT]: 'artifact processing failed',
}

export function publicErrorMessage(errorType: ExecutionErrorType): string {
  return PUBLIC_ERROR_MESSAGES[errorType]
}

/** Stable, content-verifiable reference to a durable node artifact. */
export const ArtifactKind = {
  TEXT: 'text',
  JSON: 'json',
  FILE: 'file',
} as const

export type ArtifactKind = (typeof ArtifactKind)[keyof typeof ArtifactKind]

export interface ArtifactRef {
  artifactId: string
  kind: ArtifactKind
  name: string
  mediaType: string
  sizeBytes: number
  sha256: string
  summary: string
}

export interface ArtifactRefInit {
  artifactId: string
  kind: ArtifactKind
  name: string
  mediaType: string
  sizeBytes: number
  sha256: string
  summary?: string
}

export function createArtifactRef(init: ArtifactRefInit): ArtifactRef {
  return {
    artifactId: init.artifactId,
    kind: init.kind,
    name: init.name,
    mediaType: init.mediaType,
    sizeBytes: init.sizeBytes,
    sha256: init.sha256,
    summary: init.summary ?? '',
  }
}

/** Structured, serializable failure returned by an executor. */
export interface ExecutionError {
  errorType: ExecutionErrorType
  message: string
  retryable: boolean
  code: string | null
  details: Record<string, unknown>
}

export interface ExecutionErrorInit {
  errorType: ExecutionErrorType
  message?: string
  retryable?: boolean
  code?: string | null
  details?: Record<string, unknown>
}

export function createExecutionError(init: ExecutionErrorInit): ExecutionError {
  return {
    errorType: init.errorType,
    message: init.message ?? publicErrorMessage(init.errorType),
    retryable: init.retryable ?? false,
    code: init.code ?? null,
    details: init.details ?? {},
  }
}

/**
 * Classify an exception without retaining its message or traceback.
 * Mirrors `ExecutionError.from_exception`.
 */
export function executionErrorFromException(options: {
  errorType: ExecutionErrorType
  retryable: boolean
  code?: string | null
}): ExecutionError {
  return createExecutionError({
    errorType: options.errorType,
    retryable: options.retryable,
    code: options.code ?? null,
  })
}

/** Complete input required to execute one task-graph node. */
export interface NodeExecutionRequest {
  runId: string
  nodeId: string
  executorKind: ExecutorKind
  prompt: string
  idempotencyKey: string | null
  goalId: string | null
  planId: string | null
  modelId: string | null
  deploymentId: string | null
  dependencyOutputs: Record<string, string>
  dependencyArtifacts: Record<string, ArtifactRef[]>
  allowedTools: string[]
  outputRequirements: string[]
  successCriteria: string[]
  expectedOutputSchema: Record<string, unknown> | null
  metadata: Record<string, unknown>
  /** Optional extension slot (Router-only `call_purpose` decoupled). */
  callPurpose?: string | null
  /** Optional extension slot (Router-only attachments decoupled). */
  attachments?: unknown[]
}

export interface NodeExecutionRequestInit {
  runId: string
  nodeId: string
  executorKind: ExecutorKind
  prompt: string
  idempotencyKey?: string | null
  goalId?: string | null
  planId?: string | null
  modelId?: string | null
  deploymentId?: string | null
  dependencyOutputs?: Record<string, string>
  dependencyArtifacts?: Record<string, ArtifactRef[]>
  allowedTools?: string[]
  outputRequirements?: string[]
  successCriteria?: string[]
  expectedOutputSchema?: Record<string, unknown> | null
  metadata?: Record<string, unknown>
  callPurpose?: string | null
  attachments?: unknown[]
}

/** Create a NodeExecutionRequest with defaults and deduped requirement lists. */
export function createNodeExecutionRequest(init: NodeExecutionRequestInit): NodeExecutionRequest {
  return {
    runId: init.runId,
    nodeId: init.nodeId,
    executorKind: init.executorKind,
    prompt: init.prompt,
    idempotencyKey: init.idempotencyKey ?? null,
    goalId: init.goalId ?? null,
    planId: init.planId ?? null,
    modelId: init.modelId ?? null,
    deploymentId: init.deploymentId ?? null,
    dependencyOutputs: init.dependencyOutputs ?? {},
    dependencyArtifacts: init.dependencyArtifacts ?? {},
    allowedTools: [...(init.allowedTools ?? [])],
    outputRequirements: dedupeRequirements(init.outputRequirements ?? []),
    successCriteria: dedupeRequirements(init.successCriteria ?? []),
    expectedOutputSchema: init.expectedOutputSchema ?? null,
    metadata: init.metadata ?? {},
    callPurpose: init.callPurpose ?? null,
    attachments: init.attachments,
  }
}

/** Reject blanks and remove duplicates while retaining source order. */
function dedupeRequirements(values: string[]): string[] {
  if (values.some((value) => value.trim() === '')) {
    throw new Error('requirements must not be blank')
  }
  return [...new Set(values)]
}

/** Terminal, executor-independent result for one node attempt. */
export interface NodeResult {
  runId: string
  nodeId: string
  executorKind: ExecutorKind
  status: NodeResultStatus
  content: string
  structuredOutput: unknown
  modelId: string | null
  durationMs: number
  metadata: Record<string, unknown>
  artifacts: ArtifactRef[]
  error: ExecutionError | null
}

export interface NodeResultInit {
  runId: string
  nodeId: string
  executorKind: ExecutorKind
  status: NodeResultStatus
  content?: string
  structuredOutput?: unknown
  modelId?: string | null
  durationMs?: number
  metadata?: Record<string, unknown>
  artifacts?: ArtifactRef[]
  error?: ExecutionError | null
}

/**
 * Create a NodeResult and enforce the terminal-outcome invariant:
 * success ⇒ no error; failure ⇒ error required (mirrors pydantic
 * `model_validator(mode="after")`).
 */
export function createNodeResult(init: NodeResultInit): NodeResult {
  const succeeded = init.status === NodeResultStatus.SUCCEEDED
  const error = init.error ?? null
  if (succeeded && error !== null) {
    throw new Error('successful node result cannot contain an error')
  }
  if (!succeeded && error === null) {
    throw new Error('unsuccessful node result must contain an error')
  }
  return {
    runId: init.runId,
    nodeId: init.nodeId,
    executorKind: init.executorKind,
    status: init.status,
    content: init.content ?? '',
    structuredOutput: init.structuredOutput ?? null,
    modelId: init.modelId ?? null,
    durationMs: init.durationMs ?? 0,
    metadata: init.metadata ?? {},
    artifacts: init.artifacts ?? [],
    error,
  }
}

/** Copy a NodeResult with selective field updates (mirrors `model_copy(update=...)`). */
export function nodeResultWith(result: NodeResult, update: Partial<NodeResultInit>): NodeResult {
  return createNodeResult({
    runId: update.runId ?? result.runId,
    nodeId: update.nodeId ?? result.nodeId,
    executorKind: update.executorKind ?? result.executorKind,
    status: update.status ?? result.status,
    content: update.content ?? result.content,
    structuredOutput: update.structuredOutput !== undefined ? update.structuredOutput : result.structuredOutput,
    modelId: update.modelId !== undefined ? update.modelId : result.modelId,
    durationMs: update.durationMs ?? result.durationMs,
    metadata: update.metadata ?? result.metadata,
    artifacts: update.artifacts ?? result.artifacts,
    error: update.error !== undefined ? update.error : result.error,
  })
}
