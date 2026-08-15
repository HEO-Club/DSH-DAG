/**
 * Tests for DAG validation (KR4.2) — TypeScript port of
 * `tests/test_validation.py` (1:1 scenario coverage).
 */

import { describe, expect, it } from 'vitest'
import { ExecutionPlan, PlanStep, createQuery, type Query } from '../src/model.js'
import { DAGValidator, ValidationSeverity } from '../src/validation.js'

function buildPlan(queries: Query[]): ExecutionPlan {
  return new ExecutionPlan({
    originalTask: 'task',
    steps: queries.map((query) => new PlanStep(query)),
  })
}

describe('DAGValidator', () => {
  it('valid DAG passes and returns topological order', () => {
    const q1 = createQuery({ id: '1', content: 'root', skill: 'qa' })
    const q2 = createQuery({
      id: '2',
      content: 'branch',
      skill: 'code_generation',
      dependsOn: ['1'],
    })
    const q3 = createQuery({
      id: '3',
      content: 'merge',
      skill: 'summarization',
      dependsOn: ['1', '2'],
    })

    const result = new DAGValidator().validate(buildPlan([q1, q2, q3]))

    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.warnings).toEqual([])
    expect(result.topoOrder).toEqual(['1', '2', '3'])
    expect(result.nonExecutableNodeIds).toEqual([])
  })

  it('cycle is reported with non-executable nodes', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa', dependsOn: ['2'] })
    const q2 = createQuery({ id: '2', content: 'b', skill: 'qa', dependsOn: ['1'] })

    const result = new DAGValidator().validate(buildPlan([q1, q2]))

    expect(result.valid).toBe(false)
    expect(result.errors.some((issue) => issue.code === 'cycle_detected')).toBe(true)
    expect(result.nonExecutableNodeIds).toEqual(['1', '2'])
    expect(result.topoOrder).toEqual([])
  })

  it('self-reference is a cycle', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa', dependsOn: ['1'] })

    const result = new DAGValidator().validate(buildPlan([q1]))

    expect(result.valid).toBe(false)
    expect(result.errors.some((issue) => issue.code === 'cycle_detected')).toBe(true)
  })

  it('missing dependency is reported', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa', dependsOn: ['ghost'] })

    const result = new DAGValidator().validate(buildPlan([q1]))

    expect(result.valid).toBe(false)
    expect(result.errors.some((issue) => issue.code === 'missing_dependency')).toBe(
      true,
    )
    expect(result.nonExecutableNodeIds).toContain('1')
  })

  it('duplicate node id is reported', () => {
    const q1 = createQuery({ id: 'x', content: 'a', skill: 'qa' })
    const q2 = createQuery({ id: 'x', content: 'b', skill: 'qa' })

    const result = new DAGValidator().validate(buildPlan([q1, q2]))

    expect(result.valid).toBe(false)
    expect(result.errors.some((issue) => issue.code === 'duplicate_node_id')).toBe(
      true,
    )
    expect(result.nonExecutableNodeIds).toContain('x')
  })

  it('isolated node emits warning only', () => {
    const q1 = createQuery({ id: '1', content: 'root', skill: 'qa' })
    const q2 = createQuery({ id: '2', content: 'lonely', skill: 'qa' })

    const result = new DAGValidator().validate(buildPlan([q1, q2]))

    expect(result.valid).toBe(true)
    const isolated = result.warnings.filter(
      (issue) =>
        issue.code === 'isolated_node' &&
        issue.severity === ValidationSeverity.WARNING,
    )
    expect(isolated).toHaveLength(2)
  })

  it('schema mismatch is reported', () => {
    const producer = createQuery({
      id: '1',
      content: 'data',
      skill: 'qa',
      outputSchema: 'weather_data',
    })
    const consumer = createQuery({
      id: '2',
      content: 'report',
      skill: 'qa',
      dependsOn: ['1'],
      inputSchema: 'temperature_report',
    })

    const result = new DAGValidator().validate(buildPlan([producer, consumer]))

    expect(result.valid).toBe(false)
    expect(result.errors.some((issue) => issue.code === 'schema_mismatch')).toBe(
      true,
    )
  })

  it('unprovided input schema is reported', () => {
    const q1 = createQuery({
      id: '1',
      content: 'a',
      skill: 'qa',
      inputSchema: 'needs_data',
    })

    const result = new DAGValidator().validate(buildPlan([q1]))

    expect(result.valid).toBe(false)
    expect(
      result.errors.some((issue) => issue.code === 'input_schema_unprovided'),
    ).toBe(true)
  })

  it('unknown upstream output schema emits warning', () => {
    const producer = createQuery({ id: '1', content: 'data', skill: 'qa' })
    const consumer = createQuery({
      id: '2',
      content: 'report',
      skill: 'qa',
      dependsOn: ['1'],
      inputSchema: 'anything',
    })

    const result = new DAGValidator().validate(buildPlan([producer, consumer]))

    expect(result.valid).toBe(true)
    expect(result.warnings.some((issue) => issue.code === 'schema_unverified')).toBe(
      true,
    )
  })

  it('optional final output emits warning', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa', required: false })

    const result = new DAGValidator().validate(buildPlan([q1]))

    expect(result.valid).toBe(true)
    expect(
      result.warnings.some((issue) => issue.code === 'no_required_final_output'),
    ).toBe(true)
  })

  it('empty plan is invalid', () => {
    const plan = new ExecutionPlan({ originalTask: 'task', steps: [] })

    const result = new DAGValidator().validate(plan)

    expect(result.valid).toBe(false)
    expect(result.errors.some((issue) => issue.code === 'empty_plan')).toBe(true)
  })

  it('non-executable propagates to dependents', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa', dependsOn: ['ghost'] })
    const q2 = createQuery({ id: '2', content: 'b', skill: 'qa', dependsOn: ['1'] })

    const result = new DAGValidator().validate(buildPlan([q1, q2]))

    expect(result.valid).toBe(false)
    expect(result.nonExecutableNodeIds).toEqual(['1', '2'])
  })

  it('topo order is provided even when acyclic with errors', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa', outputSchema: 'x' })
    const q2 = createQuery({
      id: '2',
      content: 'b',
      skill: 'qa',
      dependsOn: ['1'],
      inputSchema: 'y',
    })

    const result = new DAGValidator().validate(buildPlan([q1, q2]))

    expect(result.valid).toBe(false)
    expect(result.topoOrder).toEqual(['1', '2'])
  })

  it('plan validation integration', () => {
    const queries = [
      createQuery({ id: '1', content: 'root', skill: 'qa', outputSchema: 'raw' }),
      createQuery({
        id: '2',
        content: 'branch',
        skill: 'qa',
        dependsOn: ['1'],
        inputSchema: 'raw',
      }),
    ]

    const plan = buildPlan(queries)
    const result = new DAGValidator().validate(plan)

    expect(result.valid).toBe(true)
    expect(result.topoOrder).toEqual(['1', '2'])
    expect(result.nonExecutableNodeIds).toEqual([])
  })
})
