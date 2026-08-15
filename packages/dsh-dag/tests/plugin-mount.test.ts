/**
 * Plugin mount test: the plugin loads under a real cordis Context with fake
 * services, registers the `dag` service, and unloads cleanly.
 */

import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, Config, inject, name } from '../src/index.js'
import { createFakeSubagents, createFakeSystemPrompt, createFakeTools } from './fixtures.js'

describe('plugin mount', () => {
  it('registers the dag service and unloads without leaking', async () => {
    const ctx = new Context()
    const subagents = createFakeSubagents({})
    ctx.provide('tools', createFakeTools() as never)
    ctx.provide('subagents', subagents as never)
    ctx.provide('systemPrompt', createFakeSystemPrompt() as never)

    const fiber = ctx.plugin({ name, inject, Config, apply }, {}) as unknown as Fiber
    await fiber
    expect(ctx.get('dag')).toBeDefined()

    await fiber.dispose()
    expect(ctx.get('dag')).toBeUndefined()
  })
})
