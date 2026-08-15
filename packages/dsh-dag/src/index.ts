/**
 * @evo-router/dsh-dag — DSH Multi-Agent DAG plugin entry.
 *
 * A Cordis plugin that provides the `dag` service and registers the `dag_run`
 * model tool. Runs on the host plane (it publishes the `dag` service); the
 * model-facing tool is composed per-agent via a preset `isolate` realm.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config.js'
import type { DagConfig } from './config.js'
import { DAGRunController } from './dag-service.js'
import { registerDagTool } from './tool.js'

export const name = 'dsh-dag'

/** Hard dependencies provided by the DSH host composition. */
export const inject = ['tools', 'subagents', 'systemPrompt']

export { Config }

export function apply(ctx: Context, config: DagConfig): () => void {
  // Service subclass auto-registers `ctx.dag` on construction and is removed
  // with the owning fiber.
  const controller = new DAGRunController(ctx, config)
  const disposeTool = registerDagTool(ctx, config, controller)
  return () => {
    disposeTool()
    controller.disposeAll()
  }
}
