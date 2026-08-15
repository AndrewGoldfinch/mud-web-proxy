// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Test doubles that stand in for a full interface.
 *
 * One assertion, in one place, instead of `as unknown as T` at every mock
 * site. The invariant is the same wherever it is used, so it is stated once
 * here: a double implements the subset of `T` that the code under test
 * actually touches. Reaching beyond that subset is a `undefined is not a
 * function` at runtime, which is a loud failure in the test that did it —
 * not a silent wrong answer in production.
 */

/**
 * Present a partial implementation as `T`, keeping the double's own extra
 * members (`getWrittenData`, `clearWrittenData`, and friends) visible to the
 * test that built it.
 *
 * Curried because TypeScript cannot infer one type argument while being given
 * another: `asDouble<TelnetSocket>()({ ... })` names the interface being stood
 * in for and still infers the double's own shape from the literal.
 */
export const asDouble =
  <T>() =>
  <U>(value: U): T & U =>
    // SAFETY: see the module comment — the double covers what the code under
    // test reads, and anything beyond that fails loudly rather than silently.
    value as T & U;

/**
 * A stub standing in for a function the code under test reaches through a
 * module binding (`net.createConnection`, `globalThis.setTimeout`, …).
 *
 * Same invariant as `asDouble`, and curried for the same reason: the stub
 * implements the calls the test actually drives, and the assertion recording
 * that is written once, here, rather than at every assignment site.
 */
export const asStub =
  <T>() =>
  <U>(implementation: U): T =>
    // SAFETY: see above — the stub covers the calls the test drives, and an
    // uncovered call is a runtime failure in that test. Asserted to `T & U`
    // rather than `T` because that is the single-step conversion TypeScript
    // accepts; the result is returned as `T`, which it satisfies.
    implementation as T & U;
