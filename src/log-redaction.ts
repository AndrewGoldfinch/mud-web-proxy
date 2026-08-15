// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Log redaction, applied centrally (MWP-94).
 *
 * Redaction at call sites decays. The guarantee only ever covers the log
 * statements someone remembered to wrap, and every statement added afterwards
 * is a fresh opportunity to leak — so this is applied once, inside `srv.log()`,
 * where it holds for statements nobody has written yet.
 *
 * Three distinct hazards, handled separately because they fail differently:
 *
 *  - **Secrets by value.** The shared secret and admin token are known strings.
 *    Anything containing one must not reach a log regardless of how it got
 *    there, including via an error message from a library.
 *  - **Identifiers.** Session and device tokens are credentials, but operators
 *    have a real need to correlate lines across a session. A stable truncated
 *    hash preserves correlation without the log holding the credential.
 *  - **Control sequences.** Log content is chosen by an attacker. An operator
 *    who runs `cat` on a log file hands their terminal to whoever wrote those
 *    bytes: ANSI can move the cursor and overwrite lines already read, and OSC
 *    can retitle the window. Stripping protects the reader, not the data.
 */

import { createHash } from 'crypto';

/** Length of the truncated hex digest used for identifiers. */
import { z } from 'zod';
import type { JsonValue } from './json-value';

const SHORT_HASH_HEX_CHARS = 12;

/**
 * ANSI/VT escape sequences: OSC (`ESC ] … BEL` or `ESC ] … ESC \`) and CSI
 * (`ESC [ params intermediates final`).
 *
 * A bare `ESC` followed by an ordinary character is deliberately NOT matched
 * here. Consuming the following character would neutralize two-character
 * sequences such as `ESC c`, but it buys nothing: once the `ESC` byte itself is
 * stripped — which CONTROL_CHARS does — no sequence can execute, and eating
 * the next character silently destroys real log content instead.
 *
 * One pass, not a loop to stability: "strip until nothing changes" over
 * attacker-chosen input is how a redactor becomes the denial of service.
 */
const ANSI_SEQUENCES =
  // eslint-disable-next-line no-control-regex
  /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/g;

/**
 * Remaining C0 and C1 control characters, after escape sequences are gone.
 * Tab is handled separately: deleting it would silently join two fields.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x08\x0a-\x1f\x7f-\x9f]/g;

/**
 * Remove anything that could manipulate a terminal or forge a log line.
 *
 * Newlines and carriage returns go too — left in, attacker content can
 * fabricate what looks like a separate, authentic log entry.
 */
export const neutralizeControlSequences = (value: string): string =>
  value
    .replace(ANSI_SEQUENCES, '')
    .replace(/\t/g, ' ')
    .replace(CONTROL_CHARS, '');

/**
 * A stable, short, non-reversible label for an identifier.
 *
 * Prefixed so a reader can tell at a glance that a value has been hashed
 * rather than truncated — an unlabelled 12-hex-character string looks like it
 * might be the real identifier.
 */
export const shortHash = (value: string): string =>
  `sha:${createHash('sha256').update(value).digest('hex').slice(0, SHORT_HASH_HEX_CHARS)}`;

export interface RedactionOptions {
  /**
   * Literal values to remove wherever they appear. Empty and undefined entries
   * are ignored: treating '' as a value to replace would insert the marker
   * between every character, and "no shared secret configured" is an ordinary
   * state.
   */
  secrets: (string | undefined)[];
}

/** What a log call can carry: rendered text, an error, or a value to serialise. */
export type LogMessage =
  string | number | boolean | null | undefined | Error | JsonValue;

const logTextSchema = z.string();

const toText = (value: LogMessage): string => {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (value instanceof Error) return value.message;

  const text = logTextSchema.safeParse(value);
  if (text.success) return text.data;

  // Primitives stringify to themselves; `Object(v) === v` is true for exactly
  // the non-primitives, which are the ones worth sending through JSON so the
  // line carries their contents rather than "[object Object]".
  if (Object(value) !== value) return String(value);

  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    // Circular or otherwise unserializable: not worth throwing from inside a
    // log call for.
    return '[unserializable]';
  }
};

/**
 * Prepare a value for a log line: coerce, strip control sequences, then remove
 * secrets.
 *
 * The order matters. Control characters are removed **first** so a secret
 * cannot be smuggled past the value match by splitting it with an escape
 * sequence — `hun\x1b[0mter2` contains no literal `hunter2` until the escape
 * is gone.
 */
export const redactLogMessage = (
  value: LogMessage,
  options: RedactionOptions,
): string => {
  let text = neutralizeControlSequences(toText(value));

  for (const secret of options.secrets) {
    if (!secret) continue;
    // Split/join rather than a constructed RegExp: secrets are operator-chosen
    // and may contain regex metacharacters, which would either throw or match
    // something other than the literal value.
    text = text.split(secret).join('[redacted]');
  }

  return text;
};

/**
 * A log-safe summary of a credential: device token, App Attest key id, or any
 * other value that identifies while also authenticating.
 *
 * Several call sites each built their own `value.slice(0, 8) + '... (len=N)'`.
 * A prefix of a credential is credential material — enough to correlate, and
 * also a genuine fragment of a real secret, so "redacted" in name only. Worse,
 * the duplication meant fixing one site left six others leaking, which is
 * exactly what happened. One helper, used everywhere.
 *
 * Length is retained: it is genuinely useful for spotting a truncated or
 * malformed token and reveals nothing.
 */
export const tokenSummary = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '<empty>';
  return `${shortHash(trimmed)} (len=${trimmed.length})`;
};
