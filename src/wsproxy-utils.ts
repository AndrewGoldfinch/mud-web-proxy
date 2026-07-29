import { createHash, timingSafeEqual } from 'crypto';
import iconv from 'iconv-lite';
import type { IncomingMessage, ServerResponse } from 'http';
import {
  isDiagnosticRequestAuthorized,
  type RuntimeConfig,
} from './runtime-config';

const JSON_RESPONSE_HEADERS = { 'Content-Type': 'application/json' };

export interface BackgroundPushEnvConfig {
  silentPushIntervalMs?: number;
  activityPushIntervalMs?: number;
  activityAckTimeoutMs?: number;
  fallbackCooldownMs?: number;
  maxFallbacksPerHour?: number;
  maxSnippetLength?: number;
}

export type ApnsDebugAuthResult =
  'authorized' | 'disabled' | 'diagnosticUnauthorized' | 'invalidSecret';

const readOptionalNumberEnv = (
  env: NodeJS.ProcessEnv,
  name: string,
): number | undefined => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

export const resolveBackgroundPushEnvConfig = (
  env: NodeJS.ProcessEnv,
): BackgroundPushEnvConfig => {
  return {
    silentPushIntervalMs: readOptionalNumberEnv(
      env,
      'SILENT_PUSH_INTERVAL_MS',
    ),
    activityPushIntervalMs: readOptionalNumberEnv(
      env,
      'ACTIVITY_PUSH_INTERVAL_MS',
    ),
    activityAckTimeoutMs: readOptionalNumberEnv(
      env,
      'ACTIVITY_PUSH_ACK_TIMEOUT_MS',
    ),
    fallbackCooldownMs: readOptionalNumberEnv(
      env,
      'ACTIVITY_PUSH_FALLBACK_COOLDOWN_MS',
    ),
    maxFallbacksPerHour: readOptionalNumberEnv(
      env,
      'ACTIVITY_PUSH_FALLBACK_MAX_PER_HOUR',
    ),
    maxSnippetLength: readOptionalNumberEnv(
      env,
      'ACTIVITY_PUSH_MAX_SNIPPET_LENGTH',
    ),
  };
};

const readHeaderValue = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string => {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
};

const safeEqualString = (actual: string, expected: string): boolean => {
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  const hashesEqual = timingSafeEqual(actualHash, expectedHash);
  return hashesEqual && actual.length === expected.length;
};

export const authorizeApnsDebugRequest = (
  headers: Record<string, string | string[] | undefined>,
  config: Pick<RuntimeConfig, 'diagnosticsEnabled' | 'adminToken'>,
  apnsTestSecret: string,
): ApnsDebugAuthResult => {
  if (!apnsTestSecret) return 'disabled';
  if (!isDiagnosticRequestAuthorized(headers, config)) {
    return 'diagnosticUnauthorized';
  }

  const provided = readHeaderValue(headers, 'x-apns-test-secret');
  return safeEqualString(provided, apnsTestSecret)
    ? 'authorized'
    : 'invalidSecret';
};

