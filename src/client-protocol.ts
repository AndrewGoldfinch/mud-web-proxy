// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Pure shape recognition and field validation for client messages.
 *
 * This module has no socket or I/O dependency so that the recognition rules
 * and the per-type field checks can be unit tested directly. `parse()` in
 * wsproxy.ts and SessionIntegration.parseNewMessage are its only consumers.
 *
 * Every check is a zod schema rather than a hand-rolled predicate. The input
 * is attacker-controlled, so the decision of what a field *is* belongs to one
 * declared schema per field, not to a `typeof` test at the point of use.
 * Fields are still checked in a fixed order because callers report the first
 * offending field back to the client, and that field name is part of the
 * protocol's observable behaviour.
 */

import { z } from 'zod';

import type { JsonObject, JsonValue } from './json-value';

import type {
  ActivityTokenRequest,
  ConnectRequest,
  DisconnectRequest,
  InputRequest,
  NAWSRequest,
  ResumeRequest,
  SyncAckRequest,
} from './types/index';

export type { JsonObject, JsonValue } from './json-value';

/**
 * Which wire protocol a message came from. Carried on rejections because the
 * two protocols render errors differently: a legacy client displays whatever
 * bytes arrive, so a JSON frame would be printed into the player's terminal.
 */
export type ConnectFlavor = 'typed' | 'legacy';

/** Outcome of attempting to handle one client message. */
export type ParseOutcome =
  | { kind: 'handled' }
  | { kind: 'not-ours'; parsedObject?: JsonObject }
  /**
   * A valid legacy connect. Dispatched by the caller rather than here: the
   * legacy protocol uses the raw telnet path, whose socket wiring lives in
   * wsproxy.ts. Policy is still shared — see authorizeConnect.
   */
  | { kind: 'legacy-connect'; host?: string; port?: number }
  | {
      kind: 'invalid';
      code: string;
      field?: string;
      reason: string;
      flavor: ConnectFlavor;
    };

export type Recognition =
  | { kind: 'typed'; type: string }
  | { kind: 'legacy' }
  | { kind: 'unrecognized' };

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

const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

/**
 * A JSON object, rejecting arrays, null and primitives. `z.record` is what
 * draws that line, so the "is this even an object" question is answered by the
 * schema rather than by a null check and an `Array.isArray` at each caller.
 */
const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

const stringSchema = z.string();
const numberSchema = z.number();
const booleanSchema = z.boolean();

/** A string carrying at least one non-whitespace character. */
const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0);

const portSchema = z.number().int().min(MIN_PORT).max(MAX_PORT);
const dimensionSchema = z.number().int().min(MIN_DIMENSION).max(MAX_DIMENSION);
const nonNegativeIntegerSchema = z.number().int().min(0);

/**
 * The `typeof` label for a rejected value, derived by schema rather than by
 * the operator. Only ever used to describe a value in an error message, so it
 * keeps JavaScript's labels — including `object` for `null` — to stay
 * comparable with what the protocol reported before.
 */
const typeLabel = (value: JsonValue | undefined): string => {
  if (value === undefined) return 'undefined';
  if (stringSchema.safeParse(value).success) return 'string';
  if (numberSchema.safeParse(value).success) return 'number';
  if (booleanSchema.safeParse(value).success) return 'boolean';
  return 'object';
};

/**
 * Render a client-supplied type value for an error message. The value is
 * attacker-controlled, so it is stripped of control characters and bounded
 * before it reaches a response or a log line.
 */
export const safeTypeName = (value: JsonValue | undefined): string => {
  const asString = stringSchema.safeParse(value);
  if (!asString.success) return `<${typeLabel(value)}>`;
  // eslint-disable-next-line no-control-regex
  const cleaned = asString.data.replace(/[\u0000-\u001F\u007F]/g, '');
  return cleaned.slice(0, MAX_TYPE_NAME_LENGTH);
};

/**
 * An optional field counts as absent when missing, `undefined` or `null`, so
 * a client may send `null` for a field it has no value for.
 */
const isAbsent = (o: JsonObject, key: string): boolean =>
  !(key in o) || o[key] === undefined || o[key] === null;

const bad = (field: string, reason: string): FieldValidation => ({
  ok: false,
  field,
  reason,
});

