/*
Lightweight Websocket <-> Telnet Proxy

Version history:
  v1.3 - 2014-02-27 @plamzi
  v2.0 - @neverbot
  v3.0 - 2025-03   @neverbot

Original author: plamzi <plamzi@gmail.com> (2014)
Contributors:    neverbot, Andrew Goldfinch

SPDX-License-Identifier: GPL-3.0-or-later

Copyright (C) 2014, 2015 Plamen Arnaudov
Copyright (C) 2020 Ivan Alonso
Copyright (C) 2026 Andrew Goldfinch

This program is free software: you can redistribute it and/or modify it
under the terms of the GNU General Public License as published by the Free
Software Foundation, either version 3 of the License, or (at your option)
any later version.

This program is distributed in the hope that it will be useful, but
WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY
or FITNESS FOR A PARTICULAR PURPOSE. See the GNU General Public License
for more details.

You should have received a copy of the GNU General Public License along
with this program. If not, see <https://www.gnu.org/licenses/>.

The MIT notice this header previously carried is preserved in NOTICE.

Entry point. Most server logic lives in the `srv` singleton below; the
session persistence, App Attest, and APNS layers live under `src/`.

Client protocol:

  - JSON messages with a `type` field are routed to the session layer
    (types: connect, resume, input, naws, activityToken, syncAck,
    disconnect). See src/session-integration.ts.
  - Any other payload (non-JSON, or JSON without `type`) is forwarded
    raw to the telnet target, after telnet protocol negotiation.

Example (client-side JS):

  const ws = new WebSocket('wss://mywsproxyserver:6200/');
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'connect', host: 'localhost', port: 7000 }));
  };

When ONLY_ALLOW_DEFAULT_SERVER is true (default), `host`/`port` from the
client must match srv.tn_host / srv.tn_port or the connection is refused.

HTTP endpoints exposed alongside the WS upgrade: /health always;
/diagnostic and /diagnostic/api when ENABLE_DIAGNOSTICS and ADMIN_TOKEN are
set; /attest/challenge and /attest/register only when App Attest is
configured; /debug/apns/* only when APNS is configured. Endpoints belonging
to a disabled feature are not registered and 404 like any unknown path,
rather than 403 — a 403 would confirm the feature exists.

Configuration is environment-driven: WS_PORT, TN_HOST, TN_PORT,
LOG_LEVEL, ALLOWED_ORIGINS, APNS_*, APPATTEST_*.
*/

import util from 'util';
import https from 'https';
import http from 'http';
import zlib from 'zlib';
import fs from 'fs';
import { X509Certificate } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
import { z } from 'zod';
import { errorText } from './src/error-text';
const { dirname } = path;
import type { WebSocket as WS, WebSocketServer } from 'ws';
import type { Socket } from 'net';
import type { Server as HttpServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';

import os from 'os';
import { version as packageVersion } from './package.json';
import { SessionIntegration } from './src/session-integration';
import {
  connectMudTransport,
  describeTransportError,
} from './src/mud-transport';
import { HeartbeatMonitor } from './src/heartbeat';
import { ShutdownCoordinator } from './src/shutdown';
import { MessageRateLimiter } from './src/message-rate-limit';
import {
  redactLogMessage,
  tokenSummary as summarizeToken,
  type LogMessage,
} from './src/log-redaction';
import {
  escapeDiagnosticHtml,
  getRuntimeConfig,
  LogLevel,
  isDiagnosticRequestAuthorized,
  resolveTlsSettings,
} from './src/runtime-config';
import {
  PROTOCOL_CONSTANTS,
  type ProtocolConstants,
} from './src/protocol-constants';
import {
  authorizeApnsDebugRequest,
  encodeTelnetOutbound,
  FailedAuthLimiter,
  SlidingWindowLimiter,
  authorizeSharedSecret,
  formatMissingTypeLogMessage,
  isOriginAllowed,
  isTrustedPeer,
  resolveClientAddress,
  resolveSocketAddress,
  readLimitedRequestBody,
  sendBase64IfOpen,
} from './src/wsproxy-utils';
import {
  generateChallenge,
  validateAndConsumeNonce,
  verifyAttestation,
  loadAttestedKeys,
  attestedKeyStoreSummary,
  debouncedSaveAttestedKeys,
  flushAttestedKeys,
  setAttestedKey,
  verifyAssertion,
  getAttestedKey,
  updateSignCount,
} from './src/app-attest';

// Unhandled-request log rate limiting. Module-level: the counter must
// survive across requests, and there is exactly one HTTP server per process.
const UNHANDLED_LOG_INTERVAL_MS = 30_000;
let unhandledRequestLogged = 0;
let unhandledRequestSuppressed = 0;

// Log levels enum

// ANSI color codes
const Colors = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

// Parsed once in runtime-config, which rejects an unrecognized value rather
// than silently falling back to INFO as this used to.
/**
 * Values that must never appear in a log line, read from configuration rather
 * than hardcoded so a secret cannot be added in one place and forgotten in the
 * other. Recomputed per call: cheap, and it cannot go stale.
 */
const logSecrets = (): (string | undefined)[] => [
  runtimeConfig.proxySharedSecret,
  runtimeConfig.adminToken,
  runtimeConfig.apnsTestSecret,
];

const getLogLevel = (): LogLevel => runtimeConfig.log.level;

// Check if TTY for color support
const useColors = (): boolean =>
  !!process.stdout.isTTY && !runtimeConfig.log.noColor;

// Get current file directory in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const runtimeConfig = getRuntimeConfig(process.env);

// Initialize session persistence layer
const sessionIntegration = new SessionIntegration({
  // From the config module rather than literals: a limit the operator cannot
  // set is a constant pretending to be a control, and a value parsed by config
  // while enforcement reads something else is the defect class behind MWP-80.
  sessions: runtimeConfig.sessions,
  telnet: runtimeConfig.telnet,
  buffer: {
    sizeKB: 50,
  },
  triggers: {
    rateLimit: {
      perTypePerMinute: 1,
      totalPerHour: 10,
    },
  },
  // From the parsed config, not a second read of process.env. Two parsers
  // existed for the same six variables: runtimeConfig.backgroundPush was
  // computed and never read, while this re-parsed them through a laxer helper
  // that silently dropped an unparseable value where the config module aborts.
  // Config parsed in one place while enforcement reads another is the defect
  // class MWP-80 exists to remove, and it had survived to the end of Phase 1.
  backgroundPush: runtimeConfig.backgroundPush,
  targets: {
    targetMode: runtimeConfig.targetMode,
    defaultHost: runtimeConfig.tnHost,
    defaultPort: runtimeConfig.tnPort,
    allowedTargets: runtimeConfig.allowedTargets,
    arbitraryAllowedPorts: runtimeConfig.arbitraryAllowedPorts,
  },
  trustedProxyCidrs: runtimeConfig.trustedProxyCidrs,
  mudTlsMode: runtimeConfig.mudTlsMode,
  mudDialTimeoutMs: runtimeConfig.mudDialTimeoutMs,
  // APNS config from environment
  apns: runtimeConfig.apns,
});

/**
 * Inbound message rate limiting (MWP-124). Constructed once: the sliding windows
 * are the state, so a per-connection limiter would reset with every reconnect.
 */
const messageRateLimiter = new MessageRateLimiter(runtimeConfig.messageRate);

// if this is true, only allow connections to srv.tn_host, ignoring
// the server sent as argument by the client
const ONLY_ALLOW_DEFAULT_SERVER = runtimeConfig.onlyAllowDefaultServer;
/**
 * The single source of truth for the version, imported rather than restated.
 *
 * This was a second hardcoded string that had to be kept equal to
 * package.json by hand, with a test to catch the drift. Two constants that
 * must agree is the duplication pattern behind most of Phase 1's defects, and
 * here it had a specific operational cost: a release could ship reporting the
 * previous version on /health, which is the only thing an operator has to
 * confirm a deploy took effect or that a rollback landed.
 *
 * Imported as a NAMED export, not the default. esbuild inlines a relative JSON
 * import at build time — `--packages=external` marks package imports external,
 * not relative ones — but a default import embeds the whole manifest, which put
 * every devDependency into dist/wsproxy.js. The named form tree-shakes to just
 * the string, so the bundle needs no package.json beside it and carries nothing
 * else from it.
 */
const PACKAGE_VERSION: string = packageVersion;
const PROTOCOL_NEGOTIATION_TIMEOUT_MS = 12000;
const SOCKET_CLOSE_DELAY_MS = 500;

/**
 * Resolve the real client IP from proxy headers or the socket.
 * Only honours X-Real-IP / X-Forwarded-For when the socket peer is
 * in the trusted-proxy allowlist (srv.trustedProxyCidrs).  Without that
 * configuration the caller-supplied headers are silently ignored,
 * preventing IP-spoofing attacks against per-IP connection limits
 * and logging.
 */
const getClientIP = (req: IncomingMessage): string =>
  resolveClientAddress(
    req.socket?.remoteAddress,
    req.headers,
    srv.trustedProxyCidrs,
  );

/**
 * Rate limit on failed shared-secret attempts, keyed on the resolved client
 * address. Without it the secret is only as strong as the attacker's patience.
 */
const failedAuthLimiter = new FailedAuthLimiter({
  maxFailures: 10,
  windowMs: 60_000,
});

/**
 * Rate limits on the unauthenticated App Attest endpoints (MWP-95).
 *
 * Both are counted per resolved client address. Challenge issuance is the
 * looser of the two because a genuine client asks for a fresh nonce on every
 * connect and reconnect; registration happens once per device key, so a
 * source making more than a handful an hour is not a fleet of new phones.
 */
const attestChallengeLimiter = new SlidingWindowLimiter({
  maxRequests: 30,
  windowMs: 60_000,
});

const attestRegisterLimiter = new SlidingWindowLimiter({
  maxRequests: 5,
  windowMs: 60_000,
});

/**
 * WebSocket close code to reject an upgrade with.
 *
 * Rejections used to be an HTTP status written straight to the upgrade
 * socket. Under Bun those bytes are discarded — see `rejectUpgrade` — so the
 * refusal is delivered as a close frame instead, and needs a close code.
 *
 * 1013 for the two conditions that are temporary and worth retrying after a
 * wait; 1008 for a policy decision that retrying will not change.
 */
const closeCodeForStatus = (status: number): number =>
  status === 503 || status === 429 ? 1013 : 1008;

/** How long to wait for a rejected client's closing handshake before cutting it. */
const REJECT_CLOSE_TIMEOUT_MS = 1000;

export const writeTelnet = (
  s: SocketExtended,
  data: Buffer | string,
): boolean => {
  if (!s.ts?.writable) return false;
  s.ts.write(data);
  return true;
};

interface ServerState {
  sockets: Set<SocketExtended>;
}

interface TTypeConfig {
  enabled: number;
  portal: string[];
}

interface GMCPConfig {
  enabled: number;
  portal: string[];
}

/**
 * A type alias rather than an interface so it carries an implicit index
 * signature, which is what lets it be logged through `LogMessage` without an
 * assertion. Its fields are already plain JSON values.
 */
type MSDPRequest = {
  key?: string;
  val?: string | string[];
};

export interface SocketExtended extends WS {
  req: IncomingMessage & { connection: { remoteAddress: string } };
  socketId?: number;
  /**
   * Owns and latches an upstream dial until the final socket is handed off.
   * closeSocket aborts it when a legacy WebSocket closes during setup.
   */
  pendingMudTransport?: AbortController;
  ts?: TelnetSocket;
  host?: string;
  port?: number;
  /**
   * Client address counted against maxPerIP for a legacy connection, which
   * has no Session to own that capacity. Set when the dial is authorized and
   * cleared by closeSocket, which is what releases the capacity.
   */
  legacyCountedIp?: string;
  ttype: string[];
  name?: string;
  client?: string;
  utf8?: boolean;
  debug?: boolean;
  mxp_negotiated?: number;
  gmcp_negotiated?: number;
  utf8_negotiated?: number;
  new_negotiated?: number;
  new_handshake?: number;
  sga_negotiated?: number;
  echo_negotiated?: number;
  naws_negotiated?: number;
  msdp_negotiated?: number;
  password_mode?: boolean;
  /**
   * Present only on a legacy raw socket, never on a ws one. Declared here so
   * the shutdown broadcast can ask for it directly: it used to reach it
   * through `as unknown as { write?: ... }`, which is what let an earlier
   * version call `sock.write()` on every socket and silently tell WebSocket
   * clients nothing at all.
   */
  write?: (msg: string) => void;
  /**
   * The transport wrapper older `ws` releases put between this object and the
   * underlying socket. `terminate` is the modern path; this is the fallback
   * closeSocket uses when it is absent.
   */
  socket?: { terminate: () => void };
  sendUTF: (data: string | Buffer) => void;
  terminate: () => void;
  /**
   * The native ws terminate, captured before `terminate` is replaced with a
   * graceful close. Destroys the transport without a close handshake, which is
   * the only thing that works on a half-open peer.
   */
  hardTerminate?: () => void;
  remoteAddress: string;
}

export interface TelnetSocket extends Socket {
  send: (data: string | Buffer) => void;
}

let server: ServerState = { sockets: new Set() };

// WebSocket liveness (MWP-92). Null when the heartbeat is disabled, which is
// why every call site uses `?.` rather than assuming a monitor exists.
let heartbeatMonitor: HeartbeatMonitor<SocketExtended> | null = null;
// Module-scoped so the shutdown sequence can close the listener. It was a local
// inside init(), which is why the port stayed bound until process exit (MWP-96).
let httpServer: HttpServer | null = null;
// Held so a repeated signal joins the running drain rather than restarting it
// and resetting the deadline (MWP-96).
let shutdownCoordinator: ShutdownCoordinator | null = null;

/**
 * How long to wait for the listener to drain before flushing state anyway.
 * Bounded deliberately: a listener that will not close must not cost us the
 * flush of acknowledged registrations.
 */
const LISTENER_CLOSE_WAIT_MS = 2_000;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let nextSocketId = 1;

const getHeaderValue = (
  value: string | string[] | undefined,
): string | undefined => {
  // Node gives a repeated header as an array; everything else is already the
  // single value or absent, so Array.isArray is the only branch needed.
  if (Array.isArray(value)) return value.length > 0 ? value[0] : undefined;
  return value;
};

/**
 * Bodies of the JSON HTTP endpoints.
 *
 * `looseObject` keeps unknown fields rather than rejecting them, matching what
 * the casts these replaced allowed. Fields stay optional so the handlers keep
 * emitting their own field-specific errors; a body that fails these schemas is
 * malformed JSON as far as the caller is concerned, and lands in the same
 * "Invalid JSON body" branch the parse error already used.
 */
const cancelPushBodySchema = z.looseObject({
  sessionId: z.string().optional(),
  deviceToken: z.string().optional(),
});

const testPushBodySchema = z.looseObject({
  sessionId: z.string().optional(),
  deviceToken: z.string().optional(),
  title: z.string().optional(),
  message: z.string().optional(),
});

/** The attempt list an enriched assertion failure carries, when it has one. */
const attemptDetailsSchema = z.array(z.string());

const attestBodySchema = z.looseObject({
  keyId: z.string().optional(),
  attestation: z.string().optional(),
  nonce: z.string().optional(),
});

const formatWsSocketContext = (s: SocketExtended): string => {
  const wsId = `ws#${s.socketId ?? '?'}`;
  const peerIP = s.remoteAddress || s.req?.connection?.remoteAddress || '';
  const peerPort = s.req?.socket?.remotePort;
  const sourceIP = s.req?.socket?.remoteAddress || '';
  const sourcePort = s.req?.socket?.remotePort;
  const hostHeader = getHeaderValue(s.req?.headers?.host) || '-';
  const forwardedHost =
    getHeaderValue(s.req?.headers?.['x-forwarded-host']) || '-';
  const forwardedFor =
    getHeaderValue(s.req?.headers?.['x-forwarded-for']) || '-';
  const isFixedTarget = runtimeConfig.targetMode === 'fixed';
  let targetSource: 'session' | 'requested' | 'default' | 'pending' =
    isFixedTarget ? 'default' : 'pending';
  let targetHost = isFixedTarget ? srv.tn_host : '-';
  let targetPort: number | string = isFixedTarget ? srv.tn_port : '-';

  try {
    const session = sessionIntegration.sessionManager.findByWebSocket(s);
    if (session) {
      const meta = session.getMetadata();
      targetSource = 'session';
      targetHost = meta.mudHost;
      targetPort = meta.mudPort;
    } else if (s.host || s.port) {
      targetSource = 'requested';
      targetHost = s.host ?? srv.tn_host;
      targetPort = s.port ?? srv.tn_port;
    }
  } catch (_err) {
    if (s.host || s.port) {
      targetSource = 'requested';
      targetHost = s.host ?? srv.tn_host;
      targetPort = s.port ?? srv.tn_port;
    }
  }

  const telnetRemote =
    s.ts?.remoteAddress && s.ts?.remotePort
      ? `${s.ts.remoteAddress}:${s.ts.remotePort}`
      : '-';
  const peer = peerPort ? `${peerIP}:${peerPort}` : peerIP || '-';
  const source = sourcePort ? `${sourceIP}:${sourcePort}` : sourceIP || '-';

  return (
    `${wsId} peer=${peer} source=${source} ` +
    `host=${hostHeader} x-forwarded-host=${forwardedHost} ` +
    `x-forwarded-for=${forwardedFor} ` +
    `target=${targetHost}:${targetPort} ` +
    `target_source=${targetSource} telnet_remote=${telnetRemote}`
  );
};

/** One shared schema; the logger runs on every message, including hot paths. */
const stringValueSchema = z.string();

const stringify = function (value: LogMessage): string {
  const cache = new Set<LogMessage>();
  const val = JSON.stringify(value, function (_k: string, v: LogMessage) {
    // Only non-primitives can form a cycle, and `Object(v) === v` is true for
    // exactly those — no narrowing on a representation test required.
    if (v !== null && v !== undefined && Object(v) === v) {
      if (cache.has(v)) return;
      cache.add(v);
    }
    return v;
  });
  return val ?? '';
};

// Diagnostic data gathering
const getDiagnosticData = () => {
  const mem = process.memoryUsage();
  const uptimeSeconds = process.uptime();
  const sessionStats = sessionIntegration.getStats();
  const allSessions = sessionIntegration.sessionManager.getAllSessions();

  const sessions = allSessions.map((session) => {
    const meta = session.getMetadata();
    return {
      sessionIdFull: escapeDiagnosticHtml(meta.sessionId),
      sessionId: escapeDiagnosticHtml(meta.sessionId.slice(0, 8) + '...'),
      mudHost: escapeDiagnosticHtml(meta.mudHost),
      mudPort: meta.mudPort,
      telnetConnected: meta.telnetConnected,
      clientConnected: meta.clientConnected,
      clientCount: meta.clientCount,
      createdAt: new Date(meta.createdAt).toISOString(),
      lastClientConnection: meta.lastClientConnection
        ? new Date(meta.lastClientConnection).toISOString()
        : null,
      windowSize: `${meta.windowWidth}x${meta.windowHeight}`,
      bufferStats: meta.bufferStats,
    };
  });

  const sockets = Array.from(server.sockets).map((s) => ({
    remoteAddress: escapeDiagnosticHtml(
      s.req?.connection?.remoteAddress || 'unknown',
    ),
    host: s.host ? escapeDiagnosticHtml(s.host) : null,
    port: s.port || null,
    name: s.name ? escapeDiagnosticHtml(s.name) : null,
    client: s.client ? escapeDiagnosticHtml(s.client) : null,
    protocols: {
      mxp: !!s.mxp_negotiated,
      gmcp: !!s.gmcp_negotiated,
      utf8: !!s.utf8_negotiated,
      msdp: !!s.msdp_negotiated,
      sga: !!s.sga_negotiated,
      naws: !!s.naws_negotiated,
      echo: !!s.echo_negotiated,
    },
    hasTelnet: !!s.ts,
    passwordMode: !!s.password_mode,
  }));

  return {
    server: {
      version: PACKAGE_VERSION,
      uptime: uptimeSeconds,
      uptimeFormatted: formatUptime(uptimeSeconds),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      hostname: escapeDiagnosticHtml(os.hostname()),
      pid: process.pid,
      defaultHost: escapeDiagnosticHtml(srv.tn_host),
      defaultPort: srv.tn_port,
      wsPort: srv.ws_port,
      onlyAllowDefaultServer: ONLY_ALLOW_DEFAULT_SERVER,
      open: srv.open,
    },
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      external: mem.external,
      rssFormatted: formatBytes(mem.rss),
      heapUsedFormatted: formatBytes(mem.heapUsed),
      heapTotalFormatted: formatBytes(mem.heapTotal),
      externalFormatted: formatBytes(mem.external),
    },
    connections: {
      websockets: server.sockets.size,
      ...sessionStats.sessions,
    },
    notifications: sessionStats.notifications,
    apnsReadiness: sessionStats.apnsReadiness,
    sessions,
    sockets,
    timestamp: new Date().toISOString(),
  };
};

