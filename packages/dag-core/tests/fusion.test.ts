/**
 * Tests for the cheap deterministic final-answer dedup fallback and for
 * typed result fusion.
 *
 * TypeScript port of `tests/test_fusion_dedup.py`, plus `fuse()` scenarios
 * covering the typed-fusion spec (zero / one / N results).
 */

import { describe, expect, it } from 'vitest'
import type { ExecutionResult } from '../src/model.js'
import { createExecutionResult } from '../src/model.js'
import type { FusionLlmFuse } from '../src/fusion.js'
import { FUSION_SYSTEM_PROMPT, fuse } from '../src/fusion.js'
import {
  MAX_DEDUP_ITEMS,
  MAX_DEDUP_TOTAL_CHARS,
  dedupNodeResults,
  failureSummary,
} from '../src/dedup.js'

function result(queryId: string, content: string): ExecutionResult {
  return createExecutionResult({ queryId, modelUsed: 'model', content })
}

describe('dedupNodeResults', () => {
  it('drops exact duplicates keeping the first occurrence', () => {
    const results = [
      result('a', 'shared finding'),
      result('b', 'shared finding'),
      result('c', 'unique finding'),
    ]

    const [kept, removed] = dedupNodeResults(results)

    expect(kept.map((item) => item.queryId)).toEqual(['a', 'c'])
    expect(removed).toEqual(['b'])
  })

  it('ignores whitespace and case when fingerprinting', () => {
    const results = [result('a', 'Hello   World'), result('b', 'hello world')]

    const [kept, removed] = dedupNodeResults(results)

    expect(kept.map((item) => item.queryId)).toEqual(['a'])
    expect(removed).toEqual(['b'])
  })

  it('keeps a single result unchanged', () => {
    const results = [result('a', 'only result')]

    const [kept, removed] = dedupNodeResults(results)

    expect(kept).toEqual(results)
    expect(removed).toEqual([])
  })

  it('skips deduplication when the item count is too large', () => {
    const results = [result('n0', 'content'), result('n1', 'content'), result('n2', 'content')]

    const [kept, removed] = dedupNodeResults(results, { maxItems: 2 })

    expect(kept).toEqual(results)
    expect(removed).toEqual([])
  })

  it('skips deduplication when the total content is too large', () => {
    const results = [result('a', 'x'.repeat(100)), result('b', 'x'.repeat(100))]

    const [kept, removed] = dedupNodeResults(results, { maxTotalChars: 50 })

    expect(kept).toEqual(results)
    expect(removed).toEqual([])
  })

  it('keeps blank-content results (no fingerprint)', () => {
    const results = [result('a', ''), result('b', '')]

    const [kept, removed] = dedupNodeResults(results)

    expect(kept.map((item) => item.queryId)).toEqual(['a', 'b'])
    expect(removed).toEqual([])
  })

  it('exposes the documented safety limits', () => {
    expect(MAX_DEDUP_ITEMS).toBe(64)
    expect(MAX_DEDUP_TOTAL_CHARS).toBe(2_000_000)
  })
})

describe('failureSummary', () => {
  it('renders none and failure lists', () => {
    expect(failureSummary(null)).toBe('(none)')
    expect(failureSummary([])).toBe('(none)')
    expect(
      failureSummary([
        createExecutionResult({ queryId: 'a', modelUsed: 'm', content: '', error: 'boom' }),
        createExecutionResult({ queryId: 'b', modelUsed: 'm', content: '', error: null }),
      ]),
    ).toBe('[a] boom\n[b] no error message')
  })
})

describe('fuse', () => {
  it('returns a failure message when there are no results', async () => {
    const answer = await fuse('task', [])

    expect(answer.task).toBe('task')
    expect(answer.answer).toBe('No successful results were produced.')
    expect(answer.subResults).toEqual([])
  })

  it('passes through a single result without calling the LLM', async () => {
    const single = result('q1', 'only content')
    let called = false

    const answer = await fuse('task', [single], {
      llmFuse: async () => {
        called = true
        return 'should not be used'
      },
    })

    expect(answer.answer).toBe('only content')
    expect(answer.subResults).toEqual([single])
    expect(called).toBe(false)
  })

  it('deterministically joins multiple results when no LLM fuse is provided', async () => {
    const results = [result('a', 'first'), result('b', 'second')]

    const answer = await fuse('task', results)

    expect(answer.answer).toBe('[a] first\n\n[b] second')
    expect(answer.subResults).toEqual(results)
  })

  it('delegates to the LLM fuse when provided, including failures', async () => {
    const results = [result('a', 'first'), result('b', 'second')]
    const failures = [
      createExecutionResult({ queryId: 'c', modelUsed: 'm', content: '', error: 'boom' }),
    ]
    const llmFuse: FusionLlmFuse = async (task, res, fails) =>
      `fused(${task};${res.map((item) => item.queryId).join(',')};${fails
        .map((item) => item.queryId)
        .join(',')})`

    const answer = await fuse('task', results, { llmFuse, failures })

    expect(answer.answer).toBe('fused(task;a,b;c)')
    expect(answer.subResults).toEqual(results)
  })

  it('exposes a system prompt for result fusion', () => {
    expect(typeof FUSION_SYSTEM_PROMPT).toBe('string')
    expect(FUSION_SYSTEM_PROMPT.length).toBeGreaterThan(0)
  })
})
