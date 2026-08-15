/**
 * Deterministic validation and compilation of task-graph proposals.
 *
 * TypeScript port of the Router's `src/planning/graph.py` (`TaskGraphCompiler`).
 * `compile()` runs input-source checks, `DAGValidator`, topological reordering
 * and `DAGAnalyzer`, raising a `PlanningError(INVALID_GRAPH, issues)` on any
 * deterministic failure.
 */

import { createQuery, ExecutionPlan, PlanStep } from './model.js'
import type { TaskGraphProposal } from './proposal.js'
import { PlanningError, PlanningErrorCode } from './errors.js'
import type { PlanningIssue } from './errors.js'
import { createPlanningIssue } from './errors.js'
import { DAGValidator } from './validation.js'
import { DAGAnalyzer } from './analysis.js'

export class TaskGraphCompiler {
  private readonly _validator: DAGValidator
  private readonly _analyzer: DAGAnalyzer

  constructor(options: { validator?: DAGValidator; analyzer?: DAGAnalyzer } = {}) {
    this._validator = options.validator ?? new DAGValidator()
    this._analyzer = options.analyzer ?? new DAGAnalyzer()
  }

  /** Return a validated, topologically ordered and analyzed plan. */
  compile(proposal: TaskGraphProposal): ExecutionPlan {
    const plan = this._toExecutionPlan(proposal)
    const inputIssues = this._validateInputSources(proposal)
    const validation = this._validator.validate(plan)
    const dagIssues: PlanningIssue[] = validation.errors.map((issue) =>
      createPlanningIssue({ code: issue.code, message: issue.message, nodeIds: issue.nodeIds }),
    )
    const issues = [...inputIssues, ...dagIssues]
    if (issues.length > 0) {
      throw new PlanningError(
        PlanningErrorCode.INVALID_GRAPH,
        'task graph proposal failed deterministic validation',
        issues,
      )
    }

    const stepById = new Map(plan.steps.map((step) => [step.query.id, step]))
    const orderedPlan = new ExecutionPlan({
      originalTask: proposal.objective,
      steps: validation.topoOrder.map((nodeId) => {
        const step = stepById.get(nodeId)
        if (step === undefined) {
          throw new PlanningError(
            PlanningErrorCode.INVALID_GRAPH,
            `topological order references unknown node '${nodeId}'`,
          )
        }
        return step
      }),
      revision: proposal.revision,
      dagEdges: plan.dagEdges,
    })
    try {
      orderedPlan.analysis = this._analyzer.analyze(orderedPlan)
    } catch (error) {
      throw new PlanningError(
        PlanningErrorCode.INVALID_GRAPH,
        'validated task graph could not be analyzed',
        [createPlanningIssue({ code: 'analysis_failed', message: 'validated task graph analysis failed' })],
      )
    }
    return orderedPlan
  }

  private _toExecutionPlan(proposal: TaskGraphProposal): ExecutionPlan {
    const queries = proposal.nodes.map((node) =>
      createQuery({
        id: node.nodeId,
        content: node.prompt,
        skill: node.capabilityRequirements[0] ?? '',
        dependsOn: [...node.dependsOn],
        context: {
          title: node.title,
          input_sources: node.inputSources,
          capability_requirements: [...node.capabilityRequirements],
          output_requirements: [...node.outputRequirements],
          success_criteria: [...node.successCriteria],
          executor_kind: node.executorKind,
          tool_labels: [...node.toolLabels],
          executor_recommendation: node.executorRecommendation,
          estimate: { ...node.estimate, total_tokens: node.estimate.totalTokens },
        },
      }),
    )
    return new ExecutionPlan({
      originalTask: proposal.objective,
      steps: queries.map((query) => new PlanStep(query)),
      revision: proposal.revision,
      dagEdges: proposal.nodes.flatMap((node) =>
        node.dependsOn.map((dependencyId) => [dependencyId, node.nodeId] as [string, string]),
      ),
    })
  }

  private _validateInputSources(proposal: TaskGraphProposal): PlanningIssue[] {
    const issues: PlanningIssue[] = []
    const knownIds = new Set(proposal.nodes.map((node) => node.nodeId))
    for (const node of proposal.nodes) {
      issues.push(...this._nodeInputIssues(node, knownIds))
    }
    return issues
  }

  private _nodeInputIssues(
    node: TaskGraphProposal['nodes'][number],
    knownIds: Set<string>,
  ): PlanningIssue[] {
    const issues: PlanningIssue[] = []
    const dependencyCounts = countById(node.dependsOn)
    const sourceIds = node.inputSources.map((source) => source.sourceNodeId)
    const sourceCounts = countById(sourceIds)

    for (const [dependencyId, count] of sortedEntries(dependencyCounts)) {
      if (count > 1) {
        issues.push(createPlanningIssue({
          code: 'duplicate_dependency',
          message: `Node '${node.nodeId}' declares dependency '${dependencyId}' more than once`,
          nodeIds: [node.nodeId, dependencyId],
        }))
      }
    }
    for (const [sourceId, count] of sortedEntries(sourceCounts)) {
      if (count > 1) {
        issues.push(createPlanningIssue({
          code: 'duplicate_input_source',
          message: `Node '${node.nodeId}' declares input source '${sourceId}' more than once`,
          nodeIds: [node.nodeId, sourceId],
        }))
      }
      if (!knownIds.has(sourceId)) {
        issues.push(createPlanningIssue({
          code: 'unknown_input_source',
          message: `Node '${node.nodeId}' references unknown input source '${sourceId}'`,
          nodeIds: [node.nodeId, sourceId],
        }))
      }
    }

    const dependencyIds = new Set(node.dependsOn)
    const distinctSourceIds = new Set(sourceIds)
    for (const dependencyId of [...dependencyIds].sort()) {
      if (!distinctSourceIds.has(dependencyId)) {
        issues.push(createPlanningIssue({
          code: 'missing_input_source',
          message: `Node '${node.nodeId}' depends on '${dependencyId}' but does not declare how its output is consumed`,
          nodeIds: [node.nodeId, dependencyId],
        }))
      }
    }
    for (const sourceId of [...distinctSourceIds].sort()) {
      if (!dependencyIds.has(sourceId)) {
        issues.push(createPlanningIssue({
          code: 'undeclared_input_dependency',
          message: `Node '${node.nodeId}' consumes '${sourceId}' without declaring it as a dependency`,
          nodeIds: [node.nodeId, sourceId],
        }))
      }
    }
    return issues
  }
}

function countById(values: string[]): Map<string, number> {
  const counts = new Map<string, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

function sortedEntries(counts: Map<string, number>): Array<[string, number]> {
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
}
