/*
Lightweight Websocket <-> Telnet Proxy
v1.3 - 2/27/2014 @plamzi
v2.0 - ?? @neverbot
v3.0 - March 2025 @neverbot

Author: plamzi - plamzi@gmail.com
Contributor: neverbot
MIT license

Supports client setting any host and port prior to connect.

Example (client-side JS):

if (WebSocket) {
  let ws = new WebSocket('ws://mywsproxyserver:6200/');
  ws.onopen = function(e) {
    ws.send('{ host: "localhost", port: 7000, connect: 1 }');
  };
}

Usage Notes:

The server waits to receive { "connect": 1 } to begin connecting to
a telnet client on behalf of the user, so you have to send it
even if you are not passing it host and port from the client.
*/

import util from 'util';
import net from 'net';
import https from 'https';
import http from 'http';
import zlib from 'zlib';
import fs from 'fs';
import { X509Certificate } from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';
const { dirname } = path;
import iconv from 'iconv-lite';
import type { WebSocket as WS, WebSocketServer } from 'ws';
import type { Socket } from 'net';
import type { Server as HttpServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';

import os from 'os';
import { SessionIntegration } from './src/session-integration';

// Log levels enum
const enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

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

// Get log level from environment
const getLogLevel = (): LogLevel => {
  const envLevel = process.env.LOG_LEVEL?.toUpperCase();
  switch (envLevel) {
    case 'DEBUG':
      return LogLevel.DEBUG;
    case 'INFO':
      return LogLevel.INFO;
    case 'WARN':
      return LogLevel.WARN;
    case 'ERROR':
      return LogLevel.ERROR;
    default:
      return LogLevel.INFO;
  }
};

// Check if TTY for color support
const useColors = process.stdout.isTTY && process.env.NO_COLOR !== '1';

// Get current file directory in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Initialize session persistence layer
const sessionIntegration = new SessionIntegration({
  sessions: {
    timeoutHours: 24,
    maxPerDevice: 5,
    maxPerIP: 10,
  },
  buffer: {
    sizeKB: 50,
  },
  triggers: {
    rateLimit: {
      perTypePerMinute: 1,
      totalPerHour: 10,
    },
  },
  // APNS config from environment
  apns: process.env.APNS_KEY_PATH
    ? {
        keyPath: process.env.APNS_KEY_PATH,
        keyId: process.env.APNS_KEY_ID || '',
        teamId: process.env.APNS_TEAM_ID || '',
        topic: process.env.APNS_TOPIC || '',
        environment:
          (process.env.APNS_ENVIRONMENT as 'sandbox' | 'production') ||
          'sandbox',
      }
    : undefined,
});

// if this is true, only allow connections to srv.tn_host, ignoring
// the server sent as argument by the client
const ONLY_ALLOW_DEFAULT_SERVER = true;
// Trust X-Real-IP / X-Forwarded-For headers from a reverse proxy
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const REPOSITORY_URL = 'https://github.com/maldorne/mud-web-proxy/';
const PACKAGE_VERSION = '3.0.0';
const MCCP_NEGOTIATION_DELAY_MS = 6000;
const PROTOCOL_NEGOTIATION_TIMEOUT_MS = 12000;
const SOCKET_CLOSE_DELAY_MS = 500;

/**
 * Resolve the real client IP from proxy headers or the socket.
 * Only trusts headers when TRUST_PROXY=1.
 */
const getClientIP = (req: IncomingMessage): string => {
  if (TRUST_PROXY) {
    const realIP = req.headers['x-real-ip'];
    if (typeof realIP === 'string' && realIP) return realIP;

    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded) {
      // First entry is the original client
      return forwarded.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress || '';
};

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

interface ProtocolConstants {
  WILL_ATCP: Buffer;
  WILL_GMCP: Buffer;
  DO_GMCP: Buffer;
  DO_MCCP: Buffer;
  DO_MSDP: Buffer;
  DO_MXP: Buffer;
  WILL_MXP: Buffer;
  START: Buffer;
  STOP: Buffer;
  WILL_TTYPE: Buffer;
  WILL_NEW: Buffer;
  WONT_NAWS: Buffer;
  SGA: number;
  NEW: number;
  TTYPE: number;
  MCCP2: number;
  MSDP: number;
  MSDP_VAR: number;
  MSDP_VAL: number;
  MXP: number;
  ATCP: number;
  GMCP: number;
  SE: number;
  SB: number;
  WILL: number;
  WONT: number;
  DO: number;
  DONT: number;
  IAC: number;
  IS: number;
  REQUEST: number;
  ECHO: number;
  VAR: number;
  ACCEPTED: number;
  REJECTED: number;
  CHARSET: number;
  ESC: number;
  NAWS: number;
  WILL_CHARSET: Buffer;
  WILL_UTF8: Buffer;
  ACCEPT_UTF8: Buffer;
}

interface TTypeConfig {
  enabled: number;
  portal: string[];
}

interface GMCPConfig {
  enabled: number;
  portal: string[];
}

interface MSDPRequest {
  key?: string;
  val?: string | string[];
}

export interface SocketExtended extends WS {
  req: IncomingMessage & { connection: { remoteAddress: string } };
  ts?: TelnetSocket;
  host?: string;
  port?: number;
  ttype: string[];
  name?: string;
  client?: string;
  mccp?: boolean;
  utf8?: boolean;
  debug?: boolean;
  compressed: number;
  mccp_negotiated?: number;
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
  sendUTF: (data: string | Buffer) => void;
  terminate: () => void;
  remoteAddress: string;
}

export interface TelnetSocket extends Socket {
  send: (data: string | Buffer) => void;
}

let server: ServerState = { sockets: new Set() };

const stringify = function (A: unknown): string {
  const cache = new Set<unknown>();
  const val = JSON.stringify(A, function (_k: string, v: unknown) {
    if (typeof v === 'object' && v !== null) {
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
      sessionId: meta.sessionId.slice(0, 8) + '...',
      mudHost: meta.mudHost,
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
    remoteAddress: s.req?.connection?.remoteAddress || 'unknown',
    host: s.host || null,
    port: s.port || null,
    name: s.name || null,
    client: s.client || null,
    compressed: s.compressed,
    protocols: {
      mccp: !!s.mccp_negotiated,
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
      hostname: os.hostname(),
      pid: process.pid,
      defaultHost: srv.tn_host,
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
  document.getElementById('notifications-info').innerHTML =
    statRow('Enabled', badge(n.enabled)) +
    statRow('Configured', badge(n.configured)) +
    statRow('Token Valid', badge(n.tokenValid)) +
    statRow('Pending', n.pendingNotifications);
}

function renderSessions(d) {
  var el = document.getElementById('sessions-table');
  if (!d.sessions.length) { el.innerHTML = '<div class="empty">No active sessions</div>'; return; }
  var html = '<table><tr><th>ID</th><th>MUD</th><th>Telnet</th><th>Clients</th><th>Created</th><th>Buffer</th></tr>';
  d.sessions.forEach(function(s) {
    html += '<tr>' +
      '<td>' + s.sessionId + '</td>' +
      '<td>' + s.mudHost + ':' + s.mudPort + '</td>' +
      '<td>' + badge(s.telnetConnected) + '</td>' +
      '<td>' + s.clientCount + '</td>' +
      '<td>' + new Date(s.createdAt).toLocaleString() + '</td>' +
      '<td>' + (s.bufferStats ? s.bufferStats.chunks + ' chunks / ' +
        formatBytes(s.bufferStats.sizeBytes) : '-') + '</td>' +
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
  tn_host: string;
  tn_port: number;
  debug: boolean;
  compress: boolean;
  open: boolean;
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
  initT: (so: SocketExtended) => void;
  closeSocket: (s: SocketExtended) => void;
  sendClient: (s: SocketExtended, data: Buffer) => void;
  originAllowed: (req?: IncomingMessage) => number;
  log: (
    msg: unknown,
    s?: SocketExtended,
    level?: LogLevel,
    context?: string,
  ) => void;
  logDebug: (msg: unknown, s?: SocketExtended, context?: string) => void;
  logInfo: (msg: unknown, s?: SocketExtended, context?: string) => void;
  logWarn: (msg: unknown, s?: SocketExtended, context?: string) => void;
  logError: (msg: unknown, s?: SocketExtended, context?: string) => void;
  die: (core?: boolean) => void;
  newSocket: (s: SocketExtended) => void;
  forward: (s: SocketExtended, d: Buffer) => void;
}

const srv: ServerConfig = {
  path: __dirname,
  /* this websocket proxy port - can be overridden with WS_PORT env var */
  ws_port: parseInt(process.env.WS_PORT || '6200', 10),
  /* default telnet host - can be overridden with TN_HOST env var */
  tn_host: process.env.TN_HOST || 'muds.maldorne.org',
  /* default telnet/target port - can be overridden with TN_PORT env var */
  tn_port: parseInt(process.env.TN_PORT || '5010', 10),
  /* enable additional debugging */
  debug: false,
  /* use node zlib (different from mccp) - you want this turned off unless your server can't do MCCP and your client can inflate data */
  compress: true,
  /* set to false while server is shutting down */
  open: true,

  ttype: {
    enabled: 1,
    portal: ['maldorne.org', 'XTERM-256color', 'MTTS 141'],
  } as TTypeConfig,

  gmcp: {
    enabled: 1,
    portal: ['client maldorne.org', 'client_version 1.0'],
  } as GMCPConfig,

  prt: {
    WILL_ATCP: Buffer.from([255, 251, 200]),
    WILL_GMCP: Buffer.from([255, 251, 201]),
    DO_GMCP: Buffer.from([255, 253, 201]),
    DO_MCCP: Buffer.from([255, 253, 86]),
    DO_MSDP: Buffer.from([255, 253, 69]),
    DO_MXP: Buffer.from([255, 253, 91]),
    WILL_MXP: Buffer.from([255, 251, 91]),
    START: Buffer.from([255, 250, 201]),
    STOP: Buffer.from([255, 240]),
    WILL_TTYPE: Buffer.from([255, 251, 24]),
    WILL_NEW: Buffer.from([255, 251, 39]),
    WONT_NAWS: Buffer.from([255, 252, 31]),
    SGA: 3,
    NEW: 39,
    TTYPE: 24,
    MCCP2: 86,
    MSDP: 69,
    MSDP_VAR: 1,
    MSDP_VAL: 2,
    MXP: 91,
    ATCP: 200,
    GMCP: 201,
    SE: 240,
    SB: 250,
    WILL: 251,
    WONT: 252,
    DO: 253,
    DONT: 254,
    IAC: 255,
    IS: 0,
    REQUEST: 1,
    ECHO: 1,
    VAR: 1,
    ACCEPTED: 2,
    REJECTED: 3,
    CHARSET: 42,
    ESC: 33,
    NAWS: 31,
    WILL_CHARSET: Buffer.from([255, 251, 42]),
    WILL_UTF8: Buffer.from([255, 250, 42, 2, 85, 84, 70, 45, 56, 255, 240]),
    ACCEPT_UTF8: Buffer.from([
      255, 250, 2, 34, 85, 84, 70, 45, 56, 34, 255, 240,
    ]),
  } as ProtocolConstants,

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

    // Check if TLS is disabled (for testing)
    const USE_TLS = process.env.DISABLE_TLS !== '1';

    if (
      USE_TLS &&
      fs.existsSync(path.resolve(__dirname, 'cert.pem')) &&
      fs.existsSync(path.resolve(__dirname, 'privkey.pem'))
    ) {
      const cert = fs.readFileSync(path.resolve(__dirname, 'cert.pem'));
      const key = fs.readFileSync(path.resolve(__dirname, 'privkey.pem'));
      webserver = https.createServer({
        cert: cert,
        key: key,
      });

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
    } else if (!USE_TLS) {
      // Non-TLS mode for testing
      webserver = http.createServer();
      srv.logInfo('Running without TLS (DISABLE_TLS=1)', undefined, 'init');
    } else {
      webserver = http.createServer();
      srv.logWarn(
        'No cert.pem/privkey.pem found, running without TLS',
        undefined,
        'init',
      );
    }

    webserver.listen(srv.ws_port, function () {
      srv.logInfo('server listening: port ' + srv.ws_port, undefined, 'init');
    });

    // Add HTTP endpoints
    webserver.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/health') {
        const stats = sessionIntegration.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: PACKAGE_VERSION,
            ...stats,
          }),
        );
      } else if (req.url === '/diagnostic') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(generateDiagnosticHTML());
      } else if (req.url === '/diagnostic/api') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getDiagnosticData()));
      }
    });

    // Create WebSocket server
    try {
      const { WebSocketServer } = await import('ws');
      wsServer = new WebSocketServer({ server: webserver });

      srv.logInfo(
        `WebSocket server initialized (Node.js ${process.version})`,
        undefined,
        'init',
      );
    } catch (err) {
      srv.logError(
        'Error creating WebSocket server: ' + err,
        undefined,
        'init',
      );
      process.exit(1);
    }

    wsServer.on(
      'connection',
      function connection(socket: WS, req: IncomingMessage) {
        srv.logInfo('new connection', undefined, 'ws');
        if (!srv.open) {
          socket.terminate();
          return;
        }

        if (!srv.originAllowed(req)) {
          socket.terminate();
          return;
        }

        const extendedSocket = socket as SocketExtended;
        if (!extendedSocket.req)
          extendedSocket.req = req as SocketExtended['req'];

        // Resolve real client IP (supports reverse proxy headers)
        extendedSocket.remoteAddress = getClientIP(req);

        // Add compatibility methods for the WebSocket
        extendedSocket.sendUTF = extendedSocket.send.bind(extendedSocket);
        extendedSocket.terminate = () => extendedSocket.close();

        server.sockets.add(extendedSocket);
        srv.logInfo(
          'connection count: ' + server.sockets.size,
          extendedSocket,
          'ws',
        );

        socket.on('message', function message(msg: Buffer) {
          if (!srv.parse(extendedSocket, msg)) {
            srv.forward(extendedSocket, msg);
          }
        });

        socket.on('close', () => {
          srv.logInfo('peer disconnected', extendedSocket, 'ws');
          srv.closeSocket(extendedSocket);
        });

        socket.on('error', (error: Error) => {
          srv.logError('peer error: ' + error, extendedSocket, 'ws');
          srv.closeSocket(extendedSocket);
        });
      },
    );
  },

  parse: function (s: SocketExtended, d: Buffer): number {
    if (d[0] !== '{'.charCodeAt(0)) return 0;

    try {
      const msg = d.toString();
      const parsed = JSON.parse(msg);
      if (parsed && parsed.type) {
        const handled = sessionIntegration.parseNewMessage(s, d);
        if (handled) return 1;
      } else if (parsed) {
        srv.logError(
          'Ignoring message without type field: ' + msg,
          s,
          'parse',
        );
      }
    } catch (_err) {
      // Invalid JSON, forward to MUD
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

  initT: function (so: SocketExtended): void {
    const s = so;
    const host = s.host || srv.tn_host;
    const port = s.port || srv.tn_port;

    if (!s.ttype) s.ttype = [];

    s.ttype = s.ttype.concat(srv.ttype.portal.slice(0));
    s.ttype.push(s.remoteAddress);
    s.ttype.push(s.remoteAddress);

    s.compressed = 0;

    // do not allow the proxy connect to different servers
    if (ONLY_ALLOW_DEFAULT_SERVER) {
      const resolvedHost = s.host || srv.tn_host;
      if (resolvedHost !== srv.tn_host) {
        srv.logWarn(
          'blocked connection attempt to: ' + s.host + ':' + s.port,
          s,
          'telnet',
        );
        srv.sendClient(
          s,
          Buffer.from(
            'This proxy does not allow connections to servers different to ' +
              srv.tn_host +
              '.\r\nTake a look in ' +
              REPOSITORY_URL +
              ' and install it in your own server.\r\n',
          ),
        );
        setTimeout(function () {
          srv.closeSocket(s);
        }, SOCKET_CLOSE_DELAY_MS);
        return;
      }
    }

    s.ts = net.createConnection(port, host, function () {
      srv.logInfo(
        'new connection to ' + host + ':' + port + ' for ' + s.remoteAddress,
        s,
        'telnet',
      );
    }) as TelnetSocket;

    s.ts.send = function (data: string | Buffer) {
      if (srv.debug) {
        const raw: string[] = [];
        for (let i = 0; i < data.length; i++)
          raw.push(
            util.format(
              '%d',
              typeof data === 'string' ? data.charCodeAt(i) : data[i],
            ),
          );
        srv.logDebug('write bin: ' + raw.toString(), s, 'telnet');
      }

      try {
        data = iconv.encode(data as string, 'latin1');
      } catch (ex) {
        srv.logError(
          'iconv encode error: ' + (ex as Error).toString(),
          s,
          'telnet',
        );
      }

      writeTelnet(s, data);
    };

    let negotiationTimeout: ReturnType<typeof setTimeout> | null = null;

    s.ts
      .on('connect', function () {
        srv.logInfo('new telnet socket connected', s, 'telnet');

        negotiationTimeout = setTimeout(function () {
          s.utf8_negotiated =
            s.mccp_negotiated =
            s.mxp_negotiated =
            s.gmcp_negotiated =
              1;
          s.new_negotiated =
            s.new_handshake =
            s.sga_negotiated =
            s.echo_negotiated =
            s.naws_negotiated =
              1;
        }, PROTOCOL_NEGOTIATION_TIMEOUT_MS);
      })
      .on('data', function (data: Buffer) {
        srv.sendClient(s, data);
      })
      .on('timeout', function () {
        if (negotiationTimeout) clearTimeout(negotiationTimeout);
        srv.logWarn('telnet socket timeout', s, 'telnet');
        srv.sendClient(s, Buffer.from('Timeout: server port is down.\r\n'));
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
        srv.sendClient(s, Buffer.from('Error: maybe the mud server is down?'));
        setTimeout(function () {
          srv.closeSocket(s);
        }, SOCKET_CLOSE_DELAY_MS);
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

    // Legacy behavior - close everything
    if (s.ts) {
      srv.logInfo(
        `closing telnet socket: ${s.host ?? srv.tn_host}:${s.port ?? srv.tn_port}`,
        s,
        'ws',
      );
      s.terminate();
    }

    server.sockets.delete(s);

    srv.logInfo('closing socket', s, 'ws');

    if (s.terminate) s.terminate();
    else
      (
        s as unknown as { socket: { terminate: () => void } }
      ).socket.terminate();

    srv.logInfo('active sockets: ' + server.sockets.size, s, 'ws');
  },

  sendClient: function (s: SocketExtended, data: Buffer): void {
    const p = srv.prt;

    // Skip all negotiation loops when every protocol is settled
    const negotiationDone =
      (!s.mccp || s.mccp_negotiated || s.compressed) &&
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
      if (s.mccp && !s.mccp_negotiated && !s.compressed) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.WILL &&
            data[i + 2] === p.MCCP2
          ) {
            setTimeout(function () {
              srv.logInfo('IAC DO MCCP2', s, 'proto');
              writeTelnet(s, p.DO_MCCP);
            }, MCCP_NEGOTIATION_DELAY_MS);
          } else if (
            data[i] === p.IAC &&
            data[i + 1] === p.SB &&
            data[i + 2] === p.MCCP2
          ) {
            if (i) srv.sendClient(s, data.slice(0, i));

            data = data.slice(i + 5);
            s.compressed = 1;
            srv.logInfo('MCCP compression started', s, 'proto');

            if (!data.length) return;
          }
        }
      }

      if (s.ttype.length) {
        for (let i = 0; i < data.length; i++) {
          if (
            data[i] === p.IAC &&
            data[i + 1] === p.DO &&
            data[i + 2] === p.TTYPE
          ) {
            srv.logInfo('IAC DO TTYPE <- IAC FIRST TTYPE', s, 'proto');
            srv.sendTTYPE(s, s.ttype.shift()!);
          } else if (
            data[i] === p.IAC &&
            data[i + 1] === p.SB &&
            data[i + 2] === p.TTYPE &&
            data[i + 3] === p.REQUEST
          ) {
            srv.logInfo('IAC SB TTYPE <- IAC NEXT TTYPE', s, 'proto');
            srv.sendTTYPE(s, s.ttype.shift()!);
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

    if (!srv.compress || (s.mccp && s.compressed)) {
      s.send(data.toString('base64'));
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
    const allowedOrigins = process.env.ALLOWED_ORIGINS;
    if (!allowedOrigins) return 1; // backward compatible
    const origin = req?.headers?.origin || '';
    const allowed = allowedOrigins.split(',').map((s) => s.trim());
    return allowed.includes(origin) || allowed.includes('*') ? 1 : 0;
  },

  log: function (
    msg: unknown,
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
      ? useColors
        ? `${Colors.cyan}[${context}]${Colors.reset}`
        : `[${context}]`
      : '';

    // Format message
    let messageStr: string;
    if (typeof msg === 'string') {
      messageStr = msg;
    } else if (msg instanceof Error) {
      messageStr = `${msg.name}: ${msg.message}`;
      if (msg.stack && level <= LogLevel.DEBUG) {
        messageStr += `\n${msg.stack}`;
      }
    } else {
      messageStr = util.inspect(msg, {
        depth: 3,
        colors: useColors,
        compact: true,
      });
    }

    // Build final output
    const metaStr = `${clientStr}${targetStr}${sidStr}`;
    const parts: string[] = [];
    if (useColors) {
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
    msg: unknown,
    s?: SocketExtended,
    context?: string,
  ): void {
    srv.log(msg, s, LogLevel.DEBUG, context);
  },
  logInfo: function (
    msg: unknown,
    s?: SocketExtended,
    context?: string,
  ): void {
    srv.log(msg, s, LogLevel.INFO, context);
  },
  logWarn: function (
    msg: unknown,
    s?: SocketExtended,
    context?: string,
  ): void {
    srv.log(msg, s, LogLevel.WARN, context);
  },
  logError: function (
    msg: unknown,
    s?: SocketExtended,
    context?: string,
  ): void {
    srv.log(msg, s, LogLevel.ERROR, context);
  },

  die: function (core?: boolean): void {
    srv.logWarn('Dying gracefully in 3 sec.', undefined, 'init');
    srv.open = false;

    // Shut down session integration (clears intervals, sessions)
    sessionIntegration.shutdown();

    for (const sock of server.sockets) {
      /* inform clients so they can hop to another instance faster */
      if (sock && (sock as unknown as { write: (msg: string) => void }).write)
        (sock as unknown as { write: (msg: string) => void }).write(
          'Proxy server is going down...',
        );
      setTimeout(srv.closeSocket, 10, sock);
    }

    setTimeout(
      process.exit,
      3000,
      core ? 3 : 0,
    ); /* send SIGQUIT if core dump */
  },

  newSocket: function (s: SocketExtended): void {
    if (!srv.open) {
      /* server is going down */
      s.terminate();
      // s.destroy?s.destroy():s.socket.destroy();
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
      if (s.debug) {
        if (s.password_mode) {
          srv.logDebug('forward: **** (omitted)', s, 'ws');
        } else {
          srv.logDebug('forward: ' + d, s, 'ws');
        }
      }

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

  srv.init();
};

// Start the server
init().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to initialize:', err);
  process.exit(1);
});
