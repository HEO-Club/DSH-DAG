/**
 * Centralized TaskNode state machine with validated transitions.
 *
 * TypeScript port of the Router's `src/planner/state_machine.py` (1:1).
 */

import { TaskStatus } from './model.js'
import type { PlanStep } from './model.js'

/** Raised when a node transition is not allowed by the state machine. */
export class NodeTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NodeTransitionError'
  }
}

/** Auditable record of one validated node state transition. */
export interface NodeTransition {
  nodeId: string
  fromStatus: TaskStatus
  toStatus: TaskStatus
  reason: string
  occurredAt: string
}

export function createNodeTransition(init: {
  nodeId: string
  fromStatus: TaskStatus
  toStatus: TaskStatus
  reason?: string
}): NodeTransition {
  return {
    nodeId: init.nodeId,
    fromStatus: init.fromStatus,
    toStatus: init.toStatus,
    reason: init.reason ?? '',
    occurredAt: new Date().toISOString(),
  }
}

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.SUCCEEDED,
  TaskStatus.FAILED,
  TaskStatus.CANCELLED,
])

export const SUCCESS_STATUSES: ReadonlySet<TaskStatus> = new Set([TaskStatus.SUCCEEDED])

export const TRANSITION_RULES: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  [TaskStatus.PENDING]: new Set([TaskStatus.READY, TaskStatus.BLOCKED, TaskStatus.CANCELLED]),
  [TaskStatus.READY]: new Set([TaskStatus.RUNNING, TaskStatus.CANCELLED]),
  [TaskStatus.RUNNING]: new Set([TaskStatus.SUCCEEDED, TaskStatus.FAILED, TaskStatus.CANCELLED]),
  [TaskStatus.SUCCEEDED]: new Set(),
  [TaskStatus.FAILED]: new Set(),
  [TaskStatus.BLOCKED]: new Set([TaskStatus.CANCELLED]),
  [TaskStatus.CANCELLED]: new Set(),
}

/** Return whether the state machine allows one transition. */
export function canTransition(fromStatus: TaskStatus, toStatus: TaskStatus): boolean {
  return TRANSITION_RULES[fromStatus].has(toStatus)
}

/**
 * Validate and apply one node state transition (mutates `step.status`).
 *
 * @throws NodeTransitionError when the transition is not allowed.
 */
export function transition(
  step: PlanStep,
  toStatus: TaskStatus,
  reason?: string,
): NodeTransition {
  const fromStatus = step.status
  const allowed = TRANSITION_RULES[fromStatus]
  if (!allowed.has(toStatus)) {
    throw new NodeTransitionError(
      `illegal node transition '${fromStatus}' -> '${toStatus}' for node '${step.query.id}'`,
    )
  }
  step.status = toStatus
  return createNodeTransition({
    nodeId: step.query.id,
    fromStatus,
    toStatus,
    reason: reason ?? '',
  })
}
