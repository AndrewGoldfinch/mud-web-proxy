import { existsSync as nodeExistsSync } from 'fs';
import path from 'path';
import { timingSafeEqual } from 'crypto';
import { parseAllowedTargets } from './target-policy';
import { isValidTrustedProxyEntry } from './wsproxy-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/** Throw when a present-but-unparseable value is encountered. */
const fail = (name: string, value: string, accepted: string): never => {
  throw new Error(`${name}="${value}" is invalid. Accepted form: ${accepted}`);
};

export const readBooleanEnv = (
  env: EnvLike,
  name: string,
  defaultValue: boolean,
): boolean => {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (TRUE_VALUES.has(raw)) return true;
  if (FALSE_VALUES.has(raw)) return false;
  return fail(
    name,
    env[name]!,
    Array.from(TRUE_VALUES).concat(Array.from(FALSE_VALUES)).join(', '),
  );
};

export const readIntegerEnv = (
  env: EnvLike,
  name: string,
  defaultValue: number,
): number => {
  const raw = env[name];
  if (!raw) return defaultValue;
  const trimmed = raw.trim();
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) {
    fail(name, raw, 'an integer');
  }
  return parsed;
};

export const readOptionalIntegerEnv = (
  env: EnvLike,
  name: string,
): number | undefined => {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    fail(name, raw, 'an integer or empty');
  }
  return parsed;
};

export const readEnumEnv = <T extends string>(
  env: EnvLike,
  name: string,
  options: T[],
  defaultValue: T,
): T => {
  const raw = env[name]?.trim().toLowerCase();
  if (!raw) return defaultValue;
  const normalized = options.map((o) => o.toLowerCase());
  const idx = normalized.indexOf(raw);
  if (idx === -1) {
    fail(name, env[name]!, options.join(' | '));
  }
  return options[idx] as T;
};

export const readListEnv = (
  env: EnvLike,
  name: string,
  separator = ',',
): string[] => {
  const raw = env[name];
  if (!raw) return [];
  return raw
    .split(separator)
    .map((s) => s.trim())
    .filter(Boolean);
};

const safeEqual = (actual: string, expected: string): boolean => {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
};

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface EnvLike {
  [key: string]: string | undefined;
}

export interface LogConfig {
  level: LogLevel;
  noColor: boolean;
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL_BY_NAME: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR,
};

export type InboundTlsMode = 'off' | 'required';
export type MudTlsMode = 'plain' | 'required' | 'prefer';
export type AuthMode = 'shared-secret' | 'none';
export type TargetMode = 'fixed' | 'allowlist' | 'arbitrary';

export interface ApnsConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  topic: string;
  environment: 'sandbox' | 'production';
}

export interface BackgroundPushEnvConfig {
  silentPushIntervalMs?: number;
  activityPushIntervalMs?: number;
  activityAckTimeoutMs?: number;
  fallbackCooldownMs?: number;
  maxFallbacksPerHour?: number;
  maxSnippetLength?: number;
}

export interface AppAttestConfig {
  bundleId: string;
  teamId: string;
  allowAssertionBypass: boolean;
  diagCrosskey: boolean;
  attestedKeysPath: string;
}

export interface SessionLimitsConfig {
  timeoutHours: number;
  maxPerDevice: number;
  maxPerIP: number;
  /** Undefined means unbounded; see SessionManagerConfig for the rationale. */
  maxGlobal?: number;
}

export interface RuntimeConfig {
  // Listener
  bindHost: string;
  wsPort: number;

  // Telnet target
  tnHost: string;
  tnPort: number;

  // Target policy (sibling MWP-86)
  targetMode: TargetMode;
  arbitraryAllowedPorts: string[];

  // Authentication (sibling MWP-85)
  authMode: AuthMode;
  allowQuerySecret: boolean;

  // Inbound TLS (sibling MWP-81)
  inboundTlsMode: InboundTlsMode;

  // MUD upstream TLS (sibling MWP-89)
  mudTlsMode: MudTlsMode;

  // Legacy / migration flags
  onlyAllowDefaultServer: boolean;

  // Allowed targets
  allowedTargets: string[];

  // Origin checking (sibling MWP-84)
  allowedOrigins: string[];
  allowMissingOrigin: boolean;

  // Security / auth
  requireAppAuth: boolean;
  adminToken: string;
  proxySharedSecret: string;

