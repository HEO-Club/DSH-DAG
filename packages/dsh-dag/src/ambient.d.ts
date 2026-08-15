/**
 * Narrow ambient declarations for platform globals the adapter uses.
 * The harness host (Node 20+) provides these at runtime; the declarations
 * keep strict type-checking working without @types/node.
 */

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
}

interface AbortSignalConstructor {
  prototype: AbortSignal
  any(signals: AbortSignal[]): AbortSignal
  timeout(ms: number): AbortSignal
}

declare const AbortSignal: AbortSignalConstructor

interface AbortController {
  readonly signal: AbortSignal
  abort(reason?: string): void
}

declare const AbortController: {
  prototype: AbortController
  new (): AbortController
}
