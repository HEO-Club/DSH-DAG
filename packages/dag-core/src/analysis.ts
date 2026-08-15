/**
 * Execution analysis for a validated DAG — levels, parallelism, critical path.
 *
 * TypeScript port of the Router's `src/planner/analysis.py` (1:1).
 * Field names are camelCase; semantics, error messages and analysis values
 * match the Python reference exactly.
 */

import type { ExecutionAnalysis, ExecutionPlan, Query } from './model.js'

/**
 * Compute topological levels, parallel groups, the critical path and
 * default priorities for an acyclic plan.
 *
 * Every node contributes one unit of duration. Lower priority values mean
 * higher execution priority: nodes on the critical path receive priority 1.
 */
export class DAGAnalyzer {
  /**
   * Return the execution analysis for a validated acyclic plan.
   *
   * @throws Error If the plan is empty, contains duplicate ids, references
   *   unknown dependencies, or contains a cycle.
   */
  analyze(plan: ExecutionPlan): ExecutionAnalysis {
    const steps = plan.steps
    if (steps.length === 0) {
      throw new Error('ExecutionAnalysis requires at least one node')
    }

    const nodeIds = steps.map((step) => step.query.id)
    if (new Set(nodeIds).size !== nodeIds.length) {
      throw new Error('ExecutionAnalysis requires unique node ids')
    }
    const distinctIds = new Set(nodeIds)
    const idToQuery = new Map<string, Query>()
    for (const step of steps) {
      idToQuery.set(step.query.id, step.query)
    }

    const dependents = new Map<string, string[]>()
    for (const step of steps) {
      for (const depId of step.query.dependsOn) {
        if (!distinctIds.has(depId)) {
          throw new Error(
            `ExecutionAnalysis requires valid dependencies; node '${step.query.id}' references unknown node '${depId}'`,
          )
        }
        const list = dependents.get(depId) ?? []
        list.push(step.query.id)
        dependents.set(depId, list)
      }
    }

    // Topological order via Kahn's algorithm also proves acyclicity.
    const inDegree = new Map<string, number>()
    for (const nodeId of distinctIds) {
      inDegree.set(nodeId, 0)
    }
    for (const step of steps) {
      for (const _depId of step.query.dependsOn) {
        inDegree.set(step.query.id, (inDegree.get(step.query.id) ?? 0) + 1)
      }
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
    if (topoOrder.length !== distinctIds.size) {
      throw new Error('ExecutionAnalysis requires an acyclic DAG')
    }

    // Longest path from any root to a node, and from a node to any sink.
    const distFromStart = new Map<string, number>()
    for (const nodeId of distinctIds) {
      distFromStart.set(nodeId, 1)
    }
    for (const nodeId of topoOrder) {
      const query = idToQuery.get(nodeId)!
      for (const depId of query.dependsOn) {
        const current = distFromStart.get(nodeId) ?? 0
        const candidate = (distFromStart.get(depId) ?? 0) + 1
        if (candidate > current) {
          distFromStart.set(nodeId, candidate)
        }
      }
    }

    const distToEnd = new Map<string, number>()
    for (const nodeId of distinctIds) {
      distToEnd.set(nodeId, 1)
    }
    for (const nodeId of [...topoOrder].reverse()) {
      for (const dependent of dependents.get(nodeId) ?? []) {
        const current = distToEnd.get(nodeId) ?? 0
        const candidate = (distToEnd.get(dependent) ?? 0) + 1
        if (candidate > current) {
          distToEnd.set(nodeId, candidate)
        }
      }
    }

    let criticalLength = 0
    for (const nodeId of distinctIds) {
      const length =
        (distFromStart.get(nodeId) ?? 0) + (distToEnd.get(nodeId) ?? 0) - 1
      if (length > criticalLength) {
        criticalLength = length
      }
    }

    // Topological levels: a root is level 0, a node is one level deeper
    // than its deepest dependency. Nodes on the same level can run in
    // parallel.
    const topoLevels: Record<string, number> = {}
    let maxLevel = 0
    for (const nodeId of distinctIds) {
      const level = (distFromStart.get(nodeId) ?? 0) - 1
      topoLevels[nodeId] = level
      if (level > maxLevel) {
        maxLevel = level
      }
    }
    const parallelGroups: string[][] = []
    for (let levelIndex = 0; levelIndex <= maxLevel; levelIndex += 1) {
      parallelGroups.push(
        [...distinctIds]
          .filter((nodeId) => topoLevels[nodeId] === levelIndex)
          .sort(),
      )
    }

    // Critical path: backtrack from the deepest sink, always choosing the
    // predecessor with the longest start distance.
    const sinks = [...distinctIds]
      .filter((nodeId) => (dependents.get(nodeId) ?? []).length === 0)
      .sort()
    const endNode = sinks.reduce((best, nodeId) =>
      (distFromStart.get(nodeId) ?? 0) > (distFromStart.get(best) ?? 0)
        ? nodeId
        : best,
    )
    const criticalPath: string[] = []
    let current: string | null = endNode
    while (current !== null) {
      criticalPath.push(current)
      const upstreams = [...(idToQuery.get(current)?.dependsOn ?? [])].sort()
      if (upstreams.length === 0) {
        current = null
      } else {
        current = upstreams.reduce((best, depId) =>
          (distFromStart.get(depId) ?? 0) > (distFromStart.get(best) ?? 0)
            ? depId
            : best,
        )
      }
    }
    criticalPath.reverse()

    // Slack is how many units a node can be delayed without lengthening
    // the critical path; priority 1 is reserved for zero-slack nodes.
    const priorities: Record<string, number> = {}
    for (const nodeId of distinctIds) {
      priorities[nodeId] =
        criticalLength -
        ((distFromStart.get(nodeId) ?? 0) + (distToEnd.get(nodeId) ?? 0) - 1) +
        1
    }

    return {
      topoLevels,
      parallelGroups,
      criticalPath,
      priorities,
    }
  }
}
