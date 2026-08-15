// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Message text for a thrown value.
 *
 * Its own module because both `runtime-config` and `wsproxy-utils` need it and
 * the second already imports the first, so putting it in either would close a
 * cycle.
 */

/**
 * JavaScript lets any value be thrown, so the `(err as Error).message` this
 * replaced produced `undefined` whenever something threw a string or a plain
 * object — silently, into a log line. The parameter is named `cause` because
 * that is what it is: the error-cause slot, and the one input in this codebase
 * that genuinely cannot be typed.
 */
export const errorText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/**
 * The thrown value as an Error, wrapping it when it is not one.
 *
 * Callers that need to *pass on* a failure rather than just describe it; same
 * reasoning as errorText, and the same `cause` parameter for the same reason.
 */
export const toError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));
