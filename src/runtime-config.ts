import { existsSync as nodeExistsSync, readFileSync } from 'fs';
import path from 'path';
import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from 'crypto';
import { parseAllowedTargets } from './target-policy';
import { isValidTrustedProxyEntry } from './wsproxy-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_VALUES = new Set(['0', 'false', 'no', 'off']);

/**
 * Check that a certificate and key are usable together, returning an error
 * message or null.
 *
 * `existsSync` is not enough. A file can be present and still be unreadable,
 * truncated, or paired with the wrong key — and each of those fails at the
 * first TLS handshake rather than at startup, which turns an operator error
 * into a user-visible outage. The mismatch case is the likeliest of the three
 * in practice: a certificate renewed without its key, or copied from another
 * host.
 *
 * The pair is compared by exporting both public keys to SPKI DER rather than
 * via `X509Certificate.checkPrivateKey`, because the DER comparison behaves
 * the same across runtimes.
 */
export const validateTlsMaterial = (
  certPath: string,
  keyPath: string,
): string | null => {
  let certPem: Buffer;
  try {
    certPem = readFileSync(certPath);
  } catch (err) {
    return `TLS certificate at ${certPath} could not be read: ${(err as Error).message}`;
  }

  let keyPem: Buffer;
  try {
    keyPem = readFileSync(keyPath);
  } catch (err) {
    return `TLS key at ${keyPath} could not be read: ${(err as Error).message}`;
  }

  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certPem);
  } catch (err) {
    return `TLS certificate at ${certPath} is not a valid certificate: ${(err as Error).message}`;
  }

  let privateKey;
  try {
    privateKey = createPrivateKey(keyPem);
  } catch (err) {
    return `TLS key at ${keyPath} is not a valid private key: ${(err as Error).message}`;
  }

  try {
    const fromKey = createPublicKey(privateKey).export({
      type: 'spki',
      format: 'der',
    });
    const fromCert = certificate.publicKey.export({
      type: 'spki',
      format: 'der',
    });
    if (!fromKey.equals(fromCert)) {
      return `TLS certificate at ${certPath} does not match the private key at ${keyPath}.`;
    }
  } catch (err) {
    return `TLS certificate at ${certPath} and key at ${keyPath} could not be compared: ${(err as Error).message}`;
  }

  return null;
};

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
  // isInteger, not isFinite: the name promises an integer, and callers compare
  // against it with >=. A fractional cap of 1.5 admits 2, so the setting
  // reports one limit and enforces another.
  if (!Number.isInteger(parsed)) {
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

/** Every APNS field that must be present together for push to work. */
const APNS_REQUIRED_VARS = [
  'APNS_KEY_PATH',
  'APNS_KEY_ID',
  'APNS_TEAM_ID',
  'APNS_TOPIC',
] as const;

export interface BackgroundPushEnvConfig {
  silentPushIntervalMs?: number;
  activityPushIntervalMs?: number;
  activityAckTimeoutMs?: number;
  fallbackCooldownMs?: number;
  maxFallbacksPerHour?: number;
  maxSnippetLength?: number;
}

export interface AppAttestConfig {
  /**
   * Derived, never read directly from the environment: App Attest is on
   * exactly when it has been given the identifiers it cannot work without.
   * A separate APPATTEST_ENABLED would let the two disagree, and the
   * disagreement that matters — enabled but unconfigured — is the one that
   * registers routes which can only ever return errors.
   */
  enabled: boolean;
  bundleId: string;
  teamId: string;
  attestedKeysPath: string;
}

export interface MessageRateConfig {
  /** Frames per second for one session. */
  perSessionPerSecond: number;
  /** Frames per second for one resolved client address, across its sessions. */
  perAddressPerSecond: number;
}

export interface ShutdownConfig {
  /**
   * How long to stay up, already unready, before closing anything.
   *
   * A load balancer needs to observe the 503 before capacity disappears.
   * Skipping this window is the ordinary cause of errors during a deploy.
   */
  gracePeriodMs: number;
  /** Absolute budget for the whole drain, after which the process exits anyway. */
  deadlineMs: number;
}

export interface TelnetLimitsConfig {
  /** Cap on one subnegotiation payload before the sequence is discarded. */
  maxSubnegotiationBytes: number;
  /** Per-session output buffer used for resume replay. */
  outputBufferBytes: number;
}

export interface HeartbeatConfig {
  enabled: boolean;
  intervalMs: number;
  timeoutMs: number;
}

export interface SessionLimitsConfig {
  timeoutHours: number;
  maxPerDevice: number;
  maxPerIP: number;
  /** Undefined means unbounded; see SessionManagerConfig for the rationale. */
  maxGlobal?: number;
  resumeGraceMs?: number;
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

  // WebSocket liveness (sibling MWP-92)
  heartbeat: HeartbeatConfig;

  // Telnet-side byte caps (sibling MWP-93)
  telnet: TelnetLimitsConfig;

  // Graceful shutdown (sibling MWP-96)
  shutdown: ShutdownConfig;

  // Inbound message rate (sibling MWP-124)
  messageRate: MessageRateConfig;

  // Diagnostics
  diagnosticsEnabled: boolean;

  // TLS
  tlsCertPath: string;
  tlsKeyPath: string;

  // Logging
  log: LogConfig;

  // APNS
  apns: ApnsConfig | undefined;

  // APNS test
  apnsTestSecret: string;

  // App Attest
  appAttest: AppAttestConfig;

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
  let tlsCertPath = env.TLS_CERT_PATH || path.resolve(basePath, 'cert.pem');
  let tlsKeyPath = env.TLS_KEY_PATH || path.resolve(basePath, 'privkey.pem');

  // A compiled server started from its own dist directory keeps its
  // certificates beside the PROJECT, not beside the bundle. resolveTlsSettings
  // has always searched the parent for that layout; resolving here against
  // basePath alone aborted startup before it could, so the supported
  // deployment stopped starting. Applied only when the operator has expressed
  // no preference — an explicit path is never second-guessed.
  if (
    !env.TLS_CERT_PATH &&
    !env.TLS_KEY_PATH &&
    path.basename(basePath) === 'dist' &&
    !existsSync(tlsCertPath) &&
    !existsSync(tlsKeyPath)
  ) {
    const parentCertPath = path.resolve(basePath, '..', 'cert.pem');
    const parentKeyPath = path.resolve(basePath, '..', 'privkey.pem');
    if (existsSync(parentCertPath) && existsSync(parentKeyPath)) {
      tlsCertPath = parentCertPath;
      tlsKeyPath = parentKeyPath;
    }
  }

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

  // The two retired App Attest bypass variables are deliberately absent from
  // this function. Unlike the retired flags above, ignoring a bypass fails
  // toward the safe side: the setting is simply inert, verification stays on,
  // and there is no code path left that could consult it. Retiring them with
  // a startup error would be a weaker guarantee, not a stronger one — it
  // would mean something still reads them.

  // Retired mTLS fallback (MWP-95). It was gated on NODE_ENV !== 'production',
  // which is not a security boundary: NODE_ENV is unset far more often than
  // operators assume, and an unset NODE_ENV enabled the fallback.
  if (env.ALLOW_MTLS_FALLBACK !== undefined) {
    errors.push(
      'ALLOW_MTLS_FALLBACK has been removed. Client certificates are no ' +
        'longer accepted as a substitute for an App Attest assertion. ' +
        'Use AUTH_MODE=shared-secret for clients that cannot attest.',
    );
  }
  if (env.MTLS_CLIENT_CA_PATH !== undefined) {
    errors.push(
      'MTLS_CLIENT_CA_PATH has been removed along with ALLOW_MTLS_FALLBACK. ' +
        'The proxy no longer requests client certificates.',
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

  // APNS — optional, off unless fully configured.
  //
  // Presence of the whole set is the switch. Partial configuration used to
  // build an `apns` object out of one variable and empty strings for the
  // rest, so a typo in APNS_TOPIC produced a "configured" manager that failed
  // every push at Apple with a 4xx nobody was watching for.
  const apnsProvided = APNS_REQUIRED_VARS.filter(
    (name) => !!env[name]?.trim(),
  );
  let apns: ApnsConfig | undefined = undefined;
  if (apnsProvided.length > 0) {
    const missing = APNS_REQUIRED_VARS.filter((name) => !env[name]?.trim());
    if (missing.length > 0) {
      errors.push(
        `APNS is partially configured: ${apnsProvided.join(', ')} set but ` +
          `${missing.join(', ')} missing. Set all of ` +
          `${APNS_REQUIRED_VARS.join(', ')} to enable push, or none to ` +
          'disable it.',
      );
    } else {
      apns = {
        keyPath: env.APNS_KEY_PATH!.trim(),
        keyId: env.APNS_KEY_ID!.trim(),
        teamId: env.APNS_TEAM_ID!.trim(),
        topic: env.APNS_TOPIC!.trim(),
        environment: readEnumEnv<'sandbox' | 'production'>(
          env,
          'APNS_ENVIRONMENT',
          ['sandbox', 'production'],
          'sandbox',
        ),
      };
    }
  }

  // APNS test secret
  const apnsTestSecret = env.APNS_TEST_SECRET ?? '';

  // App Attest — optional, off unless fully configured. Both identifiers are
  // required because verification uses both: bundleId for the rpIdHash and
  // teamId for the App ID the attestation nonce is bound to.
  const appAttestBundleId = env.APPATTEST_BUNDLE_ID?.trim() ?? '';
  const appAttestTeamId = env.APPATTEST_TEAM_ID?.trim() ?? '';
  const appAttest: AppAttestConfig = {
    enabled: Boolean(appAttestBundleId && appAttestTeamId),
    bundleId: appAttestBundleId,
    teamId: appAttestTeamId,
    attestedKeysPath:
      env.ATTESTED_KEYS_PATH ||
      path.resolve(basePath, 'config/attested-keys.json'),
  };

  if (Boolean(appAttestBundleId) !== Boolean(appAttestTeamId)) {
    errors.push(
      'App Attest is partially configured: ' +
        `${appAttestBundleId ? 'APPATTEST_BUNDLE_ID' : 'APPATTEST_TEAM_ID'} ` +
        'is set but ' +
        `${appAttestBundleId ? 'APPATTEST_TEAM_ID' : 'APPATTEST_BUNDLE_ID'} ` +
        'is missing. Set both to enable App Attest, or neither to disable it.',
    );
  }

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

  // There used to be a second plaintext check here that fired when
  // NODE_ENV === 'production', on loopback as well as off it. MWP-95 removes
  // it: the bind address is the honest signal about who can reach the
  // listener, and NODE_ENV is a string the same operator sets — unset far
  // more often than assumed, so the guard was absent exactly where it was
  // most needed. The non-loopback check below is what actually protects the
  // socket, and it is not keyed on the environment name.

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

  // ---- WebSocket liveness (MWP-92) ----
  // On by default: without pings a half-open connection holds its session slot
  // until the 24-hour session timeout, so the connection caps bound live
  // clients while dead ones accumulate underneath.
  const heartbeatEnabled = readBooleanEnv(env, 'WS_HEARTBEAT_ENABLED', true);
  const heartbeatIntervalMs = readIntegerEnv(
    env,
    'WS_HEARTBEAT_INTERVAL_MS',
    30_000,
  );
  const heartbeatTimeoutMs = readIntegerEnv(
    env,
    'WS_HEARTBEAT_TIMEOUT_MS',
    90_000,
  );

  if (heartbeatIntervalMs <= 0) {
    errors.push(
      `WS_HEARTBEAT_INTERVAL_MS must be a positive integer (got ${heartbeatIntervalMs}).`,
    );
  }
  // At or below the interval, the first sweep reclaims every peer before a
  // ping could be answered. A configuration that disconnects all clients
  // should fail to start rather than start and misbehave.
  if (heartbeatTimeoutMs <= heartbeatIntervalMs) {
    errors.push(
      `WS_HEARTBEAT_TIMEOUT_MS (${heartbeatTimeoutMs}) must be greater than ` +
        `WS_HEARTBEAT_INTERVAL_MS (${heartbeatIntervalMs}), or every peer is ` +
        'reclaimed before it can answer a ping.',
    );
  }

  const heartbeat: HeartbeatConfig = {
    enabled: heartbeatEnabled,
    intervalMs: heartbeatIntervalMs,
    timeoutMs: heartbeatTimeoutMs,
  };

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

  // How long a session with no attached client keeps its capacity. Default 45
  // minutes: silent push runs every 20 minutes, so this tolerates one lost
  // push before a backgrounded client's session is reclaimed. Reaping sooner
  // would delete the session before the push that would have woken it.
  const resumeGraceMinutes = readPositive('RESUME_GRACE_MINUTES', 45);

  const sessions: SessionLimitsConfig = {
    timeoutHours: readPositive('SESSION_TIMEOUT_HOURS', 24),
    maxPerDevice: readPositive('MAX_SESSIONS_PER_DEVICE', 5),
    maxPerIP: readPositive('MAX_SESSIONS_PER_IP', 10),
    maxGlobal: rawMaxGlobal,
    resumeGraceMs: resumeGraceMinutes * 60 * 1000,
  };

  // ---- Telnet byte caps (MWP-93) ----
  // The telnet parser is stateful across chunks, which is what lets it handle
  // an IAC sequence split over a TCP boundary — and what made an unterminated
  // subnegotiation a memory sink. Measured before the cap: 12.5 MiB streamed
  // produced 435 MiB RSS, roughly 35x, because the accumulator is a number[].
  // Defaults sit above what real MUDs send; a cap that breaks Aardwolf is a
  // worse outcome than the memory it saves.
  const maxSubnegotiationBytes = readPositive(
    'MAX_SUBNEGOTIATION_BYTES',
    64 * 1024,
  );
  const outputBufferBytes = readPositive('OUTPUT_BUFFER_BYTES', 50 * 1024);

  // ---- Inbound message rate (MWP-124) ----
  // Connection caps bound how many sessions a client may hold; these bound how
  // fast it may talk through them. Each `input` frame becomes a telnet write, so
  // the first casualty of an unthrottled client is the upstream MUD.
  //
  // Defaults are far above human typing and above what a well-behaved client
  // sends — a MUD client batches a few frames per keystroke at most. The address
  // budget is the larger, so a legitimate multi-session user is not throttled as
  // though they were one noisy session.
  const perSessionPerSecond = readPositive('MAX_MESSAGES_PER_SECOND', 60);
  const perAddressPerSecond = readPositive(
    'MAX_MESSAGES_PER_SECOND_PER_IP',
    240,
  );

  if (perAddressPerSecond < perSessionPerSecond) {
    errors.push(
      `MAX_MESSAGES_PER_SECOND_PER_IP (${perAddressPerSecond}) must be at least ` +
        `MAX_MESSAGES_PER_SECOND (${perSessionPerSecond}), or a single session ` +
        'can never reach its own allowance and the per-session limit is dead.',
    );
  }

  const messageRate: MessageRateConfig = {
    perSessionPerSecond,
    perAddressPerSecond,
  };

  // ---- Graceful shutdown (MWP-96) ----
  const shutdownGraceMs = readPositive('SHUTDOWN_GRACE_MS', 3_000);
  const shutdownDeadlineMs = readPositive('SHUTDOWN_DEADLINE_MS', 15_000);

  // The deadline has to leave room for the work that follows the grace period.
  // Accepted independently, a 20s grace against the 15s default deadline let the
  // deadline fire while still waiting — so the client close, session cleanup,
  // key flush and listener close never ran at all. A configuration that
  // silently defeats the ordered shutdown must not start.
  if (shutdownDeadlineMs <= shutdownGraceMs) {
    errors.push(
      `SHUTDOWN_DEADLINE_MS (${shutdownDeadlineMs}) must be greater than ` +
        `SHUTDOWN_GRACE_MS (${shutdownGraceMs}), or the deadline expires during ` +
        'the grace period and no connections are closed cleanly.',
    );
  }

  const shutdown: ShutdownConfig = {
    gracePeriodMs: shutdownGraceMs,
    deadlineMs: shutdownDeadlineMs,
  };

  const telnet: TelnetLimitsConfig = {
    maxSubnegotiationBytes,
    outputBufferBytes,
  };

  // REQUIRE_APP_AUTH without App Attest configured is not a stricter posture,
  // it is a closed door: every upgrade would be rejected for missing headers
  // the client has no way to obtain, because the routes that mint them are
  // not registered. Refuse to start rather than fail every connection.
  const requireAppAuth = readBooleanEnv(env, 'REQUIRE_APP_AUTH', false);
  if (requireAppAuth && !appAttest.enabled) {
    errors.push(
      'REQUIRE_APP_AUTH=true requires App Attest to be configured. Set ' +
        'APPATTEST_BUNDLE_ID and APPATTEST_TEAM_ID, or unset REQUIRE_APP_AUTH.',
    );
  }

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
    requireAppAuth,
    adminToken,
    proxySharedSecret,
    trustedProxyCidrs,
    sessions,
    heartbeat,
    telnet,
    shutdown,
    messageRate,
    diagnosticsEnabled,
    tlsCertPath,
    tlsKeyPath,
    log: { level: logLevel, noColor },
    apns,
    apnsTestSecret,
    appAttest,
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
  const { config, errors } = parseRuntimeConfig(env, existsSync, basePath);

  // `required` is also the DEFAULT, so enforcing it only when the operator
  // spelled it out meant the default path fell through to a plaintext
  // listener. Missing certificates are fatal under `required` however the
  // mode was arrived at; an operator who wants plaintext says so with
  // INBOUND_TLS_MODE=off.
  //
  // Existence is checked in parseRuntimeConfig, which takes an injected
  // existsSync and stays free of real I/O. The deeper check — readable,
  // parseable, matching pair — happens here, at the real entry point, where
  // touching the filesystem is appropriate.
  if (config.inboundTlsMode === 'required' && errors.length === 0) {
    const problem = validateTlsMaterial(config.tlsCertPath, config.tlsKeyPath);
    if (problem) errors.push(problem);
  }

  if (errors.length > 0) {
    throw new Error('Configuration errors:\n  ' + errors.join('\n  '));
  }
  return config;
};

// ---------------------------------------------------------------------------
// resolveTlsSettings — backward compatible wrapper
// ---------------------------------------------------------------------------

/**
 * Resolve which certificate and key the listener should use.
 *
 * This reports what TLS material is available; it does not decide whether
 * running without TLS is acceptable. That decision belongs to
 * parseRuntimeConfig, which runs first (`getRuntimeConfig` at the top of
 * wsproxy.ts) and aborts startup when INBOUND_TLS_MODE=required has no usable
 * pair, or when a plaintext listener on a non-loopback address has not been
 * acknowledged.
 *
 * The three `NODE_ENV === 'production'` throws that used to live here were
 * removed in MWP-95. They were a second, weaker copy of those same rules,
 * keyed on a string rather than on the mode and bind address the operator
 * actually configured — and two of them named
 * ALLOW_INSECURE_PRODUCTION_NO_TLS, a variable parseRuntimeConfig retires and
 * aborts on, so following the error message could never work.
 */
export const resolveTlsSettings = (
  env: EnvLike,
  basePath: string,
  existsSync: (filePath: string) => boolean,
): TlsSettings => {
  let certPath = env.TLS_CERT_PATH || path.resolve(basePath, 'cert.pem');
  let keyPath = env.TLS_KEY_PATH || path.resolve(basePath, 'privkey.pem');

  if (readBooleanEnv(env, 'DISABLE_TLS', false)) {
    return { useTls: false, certPath, keyPath, reason: 'disabled' };
  }

  const inboundTlsMode = readEnumEnv(
    env,
    'INBOUND_TLS_MODE',
    ['required', 'off', 'optional'],
    'required',
  );
  if (inboundTlsMode === 'off') {
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
