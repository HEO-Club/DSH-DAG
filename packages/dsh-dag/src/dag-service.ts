/**
 * The `dag` service (`DAGRunController`): programmatic entry point for outer
 * orchestrators. Registered as a cordis Service on the host plane (the plugin
 * provides the service; it is not per-session).
 */

import { Service } from '@deepseek-ai/cordis'
import type { DAGStartRequest, HarnessContext } from './contracts.js'
import type { DagConfig } from './config.js'
import { DAGRun, startDagRun } from './dag-run.js'

export class DAGRunController extends Service {
  private readonly runs = new Map<string, DAGRun>()

  constructor(ctx: HarnessContext, private readonly config: DagConfig) {
    super(ctx, 'dag')
  }

  /** Compile, schedule and start one DAG run. */
  start(request: DAGStartRequest): DAGRun {
    const run = startDagRun({ ctx: this.ctx, config: this.config, request })
    this.runs.set(run.id, run)
    const remove = (): void => {
      this.runs.delete(run.id)
    }
    void run.result.then(remove, remove)
    return run
  }

  get(id: string): DAGRun | undefined {
    return this.runs.get(id)
  }

  list(): DAGRun[] {
    return [...this.runs.values()]
  }

  cancel(id: string, reason?: string): void {
    this.runs.get(id)?.cancel(reason)
  }

  /** Cancel every active run (called on plugin unload). */
  disposeAll(): void {
    for (const run of this.runs.values()) {
      run.cancel('dsh-dag plugin unloaded')
    }
  }
}