  // Trusted proxy
  trustedProxyCidrs: boolean | string[];

  // Session limits (sibling MWP-92)
  sessions: SessionLimitsConfig;

  // Diagnostics
  diagnosticsEnabled: boolean;

  // TLS
  tlsCertPath: string;
  tlsKeyPath: string;

  // Logging
  log: LogConfig;

  // Platform
  nodeEnv: string;

  // APNS
  apns: ApnsConfig | undefined;

  // APNS test
  apnsTestSecret: string;

  // App Attest
  appAttest: AppAttestConfig;

  // mTLS
  mtlsClientCaPath: string;
  allowMtlsFallback: boolean;

  // Background push
  backgroundPush: BackgroundPushEnvConfig;

  // Internal: raw env copy for testing
  _raw: EnvLike;
}

export interface TlsSettings {
  useTls: boolean;
  certPath: string;
  keyPath: string;
  reason: 'configured' | 'disabled' | 'missing_certs';
}

export interface ConfigValidationErrors {
  errors: string[];
}

// ---------------------------------------------------------------------------
// parseRuntimeConfig — single entry point
// ---------------------------------------------------------------------------

export const parseRuntimeConfig = (
  env: EnvLike,
  existsSync: (filePath: string) => boolean,
  basePath: string,
): { config: Readonly<RuntimeConfig>; errors: string[] } => {
  const errors: string[] = [];

  // ---- Parse every env var ----

  // Listener
  const bindHost = env.BIND_HOST || '127.0.0.1';
  const wsPort = readIntegerEnv(env, 'WS_PORT', 6200);

  // Telnet target
  const tnHost = env.TN_HOST || 'muds.maldorne.org';
  const tnPort = readIntegerEnv(env, 'TN_PORT', 5010);

  // Target policy
  const targetMode = readEnumEnv<TargetMode>(
    env,
    'TARGET_MODE',
    ['fixed', 'allowlist', 'arbitrary'],
    'fixed',
  );
  const arbitraryAllowedPorts = readListEnv(env, 'ARBITRARY_ALLOWED_PORTS');

  // Legacy flag — must fail if set
  if (env.ONLY_ALLOW_DEFAULT_SERVER !== undefined) {
    errors.push(
      'ONLY_ALLOW_DEFAULT_SERVER has been removed. ' +
        'Use TARGET_MODE=fixed (default) to restrict to a single target, ' +
        'or TARGET_MODE=allowlist/arbitrary for more flexibility.',
    );
  }

  // Authentication
  // Browsers cannot set headers on a WebSocket, so the secret can also be
  // passed as ?secret=. That puts it in access logs and referrers, so it is
  // opt-in rather than automatic.
  const allowQuerySecret = readBooleanEnv(
    env,
    'AUTH_ALLOW_QUERY_SECRET',
    false,
  );

  const authMode = readEnumEnv<AuthMode>(
    env,
    'AUTH_MODE',
    ['shared-secret', 'none'],
    'none',
  );
  const proxySharedSecret = env.PROXY_SHARED_SECRET ?? '';

  // Inbound TLS
  const inboundTlsMode = readEnumEnv<InboundTlsMode>(
    env,
    'INBOUND_TLS_MODE',
    ['off', 'required'],
    'required',
  );

  // Legacy TLS flags — must fail if set
  if (env.DISABLE_TLS !== undefined) {
    errors.push(
      'DISABLE_TLS has been removed. ' +
        'Use INBOUND_TLS_MODE=off to disable inbound TLS. ' +
        'Note: INBOUND_TLS_MODE=off is only allowed when BIND_HOST is loopback.',
    );
  }
  if (env.ALLOW_INSECURE_PRODUCTION_NO_TLS !== undefined) {
    errors.push(
      'ALLOW_INSECURE_PRODUCTION_NO_TLS has been removed. ' +
        'Use INBOUND_TLS_MODE=off (loopback only) or ' +
        'INBOUND_TLS_MODE=required with valid TLS_CERT_PATH/TLS_KEY_PATH.',
    );
  }

  // TLS paths
  const tlsCertPath = env.TLS_CERT_PATH || path.resolve(basePath, 'cert.pem');
  const tlsKeyPath = env.TLS_KEY_PATH || path.resolve(basePath, 'privkey.pem');

  // MUD upstream TLS
  // Defaults to `prefer`, NOT `plain`. Current behaviour is to attempt TLS
  // and fall back, so defaulting to `plain` would stop attempting TLS
  // entirely — silently downgrading every deployment that reaches a MUD
  // supporting it, via the very change meant to prevent downgrades.
  const mudTlsMode = readEnumEnv<MudTlsMode>(
    env,
    'MUD_TLS_MODE',
    ['plain', 'required', 'prefer'],
    'prefer',
  );

  // Allowed targets
  const allowedTargets = readListEnv(env, 'ALLOWED_TARGETS');

  // Origin checking
  const allowedOrigins = readListEnv(env, 'ALLOWED_ORIGINS');
  const allowMissingOrigin = readBooleanEnv(
    env,
    'ALLOW_MISSING_ORIGIN',
    false,
  );

  // Validate origin entries
  for (const origin of allowedOrigins) {
    if (origin === '*') {
      errors.push(
        `ALLOWED_ORIGINS contains "*" wildcard. Wildcards are not accepted; list exact origins (e.g. "https://app.example.com").`,
      );
    }
    if (!/^https?:\/\/[^/]+$/.test(origin)) {
      errors.push(
        `ALLOWED_ORIGINS contains malformed entry "${origin}". Expected scheme + host + optional port (e.g. "https://app.example.com:8443").`,
      );
    }
  }

  // Trusted proxy
  const trustedProxyRaw = env.TRUSTED_PROXY_CIDRS?.trim().toLowerCase();
  let trustedProxyCidrs: boolean | string[] = false;
  if (trustedProxyRaw === 'true') {
    trustedProxyCidrs = true;
  } else if (trustedProxyRaw && trustedProxyRaw !== 'false') {
    const entries = trustedProxyRaw
      .split(',')
      .map((cidr) => cidr.trim())
      .filter(Boolean);

    // A malformed entry must abort rather than be accepted and match nothing.
    // Silently ignoring it leaves forwarded headers unhonoured, collapsing
    // every client onto the proxy's own address and tripping per-IP limits
    // service-wide — while reading as configured.
    const invalid = entries.filter((e) => !isValidTrustedProxyEntry(e));
    if (invalid.length > 0) {
      errors.push(
        `TRUSTED_PROXY_CIDRS contains invalid ${
          invalid.length === 1 ? 'entry' : 'entries'
        }: ${invalid.join(', ')}. Expected IPv4/IPv6 addresses or CIDR ` +
          'ranges (e.g. "127.0.0.1,10.0.0.0/8,2001:db8::/32"), or ' +
          'true/false.',
      );
    }

    trustedProxyCidrs = entries;
  }

  // Retired TRUST_PROXY name
  if (env.TRUST_PROXY !== undefined) {
    errors.push(
      'TRUST_PROXY has been renamed to TRUSTED_PROXY_CIDRS. ' +
        'Update the environment; the old name is no longer honoured.',
    );
  }

  // Diagnostics
  const diagnosticsEnabled = readBooleanEnv(env, 'ENABLE_DIAGNOSTICS', false);
  const adminToken = env.ADMIN_TOKEN || '';

  // Logging
  const logLevelName = readEnumEnv<'debug' | 'info' | 'warn' | 'error'>(
    env,
    'LOG_LEVEL',
    ['debug', 'info', 'warn', 'error'],
    'info',
  );
  const logLevel = LOG_LEVEL_BY_NAME[logLevelName];
  const noColor = env.NO_COLOR === '1';

  // Platform
  const nodeEnv = env.NODE_ENV || 'development';

  // APNS
  const apnsKeyPath = env.APNS_KEY_PATH;
  let apns: ApnsConfig | undefined = undefined;
  if (apnsKeyPath) {
    apns = {
      keyPath: apnsKeyPath,
      keyId: env.APNS_KEY_ID || '',
      teamId: env.APNS_TEAM_ID || '',
      topic: env.APNS_TOPIC || '',
      environment: readEnumEnv<'sandbox' | 'production'>(
        env,
        'APNS_ENVIRONMENT',
        ['sandbox', 'production'],
        'sandbox',
      ),
    };
  }

  // APNS test secret
  const apnsTestSecret = env.APNS_TEST_SECRET ?? '';

  // App Attest
  const appAttest: AppAttestConfig = {
    bundleId: env.APPATTEST_BUNDLE_ID ?? '',
    teamId: env.APPATTEST_TEAM_ID ?? '',
    allowAssertionBypass: readBooleanEnv(
      env,
      'APPATTEST_ALLOW_ASSERTION_BYPASS',
      false,
    ),
    diagCrosskey: readBooleanEnv(env, 'APPATTEST_DIAG_CROSSKEY', false),
    attestedKeysPath:
      env.ATTESTED_KEYS_PATH ||
      path.resolve(basePath, 'config/attested-keys.json'),
  };

  // mTLS
  const mtlsClientCaPath = env.MTLS_CLIENT_CA_PATH || '';
  // The production guard belongs with the flag. wsproxy.ts computed
  // `ALLOW_MTLS_FALLBACK === 'true' && NODE_ENV !== 'production'` in three
  // places while the config parsed the flag alone; centralizing on the config
  // value without the guard would have enabled the fallback in production.
  //
  // MWP-95 removes NODE_ENV-keyed security decisions entirely. Until then the
  // condition lives here, once, rather than in three copies.
  const allowMtlsFallback =
    readBooleanEnv(env, 'ALLOW_MTLS_FALLBACK', false) &&
    env.NODE_ENV !== 'production';

  // Background push
  const backgroundPush: BackgroundPushEnvConfig = {
    silentPushIntervalMs: readOptionalIntegerEnv(
      env,
      'SILENT_PUSH_INTERVAL_MS',
    ),
    activityPushIntervalMs: readOptionalIntegerEnv(
      env,
      'ACTIVITY_PUSH_INTERVAL_MS',
    ),
    activityAckTimeoutMs: readOptionalIntegerEnv(
      env,
      'ACTIVITY_PUSH_ACK_TIMEOUT_MS',
    ),
    fallbackCooldownMs: readOptionalIntegerEnv(
      env,
      'ACTIVITY_PUSH_FALLBACK_COOLDOWN_MS',
    ),
    maxFallbacksPerHour: readOptionalIntegerEnv(
      env,
      'ACTIVITY_PUSH_FALLBACK_MAX_PER_HOUR',
    ),
    maxSnippetLength: readOptionalIntegerEnv(
      env,
      'ACTIVITY_PUSH_MAX_SNIPPET_LENGTH',
    ),
  };

  // ---- Cross-field validation ----

  // TARGET_MODE=arbitrary requires enforced authentication. The client names
  // the host, so an unauthenticated arbitrary mode is an open SSRF relay.
  // Reserved-network rejection is applied on the connect path (MWP-88).
  if (targetMode === 'arbitrary' && authMode === 'none') {
    errors.push(
      'TARGET_MODE=arbitrary requires AUTH_MODE=shared-secret. Without it, ' +
        'any client could direct the proxy to connect to any host.',
    );
  }

  // TARGET_MODE=allowlist requires a non-empty, parseable ALLOWED_TARGETS.
  // An empty list must be a startup error, never a permissive fallback.
  if (targetMode === 'allowlist') {
    // Validate with the same parser validateTarget uses. A second,
    // hand-rolled check here could accept entries enforcement later drops,
    // starting the proxy in a mode that denies everything.
    if (parseAllowedTargets(allowedTargets).size === 0) {
      errors.push(
        'TARGET_MODE=allowlist requires ALLOWED_TARGETS to contain at least ' +
          'one valid host:port entry. An empty or unparseable allowlist is a ' +
          'configuration error, not a permissive default.',
      );
    }
  }

  // TARGET_MODE=arbitrary requires ARBITRARY_ALLOWED_PORTS
  if (targetMode === 'arbitrary' && arbitraryAllowedPorts.length === 0) {
    errors.push(
      'TARGET_MODE=arbitrary requires ARBITRARY_ALLOWED_PORTS to be set ' +
        '(e.g. "23,4000-4100").',
    );
  }

  // AUTH_MODE=shared-secret requires PROXY_SHARED_SECRET >= 32 bytes
  if (authMode === 'shared-secret') {
    if (!proxySharedSecret) {
      errors.push(
        'AUTH_MODE=shared-secret requires PROXY_SHARED_SECRET to be set.',
      );
    } else if (proxySharedSecret.length < 32) {
      errors.push(
        `PROXY_SHARED_SECRET must be at least 32 bytes (current length: ${proxySharedSecret.length}).`,
      );
    }
  }

  // INBOUND_TLS_MODE=required requires valid certs
  if (inboundTlsMode === 'required') {
    if (!existsSync(tlsCertPath)) {
      errors.push(
        `TLS certificate not found at ${tlsCertPath}. INBOUND_TLS_MODE=required requires both TLS_CERT_PATH and TLS_KEY_PATH to point to existing files.`,
      );
    }
    if (!existsSync(tlsKeyPath)) {
      errors.push(
        `TLS key not found at ${tlsKeyPath}. INBOUND_TLS_MODE=required requires both TLS_CERT_PATH and TLS_KEY_PATH to point to existing files.`,
      );
    }
  }

  // Plaintext in production requires the same acknowledgement, even on
  // loopback: a production deployment terminating TLS elsewhere is a
  // deliberate topology, not a default.
  if (
    inboundTlsMode === 'off' &&
    nodeEnv === 'production' &&
    !readBooleanEnv(env, 'ALLOW_INSECURE_INBOUND_NO_TLS', false)
  ) {
    errors.push(
      'INBOUND_TLS_MODE=off in production requires ' +
        'ALLOW_INSECURE_INBOUND_NO_TLS=true to acknowledge that this process ' +
        'serves plaintext and must sit behind a proxy that terminates TLS.',
    );
  }

  // INBOUND_TLS_MODE=off on non-loopback requires acknowledgement
  if (
    inboundTlsMode === 'off' &&
    bindHost !== '127.0.0.1' &&
    bindHost !== '::1'
  ) {
    if (!readBooleanEnv(env, 'ALLOW_INSECURE_INBOUND_NO_TLS', false)) {
      errors.push(
        `INBOUND_TLS_MODE=off on BIND_HOST=${bindHost} is not allowed without explicit acknowledgement. ` +
          'Set ALLOW_INSECURE_INBOUND_NO_TLS=true to acknowledge the risk, or use INBOUND_TLS_MODE=required.',
      );
    }
  }

  // TARGET_MODE=arbitrary with AUTH_MODE=none is already covered above
  // ALLOWED_ORIGINS requires allowlist to be set (unset = no restriction)

  // ---- Session limits (MWP-92) ----
  // Previously hardcoded at wsproxy.ts:147-151, so an operator could neither
  // change them nor see them reported. A limit nobody can configure is a
  // constant pretending to be a control.
  const readPositive = (name: string, fallback: number): number => {
    const value = readIntegerEnv(env, name, fallback);
    if (value <= 0) {
      errors.push(`${name} must be a positive integer (got ${value}).`);
    }
    return value;
  };

  // Absent means unbounded, so this cannot go through readPositive.
  const rawMaxGlobal = readOptionalIntegerEnv(env, 'MAX_SESSIONS_GLOBAL');
  if (rawMaxGlobal !== undefined && rawMaxGlobal <= 0) {
    errors.push(
      `MAX_SESSIONS_GLOBAL must be a positive integer when set (got ${rawMaxGlobal}). ` +
        'Leave it unset for no global bound.',
    );
  }

  const sessions: SessionLimitsConfig = {
    timeoutHours: readPositive('SESSION_TIMEOUT_HOURS', 24),
    maxPerDevice: readPositive('MAX_SESSIONS_PER_DEVICE', 5),
    maxPerIP: readPositive('MAX_SESSIONS_PER_IP', 10),
    maxGlobal: rawMaxGlobal,
  };

  // Build config object
  const config: RuntimeConfig = {
    bindHost,
    wsPort,
    tnHost,
    tnPort,
    targetMode,
    arbitraryAllowedPorts,
    authMode,
    allowQuerySecret,
    inboundTlsMode,
    mudTlsMode,
    onlyAllowDefaultServer: targetMode === 'fixed',
    allowedTargets,
    allowedOrigins,
    allowMissingOrigin,
    requireAppAuth: readBooleanEnv(env, 'REQUIRE_APP_AUTH', false),
    adminToken,
    proxySharedSecret,
    trustedProxyCidrs,
    sessions,
    diagnosticsEnabled,
    tlsCertPath,
    tlsKeyPath,
    log: { level: logLevel, noColor },
    nodeEnv,
    apns,
    apnsTestSecret,
    appAttest,
    mtlsClientCaPath,
    allowMtlsFallback,
    backgroundPush,
    _raw: env,
  };

  return { config: Object.freeze(config), errors };
};

