/**
 * Type declarations for bun:test
 * Bun provides these at runtime
 */

declare module 'bun:test' {
  export function describe(name: string, fn: () => void): void;
  export function describe(name: string, fn: () => Promise<void>): void;

  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;

  export function beforeAll(fn: () => void | Promise<void>): void;
  export function afterAll(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;

  export function expect<T>(value: T): {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toBeDefined(): void;
    toBeUndefined(): void;
    toBeNull(): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeGreaterThan(expected: number): void;
    toBeGreaterThanOrEqual(expected: number): void;
    toBeLessThan(expected: number): void;
    toBeLessThanOrEqual(expected: number): void;
    toContain(expected: unknown): void;
    toHaveLength(expected: number): void;
    toThrow(expected?: string | RegExp): void;
    toMatch(expected: string | RegExp): void;
    toBeInstanceOf(expected: unknown): void;
    toHaveProperty(key: string, value?: unknown): void;
    resolves: {
      toBe(expected: T): Promise<void>;
      toEqual(expected: unknown): Promise<void>;
      toBeDefined(): Promise<void>;
    };
    rejects: {
      toBe(expected: T): Promise<void>;
      toEqual(expected: unknown): Promise<void>;
      toThrow(expected?: string | RegExp): Promise<void>;
    };
    not: {
      toBe(expected: T): void;
      toEqual(expected: unknown): void;
      toBeDefined(): void;
      toBeUndefined(): void;
      toContain(expected: unknown): void;
    };
  };
}
