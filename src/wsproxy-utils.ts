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
