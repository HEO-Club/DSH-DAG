/**
 * Cheap deterministic deduplication for final-answer fallback paths.
 *
 * TypeScript port of the Router's `src/fusion/dedup.py`. Duplicate detection
 * uses exact normalized fingerprints only; semantic deduplication remains the
 * fusion LLM's responsibility. When the input is large enough that hashing
 * would be expensive the check is skipped entirely, returning the input
 * unchanged with no removals.
 */

import { createHash } from 'node:crypto'
import type { ExecutionResult } from './model.js'

// Safety limits so the deterministic fallback never becomes a latency bottleneck.
export const MAX_DEDUP_ITEMS = 64
export const MAX_DEDUP_TOTAL_CHARS = 2_000_000

/** Return a stable fingerprint for one node result's content. */
function fingerprint(content: string): string {
  const normalized = content.split(/\s+/).join(' ').trim().toLowerCase()
  if (normalized === '') {
    return ''
  }
  return createHash('sha256').update(normalized, 'utf8').digest('hex')
}

/** Render failed-node context for the fusion prompt. */
export function failureSummary(failures: ExecutionResult[] | null): string {
  if (failures === null || failures.length === 0) {
    return '(none)'
  }
  return failures
    .map((item) => `[${item.queryId}] ${item.error ?? 'no error message'}`)
    .join('\n')
}

/**
 * Drop exact-duplicate node contents with bounded cost.
 *
 * Returns `[keptResults, removedQueryIds]`.
 */
export function dedupNodeResults(
  results: ExecutionResult[],
  options?: { maxItems?: number; maxTotalChars?: number },
): [ExecutionResult[], string[]] {
  const maxItems = options?.maxItems ?? MAX_DEDUP_ITEMS
  const maxTotalChars = options?.maxTotalChars ?? MAX_DEDUP_TOTAL_CHARS
  if (results.length <= 1) {
    return [results, []]
  }
  const totalChars = results.reduce((sum, item) => sum + item.content.length, 0)
  if (results.length > maxItems || totalChars > maxTotalChars) {
    return [results, []]
  }
  const seen = new Map<string, string>()
  const kept: ExecutionResult[] = []
  const removed: string[] = []
  for (const result of results) {
    const fp = fingerprint(result.content)
    if (fp === '') {
      kept.push(result)
      continue
    }
    if (seen.has(fp)) {
      removed.push(result.queryId)
      continue
    }
    seen.set(fp, result.queryId)
    kept.push(result)
  }
  return [kept, removed]
}
