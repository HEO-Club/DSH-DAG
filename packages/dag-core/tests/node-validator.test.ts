/**
 * Tests for deterministic and model-assisted node result validation.
 *
 * TypeScript port of `tests/test_result_validation.py`.
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { NodeExecutionRequest, NodeResult, NodeResultInit } from '../src/executor-contracts.js'
import {
  ArtifactKind,
  ExecutionErrorType,
  ExecutorKind,
  NodeResultStatus,
  createArtifactRef,
  createExecutionError,
  createNodeExecutionRequest,
  createNodeResult,
} from '../src/executor-contracts.js'
import type { NodeReviewer } from '../src/node-validator.js'
import {
  NodeResultValidator,
  ReviewBudget,
  ValidationStatus,
  ValidatorPrompt,
} from '../src/node-validator.js'

function request(
  updates: Partial<Parameters<typeof createNodeExecutionRequest>[0]> = {},
): NodeExecutionRequest {
  return createNodeExecutionRequest({
    runId: 'run-1',
    nodeId: 'critical',
    executorKind: ExecutorKind.DIRECT_LLM,
    prompt: 'Produce a JSON report',
    expectedOutputSchema: {
      type: 'object',
      required: ['answer'],
      properties: { answer: { type: 'string' } },
    },
    ...updates,
  })
}

function result(updates: Partial<NodeResultInit> = {}): NodeResult {
  return createNodeResult({
    runId: 'run-1',
    nodeId: 'critical',
    executorKind: ExecutorKind.DIRECT_LLM,
    status: NodeResultStatus.SUCCEEDED,
    content: '{"answer":"done"}',
    structuredOutput: { answer: 'done' },
    ...updates,
  })
}

describe('NodeResultValidator.validate', () => {
  it('reports empty results, invalid JSON, and missing required fields', () => {
    const validator = new NodeResultValidator()

    const empty = validator.validate(request(), result({ content: '', structuredOutput: null }))
    const malformed = validator.validate(
      request(),
      result({ content: 'not-json', structuredOutput: null }),
    )
    const missing = validator.validate(request(), result({ content: '{}', structuredOutput: {} }))

    expect(empty.status).toBe(ValidationStatus.FAILED)
    expect(empty.errors[0]?.code).toBe('empty_result')
    expect(malformed.errors[0]?.code).toBe('invalid_json')
    expect(missing.errors.some((issue) => issue.code === 'schema_validation_failed')).toBe(true)
  })

  it('reports execution failure when the node did not succeed', () => {
    const failedResult = createNodeResult({
      runId: 'run-1',
      nodeId: 'critical',
      executorKind: ExecutorKind.DIRECT_LLM,
      status: NodeResultStatus.FAILED,
      modelId: 'primary',
      error: createExecutionError({
        errorType: ExecutionErrorType.PROVIDER_ERROR,
        message: 'provider down',
        retryable: true,
      }),
    })

    const validation = new NodeResultValidator().validate(request(), failedResult)

    expect(validation.status).toBe(ValidationStatus.FAILED)
    expect(validation.qualityScore).toBe(0)
    expect(validation.errors.map((issue) => issue.code)).toContain('execution_failed')
  })

  it('checks artifact paths and success conditions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dag-core-validator-'))
    try {
      const existing = join(dir, 'report.txt')
      writeFileSync(existing, 'report', 'utf8')
      const missingPath = join(dir, 'missing.txt')
      const validation = new NodeResultValidator().validate(
        request({
          metadata: {
            required_artifacts: [existing, missingPath],
            success_criteria: ['answer', 'citation'],
          },
        }),
        result({ content: '{"answer":"done with answer"}' }),
      )

      expect(validation.status).toBe(ValidationStatus.FAILED)
      expect(validation.artifactsFound).toEqual([existing])
      expect(validation.missingArtifacts).toEqual([missingPath])
      expect(validation.missingContent).toEqual(['citation'])
      expect(validation.repairSuggestions.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('accepts required artifacts by stable artifact ID reference', () => {
    const artifact = createArtifactRef({
      artifactId: 'artifact_' + 'a'.repeat(64),
      kind: ArtifactKind.JSON,
      name: 'report.json',
      mediaType: 'application/json',
      sizeBytes: 2,
      sha256: 'b'.repeat(64),
      summary: 'report',
    })
    const nodeResult = result({ artifacts: [artifact] })
    const validation = new NodeResultValidator().validate(
      request({ metadata: { required_artifacts: [artifact.artifactId] } }),
      nodeResult,
    )

    expect(validation.status).toBe(ValidationStatus.PASSED)
    expect(validation.artifactsFound).toEqual([artifact.artifactId])
    expect(ValidatorPrompt.render(request(), nodeResult)).toContain(artifact.artifactId)
  })
})

describe('NodeResultValidator.review', () => {
  class ReviewingRunner implements NodeReviewer {
    requests: NodeExecutionRequest[] = []

    async execute(req: NodeExecutionRequest): Promise<NodeResult> {
      this.requests.push(req)
      return createNodeResult({
        runId: req.runId,
        nodeId: req.nodeId,
        executorKind: req.executorKind,
        status: NodeResultStatus.SUCCEEDED,
        modelId: req.modelId,
        content: JSON.stringify({
          status: 'passed',
          quality_score: 0.9,
          missing_content: [],
          incorrect_content: [],
          repair_suggestions: [],
          errors: [],
        }),
        structuredOutput: {
          status: 'passed',
          quality_score: 0.9,
          missing_content: [],
          incorrect_content: [],
          repair_suggestions: [],
          artifacts_found: [],
          missing_artifacts: [],
          errors: [],
        },
      })
    }
  }

  it('reviews high-value nodes with the prompt and enforces the budget', async () => {
    const reviewer = new ReviewingRunner()
    const validator = new NodeResultValidator({ reviewer, modelId: 'reviewer' })
    const budget = new ReviewBudget({ highValueNodeIds: new Set(['critical']), maxReviews: 1 })

    const reviewed = await validator.review(request(), result(), { budget })
    const skipped = await validator.review(request(), result(), { budget })

    expect(reviewed.qualityScore).toBe(0.9)
    expect(skipped.status).toBe(ValidationStatus.SKIPPED)
    expect(budget.reviewsUsed).toBe(1)
    const prompt = reviewer.requests[0]!.prompt
    expect(prompt).toContain('Produce a JSON report')
    expect(prompt.toLowerCase()).toContain('success criteria')
    expect(prompt).toContain('done')
    expect(ValidatorPrompt.version).toBe('1.0')
  })

  it('skips with reviewer_unavailable when no reviewer model is configured', async () => {
    const validator = new NodeResultValidator()
    const budget = new ReviewBudget({ highValueNodeIds: new Set(['critical']), maxReviews: 1 })

    const validation = await validator.review(request(), result(), { budget })

    expect(validation.status).toBe(ValidationStatus.SKIPPED)
    expect(validation.errors.map((issue) => issue.code)).toEqual(['reviewer_unavailable'])
  })

  it('fails the review when the reviewer does not succeed', async () => {
    const reviewer: NodeReviewer = {
      async execute(): Promise<NodeResult> {
        return createNodeResult({
          runId: 'run-1',
          nodeId: 'validate_critical',
          executorKind: ExecutorKind.DIRECT_LLM,
          status: NodeResultStatus.FAILED,
          modelId: 'reviewer',
          error: createExecutionError({
            errorType: ExecutionErrorType.PROVIDER_ERROR,
            message: 'reviewer boom',
            retryable: false,
          }),
        })
      },
    }
    const validator = new NodeResultValidator({ reviewer, modelId: 'reviewer' })
    const budget = new ReviewBudget({ highValueNodeIds: new Set(['critical']), maxReviews: 1 })

    const validation = await validator.review(request(), result(), { budget })

    expect(validation.status).toBe(ValidationStatus.FAILED)
    expect(validation.errors[0]?.code).toBe('review_failed')
    expect(validation.errors[0]?.message).toBe('reviewer boom')
  })
})