const formatUptime = (seconds: number): string => {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
};

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};

const generateDiagnosticHTML = (): string => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>mud-web-proxy diagnostic</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d;
    --text: #e6edf3; --text-dim: #8b949e; --accent: #58a6ff;
    --green: #3fb950; --yellow: #d29922; --red: #f85149;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace;
    background: var(--bg); color: var(--text);
    font-size: 14px; line-height: 1.5; padding: 20px;
  }
  h1 { font-size: 18px; margin-bottom: 4px; }
  h2 {
    font-size: 13px; text-transform: uppercase; letter-spacing: 1px;
    color: var(--accent); margin-bottom: 8px; border-bottom: 1px solid var(--border);
    padding-bottom: 4px;
  }
  .header {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 16px; border-bottom: 2px solid var(--border); padding-bottom: 8px;
  }
  .header-meta { font-size: 12px; color: var(--text-dim); }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 16px; margin-bottom: 16px; }
  .card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 6px; padding: 12px;
  }
  .stat-row { display: flex; justify-content: space-between; padding: 3px 0; }
  .stat-label { color: var(--text-dim); }
  .stat-value { font-weight: bold; }
  .badge {
    display: inline-block; padding: 1px 6px; border-radius: 3px;
    font-size: 12px; font-weight: bold;
  }
  .badge-green { background: rgba(63,185,80,0.2); color: var(--green); }
  .badge-yellow { background: rgba(210,153,34,0.2); color: var(--yellow); }
  .badge-red { background: rgba(248,81,73,0.2); color: var(--red); }
  table {
    width: 100%; border-collapse: collapse; font-size: 13px;
  }
  th {
    text-align: left; padding: 6px 8px; border-bottom: 2px solid var(--border);
    color: var(--text-dim); font-size: 11px; text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  td { padding: 5px 8px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: rgba(88,166,255,0.05); }
  .protocols span {
    display: inline-block; margin: 1px 2px; padding: 0 4px;
    border-radius: 3px; font-size: 11px;
  }
  .proto-on { background: rgba(63,185,80,0.15); color: var(--green); }
  .proto-off { background: rgba(139,148,158,0.1); color: var(--text-dim); opacity: 0.5; }
  .refresh-bar {
    position: fixed; top: 0; left: 0; right: 0; height: 2px;
    background: var(--border); z-index: 100;
  }
  .refresh-bar-inner {
    height: 100%; background: var(--accent); width: 0%;
    transition: width 1s linear;
  }
  .empty { color: var(--text-dim); font-style: italic; padding: 12px; text-align: center; }
  .control-row { display: flex; gap: 8px; margin-bottom: 8px; flex-wrap: wrap; }
  .control-row input {
    flex: 1; min-width: 180px; background: #0b0f14; color: var(--text);
    border: 1px solid var(--border); border-radius: 4px; padding: 6px 8px;
    font-family: inherit; font-size: 12px;
  }
  .control-row button {
    background: #1f6feb; color: #fff; border: none; border-radius: 4px;
    padding: 6px 10px; font-family: inherit; font-size: 12px; cursor: pointer;
  }
  .control-row button.secondary { background: #30363d; }
  .control-row button:disabled { opacity: 0.6; cursor: not-allowed; }
  .result-box {
    margin-top: 8px; background: #0b0f14; border: 1px solid var(--border);
    border-radius: 4px; padding: 8px; font-size: 12px; white-space: pre-wrap;
    color: var(--text-dim);
  }
  @media (max-width: 600px) { .grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<div class="refresh-bar"><div class="refresh-bar-inner" id="progress"></div></div>

<div class="header">
  <div>
    <h1>mud-web-proxy diagnostic</h1>
    <span class="header-meta" id="meta"></span>
  </div>
  <div class="header-meta">
    auto-refresh: <strong>5s</strong> |
    <span id="status">loading...</span>
  </div>
</div>

<div class="grid">
  <div class="card">
    <h2>Server</h2>
    <div id="server-info"></div>
  </div>
  <div class="card">
    <h2>Memory</h2>
    <div id="memory-info"></div>
  </div>
  <div class="card">
    <h2>Connections</h2>
    <div id="connections-info"></div>
  </div>
  <div class="card">
    <h2>Notifications</h2>
    <div id="notifications-info"></div>
  </div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>APNS Debug Push</h2>
  <div class="control-row">
    <input id="apns-secret" type="password" placeholder="x-apns-test-secret">
    <input id="apns-session-id" type="text" placeholder="sessionId (optional if device token set)">
  </div>
  <div class="control-row">
    <input id="apns-device-token" type="text" placeholder="deviceToken (optional if sessionId set)">
  </div>
  <div class="control-row">
    <input id="apns-alert-title" type="text" placeholder="alert title" value="MUDBasher Test">
    <input id="apns-alert-message" type="text" placeholder="alert message" value="Visible APNS test from diagnostics">
  </div>
  <div class="control-row">
    <button id="apns-silent-btn" type="button">Send Silent Push</button>
    <button id="apns-alert-btn" type="button">Send Alert Push</button>
    <button id="apns-clear-btn" class="secondary" type="button">Clear</button>
  </div>
  <div id="apns-debug-result" class="result-box">ready</div>
</div>

<div class="card" style="margin-bottom:16px">
  <h2>Active Sessions</h2>
  <div id="sessions-table"></div>
</div>

<div class="card">
  <h2>WebSocket Connections</h2>
  <div id="sockets-table"></div>
</div>

<script>
const REFRESH_MS = 5000;
let timer = 0;

function badge(val, trueClass, falseClass) {
  trueClass = trueClass || 'badge-green';
  falseClass = falseClass || 'badge-red';
  return '<span class="badge ' + (val ? trueClass : falseClass) + '">' +
    (val ? 'yes' : 'no') + '</span>';
}

function statRow(label, value) {
  return '<div class="stat-row"><span class="stat-label">' + label +
    '</span><span class="stat-value">' + value + '</span></div>';
}

function renderServer(d) {
  var s = d.server;
  document.getElementById('meta').textContent =
    'v' + s.version + ' | node ' + s.nodeVersion + ' | pid ' + s.pid;
  document.getElementById('server-info').innerHTML =
    statRow('Uptime', s.uptimeFormatted) +
    statRow('Hostname', s.hostname) +
    statRow('Platform', s.platform + '/' + s.arch) +
    statRow('WS Port', s.wsPort) +
    statRow('Default MUD', s.defaultHost + ':' + s.defaultPort) +
    statRow('Restrict Server', badge(s.onlyAllowDefaultServer, 'badge-yellow', 'badge-green')) +
    statRow('Accepting', badge(s.open));
}

function renderMemory(d) {
  var m = d.memory;
  var pct = ((m.heapUsed / m.heapTotal) * 100).toFixed(1);
  document.getElementById('memory-info').innerHTML =
    statRow('RSS', m.rssFormatted) +
    statRow('Heap Used', m.heapUsedFormatted + ' (' + pct + '%)') +
    statRow('Heap Total', m.heapTotalFormatted) +
    statRow('External', m.externalFormatted);
}

function renderConnections(d) {
  var c = d.connections;
  document.getElementById('connections-info').innerHTML =
    statRow('WebSockets', c.websockets) +
    statRow('Total Sessions', c.totalSessions) +
    statRow('Connected', '<span class="badge badge-green">' + c.connectedSessions + '</span>') +
    statRow('Disconnected', c.disconnectedSessions > 0 ?
      '<span class="badge badge-yellow">' + c.disconnectedSessions + '</span>' :
      c.disconnectedSessions) +
    statRow('Unique Devices', c.uniqueDevices) +
    statRow('Unique IPs', c.uniqueIPs);
}

function renderNotifications(d) {
  var n = d.notifications;
  var a = d.apnsReadiness || {};
  var overall = a.available ? '<span class="badge badge-green">ready</span>' :
    (a.configured ? '<span class="badge badge-yellow">degraded</span>' :
    '<span class="badge badge-red">not configured</span>');
  var hostAndEnv = a.host && a.environment ? (a.host + ' (' + a.environment + ')') :
    (a.host || a.environment || '-');
  var tokenExpiry = a.tokenExpiresAt ? new Date(a.tokenExpiresAt).toLocaleString() : '-';
  var keyId = a.keyId || '-';
  var topic = a.topic || '-';
  document.getElementById('notifications-info').innerHTML =
    statRow('Overall', overall) +
    statRow('Enabled', badge(n.enabled)) +
    statRow('Configured', badge(n.configured)) +
    statRow('Token Valid', badge(n.tokenValid)) +
    statRow('Available', badge(!!a.available)) +
    statRow('Host / Env', hostAndEnv) +
    statRow('Topic', topic) +
    statRow('Key ID', keyId) +
    statRow('Token Expires', tokenExpiry) +
    statRow('Pending', n.pendingNotifications);
}

function apnsPayloadFromInputs(includeAlertFields) {
  var sessionId = document.getElementById('apns-session-id').value.trim();
  var deviceToken = document.getElementById('apns-device-token').value.trim();
  var payload = {};
  if (sessionId) payload.sessionId = sessionId;
  if (deviceToken) payload.deviceToken = deviceToken;
  if (includeAlertFields) {
    var title = document.getElementById('apns-alert-title').value.trim();
    var message = document.getElementById('apns-alert-message').value.trim();
    if (title) payload.title = title;
    if (message) payload.message = message;
  }
  return payload;
}

function setAPNSResult(text) {
  document.getElementById('apns-debug-result').textContent = text;
}

function setAPNSButtonsDisabled(disabled) {
  document.getElementById('apns-silent-btn').disabled = disabled;
  document.getElementById('apns-alert-btn').disabled = disabled;
}

function runAPNSTest(path, payload) {
  var secret = document.getElementById('apns-secret').value.trim();
  if (!secret) {
    setAPNSResult('missing secret: enter x-apns-test-secret');
    return;
  }
  if (!payload.sessionId && !payload.deviceToken) {
    setAPNSResult('provide sessionId or deviceToken');
    return;
  }

  setAPNSButtonsDisabled(true);
  setAPNSResult('sending...');

  fetch(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-apns-test-secret': secret
    },
    body: JSON.stringify(payload)
  })
    .then(function(r) {
      return r.text().then(function(body) {
        var parsed;
        try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }
        return { ok: r.ok, status: r.status, body: parsed };
      });
    })
    .then(function(result) {
      setAPNSResult('status=' + result.status + '\\n' + JSON.stringify(result.body, null, 2));
    })
    .catch(function(err) {
      setAPNSResult('request failed: ' + err);
    })
    .finally(function() {
      setAPNSButtonsDisabled(false);
    });
}

