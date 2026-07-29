/**
 * Pure shape recognition and field validation for client messages.
 *
 * This module has no socket or I/O dependency so that the recognition rules
 * and the per-type field checks can be unit tested directly. `parse()` in
 * wsproxy.ts and SessionIntegration.parseNewMessage are its only consumers.
 */

/** Outcome of attempting to handle one client message. */
export type ParseOutcome =
  | { kind: 'handled' }
  | { kind: 'not-ours'; parsedObject?: Record<string, unknown> }
  | { kind: 'invalid'; code: string; field?: string; reason: string };

export type Recognition =
  | { shape: 'typed'; type: string }
  | { shape: 'legacy' }
  | { shape: 'unrecognized' };

export type FieldValidation =
  { ok: true } | { ok: false; field: string; reason: string };

export type LegacyConnect = { host?: string; port?: number };

export type LegacyValidation =
  | { ok: true; value: LegacyConnect }
  | { ok: false; field: string; reason: string };

/** The message types SessionIntegration dispatches. */
export const KNOWN_TYPES = [
  'connect',
  'resume',
  'activityToken',
  'syncAck',
  'input',
  'naws',
  'disconnect',
] as const;

export type KnownType = (typeof KNOWN_TYPES)[number];

const MAX_TYPE_NAME_LENGTH = 32;
const MIN_PORT = 1;
const MAX_PORT = 65535;
const MIN_DIMENSION = 1;
const MAX_DIMENSION = 65535;

/**
 * Render a client-supplied type value for an error message. The value is
 * attacker-controlled, so it is stripped of control characters and bounded
 * before it reaches a response or a log line.
 */
export const safeTypeName = (value: unknown): string => {
  if (typeof value !== 'string') return `<${typeof value}>`;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, '');
  return cleaned.slice(0, MAX_TYPE_NAME_LENGTH);
};

const isNonEmptyString = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;

const isString = (v: unknown): v is string => typeof v === 'string';

const isIntegerInRange = (v: unknown, min: number, max: number): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const isNonNegativeInteger = (v: unknown): boolean =>
  typeof v === 'number' && Number.isInteger(v) && v >= 0;

const isAbsent = (o: Record<string, unknown>, key: string): boolean =>
  !(key in o) || o[key] === undefined || o[key] === null;

const bad = (field: string, reason: string): FieldValidation => ({
  ok: false,
  field,
  reason,
});

const PORT_REASON = `port must be an integer between ${MIN_PORT} and ${MAX_PORT}`;
const DIMENSION_REASON = `must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`;

/**
 * Classify a parsed JSON value. A recognized shape is dispatched or rejected;
 * an unrecognized one is ordinary player input and goes to the MUD.
 *
 * `type` takes precedence over `connect` so a typed message carrying an
 * incidental `connect` field is never mistaken for the legacy protocol.
 */
export const recognize = (parsed: unknown): Recognition => {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { shape: 'unrecognized' };
  }
  const o = parsed as Record<string, unknown>;
  if ('type' in o) return { shape: 'typed', type: safeTypeName(o.type) };
  if ('connect' in o) return { shape: 'legacy' };
  return { shape: 'unrecognized' };
};

/** Validate the fields of a known typed message. */
export const validateTyped = (
  type: string,
  o: Record<string, unknown>,
): FieldValidation => {
  switch (type) {
    case 'connect':
      if (!isNonEmptyString(o.host)) {
        return bad('host', 'host must be a non-empty string');
      }
      if (!isIntegerInRange(o.port, MIN_PORT, MAX_PORT)) {
        return bad('port', PORT_REASON);
      }
      if (
        !isAbsent(o, 'width') &&
        !isIntegerInRange(o.width, MIN_DIMENSION, MAX_DIMENSION)
      ) {
        return bad('width', `width ${DIMENSION_REASON}`);
      }
      if (
        !isAbsent(o, 'height') &&
        !isIntegerInRange(o.height, MIN_DIMENSION, MAX_DIMENSION)
      ) {
        return bad('height', `height ${DIMENSION_REASON}`);
      }
      if (!isAbsent(o, 'deviceToken') && !isNonEmptyString(o.deviceToken)) {
        return bad('deviceToken', 'deviceToken must be a non-empty string');
      }
      return { ok: true };

    case 'resume':
      if (!isNonEmptyString(o.sessionId)) {
        return bad('sessionId', 'sessionId must be a non-empty string');
      }
      if (!isNonEmptyString(o.token)) {
        return bad('token', 'token must be a non-empty string');
      }
      if (!isNonNegativeInteger(o.lastSeq)) {
        return bad('lastSeq', 'lastSeq must be a non-negative integer');
      }
      return { ok: true };

    case 'activityToken':
      if (!isNonEmptyString(o.token)) {
        return bad('token', 'token must be a non-empty string');
      }
      return { ok: true };

    case 'syncAck':
      if (!isNonEmptyString(o.sessionId)) {
        return bad('sessionId', 'sessionId must be a non-empty string');
      }
      if (!isNonNegativeInteger(o.lastSeq)) {
        return bad('lastSeq', 'lastSeq must be a non-negative integer');
      }
      return { ok: true };

    case 'input':
      // An empty line is legitimate: the player pressed enter.
      if (!isString(o.text)) return bad('text', 'text must be a string');
      return { ok: true };

    case 'naws':
      if (!isIntegerInRange(o.width, MIN_DIMENSION, MAX_DIMENSION)) {
        return bad('width', `width ${DIMENSION_REASON}`);
      }
      if (!isIntegerInRange(o.height, MIN_DIMENSION, MAX_DIMENSION)) {
        return bad('height', `height ${DIMENSION_REASON}`);
      }
      return { ok: true };

    case 'disconnect':
      return { ok: true };

    default:
      return bad('type', `Unknown message type: ${safeTypeName(type)}`);
  }
};

/**
 * Validate a legacy connect object.
 *
 * `host` and `port` are both optional: a bare `{connect: 1}` means the
 * default target, matching initT's `s.host || srv.tn_host` fallback. The
 * default is still subject to validateTarget, so under allowlist mode it is
 * denied unless TN_HOST is itself listed.
 */
export const validateLegacy = (
  o: Record<string, unknown>,
): LegacyValidation => {
  if (!o.connect) {
    return { ok: false, field: 'connect', reason: 'connect must be truthy' };
  }

  let host: string | undefined;
  if (!isAbsent(o, 'host')) {
    if (!isNonEmptyString(o.host)) {
      return {
        ok: false,
        field: 'host',
        reason: 'host must be a non-empty string',
      };
    }
    host = o.host;
  }

  let port: number | undefined;
  if (!isAbsent(o, 'port')) {
    if (!isIntegerInRange(o.port, MIN_PORT, MAX_PORT)) {
      return { ok: false, field: 'port', reason: PORT_REASON };
    }
    port = o.port as number;
  }

  return { ok: true, value: { host, port } };
};
