import { describe, expect, it } from 'vitest'
import { ExecutionPlan, PlanStep, TaskStatus, createQuery } from '../src/model.js'
import { canTransition, transition } from '../src/state-machine.js'

describe('smoke', () => {
  it('creates a plan with ready steps', () => {
    const plan = new ExecutionPlan({
      originalTask: 'task',
      steps: [new PlanStep(createQuery({ id: 'a', content: 'x', skill: 'qa' }))],
    })
    expect(plan.readySteps).toHaveLength(1)
  })

  it('state machine allows legal transitions only', () => {
    expect(canTransition(TaskStatus.PENDING, TaskStatus.READY)).toBe(true)
    expect(canTransition(TaskStatus.SUCCEEDED, TaskStatus.READY)).toBe(false)
    const step = new PlanStep(createQuery({ id: 'a', content: 'x', skill: 'qa' }))
    const record = transition(step, TaskStatus.READY, 'root')
    expect(record.toStatus).toBe(TaskStatus.READY)
    expect(step.status).toBe(TaskStatus.READY)
  })
})