function useSessionId(sessionId) {
  var sidInput = document.getElementById('apns-session-id');
  sidInput.value = sessionId;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(sessionId).then(function() {
      setAPNSResult('sessionId copied and loaded: ' + sessionId);
    }).catch(function() {
      setAPNSResult('sessionId loaded: ' + sessionId);
    });
  } else {
    setAPNSResult('sessionId loaded: ' + sessionId);
  }
}

function renderSessions(d) {
  var el = document.getElementById('sessions-table');
  if (!d.sessions.length) { el.innerHTML = '<div class="empty">No active sessions</div>'; return; }
  var html = '<table><tr><th>ID</th><th>MUD</th><th>Telnet</th><th>Clients</th><th>Created</th><th>Buffer</th><th>Action</th></tr>';
  d.sessions.forEach(function(s) {
    html += '<tr>' +
      '<td>' + s.sessionId + '</td>' +
      '<td>' + s.mudHost + ':' + s.mudPort + '</td>' +
      '<td>' + badge(s.telnetConnected) + '</td>' +
      '<td>' + s.clientCount + '</td>' +
      '<td>' + new Date(s.createdAt).toLocaleString() + '</td>' +
      '<td>' + (s.bufferStats ? s.bufferStats.chunks + ' chunks / ' +
        formatBytes(s.bufferStats.sizeBytes) : '-') + '</td>' +
      '<td><button type="button" class="secondary" onclick="useSessionId(\\'' + s.sessionIdFull + '\\')">Use</button></td>' +
      '</tr>';
  });
  el.innerHTML = html + '</table>';
}

function renderSockets(d) {
  var el = document.getElementById('sockets-table');
  if (!d.sockets.length) { el.innerHTML = '<div class="empty">No WebSocket connections</div>'; return; }
  var html = '<table><tr><th>Remote</th><th>MUD</th><th>User</th><th>Client</th><th>Telnet</th><th>Protocols</th></tr>';
  d.sockets.forEach(function(s) {
    var protos = '';
    Object.keys(s.protocols).forEach(function(p) {
      protos += '<span class="' + (s.protocols[p] ? 'proto-on' : 'proto-off') + '">' + p + '</span>';
    });
    html += '<tr>' +
      '<td>' + s.remoteAddress + '</td>' +
      '<td>' + (s.host ? s.host + ':' + s.port : '-') + '</td>' +
      '<td>' + (s.name || '-') + '</td>' +
      '<td>' + (s.client || '-') + '</td>' +
      '<td>' + badge(s.hasTelnet) + '</td>' +
      '<td class="protocols">' + protos + '</td>' +
      '</tr>';
  });
  el.innerHTML = html + '</table>';
}

function formatBytes(b) {
  if (!b) return '0 B';
  var k = 1024, s = ['B','KB','MB','GB'];
  var i = Math.floor(Math.log(b) / Math.log(k));
  return parseFloat((b / Math.pow(k, i)).toFixed(1)) + ' ' + s[i];
}

function refresh() {
  fetch('/diagnostic/api')
    .then(function(r) { return r.json(); })
    .then(function(d) {
      renderServer(d);
      renderMemory(d);
      renderConnections(d);
      renderNotifications(d);
      renderSessions(d);
      renderSockets(d);
      document.getElementById('status').innerHTML =
        '<span class="badge badge-green">live</span> ' +
        new Date(d.timestamp).toLocaleTimeString();
    })
    .catch(function() {
      document.getElementById('status').innerHTML =
        '<span class="badge badge-red">error</span>';
    });
}

document.getElementById('apns-silent-btn').addEventListener('click', function() {
  runAPNSTest('/debug/apns/test', apnsPayloadFromInputs(false));
});

document.getElementById('apns-alert-btn').addEventListener('click', function() {
  runAPNSTest('/debug/apns/alert-test', apnsPayloadFromInputs(true));
});

document.getElementById('apns-clear-btn').addEventListener('click', function() {
  document.getElementById('apns-device-token').value = '';
  document.getElementById('apns-alert-title').value = 'MUDBasher Test';
  document.getElementById('apns-alert-message').value = 'Visible APNS test from diagnostics';
  setAPNSResult('ready');
});

function tick() {
  timer += 1000;
  var pct = (timer / REFRESH_MS) * 100;
  document.getElementById('progress').style.width = pct + '%';
  if (timer >= REFRESH_MS) { timer = 0; refresh(); }
}

