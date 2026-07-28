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
const PREFIX = /^\d{1,2}$/;
const IPV4_MAX_PREFIX = 32;

/** Parse a dotted-quad into octets, or null if it is not a valid IPv4 address. */
const parseIPv4 = (value: string): number[] | null => {
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
 * bare IPv4 form in TRUST_PROXY, so both forms must compare equal. Only strip
 * the mapping prefix when what remains is genuinely IPv4, to avoid mangling
 * real IPv6 addresses.
 */
const normalizeAddress = (address: string): string => {
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

    if (!peerOctets) continue;

    const [network, prefixText] = entry.split('/');
    if (!PREFIX.test(prefixText)) continue;
    const prefix = Number(prefixText);
    if (prefix > IPV4_MAX_PREFIX) continue;

    const networkOctets = parseIPv4(normalizeAddress(network));
    if (!networkOctets) continue;

    if (matchesPrefix(peerOctets, networkOctets, prefix)) return true;
  }

  return false;
};