// ---------------------------------------------------------------------------
// getRuntimeConfig — thin wrapper for existing callers (backward compat)
// ---------------------------------------------------------------------------

/**
 * Legacy entry point. Uses the defaults from the sibling issues
 * (TARGET_MODE=fixed, AUTH_MODE=none, INBOUND_TLS_MODE=required)
 * and delegates to parseRuntimeConfig.
 *
 * New code should call parseRuntimeConfig directly.
 */
export const getRuntimeConfig = (
  env: EnvLike,
  existsSync: (filePath: string) => boolean = nodeExistsSync,
  basePath: string = process.cwd(),
): RuntimeConfig => {
  // Only an *explicitly* configured INBOUND_TLS_MODE=required makes missing
  // certificates fatal. Previously these errors were filtered out
  // unconditionally, so `required` fell back to a plaintext listener — the
  // setting was accepted and then ignored. Defaulted behaviour still defers
  // to resolveTlsSettings, which existing callers depend on.
  const explicitlyRequired =
    env.INBOUND_TLS_MODE?.trim().toLowerCase() === 'required';

  const { config, errors } = parseRuntimeConfig(
    env,
    explicitlyRequired ? existsSync : () => false,
    basePath,
  );

  const fatalErrors = explicitlyRequired
    ? errors
    : errors.filter(
        (e) =>
          !e.includes('TLS certificate not found') &&
          !e.includes('TLS key not found'),
      );
  if (fatalErrors.length > 0) {
    throw new Error('Configuration errors:\n  ' + fatalErrors.join('\n  '));
  }
  return config;
};