export const readLimitedRequestBody = (
  req: IncomingMessage,
  res: ServerResponse,
  maxBodySize: number,
  onBodyTooLarge?: (bodySize: number) => void,
): Promise<Buffer | null> => {
  return new Promise((resolve, reject) => {
    let bodySize = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const settle = (body: Buffer | null): void => {
      if (settled) return;
      settled = true;
      resolve(body);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;

      bodySize += chunk.length;
      if (bodySize > maxBodySize) {
        if (onBodyTooLarge) onBodyTooLarge(bodySize);
        res.writeHead(413, JSON_RESPONSE_HEADERS);
        res.end(JSON.stringify({ error: 'Request body too large' }));
        req.destroy();
        settle(null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      settle(Buffer.concat(chunks));
    });

    req.on('error', (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
};

export const encodeTelnetOutbound = (
  data: string | Buffer,
  utf8Negotiated: boolean,
): Buffer => {
  if (Buffer.isBuffer(data)) return data;
  if (utf8Negotiated) return Buffer.from(data, 'utf8');
  return iconv.encode(data, 'latin1');
};

export interface Base64SendSocket {
  readyState?: number;
  send(data: string): void;
}

export const sendBase64IfOpen = (
  socket: Base64SendSocket,
  data: Buffer,
): boolean => {
  if (socket.readyState !== 1) return false;
  socket.send(data.toString('base64'));
  return true;
};

export const formatMissingTypeLogMessage = (
  parsed: unknown,
  byteLength: number,
  _rawMessage?: string,
): string => {
  const keys =
    parsed && typeof parsed === 'object'
      ? Object.keys(parsed).slice(0, 10)
      : [];
  const keySummary = keys.length ? keys.join(',') : '<none>';
  return `Ignoring JSON message without type field bytes=${byteLength} keys=${keySummary}`;
};

const IPV4_MAPPED = /^::ffff:(.+)$/;
const OCTET = /^\d{1,3}$/;
const IPV4_MAX_PREFIX = 32;

/** Parse a dotted-quad into octets, or null if it is not a valid IPv4 address. */
export const parseIPv4 = (value: string): number[] | null => {
  const parts = value.split('.');
  if (parts.length !== 4) return null;

  const octets: number[] = [];
  for (const part of parts) {
    if (!OCTET.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    octets.push(octet);
  }
  return octets;
};

/**
 * Normalize an address for comparison.
 *
 * Node reports IPv4 peers as `::ffff:a.b.c.d` on a dual-stack listener, which
 * is the default when the server binds all interfaces. Operators write the
 * bare IPv4 form in TRUSTED_PROXY_CIDRS, so both forms must compare equal. Only strip
 * the mapping prefix when what remains is genuinely IPv4, to avoid mangling
 * real IPv6 addresses.
 */
export const normalizeAddress = (address: string): string => {
  const trimmed = address.trim().toLowerCase();
  const mapped = trimmed.match(IPV4_MAPPED);
  if (mapped && parseIPv4(mapped[1])) return mapped[1];
  return trimmed;
};

/** Compare two IPv4 addresses under a prefix length. */
const matchesPrefix = (
  peer: number[],
  network: number[],
  prefix: number,
): boolean => {
  for (let i = 0; i < 4; i++) {
    const bits = Math.min(8, Math.max(0, prefix - i * 8));
    if (bits === 0) break;
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((peer[i] & mask) !== (network[i] & mask)) return false;
  }
  return true;
};

/**
 * Decide whether forwarded client-IP headers from this peer may be trusted.
 *
 * Shared by wsproxy.ts (getClientIP, requestPeer) and SessionIntegration so
 * the rate limiter and the logger never disagree about who the client is.
 * Accepts `true` (trust every peer), `false`/undefined (trust none, the
 * default), or a list of exact addresses and IPv4 CIDR ranges.
 *
 * Malformed entries never match; they are skipped so a typo fails closed
 * rather than widening trust.
 */
export const isTrustedPeer = (
  peerAddress: string | undefined,
  trustList: boolean | string[] | undefined,
): boolean => {
  if (!peerAddress || !trustList) return false;
  if (trustList === true) return true;

  const peer = normalizeAddress(peerAddress);
  const peerOctets = parseIPv4(peer);

  for (const rawEntry of trustList) {
    const entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;

    if (!entry.includes('/')) {
      if (normalizeAddress(entry) === peer) return true;
      continue;
    }

    const parts = entry.split('/');
    if (parts.length !== 2) continue;
    const [network, prefixText] = parts;
    const prefix = Number(prefixText);
    if (!/^\d{1,3}$/.test(prefixText) || !Number.isInteger(prefix)) continue;

    // Decide the family from how the entry was WRITTEN. normalizeAddress
    // collapses ::ffff:a.b.c.d to bare IPv4, so a mapped range like
    // ::ffff:0:0/96 would otherwise be read as IPv4 and its prefix rejected
    // as out of range.
    if (!network.includes(':')) {
      const networkOctets = parseIPv4(network);
      if (!networkOctets || !peerOctets) continue;
      if (prefix > IPV4_MAX_PREFIX) continue;
      if (matchesPrefix(peerOctets, networkOctets, prefix)) return true;
      continue;
    }

    // IPv6 range. Previously unsupported, so only exact IPv6 addresses
    // matched — the limitation carried in MWP-88's notes.
    const networkGroups = parseIPv6Groups(network);
    if (!networkGroups) continue;

    // normalizeAddress reduces ::ffff:a.b.c.d to bare IPv4, so a peer
    // compared against an IPv6 range needs its mapped form back. Without
    // this, ::ffff:0:0/96 — the canonical range for mapped addresses —
    // matches nothing and forwarded headers are silently ignored.
    const peerGroups =
      parseIPv6Groups(peer) ??
      (peerOctets
        ? [
            0,
            0,
            0,
            0,
            0,
            0xffff,
            (peerOctets[0] << 8) | peerOctets[1],
            (peerOctets[2] << 8) | peerOctets[3],
          ]
        : null);
    if (!peerGroups) continue;
    if (prefix > 128) continue;
    if (matchesPrefixV6(peerGroups, networkGroups, prefix)) return true;
  }

  return false;
};

// ---------------------------------------------------------------------------
// Shared-secret authentication (MWP-85)
// ---------------------------------------------------------------------------

export interface SharedSecretAuthConfig {
  authMode: 'shared-secret' | 'none';
  sharedSecret: string;
  /**
   * Accept the secret as a `secret` query parameter.
   *
   * Browsers cannot set headers on a WebSocket, so this is the only option
   * for them — but the value then appears in access logs, proxy logs, and
   * referrers. Opt-in for that reason.
   */
  allowQuerySecret: boolean;
}

export type SharedSecretAuthResult =
  { authorized: true } | { authorized: false; reason: string };

const BEARER = /^bearer\s+(.*)$/i;

/** Constant-time compare that tolerates unequal lengths. */
const secretsMatch = (supplied: string, expected: string): boolean => {
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, and the length itself is not
  // secret, so check it first.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

/**
 * Authorize a WebSocket upgrade against the configured shared secret.
 *
 * Pure and synchronous so it can be exercised directly. The caller is
 * responsible for rejecting with 401 *before* allocating any session or
 * connection-limit capacity, so failed authentication cannot consume quota.
 *
 * Never returns the supplied or configured secret in `reason` — that string
 * reaches the logs.
 */
export const authorizeSharedSecret = (
  headers: Record<string, string | string[] | undefined>,
  url: string | undefined,
  config: SharedSecretAuthConfig,
): SharedSecretAuthResult => {
  if (config.authMode !== 'shared-secret') return { authorized: true };

  if (!config.sharedSecret) {
    // Startup validation should have prevented this; fail closed regardless.
    return { authorized: false, reason: 'auth is misconfigured' };
  }

  const authorization = headers['authorization'];
  if (typeof authorization === 'string') {
    const match = authorization.match(BEARER);
    if (match) {
      const supplied = match[1].trim();
      if (supplied && secretsMatch(supplied, config.sharedSecret)) {
        return { authorized: true };
      }
      return { authorized: false, reason: 'invalid credentials' };
    }
    return { authorized: false, reason: 'unsupported authorization scheme' };
  }
  if (authorization !== undefined) {
    // Duplicate headers arrive as an array; do not guess which one was meant.
    return { authorized: false, reason: 'malformed authorization header' };
  }

  if (config.allowQuerySecret && url) {
    let supplied: string | null = null;
    try {
      supplied = new URL(url, 'http://placeholder.invalid').searchParams.get(
        'secret',
      );
    } catch {
      // A malformed URL leaves `supplied` at its initial null, which fails
      // the check below.
    }
    if (supplied && secretsMatch(supplied, config.sharedSecret)) {
      return { authorized: true };
    }
  }

  return { authorized: false, reason: 'missing or invalid credentials' };
};

export interface FailedAuthLimiterOptions {
  maxFailures: number;
  windowMs: number;
  /** Bounds the store, which is addressable by an attacker. */
  maxTrackedSources?: number;
  now?: () => number;
}

/**
 * Per-source rate limit on failed authentication.
 *
 * Without this, the shared secret is only as strong as the attacker's
 * patience. Bounded so that tracking failures cannot itself become a
 * memory-growth vector.
 */
export class FailedAuthLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly maxTrackedSources: number;
  private readonly now: () => number;

  constructor(options: FailedAuthLimiterOptions) {
    this.maxFailures = options.maxFailures;
    this.windowMs = options.windowMs;
    this.maxTrackedSources = options.maxTrackedSources ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  private recent(source: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.failures.get(source) ?? []).filter((t) => t > cutoff);
    if (kept.length === 0) this.failures.delete(source);
    else this.failures.set(source, kept);
    return kept;
  }

  recordFailure(source: string): void {
    if (
      !this.failures.has(source) &&
      this.failures.size >= this.maxTrackedSources
    ) {
      // Evict the oldest tracked source rather than growing without bound.
      const oldest = this.failures.keys().next();
      if (!oldest.done) this.failures.delete(oldest.value);
    }
    const times = this.recent(source);
    times.push(this.now());
    this.failures.set(source, times);
  }

  recordSuccess(source: string): void {
    this.failures.delete(source);
  }

  isBlocked(source: string): boolean {
    return this.recent(source).length >= this.maxFailures;
  }

  size(): number {
    return this.failures.size;
  }
}

export interface SlidingWindowLimiterOptions {
  /** Requests permitted per source within `windowMs`. */
  maxRequests: number;
  windowMs: number;
  /** Bounds the store, which is addressable by an attacker. */
  maxTrackedSources?: number;
  now?: () => number;
}

/**
 * Per-source sliding-window rate limit on successful requests.
 *
 * FailedAuthLimiter counts only failures, which is right for guessing a
 * secret but wrong for endpoints where every *successful* call costs
 * something — App Attest challenge issuance stores a nonce per request, so a
 * client that never fails is exactly the one to bound.
 *
 * The tracking store is itself capped, so rotating source addresses cannot
 * turn the limiter into the memory-growth vector it exists to prevent.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private readonly maxTrackedSources: number;
  private readonly now: () => number;

  constructor(options: SlidingWindowLimiterOptions) {
    this.maxRequests = options.maxRequests;
    this.windowMs = options.windowMs;
    this.maxTrackedSources = options.maxTrackedSources ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  /**
   * Record a request and report whether it is allowed. Returns false when the
   * source has already used its allowance for the current window.
   */
  tryConsume(source: string): boolean {
    const cutoff = this.now() - this.windowMs;
    const kept = (this.hits.get(source) ?? []).filter((t) => t > cutoff);

    if (kept.length >= this.maxRequests) {
      // Keep the trimmed list so the window still slides while blocked, but
      // do not record this attempt — otherwise a client hammering the
      // endpoint would extend its own block indefinitely.
      this.hits.set(source, kept);
      return false;
    }

    if (!this.hits.has(source) && this.hits.size >= this.maxTrackedSources) {
      const oldest = this.hits.keys().next();
      if (!oldest.done) this.hits.delete(oldest.value);
    }

    kept.push(this.now());
    this.hits.set(source, kept);
    return true;
  }

  size(): number {
    return this.hits.size;
  }
}

/** Expand an IPv6 literal into eight 16-bit groups, or null if malformed. */
export const parseIPv6Groups = (value: string): number[] | null => {
  let text = value.trim().toLowerCase().split('%')[0];
  if (!text.includes(':')) return null;

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const octets = parseIPv4(maybeV4);
    if (!octets) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = text.slice(0, lastColon + 1) + '0';
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  if (head === null) return null;

  if (halves.length === 1) {
    const all = tail.length ? head.slice(0, -1).concat(tail) : head;
    return all.length === 8 ? all : null;
  }

  const rest = toGroups(halves[1]);
  if (rest === null) return null;
  const after = tail.length ? rest.slice(0, -1).concat(tail) : rest;
  const explicit = head.length + after.length;
  // RFC 4291: `::` replaces at least one group of zeros, so eight explicit
  // groups alongside it is malformed. Accepting it would let a mistyped trust
  // entry through the fail-fast validation.
  if (explicit >= 8) return null;
  return head.concat(new Array(8 - explicit).fill(0), after);
};

const matchesPrefixV6 = (
  peer: number[],
  network: number[],
  prefix: number,
): boolean => {
  for (let i = 0; i < 8; i++) {
    const bits = Math.min(16, Math.max(0, prefix - i * 16));
    if (bits === 0) break;
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if ((peer[i] & mask) !== (network[i] & mask)) return false;
  }
  return true;
};

/**
 * Validate a trusted-proxy entry. Exported so startup can reject a malformed
 * list rather than accepting one that silently matches nothing — an operator
 * who typos this believes forwarded headers are honoured when they are not.
 */
export const isValidTrustedProxyEntry = (entry: string): boolean => {
  const value = entry.trim().toLowerCase();
  if (!value) return false;

  if (!value.includes('/')) {
    const bare = normalizeAddress(value);
    return !!parseIPv4(bare) || !!parseIPv6Groups(bare);
  }

  const parts = value.split('/');
  if (parts.length !== 2) return false;
  const [network, prefixText] = parts;
  if (!/^\d{1,3}$/.test(prefixText)) return false;
  const prefix = Number(prefixText);

  if (!network.includes(':')) {
    return !!parseIPv4(network) && prefix <= 32;
  }
  return !!parseIPv6Groups(network) && prefix <= 128;
};

/**
 * Resolve the client's real address.
 *
 * Defined once because two copies of this logic already diverged (#28), with
 * the rate limiter and the logger disagreeing about who the client was.
 *
 * An untrusted peer is taken at face value; its headers are ignored entirely.
 * For a trusted peer, `x-real-ip` wins because a proxy *sets* it, whereas
 * `x-forwarded-for` is conventionally *appended* to — so the forwarded chain
 * is walked right to left, discarding trusted hops, and the first untrusted
 * entry is the client. Reading the leftmost entry instead returns whatever
 * the caller prepended.
 */
export const resolveClientAddress = (
  peerAddress: string | undefined,
  headers: Record<string, string | string[] | undefined>,
  trustList: boolean | string[] | undefined,
): string => {
  const peer = peerAddress || '';
  if (!isTrustedPeer(peer, trustList)) return peer;

  const first = (v: string | string[] | undefined): string =>
    (Array.isArray(v) ? v[0] : v || '').trim();

  const realIP = first(headers['x-real-ip']);
  if (realIP) return realIP;

  const forwarded = first(headers['x-forwarded-for']);
  if (forwarded) {
    const hops = forwarded
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean);

    if (trustList === true) {
      // `true` says "trust any peer" and so cannot say which hops are
      // proxies — stripping trusted hops would consume the entire chain and
      // resolve every client to the peer. Take the leftmost entry, the
      // conventional reading. This is why a CIDR list is the safer setting:
      // it can distinguish a proxy hop from a client-supplied one.
      if (hops.length > 0) return hops[0];
    } else {
      for (let i = hops.length - 1; i >= 0; i--) {
        if (!isTrustedPeer(hops[i], trustList)) return hops[i];
      }
    }
  }

  return peer;
};

/**
 * Is this Origin permitted?
 *
 * Browser hardening, not authentication — it stops a page on another site
 * opening a WebSocket with a victim's ambient credentials. A non-browser
 * client sends whatever Origin it likes, so this is never a substitute for
 * AUTH_MODE.
 *
 * An empty allowlist means no restriction. A wildcard entry is never honoured:
 * startup rejects "*", and accepting it here as well would be a second door to
 * the same room.
 */
export const isOriginAllowed = (
  origin: string | undefined,
  allowedOrigins: string[],
  allowMissingOrigin: boolean,
): boolean => {
  if (allowedOrigins.length === 0) return true;

  const normalize = (value: string): string =>
    value.trim().toLowerCase().replace(/\/+$/, '');

  const supplied = normalize(origin ?? '');
  // Native clients send no Origin at all. Permitting that is an explicit
  // operator decision, because it means Origin is no longer filtering anything.
  if (!supplied) return allowMissingOrigin;

  return allowedOrigins
    .filter((entry) => entry.trim() !== '*')
    .map(normalize)
    .includes(supplied);
};
