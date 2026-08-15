/**
 * Deterministic validation and atomic commit for scheduling decisions.
 *
 * TypeScript port of the Router's `src/scheduling/contracts.py` (portable
 * contracts) and `src/scheduling/kernel.py` (`DeterministicSchedulingKernel`).
 * The kernel owns every controller-side state transition: it projects only
 * currently runnable nodes, rejects Agent proposals that violate hard
 * concurrency limits, and atomically commits a validated decision to RUNNING
 * on a deep copy of the plan before writing the final statuses back.
 */

import { createQuery, ExecutionPlan, PlanStep, TaskStatus } from './model.js'
import { createConcurrencyLimits } from './async-scheduler.js'
import type { ConcurrencyLimits } from './async-scheduler.js'
import { EventDrivenScheduler } from './event-scheduler.js'
import type { NodeTransition } from './state-machine.js'

/** One currently runnable node exposed to a Scheduler Agent. */
export interface SchedulingCandidate {
  nodeId: string
  priority: number
  modelId: string | null
  dependencyIds: string[]
  metadata: Record<string, unknown>
}

/** Immutable controller-owned facts used for one scheduling decision. */
export interface SchedulingSnapshot {
  runId: string
  goalId: string
  planId: string
  candidates: SchedulingCandidate[]
  globalLimit: number
  modelLimits: Record<string, number>
}

/** Semantic ordering and selection proposed by a Scheduler Agent. */
export interface SchedulingDecision {
  selectedNodeIds: string[]
  reason: string
  confidence: number
}

/** Auditable result of atomically moving selected nodes to RUNNING. */
export interface SchedulingCommit {
  decision: SchedulingDecision
  transitions: NodeTransition[]
}

/** Raised when an Agent proposal violates controller-owned scheduling facts. */
export class SchedulingDecisionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SchedulingDecisionError'
  }
}

/** Validate semantic scheduling advice and own every state transition. */
export class DeterministicSchedulingKernel {
  /** Project only currently runnable nodes and hard concurrency limits. */
  snapshot(
    plan: ExecutionPlan,
    options: {
      runId: string
      goalId: string
      planId: string
      nodeModels?: Record<string, string>
      limits?: ConcurrencyLimits
    },
  ): SchedulingSnapshot {
    const resolvedLimits = options.limits ?? createConcurrencyLimits({})
    const models = options.nodeModels ?? {}
    const priorities = plan.analysis !== null ? plan.analysis.priorities : {}
    const candidates: SchedulingCandidate[] = plan.readySteps.map((step) => ({
      nodeId: step.query.id,
      priority: priorities[step.query.id] ?? 0,
      modelId: models[step.query.id] ?? null,
      dependencyIds: [...step.query.dependsOn],
      metadata: {
        skill: step.query.skill,
        estimate: step.query.context['estimate'],
      },
    }))
    return {
      runId: options.runId,
      goalId: options.goalId,
      planId: options.planId,
      candidates,
      globalLimit: resolvedLimits.globalLimit,
      modelLimits: { ...resolvedLimits.modelLimits },
    }
  }

  /** Reject unknown nodes and concurrency-limit violations. */
  validate(snapshot: SchedulingSnapshot, decision: SchedulingDecision): void {
    const candidates = new Map(snapshot.candidates.map((item) => [item.nodeId, item]))
    const unknown = decision.selectedNodeIds.filter((nodeId) => !candidates.has(nodeId))
    if (unknown.length > 0) {
      throw new SchedulingDecisionError(`scheduler selected nodes that are not ready: ${unknown.join(', ')}`)
    }
    if (snapshot.globalLimit > 0 && decision.selectedNodeIds.length > snapshot.globalLimit) {
      throw new SchedulingDecisionError('scheduler exceeded the global concurrency limit')
    }
    const selectedModels = new Map<string, number>()
    for (const nodeId of decision.selectedNodeIds) {
      const modelId = candidates.get(nodeId)?.modelId ?? null
      if (modelId !== null) {
        selectedModels.set(modelId, (selectedModels.get(modelId) ?? 0) + 1)
      }
    }
    for (const [modelId, count] of selectedModels) {
      const limit = snapshot.modelLimits[modelId] ?? 0
      if (limit > 0 && count > limit) {
        throw new SchedulingDecisionError(`scheduler exceeded concurrency limit for model '${modelId}'`)
      }
    }
  }

