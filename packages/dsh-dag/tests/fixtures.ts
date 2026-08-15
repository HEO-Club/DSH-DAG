/**
 * Shared test fixtures: fake sub-agent provider, fake service shims and
 * proposal builders. No real LLM, no network, no real DSH profile.
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createTaskGraphProposal } from '@evo-router/dag-core'
import type { TaskGraphProposal } from '@evo-router/dag-core'

export type FakeStopReason = SubagentResult['stopReason']

export interface FakeChildScript {
  output?: string
  structured?: unknown
  stopReason?: FakeStopReason
}

export interface FakeStartedCall {
  label: string
  prompt: string
  model: string | undefined
}

/** A subagents service shim with scripted per-node child outcomes. */
export function createFakeSubagents(scripts: Record<string, FakeChildScript | ((label: string) => FakeChildScript)>) {
  const started: FakeStartedCall[] = []
  const disposedLabels: string[] = []
  const provider = {
    name: 'fake',
    capabilities: { outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    inheritsParentContext: false,
    start: async () => {
      throw new Error('provider.start is not used by the shim')
    },
  }
  const service = {
    provider,
    started,
    disposedLabels,
    async start(name: string, request: SubagentStartRequest) {
      const label = request.label ?? 'unknown'
      const key = label.replace(/^dag:/, '')
      const raw = typeof scripts[key] === 'function' ? scripts[key](key) : scripts[key]
      const script: FakeChildScript = raw ?? { output: `output of ${key}`, stopReason: 'completed' }
      const model = (request.agentOptions as { model?: string } | undefined)?.model
      started.push({
        label,
        prompt: textOf(request.prompt),
        model,
      })
      let settled = false
      return {
        id: label as never,
        localAgent: undefined,
        result: Promise.resolve<SubagentResult>({
          output: script.output !== undefined ? ([{ type: 'text', text: script.output }] as ContentBlock[]) : [],
          ...(script.structured !== undefined ? { structured: script.structured } : {}),
          stopReason: script.stopReason ?? 'completed',
        }),
        dispose: async () => {
          disposedLabels.push(label)
          settled = true
        },
      }
    },
    registerProvider() {
      return () => {}
    },
    getProvider() {
      return provider
    },
    list() {
      return ['fake']
    },
  }
  return service
}

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('')
}

export interface FakeToolsShim {
  register: () => () => void
}

export interface FakeSystemPromptShim {
  section: () => () => void
}

export function createFakeTools(): FakeToolsShim {
  return { register: () => () => {} }
}

export function createFakeSystemPrompt(): FakeSystemPromptShim {
  return { section: () => () => {} }
}

export function makeParent(): Agent {
  return { session: undefined } as unknown as Agent
}

/** Build a diamond proposal: root → (left, right) → merge. */
export function diamondProposal(): TaskGraphProposal {
  return createTaskGraphProposal({
    planId: 'diamond',
    objective: 'diamond task',
    nodes: [
      { nodeId: 'root', title: 'Root', prompt: 'produce root', capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
      { nodeId: 'left', title: 'Left', prompt: 'produce left', dependsOn: ['root'], inputSources: [{ sourceNodeId: 'root', purpose: 'use root' }], capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
      { nodeId: 'right', title: 'Right', prompt: 'produce right', dependsOn: ['root'], inputSources: [{ sourceNodeId: 'root', purpose: 'use root' }], capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
      { nodeId: 'merge', title: 'Merge', prompt: 'merge', dependsOn: ['left', 'right'], inputSources: [{ sourceNodeId: 'left', purpose: 'use left' }, { sourceNodeId: 'right', purpose: 'use right' }], capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
    ],
  })
}

/** A proposal with a node model assignment and one failing leaf. */
export function failureProposal(): TaskGraphProposal {
  return createTaskGraphProposal({
    planId: 'failure',
    objective: 'failure task',
    nodes: [
      { nodeId: 'ok', title: 'Ok', prompt: 'do ok', capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
      { nodeId: 'bad', title: 'Bad', prompt: 'do bad', capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime', model: 'model-b' },
      { nodeId: 'child', title: 'Child', prompt: 'do child', dependsOn: ['bad'], inputSources: [{ sourceNodeId: 'bad', purpose: 'use bad' }], capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
    ],
  })
}

export function singleNodeProposal(prompt = 'single task prompt'): TaskGraphProposal {
  return createTaskGraphProposal({
    planId: 'single',
    objective: 'single task',
    nodes: [
      { nodeId: 'only', title: 'Only', prompt, capabilityRequirements: ['general'], outputRequirements: ['out'], successCriteria: ['ok'], executorKind: 'runtime' },
    ],
  })
}
