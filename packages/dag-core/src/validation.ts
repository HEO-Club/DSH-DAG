/**
 * DAG validation — deterministic legality checks for an ExecutionPlan.
 *
 * TypeScript port of the Router's `src/planner/validation.py` (1:1).
 * Field names are camelCase; findings and message text match the Python
 * reference exactly.
 */

import type { ExecutionPlan, Query } from './model.js'

/** Severity of one DAG validation finding. */
export const ValidationSeverity = {
  ERROR: 'error',
  WARNING: 'warning',
} as const

export type ValidationSeverity =
  (typeof ValidationSeverity)[keyof typeof ValidationSeverity]

/** One structured finding from DAG validation. */
export interface ValidationIssue {
  code: string
  message: string
  severity: ValidationSeverity
  nodeIds: string[]
}

/** Structured validation report instead of ad-hoc exceptions. */
export interface ValidationResult {
  valid: boolean
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
  topoOrder: string[]
  nonExecutableNodeIds: string[]
}

/**
 * Check that an ExecutionPlan is legal and executable before scheduling.
 *
 * The dependency graph is derived from each step's `query.dependsOn`,
 * which is the source of truth. Findings are returned as a structured
 * `ValidationResult`; the validator never throws for invalid plans.
 */
export class DAGValidator {
  /** Return the full validation report for `plan`. */
  validate(plan: ExecutionPlan): ValidationResult {
    const errors: ValidationIssue[] = []
    const warnings: ValidationIssue[] = []
    const nonExecutable = new Set<string>()

    const steps = plan.steps
    if (steps.length === 0) {
      errors.push(
        this.issue(
          'empty_plan',
          'ExecutionPlan contains no nodes',
          ValidationSeverity.ERROR,
        ),
      )
      return { valid: false, errors, warnings, topoOrder: [], nonExecutableNodeIds: [] }
    }

    const idCounts = new Map<string, number>()
    for (const step of steps) {
      idCounts.set(step.query.id, (idCounts.get(step.query.id) ?? 0) + 1)
    }
    const duplicatedIds = [...idCounts.entries()]
      .filter(([, count]) => count > 1)
      .map(([id]) => id)
      .sort()
    for (const nodeId of duplicatedIds) {
      errors.push(
        this.issue(
          'duplicate_node_id',
          `Node id '${nodeId}' appears more than once`,
          ValidationSeverity.ERROR,
          [nodeId],
        ),
      )
      nonExecutable.add(nodeId)
    }

    const distinctIds = new Set(idCounts.keys())
    const canonicalQuery = new Map<string, Query>()
    for (const step of steps) {
      if (!canonicalQuery.has(step.query.id)) {
        canonicalQuery.set(step.query.id, step.query)
      }
    }

    // Build valid edges; self-loops stay in the graph so Kahn rejects them.
    const dependents = new Map<string, string[]>()
    const validEdges: Array<[string, string]> = []
    for (const step of steps) {
      const downstream = step.query.id
      for (const depId of step.query.dependsOn) {
        if (!distinctIds.has(depId)) {
          errors.push(
            this.issue(
              'missing_dependency',
              `Node '${downstream}' depends on unknown node '${depId}'`,
              ValidationSeverity.ERROR,
              [downstream, depId],
            ),
          )
          nonExecutable.add(downstream)
          continue
        }
        if (duplicatedIds.includes(depId)) {
          continue // ambiguous target, already reported
        }
        validEdges.push([depId, downstream])
        const list = dependents.get(depId) ?? []
        list.push(downstream)
        dependents.set(depId, list)
      }
    }

    // Schema compatibility: every declared input must match an upstream
    // output tag. An upstream without an output tag cannot be verified.
    for (const step of steps) {
      const query = step.query
      if (query.inputSchema === null) {
        continue
      }
      if (query.dependsOn.length === 0) {
        errors.push(
          this.issue(
            'input_schema_unprovided',
            `Node '${query.id}' requires input '${query.inputSchema}' but has no upstream nodes`,
            ValidationSeverity.ERROR,
            [query.id],
          ),
        )
        continue
      }
      for (const depId of query.dependsOn) {
        if (!distinctIds.has(depId) || duplicatedIds.includes(depId)) {
          continue // reported elsewhere
        }
        const upstream = canonicalQuery.get(depId)
        if (upstream === undefined) {
          continue
        }
        if (upstream.outputSchema === null) {
          warnings.push(
            this.issue(
              'schema_unverified',
              `Node '${query.id}' requires input '${query.inputSchema}' but upstream '${depId}' declares no output schema`,
              ValidationSeverity.WARNING,
              [depId, query.id],
            ),
          )
        } else if (upstream.outputSchema !== query.inputSchema) {
          errors.push(
            this.issue(
              'schema_mismatch',
              `Node '${query.id}' requires input '${query.inputSchema}' but upstream '${depId}' produces '${upstream.outputSchema}'`,
              ValidationSeverity.ERROR,
              [depId, query.id],
            ),
          )
        }
      }
    }

    // Cycle detection and topological order via Kahn's algorithm.
    const inDegree = new Map<string, number>()
    for (const nodeId of distinctIds) {
      inDegree.set(nodeId, 0)
    }
    for (const [, downstream] of validEdges) {
      inDegree.set(downstream, (inDegree.get(downstream) ?? 0) + 1)
    }
    const queue: string[] = [...distinctIds]
      .filter((nodeId) => (inDegree.get(nodeId) ?? 0) === 0)
      .sort()
    let head = 0
    const topoOrder: string[] = []
    while (head < queue.length) {
      const nodeId = queue[head]!
      head += 1
      topoOrder.push(nodeId)
      for (const dependent of [...(dependents.get(nodeId) ?? [])].sort()) {
        inDegree.set(dependent, (inDegree.get(dependent) ?? 0) - 1)
        if (inDegree.get(dependent) === 0) {
          queue.push(dependent)
        }
      }
    }

    const cyclicIds = [...distinctIds]
      .filter((nodeId) => !topoOrder.includes(nodeId))
      .sort()
    if (cyclicIds.length > 0) {
      errors.push(
        this.issue(
          'cycle_detected',
          `DAG contains a cycle involving: ${cyclicIds.join(', ')}`,
          ValidationSeverity.ERROR,
          cyclicIds,
        ),
      )
      for (const nodeId of cyclicIds) {
        nonExecutable.add(nodeId)
      }
    }

    // Isolated nodes: no valid edge in either direction.
    const upstreamIds = new Set(validEdges.map(([upstream]) => upstream))
    const downstreamIds = new Set(validEdges.map(([, downstream]) => downstream))
    if (distinctIds.size > 1) {
      for (const nodeId of [...distinctIds].sort()) {
        if (duplicatedIds.includes(nodeId) || nonExecutable.has(nodeId)) {
          continue // already reported
        }
        if (!upstreamIds.has(nodeId) && !downstreamIds.has(nodeId)) {
          warnings.push(
            this.issue(
              'isolated_node',
              `Node '${nodeId}' has no dependencies and no dependents`,
              ValidationSeverity.WARNING,
              [nodeId],
            ),
          )
        }
      }
    }

    // Final output: an executable sink (node without dependents).
    const sinks = [...distinctIds]
      .sort()
      .filter((nodeId) => !upstreamIds.has(nodeId))
    const executableSinks = sinks.filter((nodeId) => !nonExecutable.has(nodeId))
    if (executableSinks.length === 0) {
      errors.push(
        this.issue(
          'no_valid_final_output',
          'No executable final output node exists',
          ValidationSeverity.ERROR,
          sinks,
        ),
      )
    } else if (
      !executableSinks.some(
        (nodeId) => canonicalQuery.get(nodeId)?.required ?? true,
      )
    ) {
      warnings.push(
        this.issue(
          'no_required_final_output',
          'All final output nodes are optional',
          ValidationSeverity.WARNING,
          executableSinks,
        ),
      )
    }

    // Propagate non-executability along dependency edges: a dependent of a
    // non-executable node cannot run either.
    let changed = true
    while (changed) {
      changed = false
      for (const [upstream, downstream] of validEdges) {
        if (nonExecutable.has(upstream) && !nonExecutable.has(downstream)) {
          nonExecutable.add(downstream)
          changed = true
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      topoOrder: cyclicIds.length > 0 ? [] : topoOrder,
      nonExecutableNodeIds: [...nonExecutable].sort(),
    }
  }

  private issue(
    code: string,
    message: string,
    severity: ValidationSeverity,
    nodeIds?: string[],
  ): ValidationIssue {
    return { code, message, severity, nodeIds: nodeIds ?? [] }
  }
}