  /** Select a deterministic priority-ordered wave within every limit. */
  fallback(snapshot: SchedulingSnapshot): SchedulingDecision {
    const ordered = [...snapshot.candidates].sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority
      if (a.nodeId < b.nodeId) return -1
      if (a.nodeId > b.nodeId) return 1
      return 0
    })
    const selected: string[] = []
    const modelCounts = new Map<string, number>()
    for (const candidate of ordered) {
      if (snapshot.globalLimit > 0 && selected.length >= snapshot.globalLimit) break
      if (candidate.modelId !== null) {
        const modelLimit = snapshot.modelLimits[candidate.modelId] ?? 0
        if (modelLimit > 0 && (modelCounts.get(candidate.modelId) ?? 0) >= modelLimit) continue
      }
      selected.push(candidate.nodeId)
      if (candidate.modelId !== null) {
        modelCounts.set(candidate.modelId, (modelCounts.get(candidate.modelId) ?? 0) + 1)
      }
    }
    if (selected.length === 0) {
      throw new SchedulingDecisionError('no runnable nodes fit the scheduling limits')
    }
    return {
      selectedNodeIds: selected,
      reason: 'deterministic priority and concurrency fallback',
      confidence: 1.0,
    }
  }

  /** Validate then transition every selected node atomically to RUNNING. */
  commit(
    plan: ExecutionPlan,
    decision: SchedulingDecision,
    options: {
      runId: string
      goalId: string
      planId: string
      nodeModels?: Record<string, string>
      limits?: ConcurrencyLimits
    },
  ): SchedulingCommit {
    const snapshot = this.snapshot(plan, {
      runId: options.runId,
      goalId: options.goalId,
      planId: options.planId,
      nodeModels: options.nodeModels,
      limits: options.limits,
    })
    this.validate(snapshot, decision)
    const staged = deepCopyPlan(plan)
    const stagedSteps = new Map(staged.steps.map((step) => [step.query.id, step]))
    const scheduler = new EventDrivenScheduler()
    scheduler.bind(staged)
    for (const nodeId of decision.selectedNodeIds) {
      const stagedStep = stagedSteps.get(nodeId)
      if (stagedStep !== undefined && stagedStep.status === TaskStatus.PENDING) {
        scheduler.ready(nodeId, 'selected by Scheduler Agent')
      }
      scheduler.start(nodeId)
    }

    const originalSteps = new Map(plan.steps.map((step) => [step.query.id, step]))
    for (const nodeId of decision.selectedNodeIds) {
      const original = originalSteps.get(nodeId)
      const stagedStep = stagedSteps.get(nodeId)
      if (original !== undefined && stagedStep !== undefined) {
        original.status = stagedStep.status
      }
    }
    return {
      decision,
      transitions: scheduler.history,
    }
  }
}

/** Deep copy of a plan (mirrors ``model_copy(deep=True)`` in kernel.commit). */
function deepCopyPlan(plan: ExecutionPlan): ExecutionPlan {
  const steps = plan.steps.map((step) => {
    const copy = new PlanStep(
      createQuery({
        id: step.query.id,
        content: step.query.content,
        skill: step.query.skill,
        required: step.query.required,
        context: { ...step.query.context },
        dependsOn: [...step.query.dependsOn],
        inputSchema: step.query.inputSchema,
        outputSchema: step.query.outputSchema,
      }),
    )
    copy.status = step.status
    copy.result = step.result
    copy.error = step.error
    return copy
  })
  return new ExecutionPlan({
    originalTask: plan.originalTask,
    steps,
    revision: plan.revision,
    dagEdges: plan.dagEdges.map((edge) => [edge[0], edge[1]] as [string, string]),
    analysis:
      plan.analysis === null
        ? null
        : {
            topoLevels: { ...plan.analysis.topoLevels },
            parallelGroups: plan.analysis.parallelGroups.map((group) => [...group]),
            criticalPath: [...plan.analysis.criticalPath],
            priorities: { ...plan.analysis.priorities },
          },
  })
}
