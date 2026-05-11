import path from 'path';
import { timingSafeEqual } from 'crypto';

export interface EnvLike {
  [key: string]: string | undefined;
}

export interface RuntimeConfig {
  wsPort: number;
  tnHost: string;
  tnPort: number;
  onlyAllowDefaultServer: boolean;
  allowedTargets: string[];
  requireAppAuth: boolean;
  diagnosticsEnabled: boolean;
  adminToken: string;
}

export interface TlsSettings {
  useTls: boolean;
  certPath: string;
  keyPath: string;
  reason: 'configured' | 'disabled' | 'missing_certs';
}

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

export const readBooleanEnv = (
  env: EnvLike,
  name: string,
  defaultValue: boolean,
): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  return defaultValue;
};

export const readIntegerEnv = (
  env: EnvLike,
  name: string,
  defaultValue: number,
): number => {
  const raw = env[name];
  if (!raw) return defaultValue;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : defaultValue;
};

export const getRuntimeConfig = (env: EnvLike): RuntimeConfig => {
  const allowedTargets = (env.ALLOWED_TARGETS ?? '')
    .split(',')
    .map((target) => target.trim())
    .filter(Boolean);

  return {
    wsPort: readIntegerEnv(env, 'WS_PORT', 6200),
    tnHost: env.TN_HOST || 'muds.maldorne.org',
    tnPort: readIntegerEnv(env, 'TN_PORT', 5010),
    onlyAllowDefaultServer: readBooleanEnv(
      env,
      'ONLY_ALLOW_DEFAULT_SERVER',
      true,
    ),
    allowedTargets,
    requireAppAuth: readBooleanEnv(env, 'REQUIRE_APP_AUTH', false),
    diagnosticsEnabled: readBooleanEnv(env, 'ENABLE_DIAGNOSTICS', false),
    adminToken: env.ADMIN_TOKEN || '',
  };
};

export const resolveTlsSettings = (
  env: EnvLike,
  basePath: string,
  existsSync: (filePath: string) => boolean,
): TlsSettings => {
  const certPath = env.TLS_CERT_PATH || path.resolve(basePath, 'cert.pem');
  const keyPath = env.TLS_KEY_PATH || path.resolve(basePath, 'privkey.pem');
  const production = env.NODE_ENV === 'production';
  const allowInsecureProductionNoTls = readBooleanEnv(
    env,
    'ALLOW_INSECURE_PRODUCTION_NO_TLS',
    false,
  );

  if (readBooleanEnv(env, 'DISABLE_TLS', false)) {
    if (production && !allowInsecureProductionNoTls) {
      throw new Error(
        'DISABLE_TLS=1 is not allowed in production without ALLOW_INSECURE_PRODUCTION_NO_TLS=true',
      );
    }
    return { useTls: false, certPath, keyPath, reason: 'disabled' };
  }

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { useTls: true, certPath, keyPath, reason: 'configured' };
  }

  if (production && !allowInsecureProductionNoTls) {
    throw new Error(
      'TLS certificate and key are required in production unless ALLOW_INSECURE_PRODUCTION_NO_TLS=true',
    );
  }

  return { useTls: false, certPath, keyPath, reason: 'missing_certs' };
};

const readHeader = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string => {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
};

const safeEqual = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
};

export const isDiagnosticRequestAuthorized = (
  headers: Record<string, string | string[] | undefined>,
  config: Pick<RuntimeConfig, 'diagnosticsEnabled' | 'adminToken'>,
): boolean => {
  if (!config.diagnosticsEnabled || !config.adminToken) return false;

  const tokenHeader = readHeader(headers, 'x-admin-token');
  const authorization = readHeader(headers, 'authorization');
  const bearerPrefix = 'Bearer ';
  const bearerToken = authorization.startsWith(bearerPrefix)
    ? authorization.slice(bearerPrefix.length)
    : '';

  return (
    safeEqual(tokenHeader, config.adminToken) ||
    safeEqual(bearerToken, config.adminToken)
  );
};

export const escapeDiagnosticHtml = (value: unknown): string => {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};