/** `null` when the field satisfies the schema, otherwise the rejection. */
const checkField = (
  o: JsonObject,
  key: string,
  schema: z.ZodType<JsonValue>,
  reason: string,
): FieldValidation | null =>
  schema.safeParse(o[key]).success ? null : bad(key, reason);

/** As checkField, but a field the client may omit entirely. */
const checkOptionalField = (
  o: JsonObject,
  key: string,
  schema: z.ZodType<JsonValue>,
  reason: string,
): FieldValidation | null =>
  isAbsent(o, key) ? null : checkField(o, key, schema, reason);

const PORT_REASON = `port must be an integer between ${MIN_PORT} and ${MAX_PORT}`;
const DIMENSION_REASON = `must be an integer between ${MIN_DIMENSION} and ${MAX_DIMENSION}`;

/**
 * Decode a value into a client-message object, or reject it.
 *
 * Exported because the callers that need the object also need to know it was
 * one; returning `undefined` keeps that single decision in this module.
 */
export const asClientObject = (parsed: JsonValue): JsonObject | undefined => {
  const result = jsonObjectSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
};

/**
 * Classify a parsed JSON value. A recognized shape is dispatched or rejected;
 * an unrecognized one is ordinary player input and goes to the MUD.
 *
 * `type` takes precedence over `connect` so a typed message carrying an
 * incidental `connect` field is never mistaken for the legacy protocol.
 */
export const recognize = (parsed: JsonValue): Recognition => {
  const o = asClientObject(parsed);
  if (o === undefined) return { kind: 'unrecognized' };
  if ('type' in o) return { kind: 'typed', type: safeTypeName(o.type) };
  if ('connect' in o) return { kind: 'legacy' };
  return { kind: 'unrecognized' };
};

type FieldCheck = (o: JsonObject) => FieldValidation | null;

/**
 * Ordered field checks per type; the first failure is the reported one.
 *
 * A Map, not an object literal: `type` is attacker-controlled, and a plain
 * object would resolve `toString` or `constructor` through the prototype chain
 * and hand back something that is not a check list at all. The switch this
 * replaced was immune to that by construction, and so is a Map.
 */
const TYPED_FIELD_CHECKS = new Map<string, readonly FieldCheck[]>([
  [
    'connect',
    [
      (o) =>
        checkField(
          o,
          'host',
          nonEmptyStringSchema,
          'host must be a non-empty string',
        ),
      (o) => checkField(o, 'port', portSchema, PORT_REASON),
      (o) =>
        checkOptionalField(
          o,
          'width',
          dimensionSchema,
          `width ${DIMENSION_REASON}`,
        ),
      (o) =>
        checkOptionalField(
          o,
          'height',
          dimensionSchema,
          `height ${DIMENSION_REASON}`,
        ),
      (o) =>
        checkOptionalField(
          o,
          'deviceToken',
          nonEmptyStringSchema,
          'deviceToken must be a non-empty string',
        ),
    ],
  ],
  [
    'resume',
    [
      (o) =>
        checkField(
          o,
          'sessionId',
          nonEmptyStringSchema,
          'sessionId must be a non-empty string',
        ),
      (o) =>
        checkField(
          o,
          'token',
          nonEmptyStringSchema,
          'token must be a non-empty string',
        ),
      (o) =>
        checkField(
          o,
          'lastSeq',
          nonNegativeIntegerSchema,
          'lastSeq must be a non-negative integer',
        ),
    ],
  ],
  [
    'activityToken',
    [
      (o) =>
        checkField(
          o,
          'token',
          nonEmptyStringSchema,
          'token must be a non-empty string',
        ),
    ],
  ],
  [
    'syncAck',
    [
      (o) =>
        checkField(
          o,
          'sessionId',
          nonEmptyStringSchema,
          'sessionId must be a non-empty string',
        ),
      (o) =>
        checkField(
          o,
          'lastSeq',
          nonNegativeIntegerSchema,
          'lastSeq must be a non-negative integer',
        ),
    ],
  ],
  [
    // An empty line is legitimate: the player pressed enter.
    'input',
    [(o) => checkField(o, 'text', stringSchema, 'text must be a string')],
  ],
  [
    'naws',
    [
      (o) =>
        checkField(o, 'width', dimensionSchema, `width ${DIMENSION_REASON}`),
      (o) =>
        checkField(o, 'height', dimensionSchema, `height ${DIMENSION_REASON}`),
    ],
  ],
  ['disconnect', []],
]);

