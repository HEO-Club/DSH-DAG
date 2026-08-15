/**
 * Tests for DAG execution analysis (KR4.3) — TypeScript port of
 * `tests/test_analysis.py` (1:1 scenario coverage).
 */

import { describe, expect, it } from 'vitest'
import { ExecutionPlan, PlanStep, createQuery, type Query } from '../src/model.js'
import { DAGAnalyzer } from '../src/analysis.js'

function buildPlan(queries: Query[]): ExecutionPlan {
  return new ExecutionPlan({
    originalTask: 'task',
    steps: queries.map((query) => new PlanStep(query)),
  })
}

describe('DAGAnalyzer', () => {
  it('computes topological levels and parallel groups', () => {
    const q1 = createQuery({ id: '1', content: 'root', skill: 'qa' })
    const q2 = createQuery({ id: '2', content: 'a', skill: 'qa', dependsOn: ['1'] })
    const q3 = createQuery({ id: '3', content: 'b', skill: 'qa', dependsOn: ['1'] })
    const q4 = createQuery({
      id: '4',
      content: 'merge',
      skill: 'qa',
      dependsOn: ['2', '3'],
    })

    const analysis = new DAGAnalyzer().analyze(buildPlan([q1, q2, q3, q4]))

    expect(analysis.topoLevels).toEqual({ '1': 0, '2': 1, '3': 1, '4': 2 })
    expect(analysis.parallelGroups).toEqual([['1'], ['2', '3'], ['4']])
  })

  it('computes linear chain levels and critical path', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa' })
    const q2 = createQuery({ id: '2', content: 'b', skill: 'qa', dependsOn: ['1'] })
    const q3 = createQuery({ id: '3', content: 'c', skill: 'qa', dependsOn: ['2'] })

    const analysis = new DAGAnalyzer().analyze(buildPlan([q1, q2, q3]))

    expect(analysis.parallelGroups).toEqual([['1'], ['2'], ['3']])
    expect(analysis.criticalPath).toEqual(['1', '2', '3'])
    expect(analysis.priorities).toEqual({ '1': 1, '2': 1, '3': 1 })
  })

  it('critical path prefers the longest branch', () => {
    const q1 = createQuery({ id: '1', content: 'root', skill: 'qa' })
    const q2 = createQuery({ id: '2', content: 'short', skill: 'qa', dependsOn: ['1'] })
    const q3 = createQuery({ id: '3', content: 'long-a', skill: 'qa', dependsOn: ['1'] })
    const q4 = createQuery({ id: '4', content: 'long-b', skill: 'qa', dependsOn: ['3'] })
    const q5 = createQuery({
      id: '5',
      content: 'merge',
      skill: 'qa',
      dependsOn: ['2', '4'],
    })

    const analysis = new DAGAnalyzer().analyze(buildPlan([q1, q2, q3, q4, q5]))

    expect(analysis.criticalPath).toEqual(['1', '3', '4', '5'])
  })

  it('priorities favor critical path nodes', () => {
    const q1 = createQuery({ id: '1', content: 'root', skill: 'qa' })
    const q2 = createQuery({ id: '2', content: 'short', skill: 'qa', dependsOn: ['1'] })
    const q3 = createQuery({ id: '3', content: 'long-a', skill: 'qa', dependsOn: ['1'] })
    const q4 = createQuery({ id: '4', content: 'long-b', skill: 'qa', dependsOn: ['3'] })
    const q5 = createQuery({
      id: '5',
      content: 'merge',
      skill: 'qa',
      dependsOn: ['2', '4'],
    })

    const analysis = new DAGAnalyzer().analyze(buildPlan([q1, q2, q3, q4, q5]))

    expect(analysis.priorities['1']).toBe(1)
    expect(analysis.priorities['3']).toBe(1)
    expect(analysis.priorities['4']).toBe(1)
    expect(analysis.priorities['5']).toBe(1)
    expect(analysis.priorities['2']).toBe(2)
  })

  it('analyzes a single node', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa' })

    const analysis = new DAGAnalyzer().analyze(buildPlan([q1]))

    expect(analysis.topoLevels).toEqual({ '1': 0 })
    expect(analysis.parallelGroups).toEqual([['1']])
    expect(analysis.criticalPath).toEqual(['1'])
    expect(analysis.priorities).toEqual({ '1': 1 })
  })

  it('rejects a cycle', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa', dependsOn: ['2'] })
    const q2 = createQuery({ id: '2', content: 'b', skill: 'qa', dependsOn: ['1'] })

    expect(() => new DAGAnalyzer().analyze(buildPlan([q1, q2]))).toThrow(/acyclic/)
  })

  it('rejects a missing dependency', () => {
    const q1 = createQuery({ id: '1', content: 'a', skill: 'qa', dependsOn: ['ghost'] })

    expect(() => new DAGAnalyzer().analyze(buildPlan([q1]))).toThrow(
      /unknown node/,
    )
  })

  it('rejects duplicate ids', () => {
    const q1 = createQuery({ id: 'x', content: 'a', skill: 'qa' })
    const q2 = createQuery({ id: 'x', content: 'b', skill: 'qa' })

    expect(() => new DAGAnalyzer().analyze(buildPlan([q1, q2]))).toThrow(
      /unique node ids/,
    )
  })

  it('rejects an empty plan', () => {
    expect(() =>
      new DAGAnalyzer().analyze(
        new ExecutionPlan({ originalTask: 'task', steps: [] }),
      ),
    ).toThrow(/at least one node/)
  })
})
