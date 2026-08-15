/**
 * Typed failures raised by the long-task planning boundary.
 *
 * TypeScript port of the Router's `src/planning/errors.py`.
 */

/** Stable categories consumed by later recovery logic. */
export const PlanningErrorCode = {
  EXECUTION_FAILED: 'execution_failed',
  INVALID_OUTPUT: 'invalid_output',
  INVALID_GRAPH: 'invalid_graph',
} as const

export type PlanningErrorCode = (typeof PlanningErrorCode)[keyof typeof PlanningErrorCode]

/** One deterministic or executor-reported planning issue. */
export interface PlanningIssue {
  code: string
  message: string
  nodeIds: string[]
}

export interface PlanningIssueInit {
  code: string
  message: string
  nodeIds?: string[]
}

export function createPlanningIssue(init: PlanningIssueInit): PlanningIssue {
  return {
    code: init.code,
    message: init.message,
    nodeIds: [...(init.nodeIds ?? [])],
  }
}

/** Typed planning failure surfaced for higher-level fallback decisions. */
export class PlanningError extends Error {
  code: PlanningErrorCode
  issues: PlanningIssue[]

  constructor(code: PlanningErrorCode, message: string, issues: PlanningIssue[] = []) {
    super(message)
    this.name = 'PlanningError'
    this.code = code
    this.issues = issues
  }
}