/** Validate the fields of a known typed message. */
export const validateTyped = (
  type: string,
  o: JsonObject,
): FieldValidation => {
  const checks = TYPED_FIELD_CHECKS.get(type);
  if (checks === undefined) {
    return bad('type', `Unknown message type: ${safeTypeName(type)}`);
  }
  for (const check of checks) {
    const failure = check(o);
    if (failure !== null) return failure;
  }
  return { ok: true };
};

/**
 * The request a validated typed message decodes to.
 *
 * Only the seven types SessionIntegration dispatches; the App Attest requests
 * travel a different path and are not decoded here.
 */
export type TypedRequest =
  | ActivityTokenRequest
  | ConnectRequest
  | DisconnectRequest
  | InputRequest
  | NAWSRequest
  | ResumeRequest
  | SyncAckRequest;

/**
 * Decoders for the dispatchable types.
 *
 * `looseObject` rather than `object`: unknown keys are carried through
 * untouched, which is what the protocol has always done and what the
 * "ignores unknown extra fields" case depends on. The schemas restate the
 * field contracts in `TYPED_FIELD_CHECKS` so the decoded value arrives typed
 * instead of asserted — validateTyped is what produces the client-facing
 * rejection, this is what produces the value.
 */
const TYPED_SCHEMAS = new Map<string, z.ZodType<TypedRequest>>([
  [
    'connect',
    z.looseObject({
      type: z.literal('connect'),
      host: z.string(),
      port: z.number(),
      deviceToken: z.string().optional(),
      apiKey: z.string().optional(),
      appToken: z.string().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      debug: z.boolean().optional(),
    }),
  ],
  [
    'resume',
    z.looseObject({
      type: z.literal('resume'),
      sessionId: z.string(),
      token: z.string(),
      lastSeq: z.number(),
      deviceToken: z.string().optional(),
      appToken: z.string().optional(),
    }),
  ],
  [
    'activityToken',
    z.looseObject({ type: z.literal('activityToken'), token: z.string() }),
  ],
  [
    'syncAck',
    z.looseObject({
      type: z.literal('syncAck'),
      sessionId: z.string(),
      lastSeq: z.number(),
    }),
  ],
  ['input', z.looseObject({ type: z.literal('input'), text: z.string() })],
  [
    'naws',
    z.looseObject({
      type: z.literal('naws'),
      width: z.number(),
      height: z.number(),
    }),
  ],
  ['disconnect', z.looseObject({ type: z.literal('disconnect') })],
]);

/**
 * Decode a message validateTyped has already accepted.
 *
 * `undefined` means the message did not decode, which validateTyped should
 * have caught first. Callers treat it as a rejection rather than asserting a
 * type onto a value that failed to parse.
 */
export const parseTypedRequest = (
  type: string,
  o: JsonObject,
): TypedRequest | undefined => {
  const schema = TYPED_SCHEMAS.get(type);
  if (schema === undefined) return undefined;
  const result = schema.safeParse(o);
  return result.success ? result.data : undefined;
};

/**
 * Validate a legacy connect object.
 *
 * `host` and `port` are both optional: a bare `{connect: 1}` means the
 * default target, matching initT's `s.host || srv.tn_host` fallback. The
 * default is still subject to validateTarget, so under allowlist mode it is
 * denied unless TN_HOST is itself listed.
 */
export const validateLegacy = (o: JsonObject): LegacyValidation => {
  if (!o.connect) {
    return { ok: false, field: 'connect', reason: 'connect must be truthy' };
  }

  let host: string | undefined;
  if (!isAbsent(o, 'host')) {
    const parsedHost = nonEmptyStringSchema.safeParse(o.host);
    if (!parsedHost.success) {
      return {
        ok: false,
        field: 'host',
        reason: 'host must be a non-empty string',
      };
    }
    host = parsedHost.data;
  }

  let port: number | undefined;
  if (!isAbsent(o, 'port')) {
    const parsedPort = portSchema.safeParse(o.port);
    if (!parsedPort.success) {
      return { ok: false, field: 'port', reason: PORT_REASON };
    }
    port = parsedPort.data;
  }

  return { ok: true, value: { host, port } };
};