refresh();
setInterval(tick, 1000);
</script>
</body>
</html>`;
};

interface ServerConfig {
  path: string;
  ws_port: number;
  bind_host: string;
  tn_host: string;
  tn_port: number;
  debug: boolean;
  compress: boolean;
  open: boolean;
  trustedProxyCidrs: boolean | string[];
  ttype: TTypeConfig;
  gmcp: GMCPConfig;
  prt: ProtocolConstants;
  init: () => Promise<void>;
  parse: (s: SocketExtended, d: Buffer) => number;
  sendTTYPE: (s: SocketExtended, msg: string) => void;
  sendGMCP: (s: SocketExtended, msg: string) => void;
  sendMXP: (s: SocketExtended, msg: string) => void;
  sendMSDP: (s: SocketExtended, msdp: MSDPRequest) => void;
  sendMSDPPair: (s: SocketExtended, key: string, val: string) => void;
  initT: (so: SocketExtended, dialAddress?: string) => void;
  rejectLegacy: (s: SocketExtended, reason: string) => void;
  openLegacyConnection: (
    s: SocketExtended,
    host?: string,
    port?: number,
  ) => Promise<void>;
  closeSocket: (s: SocketExtended) => void;
  sendClient: (s: SocketExtended, data: Buffer) => void;
  originAllowed: (req?: IncomingMessage) => number;
  log: (
    msg: LogMessage,
    s?: SocketExtended,
    level?: LogLevel,
    context?: string,
  ) => void;
  logDebug: (msg: LogMessage, s?: SocketExtended, context?: string) => void;
  logInfo: (msg: LogMessage, s?: SocketExtended, context?: string) => void;
  logWarn: (msg: LogMessage, s?: SocketExtended, context?: string) => void;
  logError: (msg: LogMessage, s?: SocketExtended, context?: string) => void;
  die: (core?: boolean) => void;
  newSocket: (s: SocketExtended) => void;
  forward: (s: SocketExtended, d: Buffer) => void;
}

const srv: ServerConfig = {
  path: __dirname,
  /* this websocket proxy port - can be overridden with WS_PORT env var */
  ws_port: runtimeConfig.wsPort,
  bind_host: runtimeConfig.bindHost,
  /* default telnet host - can be overridden with TN_HOST env var */
  tn_host: runtimeConfig.tnHost,
  /* default telnet/target port - can be overridden with TN_PORT env var */
  tn_port: runtimeConfig.tnPort,
  /* enable additional debugging */
  debug: false,
  /*
   * Deflate legacy-protocol frames with node zlib before base64-encoding
   * them. Legacy clients inflate them; the typed protocol does not go through
   * this path.
   *
   * The old comment here told you to turn this off if your MUD could do MCCP.
   * It never applied: the MCCP negotiation was unreachable and was removed in
   * MWP-128, so this is the only compression the proxy performs. Hardcoded
   * rather than configurable, so the `!srv.compress` branch below is
   * currently unreachable — left in place because it is the seam where a
   * setting would land, not because anything sets it today.
   */
  compress: true,
  /* set to false while server is shutting down */
  open: true,

  /* trusted proxy CIDRs for client-IP header validation (default: none trusted) */
  trustedProxyCidrs: runtimeConfig.trustedProxyCidrs,

  ttype: {
    enabled: 1,
    portal: ['maldorne.org', 'XTERM-256color', 'MTTS 141'],
  },

  gmcp: {
    enabled: 1,
    portal: ['client maldorne.org', 'client_version 1.0'],
  },

  prt: PROTOCOL_CONSTANTS,

  init: async function (): Promise<void> {
    let webserver: HttpServer;
    let wsServer: WebSocketServer;

    // Get Node.js version
    const nodeVersion = process.version;
    const majorVersion = parseInt(nodeVersion.slice(1).split('.')[0], 10);

    srv.log(
      'Using node version ' + majorVersion,
      undefined,
      LogLevel.INFO,
      'init',
    );

    server = {
      sockets: new Set(),
    };

    const tlsSettings = resolveTlsSettings(
      process.env,
      __dirname,
      fs.existsSync,
    );

    if (tlsSettings.useTls) {
      const cert = fs.readFileSync(tlsSettings.certPath);
      const key = fs.readFileSync(tlsSettings.keyPath);
      // No requestCert: the proxy does not ask for client certificates. The
      // mTLS fallback that needed them was removed in MWP-95.
      const tlsOptions: https.ServerOptions = { cert, key };
      webserver = https.createServer(tlsOptions);

      // Parse and log certificate info
      try {
        const x509 = new X509Certificate(cert);
        const validFrom = x509.validFrom;
        const validTo = x509.validTo;
        const issuer =
          x509.issuer
            .split('\n')
            .find((line) => line.startsWith('CN='))
            ?.slice(3) ||
          x509.issuer
            .split('\n')
            .find((line) => line.startsWith('O='))
            ?.slice(2) ||
          'Unknown';
        const subject =
          x509.subject
            .split('\n')
            .find((line) => line.startsWith('CN='))
            ?.slice(3) ||
          x509.subject
            .split('\n')
            .find((line) => line.startsWith('O='))
            ?.slice(2) ||
          'Unknown';
        const daysUntilExpiry = Math.floor(
          (new Date(validTo).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );

        srv.logInfo('Using TLS/SSL', undefined, 'init');
        srv.logInfo(`  Certificate: ${subject}`, undefined, 'ssl');
        srv.logInfo(`  Issuer: ${issuer}`, undefined, 'ssl');
        srv.logInfo(
          `  Valid: ${validFrom} to ${validTo} (${daysUntilExpiry} days remaining)`,
          undefined,
          'ssl',
        );
      } catch (_err) {
        srv.logInfo(
          'Using TLS/SSL (certificate details unavailable)',
          undefined,
          'init',
        );
      }
    } else if (tlsSettings.reason === 'disabled') {
      // Plaintext listener. Named for the live variable: DISABLE_TLS is
      // retired and now aborts startup, so citing it here would send an
      // operator to a setting that refuses to start.
      webserver = http.createServer();
      srv.logInfo(
        `Running without TLS (INBOUND_TLS_MODE=off) on ${srv.bind_host}:${srv.ws_port} — this listener serves plaintext and must sit behind a proxy that terminates TLS`,
        undefined,
        'init',
      );
    } else {
      webserver = http.createServer();
      srv.logWarn(
        'No TLS certificate/key found, running without TLS',
        undefined,
        'init',
      );
    }

    const appAttestEnabled = runtimeConfig.appAttest.enabled;
    const attestedKeysPath = runtimeConfig.appAttest.attestedKeysPath;
    const requireAppAuth = runtimeConfig.requireAppAuth;
    const appAttestBundleId = runtimeConfig.appAttest.bundleId;
    const appAttestTeamId = runtimeConfig.appAttest.teamId;
    const apnsEnabled = Boolean(runtimeConfig.apns);
    const apnsTestSecret = runtimeConfig.apnsTestSecret;

    // Both features are off unless configured, and both say so out loud. An
    // operator who set the variables in the wrong file learns it here rather
    // than from a client that cannot authenticate.
    if (appAttestEnabled) {
      loadAttestedKeys(attestedKeysPath);
      const storeSummary = attestedKeyStoreSummary();
      srv.logInfo(
        `App Attest store loaded keys=${storeSummary.totalKeys} ` +
          `withSignCount=${storeSummary.keysWithSignCount} ` +
          `asserted=${storeSummary.keysAsserted} ` +
          `oldestRegistered=${storeSummary.oldestRegisteredAt ?? 'none'} ` +
          `newestRegistered=${storeSummary.newestRegisteredAt ?? 'none'} ` +
          `path=${attestedKeysPath}`,
        undefined,
        'auth',
      );
      srv.logInfo(
        `App Attest ENABLED (EXPERIMENTAL): bundleId=${appAttestBundleId} ` +
          `teamId=${appAttestTeamId} keysPath=${attestedKeysPath} ` +
          `requireAppAuth=${requireAppAuth}`,
        undefined,
        'auth',
      );
      srv.logWarn(
        'App Attest is experimental: its Apple attestation/assertion ' +
          'verification has not had an independent cryptographic review. Do ' +
          'not rely on it as your only access control — pair it with ' +
          'AUTH_MODE=shared-secret.',
        undefined,
        'auth',
      );
    } else {
      srv.logInfo(
        'App Attest DISABLED (APPATTEST_BUNDLE_ID/APPATTEST_TEAM_ID not ' +
          'set): /attest/* routes are not registered and no attested keys ' +
          'are loaded.',
        undefined,
        'auth',
      );
    }

    if (apnsEnabled) {
      srv.logInfo(
        `APNS ENABLED: topic=${runtimeConfig.apns!.topic} ` +
          `environment=${runtimeConfig.apns!.environment} ` +
          `testEndpoint=${Boolean(apnsTestSecret)}`,
        undefined,
        'init',
      );
    } else {
      srv.logInfo(
        'APNS DISABLED (APNS_KEY_PATH/APNS_KEY_ID/APNS_TEAM_ID/APNS_TOPIC ' +
          'not set): no push notifications are sent and no device tokens ' +
          'leave this process.',
        undefined,
        'init',
      );
    }

    const requestPeer = (req: IncomingMessage): string => {
      const trusted = isTrustedPeer(
        req.socket.remoteAddress,
        srv.trustedProxyCidrs,
      );
      if (trusted) {
        const forwardedFor = req.headers['x-forwarded-for'];
        const forwarded = Array.isArray(forwardedFor)
          ? forwardedFor[0]
          : forwardedFor;
        if (forwarded) return forwarded;
      }
      return req.socket.remoteAddress || 'unknown';
    };

    const summarizeUpgradeHeaders = (req: IncomingMessage): string => {
      const keyId = req.headers['x-app-assert-keyid'];
      const assertion = req.headers['x-app-assert-data'];
      const nonce = req.headers['x-app-assert-nonce'];
      const clientHash = req.headers['x-app-assert-clienthash'];
      const keyIdStr = getHeaderValue(keyId) ?? '';
      const assertionStr = getHeaderValue(assertion) ?? '';
      const nonceStr = getHeaderValue(nonce) ?? '';
      const clientHashStr = getHeaderValue(clientHash) ?? '';
      const keySummary = keyIdStr ? summarizeToken(keyIdStr) : '<missing>';
      const assertionHasSpaces = assertionStr.includes(' ');
      return `keyId=${keySummary} assertionLen=${assertionStr.length} nonceLen=${nonceStr.length} clientHashLen=${clientHashStr.length} assertionHasSpaces=${assertionHasSpaces}`;
    };

    const decodeHeaderBase64 = (value: string): Buffer => {
      // Some proxies/servers can rewrite '+' to space in header values.
      const normalized = value
        .trim()
        .replace(/ /g, '+')
        .replace(/-/g, '+')
        .replace(/_/g, '/');
      const padded = normalized + '==='.slice((normalized.length + 3) % 4);
      return Buffer.from(padded, 'base64');
    };

    // Bind the validated host, not the unspecified address. Startup
    // validation treats BIND_HOST=127.0.0.1 as loopback-only and waives the
    // plaintext-listener acknowledgment on that basis; listening without the
    // host would expose the same listener on every interface, making that
    // check a statement about a socket we never actually created.
    // An unset allowlist accepts every Origin. That is a deliberate default
    // for the public fixed-target deployment, but it is security-relevant, so
    // say so rather than leaving the operator to infer it from silence.
    if (runtimeConfig.allowedOrigins.length === 0) {
      srv.logWarn(
        'ALLOWED_ORIGINS is not set: connections from any Origin are ' +
          'accepted. Set it for internet-facing deployments. Note Origin is ' +
          'browser hardening, not authentication — see AUTH_MODE.',
        undefined,
        'init',
      );
    } else if (runtimeConfig.allowMissingOrigin) {
      srv.logWarn(
        'ALLOW_MISSING_ORIGIN=true: clients sending no Origin header bypass ' +
          'the allowlist. Such clients are gated only by AUTH_MODE.',
        undefined,
        'init',
      );
    }

    httpServer = webserver;

    webserver.listen(srv.ws_port, srv.bind_host, function () {
      srv.logInfo(
        `server listening: ${srv.bind_host}:${srv.ws_port}`,
        undefined,
        'init',
      );
    });

    // Add HTTP endpoints
    webserver.on('request', (req: IncomingMessage, res: ServerResponse) => {
      const rawUrl = req.url || '';
      const pathOnly = rawUrl.split('?')[0];

      if (pathOnly === '/health') {
        if (!srv.open) {
          res.writeHead(503, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({ status: 'draining', version: PACKAGE_VERSION }),
          );
        } else {
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
          });
          res.end(
            JSON.stringify({ status: 'healthy', version: PACKAGE_VERSION }),
          );
        }
      } else if (pathOnly === '/diagnostic') {
        if (!isDiagnosticRequestAuthorized(req.headers, runtimeConfig)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateDiagnosticHTML());
      } else if (pathOnly === '/diagnostic/api') {
        if (!isDiagnosticRequestAuthorized(req.headers, runtimeConfig)) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getDiagnosticData()));
      } else if (
        appAttestEnabled &&
        req.method === 'GET' &&
        pathOnly === '/attest/challenge'
      ) {
        // Rate-limited per source: issuing a challenge is unauthenticated and
        // costs a stored nonce, so it is the cheapest way to grow server
        // state from off-box.
        const challengePeer = getClientIP(req);
        if (!attestChallengeLimiter.tryConsume(challengePeer)) {
          srv.logWarn(
            `App Attest challenge rate-limited peer=${requestPeer(req)}`,
            undefined,
            'auth',
          );
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          });
          res.end(JSON.stringify({ error: 'Too many requests' }));
          return;
        }

        const nonce = generateChallenge();
        srv.logInfo(
          `Issued App Attest challenge peer=${requestPeer(req)} ua=${String(req.headers['user-agent'] || 'unknown').slice(0, 120)}`,
          undefined,
          'auth',
        );
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ nonce, expires: Date.now() + 60_000 }));
      } else if (
        apnsEnabled &&
        req.method === 'POST' &&
        (pathOnly === '/debug/apns/test' || pathOnly === '/debug/apns/test/')
      ) {
        const authResult = authorizeApnsDebugRequest(
          req.headers,
          runtimeConfig,
          apnsTestSecret,
        );
        if (
          authResult === 'disabled' ||
          authResult === 'diagnosticUnauthorized'
        ) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        if (authResult === 'invalidSecret') {
          srv.logWarn(
            `APNS test request rejected: invalid secret peer=${requestPeer(req)}`,
            undefined,
            'auth',
          );
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const MAX_BODY_SIZE = 8_192;
        void (async () => {
          try {
            const requestBody = await readLimitedRequestBody(
              req,
              res,
              MAX_BODY_SIZE,
              (bodySize) => {
                srv.logWarn(
                  `APNS test rejected: body too large (${bodySize} bytes) peer=${requestPeer(req)}`,
                  undefined,
                  'auth',
                );
              },
            );
            if (!requestBody) return;

            const body = cancelPushBodySchema.parse(
              JSON.parse(requestBody.toString('utf-8')),
            );

            const requestedSessionId = body.sessionId?.trim();
            let targetDeviceToken = body.deviceToken?.trim();
            let resolvedSessionId = requestedSessionId || 'manual-test';

            if (!targetDeviceToken && requestedSessionId) {
              const session =
                sessionIntegration.sessionManager.get(requestedSessionId);
              if (!session) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Session not found',
                    sessionId: requestedSessionId,
                  }),
                );
                return;
              }
              if (!session.deviceToken) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Session has no device token',
                    sessionId: requestedSessionId,
                  }),
                );
                return;
              }
              targetDeviceToken = session.deviceToken;
              resolvedSessionId = session.id;
            }

            if (!targetDeviceToken) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Provide deviceToken or sessionId',
                }),
              );
              return;
            }

            const sent =
              await sessionIntegration.notificationManager.sendSilentPush(
                targetDeviceToken,
                resolvedSessionId,
              );
            const tokenLabel = summarizeToken(targetDeviceToken);
            if (sent) {
              srv.logInfo(
                `APNS silent push test sent peer=${requestPeer(req)} sessionId=${resolvedSessionId} deviceToken=${tokenLabel}`,
                undefined,
                'auth',
              );
            } else {
              srv.logWarn(
                `APNS silent push test failed peer=${requestPeer(req)} sessionId=${resolvedSessionId} deviceToken=${tokenLabel}`,
                undefined,
                'auth',
              );
            }

            const status = sessionIntegration.notificationManager.getStatus();
            res.writeHead(sent ? 200 : 502, {
              'Content-Type': 'application/json',
            });
            res.end(
              JSON.stringify({
                sent,
                sessionId: resolvedSessionId,
                deviceToken: tokenLabel,
                notifications: status,
              }),
            );
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Invalid JSON body',
                detail: errorText(err),
              }),
            );
          }
        })();
      } else if (
        apnsEnabled &&
        req.method === 'POST' &&
        (pathOnly === '/debug/apns/alert-test' ||
          pathOnly === '/debug/apns/alert-test/')
      ) {
        const authResult = authorizeApnsDebugRequest(
          req.headers,
          runtimeConfig,
          apnsTestSecret,
        );
        if (
          authResult === 'disabled' ||
          authResult === 'diagnosticUnauthorized'
        ) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Not found' }));
          return;
        }

        if (authResult === 'invalidSecret') {
          srv.logWarn(
            `APNS alert test request rejected: invalid secret peer=${requestPeer(req)}`,
            undefined,
            'auth',
          );
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Unauthorized' }));
          return;
        }

        const MAX_BODY_SIZE = 8_192;
        void (async () => {
          try {
            const requestBody = await readLimitedRequestBody(
              req,
              res,
              MAX_BODY_SIZE,
              (bodySize) => {
                srv.logWarn(
                  `APNS alert test rejected: body too large (${bodySize} bytes) peer=${requestPeer(req)}`,
                  undefined,
                  'auth',
                );
              },
            );
            if (!requestBody) return;

            const body = testPushBodySchema.parse(
              JSON.parse(requestBody.toString('utf-8')),
            );

            const requestedSessionId = body.sessionId?.trim();
            let targetDeviceToken = body.deviceToken?.trim();
            let resolvedSessionId = requestedSessionId || 'manual-alert-test';

            if (!targetDeviceToken && requestedSessionId) {
              const session =
                sessionIntegration.sessionManager.get(requestedSessionId);
              if (!session) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Session not found',
                    sessionId: requestedSessionId,
                  }),
                );
                return;
              }
              if (!session.deviceToken) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify({
                    error: 'Session has no device token',
                    sessionId: requestedSessionId,
                  }),
                );
                return;
              }
              targetDeviceToken = session.deviceToken;
              resolvedSessionId = session.id;
            }

            if (!targetDeviceToken) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Provide deviceToken or sessionId',
                }),
              );
              return;
            }

            const alertTitle = (body.title || 'MUDBasher Test').trim();
            const alertMessage = (
              body.message || 'APNS alert test from proxy'
            ).trim();

            const sent =
              await sessionIntegration.notificationManager.sendAlertPush(
                targetDeviceToken,
                alertTitle,
                alertMessage,
                {
                  sessionId: resolvedSessionId,
                  type: 'debugAlert',
                },
              );
            const tokenLabel = summarizeToken(targetDeviceToken);
            if (sent) {
              srv.logInfo(
                `APNS alert push test sent peer=${requestPeer(req)} sessionId=${resolvedSessionId} deviceToken=${tokenLabel}`,
                undefined,
                'auth',
              );
            } else {
              srv.logWarn(
                `APNS alert push test failed peer=${requestPeer(req)} sessionId=${resolvedSessionId} deviceToken=${tokenLabel}`,
                undefined,
                'auth',
              );
            }

            const status = sessionIntegration.notificationManager.getStatus();
            res.writeHead(sent ? 200 : 502, {
              'Content-Type': 'application/json',
            });
            res.end(
              JSON.stringify({
                sent,
                sessionId: resolvedSessionId,
                deviceToken: tokenLabel,
                notifications: status,
              }),
            );
          } catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Invalid JSON body',
                detail: errorText(err),
              }),
            );
          }
        })();
      } else if (
        appAttestEnabled &&
        req.method === 'POST' &&
        (pathOnly === '/attest/register' || pathOnly === '/attest/register/')
      ) {
        srv.logInfo(
          `App Attest register request received peer=${requestPeer(req)}`,
          undefined,
          'auth',
        );
        const registerPeer = getClientIP(req);
        if (!attestRegisterLimiter.tryConsume(registerPeer)) {
          srv.logWarn(
            `App Attest register rate-limited peer=${requestPeer(req)}`,
            undefined,
            'auth',
          );
          res.writeHead(429, {
            'Content-Type': 'application/json',
            'Retry-After': '60',
          });
          res.end(JSON.stringify({ error: 'Too many requests' }));
          return;
        }
        const MAX_BODY_SIZE = 65_536; // 64 KB — Apple attestation objects are a few KB
        void (async () => {
          try {
            const requestBody = await readLimitedRequestBody(
              req,
              res,
              MAX_BODY_SIZE,
              (bodySize) => {
                srv.logWarn(
                  `App Attest register rejected: body too large (${bodySize} bytes) peer=${requestPeer(req)}`,
                  undefined,
                  'auth',
                );
              },
            );
            if (!requestBody) return;

            const body = attestBodySchema.parse(
              JSON.parse(requestBody.toString('utf-8')),
            );
            if (!body.keyId || !body.attestation || !body.nonce) {
              srv.logWarn(
                `App Attest register rejected: missing fields peer=${requestPeer(req)}`,
                undefined,
                'auth',
              );
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify({
                  error: 'Missing keyId, attestation, or nonce',
                }),
              );
              return;
            }
            if (!validateAndConsumeNonce(body.nonce)) {
              srv.logWarn(
                `App Attest register rejected: invalid nonce keyId=${summarizeToken(body.keyId)} peer=${requestPeer(req)}`,
                undefined,
                'auth',
              );
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid or expired nonce' }));
              return;
            }
            // Both identifiers are guaranteed non-empty: this route is only
            // registered when appAttest.enabled, which requires them.
            const bundleId = runtimeConfig.appAttest.bundleId;
            const teamId = runtimeConfig.appAttest.teamId;
            const attestationBuffer = Buffer.from(body.attestation, 'base64');
            const result = await verifyAttestation({
              keyId: body.keyId,
              attestationBuffer,
              nonce: body.nonce,
              bundleId,
              teamId,
            });
            const keysPath =
              runtimeConfig.appAttest.attestedKeysPath ||
              path.resolve(__dirname, 'config/attested-keys.json');
            setAttestedKey(result.keyId, {
              publicKey: result.publicKey,
              alternatePublicKey: result.alternatePublicKey,
              signCount: 0,
              registeredAt: new Date().toISOString(),
            });
            debouncedSaveAttestedKeys(keysPath);
            srv.logInfo(
              `Registered App Attest key=${summarizeToken(body.keyId)} peer=${requestPeer(req)} hasAlternateKey=${Boolean(result.alternatePublicKey)} keySource=${result.keySource} coseExtracted=${result.coseKeyExtracted} keyIdMatchesCose=${result.keyIdMatchesCoseHash} keyIdMatchesCert=${result.keyIdMatchesCertHash}`,
              undefined,
              'auth',
            );
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ registered: true }));
          } catch (err) {
            srv.logWarn(
              'Attestation registration failed: ' + errorText(err),
              undefined,
              'auth',
            );
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                error: 'Invalid attestation registration request',
              }),
            );
          }
        })();
      } else {
        // Volume here is attacker-controlled: commodity scanners walk dozens
        // of paths per second (`/.env`, `/config/.env`, `/wp-admin`), and one
        // WARN each is a log-flooding vector. Emit at most one line per
        // window and carry the suppressed count, so the signal survives
        // without the flood.
        const now = Date.now();
        if (now - unhandledRequestLogged >= UNHANDLED_LOG_INTERVAL_MS) {
          const suppressed = unhandledRequestSuppressed;
          unhandledRequestSuppressed = 0;
          unhandledRequestLogged = now;
          srv.logWarn(
            `Unhandled HTTP request method=${req.method || 'UNKNOWN'} path=${pathOnly || '<empty>'} peer=${requestPeer(req)}` +
              (suppressed > 0 ? ` suppressed=${suppressed}` : ''),
            undefined,
            'init',
          );
        } else {
          unhandledRequestSuppressed++;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    });

    // Create WebSocket server
    try {
      const { WebSocketServer } = await import('ws');
      wsServer = new WebSocketServer({
        noServer: true,
        maxPayload: 64 * 1024,
      });

      srv.logInfo(
        `WebSocket server initialized (Node.js ${process.version})`,
        undefined,
        'init',
      );

      // Liveness sweep (MWP-92). Terminating is what actually reclaims the
      // session slot: `terminate` fires 'close', which runs closeSocket and
      // releases the capacity the connection caps account for.
      const hb = runtimeConfig.heartbeat;
      if (hb.enabled) {
        heartbeatMonitor = new HeartbeatMonitor<SocketExtended>({
          intervalMs: hb.intervalMs,
          timeoutMs: hb.timeoutMs,
        });

        heartbeatTimer = setInterval(() => {
          const monitor = heartbeatMonitor;
          if (!monitor) return;

          for (const dead of monitor.sweep()) {
            srv.logWarn(
              `terminating unresponsive peer after ${hb.timeoutMs}ms without a pong ${formatWsSocketContext(dead)}`,
              dead,
              'ws',
            );
            // Hard destroy, not the graceful close `terminate` was replaced
            // with: a peer that stopped answering pings cannot complete a
            // close handshake, so a graceful close would leave the socket in
            // server.sockets until the library's own close timeout.
            (dead.hardTerminate ?? dead.terminate)();
          }

          // Ping after sweeping, so a peer is never judged on a ping sent in
          // the same tick it is measured against.
          for (const s of server.sockets) {
            try {
              s.ping?.();
            } catch {
              // A socket that cannot be pinged is already going away; the next
              // sweep collects it.
            }
          }
        }, hb.intervalMs);
        heartbeatTimer.unref?.();

        srv.logInfo(
          `WebSocket heartbeat every ${hb.intervalMs}ms, reclaiming peers silent for ${hb.timeoutMs}ms`,
          undefined,
          'init',
        );
      } else {
        srv.logWarn(
          'WebSocket heartbeat disabled: half-open connections will hold their session slot until the session timeout',
          undefined,
          'init',
        );
      }
    } catch (err) {
      srv.logError(
        'Error creating WebSocket server: ' + err,
        undefined,
        'init',
      );
      process.exit(1);
    }

    webserver.on('upgrade', (req: IncomingMessage, socket: Socket, head) => {
      /**
       * Refuse this upgrade, telling the client why.
       *
       * The obvious implementation — write `HTTP/1.1 401 ...` to the upgrade
       * socket and destroy it — is what this used to do, and under Bun 1.3.14
       * it delivers nothing at all. Every rejection arrived as a bare
       * connection reset: indistinguishable from a crash, from a network
       * fault, and from each other. Verified against the runtime rather than
       * guessed: the identical server on Node 24 delivers the status, Bun
       * delivers zero bytes, and no variation of write/end/cork/delayed
       * destroy changes that. Nor does answering from the request handler,
       * which Bun never reaches for an upgrade.
       *
       * So the handshake is completed and the refusal sent as a close frame,
       * which does arrive. That is also more than the old code ever gave a
       * browser: JavaScript cannot read the status of a failed WebSocket
       * handshake, but it can read `event.code` and `event.reason`.
       *
       * The ordering guarantee this file depends on is preserved. The socket
       * is never emitted as a `connection` — contrast the success path below,
       * which calls `wsServer.emit('connection', ...)` — so a refused client
       * still allocates no session and reserves no connection capacity.
       */
      const rejectUpgrade = (status: number, message: string): void => {
        if (socket.destroyed) return;
        wsServer.handleUpgrade(req, socket, head, (rejected) => {
          rejected.close(closeCodeForStatus(status), `${status} ${message}`);
          // A client that never answers the closing handshake would otherwise
          // hold the socket for the `ws` default of 30 seconds, which the old
          // reset never did. Bound it.
          const cut = setTimeout(
            () => rejected.terminate(),
            REJECT_CLOSE_TIMEOUT_MS,
          );
          rejected.once('close', () => clearTimeout(cut));
        });
      };

      void (async () => {
        srv.logInfo(
          `Upgrade request peer=${requestPeer(req)} path=${req.url || '/'} requireAppAuth=${requireAppAuth} ${summarizeUpgradeHeaders(req)}`,
          undefined,
          'auth',
        );
        // Both refusals below log for the same reason the auth refusals
        // further down do, and they did not until MWP-138: an operator saw
        // the "Upgrade request" line above and then silence, with no reason
        // recorded anywhere. Since MWP-136 the *client* is told `1008
        // 403 Forbidden`, so the person who can actually fix a wrong
        // ALLOWED_ORIGINS knew less than the person hitting it.
        //
        // The received Origin is client-supplied and reaches the log through
        // `srv.log`, which routes every message through `redactLogMessage`
        // and so neutralizes control sequences. Do not add a second
        // neutralize call here; do not bypass `srv.log` to add one.
        if (!srv.open) {
          srv.logWarn(
            'Rejected upgrade: server is draining',
            undefined,
            'auth',
          );
          rejectUpgrade(503, 'Service Unavailable');
          return;
        }

        if (!srv.originAllowed(req)) {
          // Naming the received value is the whole point: the usual cause is
          // a value that is nearly right — a trailing slash, http for https,
          // a missing port — which is invisible without seeing it. The
          // allowlist itself is deliberately not logged on every rejection.
          const receivedOrigin = getHeaderValue(req.headers.origin);
          srv.logWarn(
            `Rejected upgrade: origin not allowed (received ${receivedOrigin || '<missing>'})`,
            undefined,
            'auth',
          );
          rejectUpgrade(403, 'Forbidden');
          return;
        }

        // Shared-secret auth (MWP-85). Deliberately before App Attest and
        // before handleUpgrade, so a failed attempt allocates no session and
        // consumes no connection-limit capacity.
        if (runtimeConfig.authMode === 'shared-secret') {
          const peer = getClientIP(req);

          // Verify BEFORE consulting the rate limiter. Clients routinely
          // share a source address through NAT or a forward proxy, so
          // blocking first would let one failing client deny service to
          // every authorized client behind that address. The limiter exists
          // to bound the cost of wrong guesses, not to reject right ones.
          const auth = authorizeSharedSecret(req.headers, req.url, {
            authMode: runtimeConfig.authMode,
            sharedSecret: runtimeConfig.proxySharedSecret,
            allowQuerySecret: runtimeConfig.allowQuerySecret,
          });

          if (auth.authorized) {
            // Clears the block for everyone sharing this address.
            failedAuthLimiter.recordSuccess(peer);
          } else {
            failedAuthLimiter.recordFailure(peer);
            const throttled = failedAuthLimiter.isBlocked(peer);
            // auth.reason never contains the supplied or configured secret.
            srv.logWarn(
              `Rejected upgrade: ${auth.reason}${throttled ? ' (throttled)' : ''}`,
              undefined,
              'auth',
            );
            if (throttled) {
              rejectUpgrade(429, 'Too Many Requests');
            } else {
              rejectUpgrade(401, 'Unauthorized');
            }
            return;
          }
        }

        if (requireAppAuth) {
          const keyId = getHeaderValue(req.headers['x-app-assert-keyid']);
          const assertionB64 = getHeaderValue(
            req.headers['x-app-assert-data'],
          );
          const nonce = getHeaderValue(req.headers['x-app-assert-nonce']);
          const clientHashB64 = getHeaderValue(
            req.headers['x-app-assert-clienthash'],
          );

          if (keyId && assertionB64 && nonce) {
            if (!validateAndConsumeNonce(nonce)) {
              srv.logWarn(
                'Rejected upgrade: invalid/expired/reused assertion nonce',
                undefined,
                'auth',
              );
              rejectUpgrade(401, 'Invalid nonce');
              return;
            }

            const storedKey = getAttestedKey(keyId);
            if (!storedKey) {
              srv.logWarn(
                'Rejected upgrade: unknown App Attest keyId ' + keyId,
                undefined,
                'auth',
              );
              rejectUpgrade(401, 'Unknown key');
              return;
            }

            // Non-empty by construction: requireAppAuth cannot be set without
            // App Attest being configured, which startup enforces.
            const bundleId = runtimeConfig.appAttest.bundleId;
            const teamId = runtimeConfig.appAttest.teamId;

            try {
              const assertionBuffer = decodeHeaderBase64(assertionB64);
              const clientDataHashBuffer = clientHashB64
                ? decodeHeaderBase64(clientHashB64)
                : undefined;
              const previousSignCount = storedKey.signCount;
              const assertResult = await verifyAssertion({
                assertionBuffer,
                keyId,
                nonce,
                explicitClientDataHash: clientDataHashBuffer,
                bundleId,
                teamId: teamId || undefined,
                storedPublicKey: storedKey.publicKey,
                alternatePublicKey: storedKey.alternatePublicKey,
                storedSignCount: storedKey.signCount,
              });
              updateSignCount(keyId, assertResult.newSignCount);
              debouncedSaveAttestedKeys(attestedKeysPath);
              // keyRef is a prefix of the RAW keyId, which is what the store
              // is keyed by. summarizeToken emits a hash, so a log line alone
              // could not be joined to a store entry without re-hashing every
              // key in the file. keyAgeDays distinguishes a device that was
              // already registered from one that just enrolled — the question
              // every state-transfer verification actually asks.
              const keyAgeDays = Math.floor(
                (Date.now() - Date.parse(storedKey.registeredAt)) / 86_400_000,
              );
              srv.logInfo(
                `App Attest verified keyId=${summarizeToken(keyId)} ` +
                  `keyRef=${keyId.slice(0, 10)} ` +
                  `signCount=${previousSignCount}->${assertResult.newSignCount} ` +
                  `variant=${assertResult.matchedVariant} ` +
                  `keyAgeDays=${Number.isFinite(keyAgeDays) ? keyAgeDays : 'unknown'} ` +
                  `peer=${requestPeer(req)}`,
                undefined,
                'auth',
              );
            } catch (err) {
              // MWP-95 removed an opt-in cross-key diagnostic that stood here
              // and re-verified the failed assertion against every other
              // registered key. One rejected request cost a signature
              // verification per stored key, on an unauthenticated path — an
              // amplifier, for a diagnostic whose only output was a log line.
              // Do not reintroduce it, under any environment variable.
              srv.logWarn(
                'App Attest assertion failed: ' + errorText(err),
                undefined,
                'auth',
              );
              // The ~120-entry attempt matrix is debug-only: at WARN it is
              // several KB of near-identical text per rejection, which is a
              // log-flooding hazard on an unauthenticated path and hides the
              // summary above.
              // Read off the thrown value rather than asserted onto it: the
              // enriched error is one of several things the verifier can
              // throw, and a plain Error simply has no attempt list.
              const details = attemptDetailsSchema.safeParse(
                err instanceof Error && 'attemptDetails' in err
                  ? err.attemptDetails
                  : undefined,
              );
              if (details.success) {
                srv.logDebug(
                  'App Attest assertion attempts: ' + details.data.join('|'),
                  undefined,
                  'auth',
                );
              }
              rejectUpgrade(401, 'Assertion verification failed');
              return;
            }
          } else {
            // No second route in. The mTLS client-certificate fallback that
            // used to accept the connection here was removed in MWP-95: it
            // was enabled whenever NODE_ENV was anything other than
            // 'production', which includes unset.
            srv.logWarn(
              'Rejected upgrade: App Attest headers missing',
              undefined,
              'auth',
            );
            rejectUpgrade(401, 'App authentication required');
            return;
          }
        }

        wsServer.handleUpgrade(req, socket, head, (upgradedSocket) => {
          wsServer.emit('connection', upgradedSocket, req);
        });
      })().catch((cause: unknown) => {
        srv.logWarn(
          'Upgrade auth flow failed: ' + errorText(cause),
          undefined,
          'auth',
        );
        rejectUpgrade(401, 'Unauthorized');
      });
    });

    wsServer.on(
      'connection',
      function connection(socket: WS, req: IncomingMessage) {
        const incomingIP = req.socket.remoteAddress || '-';
        const incomingPort = req.socket.remotePort;
        const incomingSource = incomingPort
          ? `${incomingIP}:${incomingPort}`
          : incomingIP;
        const incomingHost = getHeaderValue(req.headers.host) || '-';
        const incomingForwardedFor =
          getHeaderValue(req.headers['x-forwarded-for']) || '-';
        srv.logInfo(
          `incoming websocket connection: source=${incomingSource} host=${incomingHost} x-forwarded-for=${incomingForwardedFor}`,
          undefined,
          'ws',
        );
        // Defence in depth: the upgrade handler already applied both checks,
        // so reaching either of these means something upstream changed and
        // that is worth a line rather than a silent disconnect.
        //
        // `terminate()` is kept rather than switched to a close code. By this
        // point the upgrade has completed, so a code *would* reach the
        // client — but a client arriving here has already passed the same
        // check moments earlier, so this is a should-never-happen path and
        // the log is what matters, not the courtesy. Revisit if it ever fires.
        if (!srv.open) {
          srv.logWarn(
            'Refused connection: server is draining',
            undefined,
            'ws',
          );
          socket.terminate();
          return;
        }

        if (!srv.originAllowed(req)) {
          const lateOrigin = getHeaderValue(req.headers.origin);
          srv.logWarn(
            `Refused connection: origin not allowed (received ${lateOrigin || '<missing>'})`,
            undefined,
            'ws',
          );
          socket.terminate();
          return;
        }

        // SAFETY: `ws` hands us a bare WebSocket and this is the one place
        // that adopts it. Every SocketExtended field is optional or assigned
        // in the lines immediately below, so the object satisfies the contract
        // by the time it reaches server.sockets — no other code path can
        // observe it half-populated.
        const extendedSocket = socket as SocketExtended;
        if (!extendedSocket.req) {
          // SAFETY: Node guarantees an upgrade request has a live connection
          // carrying a remoteAddress, and that is the only field the narrowed
          // type adds over IncomingMessage.
          extendedSocket.req = req as SocketExtended['req'];
        }
        if (!extendedSocket.socketId) extendedSocket.socketId = nextSocketId++;

        // Resolve real client IP (supports reverse proxy headers)
        extendedSocket.remoteAddress = getClientIP(req);

        srv.logInfo(
          'new connection accepted: ' + formatWsSocketContext(extendedSocket),
          extendedSocket,
          'ws',
        );

        // Add compatibility methods for the WebSocket
        extendedSocket.sendUTF = extendedSocket.send.bind(extendedSocket);

        // The native terminate is kept before being replaced. `terminate` here
        // is overridden with a graceful close for the ordinary paths, but a
        // half-open peer cannot complete a close handshake — the transport has
        // to be destroyed outright, which is what the heartbeat needs.
        // SAFETY: still the native ws terminate at this point — the graceful
        // override is installed on the very next line, so nothing has replaced
        // it yet and its zero-argument signature is ws's own.
        extendedSocket.hardTerminate = (
          extendedSocket.terminate as () => void
        ).bind(extendedSocket);
        extendedSocket.terminate = () => extendedSocket.close();

        server.sockets.add(extendedSocket);
        srv.logInfo(
          'connection count: ' + server.sockets.size,
          extendedSocket,
          'ws',
        );

        // Liveness (MWP-92). A half-open peer otherwise holds its session slot
        // until the 24-hour session timeout, so the connection caps bound live
        // clients while dead ones accumulate underneath.
        heartbeatMonitor?.track(extendedSocket);
        socket.on('pong', () => {
          heartbeatMonitor?.markAlive(extendedSocket);
        });

        socket.on('message', function message(msg: Buffer) {
          // Inbound traffic is evidence of life too, so an active client is
          // never reclaimed for having missed a ping.
          heartbeatMonitor?.markAlive(extendedSocket);

          // Rate check first, before JSON.parse and before any telnet write
          // (MWP-124). Parsing is the expensive step, and an `input` frame
          // becomes an upstream write — so a limit applied after either has
          // already paid the cost it exists to avoid. This is the single place
          // every client frame arrives, on both wire protocols.
          const address = resolveSocketAddress(
            extendedSocket,
            srv.trustedProxyCidrs,
          );
          // Keyed on the connection, not the session. A legacy raw-telnet
          // connection never has a Session, so keying on the session left
          // legacy traffic bound only by the address allowance — 240/second
          // against the 60/second the per-connection limit advertises. Both
          // wire protocols get identical policy (MWP-90).
          const decision = messageRateLimiter.check(
            `ws#${extendedSocket.socketId ?? 0}`,
            address,
          );

          if (!decision.allowed) {
            if (decision.notify) {
              // Once per window, not per dropped frame: replying to every one
              // would amplify outbound traffic during the flood being damped.
              srv.logWarn(
                `message rate limit exceeded dimension=${decision.dimension}`,
                extendedSocket,
                'ws',
              );
              try {
                extendedSocket.sendUTF(
                  JSON.stringify({
                    type: 'error',
                    code: 'rate_limited',
                    message: `Message rate limit exceeded (${decision.dimension})`,
                  }),
                );
              } catch {
                // A socket already going away is not worth failing over.
              }
            }
            return;
          }

          if (!srv.parse(extendedSocket, msg)) {
            srv.forward(extendedSocket, msg);
          }
        });

        socket.on('close', (code: number, reason: Buffer) => {
          heartbeatMonitor?.untrack(extendedSocket);
          const closeReason = reason.length ? reason.toString('utf8') : 'none';
          srv.logInfo(
            'peer disconnected: code=' +
              code +
              ' reason=' +
              closeReason +
              ' ' +
              formatWsSocketContext(extendedSocket),
            extendedSocket,
            'ws',
          );
          srv.closeSocket(extendedSocket);
        });

        socket.on('error', (error: Error) => {
          heartbeatMonitor?.untrack(extendedSocket);
          srv.logError('peer error: ' + error, extendedSocket, 'ws');
          srv.closeSocket(extendedSocket);
        });
      },
    );
  },

  parse: function (s: SocketExtended, d: Buffer): number {
    if (d[0] !== '{'.charCodeAt(0)) return 0;

    const outcome = sessionIntegration.parseNewMessage(s, d);

    if (outcome.kind === 'handled') return 1;

    if (outcome.kind === 'legacy-connect') {
      void srv.openLegacyConnection(s, outcome.host, outcome.port);
      return 1;
    }

    if (outcome.kind === 'invalid') {
      srv.logWarn(
        `rejected client message: field=${outcome.field ?? '-'} ${outcome.reason}`,
        s,
        'parse',
      );
      if (outcome.flavor === 'legacy') {
        // A legacy client renders bytes, so a JSON frame would print into
        // the player's terminal — exactly what this change exists to stop.
        srv.rejectLegacy(s, outcome.reason);
      } else {
        sessionIntegration.sendProtocolError(s, outcome);
      }
      // Returning 1 is what stops the caller forwarding this to the MUD.
      return 1;
    }

    if (outcome.parsedObject) {
      // A JSON object carrying neither `type` nor `connect` is player input
      // that happens to be JSON, so this is debug rather than error.
      srv.logDebug(
        formatMissingTypeLogMessage(outcome.parsedObject, d.length),
        s,
        'parse',
      );
    }

    return 0;
  },

  sendTTYPE: function (s: SocketExtended, msg: string): void {
    if (msg) {
      const p = srv.prt;
      writeTelnet(s, p.WILL_TTYPE);
      writeTelnet(s, Buffer.from([p.IAC, p.SB, p.TTYPE, p.IS]));
      if (s.ts) s.ts.send(msg);
      writeTelnet(s, Buffer.from([p.IAC, p.SE]));
      srv.logInfo(msg, s, 'proto');
    }
  },

  sendGMCP: function (s: SocketExtended, msg: string): void {
    writeTelnet(s, srv.prt.START);
    writeTelnet(s, msg);
    writeTelnet(s, srv.prt.STOP);
  },

  sendMXP: function (s: SocketExtended, msg: string): void {
    const p = srv.prt;
    writeTelnet(s, Buffer.from([p.ESC]));
    writeTelnet(s, '[1z' + msg);
    writeTelnet(s, Buffer.from([p.ESC]));
    writeTelnet(s, '[7z');
  },

  sendMSDP: function (s: SocketExtended, msdp: MSDPRequest): void {
    const p = srv.prt;
    srv.logInfo('sendMSDP ' + stringify(msdp), s, 'proto');

    if (!msdp.key || !msdp.val) return;

    writeTelnet(s, Buffer.from([p.IAC, p.SB, p.MSDP, p.MSDP_VAR]));
    writeTelnet(s, msdp.key);

    const values = Array.isArray(msdp.val) ? msdp.val : [msdp.val];

    for (let i = 0; i < values.length; i++) {
      writeTelnet(s, Buffer.from([p.MSDP_VAL]));
      writeTelnet(s, values[i]);
    }

    writeTelnet(s, Buffer.from([p.IAC, p.SE]));
  },

  sendMSDPPair: function (s: SocketExtended, key: string, val: string): void {
    const p = srv.prt;
    srv.logInfo('sendMSDPPair ' + key + '=' + val, s, 'proto');
    writeTelnet(s, Buffer.from([p.IAC, p.SB, p.MSDP, p.MSDP_VAR]));
    writeTelnet(s, key);
    writeTelnet(s, Buffer.from([p.MSDP_VAL]));
    writeTelnet(s, val);
    writeTelnet(s, Buffer.from([p.IAC, p.SE]));
  },

  /**
   * Reject a legacy client in the only framing it understands: bytes.
   *
   * A legacy client renders whatever arrives, so a JSON error frame would be
   * printed straight into the player's terminal.
   */
  rejectLegacy: function (s: SocketExtended, reason: string): void {
    // Deliberately not sendClient: that path drives telnet negotiation and
    // reads s.ttype, which initT has not created yet when a connect is
    // refused before dialling. Base64 is the framing legacy clients decode,
    // so write it straight to the socket.
    sendBase64IfOpen(s, Buffer.from('\r\n' + reason + '\r\n'));
    setTimeout(function () {
      srv.closeSocket(s);
    }, SOCKET_CLOSE_DELAY_MS);
  },

  /**
   * Open a legacy `{host, port, connect}` connection.
   *
   * Policy comes from the same `authorizeConnect` the typed protocol uses —
   * target validation, connection limits, capacity reservation, and the DNS
   * rebinding guard — so neither protocol can drift from the other.
   *
   * The data plane deliberately does NOT come from the session stack. A
   * legacy client cannot consume typed JSON envelopes or hold a session
   * token to resume with, so it dials raw telnet: `initT` sets `s.ts`, which
   * is what makes `forward()` deliver player input and `sendClient()` deliver
   * MUD output as the base64 frames these clients expect.
   */
  openLegacyConnection: async function (
    s: SocketExtended,
    host?: string,
    port?: number,
  ): Promise<void> {
    // One connect per socket, matching the typed protocol.
    if (s.ts || s.pendingMudTransport || sessionIntegration.hasSession(s)) {
      srv.rejectLegacy(s, 'This connection already has a session');
      return;
    }

    const controller = new AbortController();
    s.pendingMudTransport = controller;

    // A bare {connect: 1} means the configured default target. It is not
    // privileged: the decision below still applies the full target policy.
    const wantHost = host || srv.tn_host;
    const wantPort = port || srv.tn_port;

    let decision: Awaited<
      ReturnType<typeof sessionIntegration.authorizeConnect>
    >;
    try {
      decision = await sessionIntegration.authorizeConnect(s, {
        host: wantHost,
        port: wantPort,
      });
    } catch (err) {
      if (s.pendingMudTransport === controller) {
        s.pendingMudTransport = undefined;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      srv.logError(
        `telnet authorization error: ${error.toString()}`,
        s,
        'telnet',
      );
      srv.rejectLegacy(s, 'Error: maybe the mud server is down?');
      return;
    }

    if (!decision.allowed) {
      if (s.pendingMudTransport === controller) {
        s.pendingMudTransport = undefined;
      }
      srv.rejectLegacy(s, decision.reason);
      return;
    }

    if (controller.signal.aborted) {
      sessionIntegration.sessionManager.releasePendingDial(decision.ip);
      return;
    }

    // Established capacity is counted for the life of the connection and
    // released in closeSocket; hand off from the reservation so the same
    // client is not counted twice.
    s.legacyCountedIp = decision.ip !== 'unknown' ? decision.ip : undefined;
    if (s.legacyCountedIp) {
      sessionIntegration.sessionManager.incrementIPCount(s.legacyCountedIp);
    }
    sessionIntegration.sessionManager.releasePendingDial(decision.ip);

    s.host = decision.host;
    s.port = decision.port;
    srv.initT(s, decision.dialAddress);
  },

  /**
   * Dial the MUD over raw telnet and wire the socket up.
   *
   * Callers MUST authorize the target first — `openLegacyConnection` does so
   * via `sessionIntegration.authorizeConnect`. There is deliberately no
   * second policy check here: two implementations of the same policy is how
   * the protocols drift apart, which is the whole point of MWP-90.
   */
  initT: function (so: SocketExtended, dialAddress?: string): void {
    const s = so;
    const host = s.host || srv.tn_host;
    const port = s.port || srv.tn_port;

    if (!s.ttype) s.ttype = [];

    s.ttype = s.ttype.concat(srv.ttype.portal.slice(0));
    s.ttype.push(s.remoteAddress);
    s.ttype.push(s.remoteAddress);

    const controller = s.pendingMudTransport ?? new AbortController();
    s.pendingMudTransport = controller;
    let negotiationTimeout: ReturnType<typeof setTimeout> | null = null;

    // Dial the address policy resolved, not the hostname — re-resolving
    // between validation and connect is the DNS rebinding hole.
    void connectMudTransport({
      requestedHost: host,
      dialAddress: dialAddress || host,
      port,
      mode: runtimeConfig.mudTlsMode,
      dialTimeoutMs: runtimeConfig.mudDialTimeoutMs,
      signal: controller.signal,
      onDowngrade: (reason) => {
        srv.logWarn(
          `${reason}, using plain TCP for ${host}:${port}`,
          s,
          'telnet',
        );
      },
      onConnected: ({ socket }) => {
        s.ts = socket;
        if (s.pendingMudTransport === controller) {
          s.pendingMudTransport = undefined;
        }

        socket.send = function (data: string | Buffer) {
          if (srv.debug) {
            const raw: string[] = [];
            for (let i = 0; i < data.length; i++)
              raw.push(
                util.format(
                  '%d',
                  Buffer.isBuffer(data) ? data[i] : data.charCodeAt(i),
                ),
              );
            srv.logDebug('write bin: ' + raw.toString(), s, 'telnet');
          }

          try {
            data = encodeTelnetOutbound(data, Boolean(s.utf8_negotiated));
          } catch (ex) {
            srv.logError('iconv encode error: ' + String(ex), s, 'telnet');
          }

          writeTelnet(s, data);
        };

        srv.logInfo(
          'new connection to ' + host + ':' + port + ' for ' + s.remoteAddress,
          s,
          'telnet',
        );
        srv.logInfo('new telnet socket connected', s, 'telnet');

        negotiationTimeout = setTimeout(function () {
          s.utf8_negotiated = s.mxp_negotiated = s.gmcp_negotiated = 1;
          s.new_negotiated =
            s.new_handshake =
            s.sga_negotiated =
            s.echo_negotiated =
            s.naws_negotiated =
              1;
        }, PROTOCOL_NEGOTIATION_TIMEOUT_MS);

        socket
          .on('data', function (data: Buffer) {
            srv.sendClient(s, data);
          })
          .on('timeout', function () {
            if (negotiationTimeout) clearTimeout(negotiationTimeout);
            srv.logWarn('telnet socket timeout', s, 'telnet');
            srv.sendClient(
              s,
              Buffer.from('Timeout: server port is down.\r\n'),
            );
            setTimeout(function () {
              srv.closeSocket(s);
            }, SOCKET_CLOSE_DELAY_MS);
          })
          .on('close', function () {
            if (negotiationTimeout) clearTimeout(negotiationTimeout);
            srv.logInfo('telnet socket closed', s, 'telnet');
            setTimeout(function () {
              srv.closeSocket(s);
            }, SOCKET_CLOSE_DELAY_MS);
          })
          .on('error', function (err: Error) {
            if (negotiationTimeout) clearTimeout(negotiationTimeout);
            srv.logError('telnet error: ' + err.toString(), s, 'telnet');
            srv.sendClient(
              s,
              Buffer.from('Error: maybe the mud server is down?'),
            );
            setTimeout(function () {
              srv.closeSocket(s);
            }, SOCKET_CLOSE_DELAY_MS);
          });
      },
    }).catch((cause: unknown) => {
      // Abort is already being handled by closeSocket; do not send/schedule
      // twice.
      if (controller.signal.aborted) return;
      if (s.pendingMudTransport === controller) {
        s.pendingMudTransport = undefined;
      }
      const error = cause instanceof Error ? cause : new Error(String(cause));
      // The log carries the underlying cause; the player gets the stable text.
      srv.logError(
        `telnet error: ${describeTransportError(error)}`,
        s,
        'telnet',
      );
      const message =
        runtimeConfig.mudTlsMode === 'required'
          ? error.message
          : 'Error: maybe the mud server is down?';
      srv.rejectLegacy(s, message);
    });
  },

  closeSocket: function (s: SocketExtended): void {
    // Check if this socket is part of a session
    if (sessionIntegration.hasSession(s)) {
      // Detach from session instead of fully closing
      sessionIntegration.handleSocketClose(s);

      // Remove from socket list
      server.sockets.delete(s);

      srv.logInfo('peer detached from session', s, 'ws');
      srv.logInfo('active sockets: ' + server.sockets.size, s, 'ws');
      return;
    }

    // A legacy connection has no Session to own its capacity, so release the
    // IP count here. Guarded by the field so a double close cannot decrement
    // twice, which would hand out capacity that was never freed.
    if (s.legacyCountedIp) {
      sessionIntegration.sessionManager.decrementIPCount(s.legacyCountedIp);
      s.legacyCountedIp = undefined;
    }

    if (!s.ts && s.pendingMudTransport) {
      const controller = s.pendingMudTransport;
      s.pendingMudTransport = undefined;
      controller.abort();
    }

    // Legacy behavior - close everything
    if (s.ts) {
      srv.logInfo(
        `closing telnet socket: ${s.host ?? srv.tn_host}:${s.port ?? srv.tn_port}`,
        s,
        'ws',
      );
      // Destroy the telnet socket, not the WebSocket. `s.terminate` is
      // rebound at connection time to close the WebSocket, so calling it
      // here left the upstream MUD connection open — a legacy client has no
      // session to resume, so nothing would ever have reclaimed it.
      s.ts.destroy();
      s.ts = undefined;
    }

    server.sockets.delete(s);

    srv.logInfo('closing websocket: ' + formatWsSocketContext(s), s, 'ws');

    if (s.terminate) s.terminate();
    else s.socket?.terminate();

    srv.logInfo('active sockets: ' + server.sockets.size, s, 'ws');
  },

  sendClient: function (s: SocketExtended, data: Buffer): void {
    const p = srv.prt;

    // Skip all negotiation loops when every protocol is settled
    const negotiationDone =
      !s.ttype.length &&
      s.gmcp_negotiated &&
      s.msdp_negotiated &&
      s.mxp_negotiated &&
      s.new_negotiated &&
      s.new_handshake &&
      s.echo_negotiated &&
      s.sga_negotiated &&
      s.naws_negotiated &&
      s.utf8_negotiated;

    if (!negotiationDone) {
      if (s.ttype.length) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.DO &&
            data[i + 2] === p.TTYPE
          ) {
            if (!s.ttype.length) continue;
            const terminalType = s.ttype.shift();
            if (!terminalType) continue;
            srv.logInfo('IAC DO TTYPE <- IAC FIRST TTYPE', s, 'proto');
            srv.sendTTYPE(s, terminalType);
          } else if (
            data[i] === p.IAC &&
            data[i + 1] === p.SB &&
            data[i + 2] === p.TTYPE &&
            data[i + 3] === p.REQUEST
          ) {
            if (!s.ttype.length) continue;
            const terminalType = s.ttype.shift();
            if (!terminalType) continue;
            srv.logInfo('IAC SB TTYPE <- IAC NEXT TTYPE', s, 'proto');
            srv.sendTTYPE(s, terminalType);
          }
        }
      }

      if (!s.gmcp_negotiated) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            (data[i + 1] === p.DO || data[i + 1] === p.WILL) &&
            data[i + 2] === p.GMCP
          ) {
            srv.logInfo('IAC DO GMCP', s, 'proto');

            if (data[i + 1] === p.DO) writeTelnet(s, p.WILL_GMCP);
            else writeTelnet(s, p.DO_GMCP);

            srv.logInfo('IAC DO GMCP <- IAC WILL GMCP', s, 'proto');

            s.gmcp_negotiated = 1;

            for (let t = 0; t < srv.gmcp.portal.length; t++) {
              if (t === 0 && s.client) {
                srv.sendGMCP(s, 'client ' + s.client);
                continue;
              }

              srv.sendGMCP(s, srv.gmcp.portal[t]);
            }

            srv.sendGMCP(s, 'client_ip ' + s.remoteAddress);
          }
        }
      }

      if (!s.msdp_negotiated) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.WILL &&
            data[i + 2] === p.MSDP
          ) {
            writeTelnet(s, p.DO_MSDP);
            srv.logInfo('IAC WILL MSDP <- IAC DO MSDP', s, 'proto');
            srv.sendMSDPPair(s, 'CLIENT_ID', s.client || 'mudportal.com');
            srv.sendMSDPPair(s, 'CLIENT_VERSION', '1.0');
            srv.sendMSDPPair(s, 'CLIENT_IP', s.remoteAddress);
            srv.sendMSDPPair(s, 'XTERM_256_COLORS', '1');
            srv.sendMSDPPair(s, 'MXP', '1');
            srv.sendMSDPPair(s, 'UTF_8', '1');
            s.msdp_negotiated = 1;
          }
        }
      }

      if (!s.mxp_negotiated) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.DO &&
            data[i + 2] === p.MXP
          ) {
            writeTelnet(s, Buffer.from([p.IAC, p.WILL, p.MXP]));
            srv.logInfo('IAC DO MXP <- IAC WILL MXP', s, 'proto');
            s.mxp_negotiated = 1;
          } else if (
            data[i] === p.IAC &&
            data[i + 1] === p.WILL &&
            data[i + 2] === p.MXP
          ) {
            writeTelnet(s, Buffer.from([p.IAC, p.DO, p.MXP]));
            srv.logInfo('IAC WILL MXP <- IAC DO MXP', s, 'proto');
            s.mxp_negotiated = 1;
          }
        }
      }

      if (!s.new_negotiated) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.DO &&
            data[i + 2] === p.NEW
          ) {
            writeTelnet(s, Buffer.from([p.IAC, p.WILL, p.NEW]));
            srv.logInfo('IAC WILL NEW-ENV', s, 'proto');
            s.new_negotiated = 1;
          }
        }
      } else if (!s.new_handshake) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.SB &&
            data[i + 2] === p.NEW &&
            data[i + 3] === p.REQUEST
          ) {
            writeTelnet(s, Buffer.from([p.IAC, p.SB, p.NEW, p.IS, p.IS]));
            writeTelnet(s, 'IPADDRESS');
            writeTelnet(s, Buffer.from([p.REQUEST]));
            writeTelnet(s, s.remoteAddress);
            writeTelnet(s, Buffer.from([p.IAC, p.SE]));
            srv.logInfo('IAC NEW-ENV IP VAR SEND', s, 'proto');
            s.new_handshake = 1;
          }
        }
      }

      if (!s.echo_negotiated) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.WILL &&
            data[i + 2] === p.ECHO
          ) {
            writeTelnet(s, Buffer.from([p.IAC, p.WONT, p.ECHO]));
            srv.logInfo('IAC WILL ECHO <- IAC WONT ECHO', s, 'proto');
            // set a flag to avoid logging the next message (maybe passwords)
            s.password_mode = true;
            s.echo_negotiated = 1;
          }
        }
      }

      if (!s.sga_negotiated) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.WILL &&
            data[i + 2] === p.SGA
          ) {
            writeTelnet(s, Buffer.from([p.IAC, p.WONT, p.SGA]));
            srv.logInfo('IAC WILL SGA <- IAC WONT SGA', s, 'proto');
            s.sga_negotiated = 1;
          }
        }
      }

      if (!s.naws_negotiated) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.WILL &&
            data[i + 2] === p.NAWS
          ) {
            writeTelnet(s, Buffer.from([p.IAC, p.WONT, p.NAWS]));
            srv.logInfo('IAC WILL NAWS <- IAC WONT NAWS', s, 'proto');
            s.naws_negotiated = 1;
          }
        }
      }

      if (!s.utf8_negotiated) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.DO &&
            data[i + 2] === p.CHARSET
          ) {
            writeTelnet(s, p.WILL_CHARSET);
            srv.logInfo('IAC DO CHARSET <- IAC WILL CHARSET', s, 'proto');
          }

          if (
            data[i] === p.IAC &&
            data[i + 1] === p.SB &&
            data[i + 2] === p.CHARSET
          ) {
            writeTelnet(s, p.ACCEPT_UTF8);
            srv.logInfo('UTF-8 negotiated', s, 'proto');
            s.utf8_negotiated = 1;
          }
        }
      }
    } // end if (!negotiationDone)

    if (srv.debug) {
      const raw: string[] = [];
      for (let i = 0; i < data.length; i++)
        raw.push(util.format('%d', data[i]));
      srv.logDebug('raw bin: ' + raw, s, 'proto');
    }

    if (!srv.compress) {
      sendBase64IfOpen(s, data);
      return;
    }

    /* Client<->Proxy only Compression */
    zlib.deflateRaw(data, function (err: Error | null, buffer: Buffer) {
      if (err) {
        srv.logError('zlib error: ' + err, s, 'proto');
        return;
      }
      // Guard: socket may have closed during async compression
      if (s.readyState === 1) {
        s.send(buffer.toString('base64'));
      }
    });
  },

  originAllowed: function (req?: IncomingMessage): number {
    // Reads the parsed config, not process.env. The ad-hoc read here meant
    // the startup wildcard rejection was bypassed and ALLOW_MISSING_ORIGIN
    // could not be turned on at all.
    return isOriginAllowed(
      req?.headers?.origin,
      runtimeConfig.allowedOrigins,
      runtimeConfig.allowMissingOrigin,
    )
      ? 1
      : 0;
  },

  log: function (
    msg: LogMessage,
    s?: SocketExtended,
    level: LogLevel = LogLevel.INFO,
    context?: string,
  ): void {
    const currentLevel = getLogLevel();
    if (level < currentLevel) return;

    // Get client info (prefer resolved remoteAddress, fall back to req)
    const clientInfo =
      s?.remoteAddress || s?.req?.connection?.remoteAddress || '';
    const clientStr = clientInfo ? `[${clientInfo}]` : '';

    // Get MUD target info
    const mudHost = s?.host || (s?.ts ? srv.tn_host : '');
    const mudPort = s?.port || (s?.ts ? srv.tn_port : 0);
    const targetStr = mudHost && mudPort ? ` [${mudHost}:${mudPort}]` : '';

    // Get session ID
    let sidStr = '';
    try {
      if (s) {
        const session = sessionIntegration.sessionManager.findByWebSocket(s);
        if (session) sidStr = ` [sid:${session.id}]`;
      }
    } catch (_err) {
      // Session lookup may fail during startup/shutdown
    }

    // Get timestamp
    const timestamp = new Date().toISOString();

    // Format level string with color
    let levelStr: string;
    let levelColor: string;
    switch (level) {
      case LogLevel.DEBUG:
        levelStr = 'DEBUG';
        levelColor = Colors.gray;
        break;
      case LogLevel.INFO:
        levelStr = 'INFO ';
        levelColor = Colors.green;
        break;
      case LogLevel.WARN:
        levelStr = 'WARN ';
        levelColor = Colors.yellow;
        break;
      case LogLevel.ERROR:
        levelStr = 'ERROR';
        levelColor = Colors.red;
        break;
      default:
        levelStr = 'INFO ';
        levelColor = Colors.green;
    }

    // Format context if provided
    const contextStr = context
      ? useColors()
        ? `${Colors.cyan}[${context}]${Colors.reset}`
        : `[${context}]`
      : '';

    // Format message
    let messageStr: string;
    if (stringValueSchema.safeParse(msg).success) {
      messageStr = String(msg);
    } else if (msg instanceof Error) {
      messageStr = `${msg.name}: ${msg.message}`;
      if (msg.stack && level <= LogLevel.DEBUG) {
        messageStr += `\n${msg.stack}`;
      }
    } else {
      // colors: false deliberately. inspect would embed its own ANSI, which the
      // redaction below strips anyway — and stripping our own escapes to
      // neutralize an attacker's is a fight with no winner. The logger adds
      // colour to the level and metadata instead, after redaction.
      messageStr = util.inspect(msg, {
        depth: 3,
        colors: false,
        compact: true,
      });
    }

    // Redaction happens here, once, rather than at each call site (MWP-94).
    // Applied centrally it also covers log statements nobody has written yet,
    // which is the only form of this guarantee that survives future changes.
    // Secret values come from configuration, so a secret reaching a log by any
    // route — including inside a library's error message — is removed.
    messageStr = redactLogMessage(messageStr, { secrets: logSecrets() });

    // Build final output
    const metaStr = `${clientStr}${targetStr}${sidStr}`;
    const parts: string[] = [];
    if (useColors()) {
      parts.push(
        `${Colors.dim}${timestamp}${Colors.reset}`,
        `${levelColor}${levelStr}${Colors.reset}`,
      );
      if (metaStr) parts.push(`${Colors.bright}${metaStr}${Colors.reset}`);
      if (contextStr) parts.push(contextStr);
      parts.push(messageStr);
    } else {
      parts.push(timestamp, levelStr);
      if (metaStr) parts.push(metaStr);
      if (contextStr) parts.push(contextStr);
      parts.push(messageStr);
    }

    // eslint-disable-next-line no-console
    console.log(parts.join(' '));
  },

  // Convenience methods for different log levels
  logDebug: function (
    msg: LogMessage,
    s?: SocketExtended,
    context?: string,
  ): void {
    srv.log(msg, s, LogLevel.DEBUG, context);
  },
  logInfo: function (
    msg: LogMessage,
    s?: SocketExtended,
    context?: string,
  ): void {
    srv.log(msg, s, LogLevel.INFO, context);
  },
  logWarn: function (
    msg: LogMessage,
    s?: SocketExtended,
    context?: string,
  ): void {
    srv.log(msg, s, LogLevel.WARN, context);
  },
  logError: function (
    msg: LogMessage,
    s?: SocketExtended,
    context?: string,
  ): void {
    srv.log(msg, s, LogLevel.ERROR, context);
  },

  die: function (core?: boolean): void {
    // Ordered so a restart is safe behind a load balancer. What matters is not
    // that everything closes but WHEN: become unready, wait long enough for the
    // balancer to notice, and only then take capacity away. Skipping the wait is
    // the ordinary cause of errors during a deploy (MWP-96).
    const cfg = runtimeConfig.shutdown;

    shutdownCoordinator ??= new ShutdownCoordinator({
      deadlineMs: cfg.deadlineMs,
      log: (m) => srv.logWarn(m, undefined, 'init'),
      onComplete: () => {
        // One event-loop turn before exiting, so the final log line reaches a
        // redirected stdout. process.exit does not flush, and the "completed"
        // line was being lost — leaving an operator unable to tell a clean
        // drain from one that was cut short.
        setImmediate(() => process.exit(core ? 3 : 0));
      },
      steps: [
        {
          // 1. Unready first. /health already returns 503 on !srv.open, and the
          // upgrade handler already rejects with 503; this is what turns them on.
          name: 'become unready',
          run: () => {
            srv.open = false;
          },
        },
        {
          // 2. The window that makes the rest safe. Nothing is closed yet.
          name: `await ${cfg.gracePeriodMs}ms drain grace`,
          run: () =>
            new Promise<void>((resolve) => {
              const t = setTimeout(resolve, cfg.gracePeriodMs);
              t.unref?.();
            }),
        },
        {
          // 3. Stop the liveness sweep before closing sockets, or it races the
          // drain and terminates peers this sequence is already notifying.
          name: 'stop heartbeat',
          run: () => {
            if (heartbeatTimer) clearInterval(heartbeatTimer);
            heartbeatTimer = null;
            heartbeatMonitor = null;
          },
        },
        {
          name: 'close client connections',
          run: () => {
            for (const sock of server.sockets) {
              // 1001 "going away" is the code for a server shutting down, so a
              // client can tell a restart from a crash and back off accordingly.
              // The previous code called sock.write(), which does not exist on a
              // ws socket — the guard was always false, so WebSocket clients
              // were told nothing at all. Only legacy raw sockets have .write,
              // and both are declared optional on SocketExtended so this asks
              // for them directly rather than asserting a structural shape.
              try {
                if (sock.close) {
                  sock.close(1001, 'Server restarting');
                } else if (sock.write) {
                  sock.write('Proxy server is going down...');
                }
              } catch {
                // A socket already gone is not a reason to stop draining.
              }
            }
          },
        },
        {
          // 5. Telnet sockets, so the MUD sees a disconnect rather than a reset.
          name: 'close telnet sockets and sessions',
          run: () => {
            // The copy is the point: closeSocket calls
            // server.sockets.delete(sock), so this iterates a snapshot rather
            // than the Set being mutated underneath it.
            // eslint-disable-next-line unicorn/no-useless-spread
            for (const sock of [...server.sockets]) srv.closeSocket(sock);
            sessionIntegration.shutdown();
          },
        },
        {
          // 6. Release the port, BEFORE flushing state.
          //
          // MWP-96 lists the flush first, and that order is wrong: an App
          // Attest registration still being verified can update the in-memory
          // key store after the flush has run, then schedule a debounced save
          // that never fires because the process exits. Closing first means no
          // handler is still able to mutate what is about to be written.
          //
          // The wait is bounded so a listener that will not drain cannot cost
          // us the flush entirely — losing an acknowledged registration is the
          // worse outcome, and the overall deadline still applies on top.
          name: 'close listener',
          run: () =>
            new Promise<void>((resolve) => {
              if (!httpServer) return resolve();
              const bail = setTimeout(resolve, LISTENER_CLOSE_WAIT_MS);
              // In Bun 1.3.14, unref caused the container to exit here before
              // flushing state or logging shutdown completion. Keep the
              // bounded fallback referenced; the container acceptance test
              // asserts both later steps run.
              httpServer.close(() => {
                clearTimeout(bail);
                resolve();
              });
              httpServer = null;
            }),
        },
        {
          // 7. Flush persisted state last, once nothing can still change it.
          // debouncedSaveAttestedKeys coalesces over 2 seconds and nothing
          // flushed it, so a key registered just before shutdown died with the
          // timer.
          name: 'flush attested keys',
          run: () => {
            if (
              runtimeConfig.appAttest.enabled &&
              runtimeConfig.appAttest.attestedKeysPath
            ) {
              flushAttestedKeys(runtimeConfig.appAttest.attestedKeysPath);
            }
          },
        },
      ],
    });

    void shutdownCoordinator.start();
  },

  newSocket: function (s: SocketExtended): void {
    if (!srv.open) {
      /* server is going down */
      s.terminate();
      return;
    }

    server.sockets.add(s);

    s.on('data', function (d: Buffer) {
      srv.forward(s, d);
    });

    s.on('end', function () {
      srv.closeSocket(s);
    });

    s.on('error', function () {
      srv.closeSocket(s);
    });

    srv.initT(s);
    srv.logInfo('new connection', s, 'ws');
  },

  forward: function (s: SocketExtended, d: Buffer): void {
    if (s.ts) {
      // Shape, never content (MWP-94). This logged keystrokes verbatim unless
      // password_mode happened to be set, and password_mode is best-effort
      // ECHO detection — a password typed at a prompt the proxy did not
      // recognise was logged in full. Byte count is enough to debug framing.
      srv.logDebug(
        `forward: ${d.length} bytes${s.password_mode ? ' (password mode)' : ''}`,
        s,
        'ws',
      );

      // reset password mode after forwarding the message
      if (s.password_mode) {
        s.password_mode = false;
      }

      s.ts.send(d.toString());
    }
  },
};

// Initialize async
const init = async () => {
  process
    .on('SIGINT', () => {
      srv.log('Got SIGINT.');
      srv.die();
    })
    .on('SIGABRT', () => {
      srv.log('Got SIGABRT.');
      srv.die();
    })
    .on('SIGSEGV', () => {
      srv.log('Got SIGSEGV.');
      process.exit(3);
    })
    .on('SIGTERM', () => {
      srv.log('Got SIGTERM.');
      srv.die();
    });

  await srv.init();
};

// Start the server
init().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to initialize:', err);
  process.exit(1);
});
