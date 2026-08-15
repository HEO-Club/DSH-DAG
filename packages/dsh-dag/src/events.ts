/**
 * Observe-only `dag/*` event vocabulary: host cordis events plus optional
 * projection into the calling Agent's Session (same pattern as
 * `dsh-tool-workflow`). Payloads carry scalar facts only — never live handles.
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { RunStatus } from '@evo-router/dag-core'
import type { HarnessContext } from './contracts.js'

export interface DagRunStartData {
  runId: string
  planId: string
  objective: string
  nodeCount: number
}

export interface DagNodeStartData {
  runId: string
  nodeId: string
}

export interface DagNodeEndData {
  runId: string
  nodeId: string
  status: string
}

export interface DagRetryData {
  runId: string
  nodeId: string
  attempt: number
}

export interface DagRunEndData {
  runId: string
  status: RunStatus
  completionReason: string
}

export type DagEventType = 'dag/run-start' | 'dag/node-start' | 'dag/node-end' | 'dag/retry' | 'dag/run-end'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Opens one DAG run record. */
    'dag/run-start': DagRunStartData
    /** Records one node start. */
    'dag/node-start': DagNodeStartData
    /** Records one node settlement. */
    'dag/node-end': DagNodeEndData
    /** Records one bounded node retry. */
    'dag/retry': DagRetryData
    /** Closes one DAG run record. */
    'dag/run-end': DagRunEndData
  }
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    'dag/run-start'(data: DagRunStartData): void
    'dag/node-start'(data: DagNodeStartData): void
    'dag/node-end'(data: DagNodeEndData): void
    'dag/retry'(data: DagRetryData): void
    'dag/run-end'(data: DagRunEndData): void
  }
}

/**
 * Emits dag/* events to the host and, when a parent Session is available,
 * projects them as durable session records. Every append is contained: a
 * recording failure never affects run execution.
 */
export class DagEvents {
  constructor(
    private readonly ctx: HarnessContext,
    private readonly session: Session | null,
    private readonly enabled: boolean,
  ) {}

  emit(type: DagEventType, data: DagRunStartData | DagNodeStartData | DagNodeEndData | DagRetryData | DagRunEndData): void {
    if (!this.enabled) return
    try {
      const emit = this.ctx.emit as (event: string, payload: unknown) => void
      emit(type, data)
    } catch {
      // observe-only: host listeners must not break the run
    }
    if (this.session !== null) {
      try {
        const append = this.session.append as (event: string, payload: unknown) => unknown
        append(type, data)
      } catch (error) {
        this.ctx.logger?.warn?.(`dsh-dag: session append of ${type} failed: ${renderError(error)}`)
      }
    }
  }
}

function renderError(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}
