/**
 * Minimal ambient types for Bun's built-in test runner.
 *
 * Bun resolves `bun:test` natively at runtime, but `tsc` (which we run with
 * `types: ["node"]` and no bun-types dependency) needs a declaration to keep
 * the typecheck green. This covers exactly the surface our *.test.ts files use;
 * it is type-only and has no runtime effect.
 */
declare module 'bun:test' {
  interface Matchers<T = unknown> {
    toBe(expected: T): void;
    toEqual(expected: T): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeLessThanOrEqual(expected: number): void;
    toMatch(expected: RegExp | string): void;
    toThrow(expected?: RegExp | string | Error): void;
    readonly not: Matchers<T>;
  }
  export function expect<T = unknown>(actual: T): Matchers<T>;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function describe(name: string, fn: () => void): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}
