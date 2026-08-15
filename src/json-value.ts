// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * The vocabulary type for decoded JSON.
 *
 * Its own module because several boundaries need it — the client protocol, the
 * target policy, the logger — and none of them should have to depend on
 * another just to name the thing that came off the wire.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

/** A decoded JSON object. Client messages are always objects at the top level. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * A value on its way *out* to JSON.
 *
 * Distinct from JsonValue because it admits `undefined`: `JSON.stringify`
 * drops an undefined property rather than emitting it, so an optional field
 * on an outbound payload is legitimate. Nothing coming *in* from JSON.parse
 * can be undefined, which is why the inbound type does not allow it.
 */
export type JsonSerializable =
  | string
  | number
  | boolean
  | null
  | undefined
  | readonly JsonSerializable[]
  | { readonly [key: string]: JsonSerializable };

/** An object on its way out to JSON. */
export type JsonSerializableObject = {
  readonly [key: string]: JsonSerializable;
};