// ---------------------------------------------------------------------------
// resolveTlsSettings — backward compatible wrapper
// ---------------------------------------------------------------------------

export const resolveTlsSettings = (
  env: EnvLike,
  basePath: string,
  existsSync: (filePath: string) => boolean,
): TlsSettings => {
  // Use the legacy logic for backward compatibility with existing tests
  // that test resolveTlsSettings directly.
  let certPath = env.TLS_CERT_PATH || path.resolve(basePath, 'cert.pem');
  let keyPath = env.TLS_KEY_PATH || path.resolve(basePath, 'privkey.pem');
  const production = env.NODE_ENV === 'production';
  const allowInsecureProductionNoTls = readBooleanEnv(
    env,
    // Honour the live variable; the retired one is still accepted here only
    // so the legacy DISABLE_TLS tests keep exercising this wrapper.
    'ALLOW_INSECURE_INBOUND_NO_TLS',
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

  const inboundTlsMode = readEnumEnv(
    env,
    'INBOUND_TLS_MODE',
    ['required', 'off', 'optional'],
    'required',
  );
  if (inboundTlsMode === 'off') {
    if (production && !allowInsecureProductionNoTls) {
      throw new Error(
        'INBOUND_TLS_MODE=off is not allowed in production without ' +
          'ALLOW_INSECURE_INBOUND_NO_TLS=true',
      );
    }
    return { useTls: false, certPath, keyPath, reason: 'disabled' };
  }

  if (existsSync(certPath) && existsSync(keyPath)) {
    return { useTls: true, certPath, keyPath, reason: 'configured' };
  }

  if (
    !env.TLS_CERT_PATH &&
    !env.TLS_KEY_PATH &&
    path.basename(basePath) === 'dist'
  ) {
    const parentCertPath = path.resolve(basePath, '..', 'cert.pem');
    const parentKeyPath = path.resolve(basePath, '..', 'privkey.pem');
    if (existsSync(parentCertPath) && existsSync(parentKeyPath)) {
      certPath = parentCertPath;
      keyPath = parentKeyPath;
      return { useTls: true, certPath, keyPath, reason: 'configured' };
    }
  }

  if (production && !allowInsecureProductionNoTls) {
    throw new Error(
      'TLS certificate and key are required in production unless ' +
        'ALLOW_INSECURE_INBOUND_NO_TLS=true',
    );
  }

  return { useTls: false, certPath, keyPath, reason: 'missing_certs' };
};

// ---------------------------------------------------------------------------
// isDiagnosticRequestAuthorized — kept for backward compat
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// escapeDiagnosticHtml — kept for backward compat
// ---------------------------------------------------------------------------

export const escapeDiagnosticHtml = (value: unknown): string => {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const readHeader = (
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string => {
  const value = headers[name.toLowerCase()] ?? headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
};
