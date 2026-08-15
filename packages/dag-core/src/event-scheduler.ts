/**
 * Event-driven scheduler with DAG dependency propagation.
 *
 * TypeScript port of the Router's `src/planner/scheduler.py` (1:1). The
 * scheduler never keeps a ready queue and never scans the whole plan to find
 * runnable nodes; it reacts to node terminal-state events, inspects only the
 * affected downstream nodes, and transitions them PENDING -> READY (all
 * dependencies satisfied) or PENDING -> BLOCKED (a dependency failed or was
 * cancelled).
 */

import { ExecutionPlan, PlanStep, TaskStatus } from './model.js'
import type { NodeTransition } from './state-machine.js'
import { SUCCESS_STATUSES, TERMINAL_STATUSES, NodeTransitionError, transition } from './state-machine.js'

/** Terminal outcomes that block downstream PENDING nodes. */
const FAILURE_STATUSES: ReadonlySet<TaskStatus> = new Set([
  TaskStatus.FAILED,
  TaskStatus.BLOCKED,
  TaskStatus.CANCELLED,
])

/** Propagate node terminal events through the plan dependency graph. */
export class EventDrivenScheduler {
  private _plan: ExecutionPlan | null = null
  private _steps: Record<string, PlanStep> = {}
  private _parents: Record<string, string[]> = {}
  private _children: Record<string, string[]> = {}
  private _history: NodeTransition[] = []

  /** Attach one plan and build the parent/child dependency index. */
  bind(plan: ExecutionPlan): void {
    this._plan = plan
    this._steps = {}
    for (const step of plan.steps) {
      this._steps[step.query.id] = step
    }
    this._parents = {}
    this._children = {}
    for (const step of plan.steps) {
      for (const depId of step.query.dependsOn) {
        if (this._steps[depId] === undefined) {
          throw new Error(`node '${step.query.id}' depends on unknown node '${depId}'`)
        }
        const parents = this._parents[step.query.id] ?? []
        parents.push(depId)
        this._parents[step.query.id] = parents
        const children = this._children[depId] ?? []
        children.push(step.query.id)
        this._children[depId] = children
      }
    }
    this._history = []
  }

  /**
   * Transition root nodes (no dependencies) PENDING -> READY.
   *
   * This is the one-time start of the event flow, not a periodic scan.
   */
  activate(): string[] {
    const readyIds: string[] = []
    for (const nodeId of Object.keys(this._steps)) {
      const step = this._steps[nodeId]
      if (step === undefined) continue
      const parents = this._parents[nodeId] ?? []
      if (parents.length === 0 && step.status === TaskStatus.PENDING) {
        this._transition(nodeId, TaskStatus.READY, 'root node has no dependencies')
        readyIds.push(nodeId)
      }
    }
    return readyIds
  }

  /** Transition one pending node PENDING -> READY before execution. */
  ready(nodeId: string, reason = 'node is runnable'): NodeTransition {
    this._require(nodeId)
    return this._transition(nodeId, TaskStatus.READY, reason)
  }

  /** Transition one ready node READY -> RUNNING before execution. */
  start(nodeId: string): NodeTransition {
    this._require(nodeId)
    return this._transition(nodeId, TaskStatus.RUNNING, 'dispatched for execution')
  }

  /**
   * Handle one node reaching a terminal status and propagate.
   *
   * @param nodeId The node that finished.
   * @param status Its terminal outcome (SUCCEEDED, FAILED or CANCELLED).
   * @returns Ids of downstream nodes that newly became READY.
   * @throws NodeTransitionError if the status is not terminal, the node is
   *         already terminal with a different status, or the transition is
   *         illegal.
   */
  notify(nodeId: string, status: TaskStatus): string[] {
    const step = this._require(nodeId)
    if (!TERMINAL_STATUSES.has(status)) {
      throw new NodeTransitionError(`notify expects a terminal status, got '${status}'`)
    }
    if (TERMINAL_STATUSES.has(step.status)) {
      if (step.status !== status) {
        throw new NodeTransitionError(`node '${nodeId}' is already terminal at '${step.status}'`)
      }
      return []
    }
    this._transition(nodeId, status, `node finished as ${status}`)
    return this._propagate(nodeId)
  }

  /** Cancel one non-terminal node and propagate the cancellation. */
  cancel(nodeId: string, reason = 'cancelled'): string[] {
    const step = this._require(nodeId)
    if (TERMINAL_STATUSES.has(step.status)) {
      throw new NodeTransitionError(`node '${nodeId}' is terminal and cannot be cancelled`)
    }
    this._transition(nodeId, TaskStatus.CANCELLED, reason)
    return this._propagate(nodeId)
  }

  /** Return the current state of one bound node. */
  statusOf(nodeId: string): TaskStatus {
    return this._require(nodeId).status
  }

  /** Auditable transitions recorded since the last bind. */
  get history(): NodeTransition[] {
    return [...this._history]
  }

  /** Inspect only the direct downstream of ``nodeId`` and its blocked
   * descendants, returning newly ready node ids. */
  private _propagate(nodeId: string): string[] {
    const readyIds: string[] = []
    const frontier: string[] = [nodeId]
    const visited = new Set<string>()
    while (frontier.length > 0) {
      const current = frontier.pop()
      if (current === undefined || visited.has(current)) continue
      visited.add(current)
      const children = this._children[current] ?? []
      for (const childId of children) {
        const outcome = this._evaluate(childId)
        if (outcome === TaskStatus.READY) {
          this._transition(childId, TaskStatus.READY, `all dependencies of '${childId}' are satisfied`)
          readyIds.push(childId)
        } else if (outcome === TaskStatus.BLOCKED) {
          this._transition(childId, TaskStatus.BLOCKED, `a dependency of '${childId}' did not succeed`)
          frontier.push(childId)
        }
      }
    }
    return readyIds
  }

  /** Classify one pending node based only on its parents' states. */
  private _evaluate(nodeId: string): TaskStatus | null {
    const step = this._steps[nodeId]
    if (step === undefined || step.status !== TaskStatus.PENDING) return null
    const parentSteps = (this._parents[nodeId] ?? []).map((parent) => this._steps[parent])
    if (parentSteps.every((parent) => parent !== undefined && SUCCESS_STATUSES.has(parent.status))) {
      return TaskStatus.READY
    }
    if (parentSteps.some((parent) => parent !== undefined && FAILURE_STATUSES.has(parent.status))) {
      return TaskStatus.BLOCKED
    }
    return null
  }

  private _transition(nodeId: string, toStatus: TaskStatus, reason: string): NodeTransition {
    const record = transition(this._require(nodeId), toStatus, reason)
    this._history.push(record)
    return record
  }

  private _require(nodeId: string): PlanStep {
    const step = this._steps[nodeId]
    if (step === undefined) {
      throw new Error(`node '${nodeId}' is not bound to this scheduler`)
    }
    return step
  }
}
