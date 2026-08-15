// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Merge caller overrides onto defaults without letting `undefined` win.
 *
 * `{ ...defaults, ...overrides }` looks like it applies defaults, but a key
 * that is *present and undefined* overwrites the default with `undefined`.
 * That is not a hypothetical shape: `runtime-config.ts` builds its optional
 * blocks with helpers that return `number | undefined`, so every key is
 * present and most are undefined on a default install.
 *
 * The concrete failure (MWP-63, and again in `BackgroundPushScheduler`) is
 * silent. Nothing throws — the undefined flows into arithmetic, and
 * `now - last >= undefined` is simply `false` forever, so the feature stops
 * running while every log line and health check stays green.
 *
 * `undefined` is the only value skipped. An explicit `0` or `false` is a real
 * choice by the operator and is preserved, which is the other half of the same
 * bug: a `||` guard would have silently restored the default for both.
 */
export const withDefaults = <T extends object>(
  defaults: T,
  overrides: Partial<T> | undefined,
): T => {
  const merged = { ...defaults };
  if (!overrides) return merged;

  // SAFETY: `overrides` is a Partial<T>, so every own key it has is a key of
  // T. Object.keys widens to string[] because a JavaScript object may carry
  // keys the type does not describe; here it cannot, because the only values
  // read back out are written through the Partial<T> contract.
  for (const key of Object.keys(overrides) as (keyof T)[]) {
    const value = overrides[key];
    if (value !== undefined) {
      // SAFETY: Partial<T>[K] is T[K] | undefined and the guard has removed
      // undefined, so what remains is exactly T[K].
      merged[key] = value as T[keyof T];
    }
  }

  return merged;
};
