/**
 * Minimal ambient declarations for the Node.js builtin modules used by
 * dag-core.
 *
 * The monorepo keeps zero runtime dependencies and does not install
 * `@types/node`; these narrow declarations are enough for strict
 * type-checking of the few `node:` imports in this package. They declare
 * only the exact members dag-core uses, so they merge harmlessly with
 * `@types/node` if it is ever added.
 */

declare module 'node:fs' {
  /** Synchronously check whether a path exists (narrowed to string paths). */
  export function existsSync(path: string): boolean
}

declare module 'node:crypto' {
  export interface Hash {
    update(data: string, encoding?: string): Hash
    digest(encoding: string): string
  }

  /** Create a hash of the given algorithm (narrowed to string inputs). */
  export function createHash(algorithm: string): Hash
}

declare module 'node:timers/promises' {
  /** Resolve after the given delay in milliseconds. */
  export function setTimeout(delay: number): Promise<void>
}

/** Narrow ambient declarations for platform globals dag-core uses. */
interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
}

interface AbortSignalConstructor {
  prototype: AbortSignal
  /** Compose several signals into one; aborts when any child aborts. */
  any(signals: AbortSignal[]): AbortSignal
  /** A signal that aborts after the given milliseconds. */
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

declare function setTimeout(handler: () => void, timeout?: number): number
