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

JSON requests with { "chat": 1 } will be intercepted and handled
by the basic in-proxy chat system.
*/

import util from 'util';
import net from 'net';
import https from 'https';
import http from 'http';
import zlib from 'zlib';
import fs from 'fs';
import { X509Certificate } from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { minify } from 'uglify-js';
import * as ws from 'ws';
import iconv from 'iconv-lite';
import type { WebSocket as WS, WebSocketServer } from 'ws';
import type { Socket } from 'net';
import type { Server as HttpServer } from 'http';
import type { IncomingMessage, ServerResponse } from 'http';

import { SessionIntegration } from './src/session-integration';

// Log levels enum
enum LogLevel {
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
const REPOSITORY_URL = 'https://github.com/maldorne/mud-web-proxy/';

interface ServerState {
  sockets: SocketExtended[];
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

interface ChatRequest {
  chat?: number;
  channel?: string;
  msg?: string;
  name?: string;
}

interface ClientRequest {
  host?: string;
  port?: number;
  ttype?: string;
  name?: string;
  client?: string;
  mccp?: boolean;
  utf8?: boolean;
  debug?: boolean;
  chat?: number;
  connect?: number;
  bin?: number[];
  msdp?: MSDPRequest;
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
  chat?: number;
  password_mode?: boolean;
  sendUTF: (data: string | Buffer) => void;
  terminate: () => void;
  remoteAddress: string;
}

export interface TelnetSocket extends Socket {
  send: (data: string | Buffer) => void;
}

interface ChatEntry {
  date: Date;
  data: ChatRequest;
}

let server: ServerState = { sockets: [] };
let chatlog: ChatEntry[] = [];

process.chdir(__dirname);

const stringify = function (A: unknown): string {
  const cache: unknown[] = [];
  const val = JSON.stringify(A, function (_k: string, v: unknown) {
    if (typeof v === 'object' && v !== null) {
      if (cache.indexOf(v) !== -1) return;
      cache.push(v);
    }
    return v;
  });
  return val ?? '';
};

// Load chat log asynchronously
const loadChatLog = async (): Promise<ChatEntry[]> => {
  try {
    const data = await fs.promises.readFile('./chat.json', 'utf8');
    const parsed = JSON.parse(data);
    // Ensure we always return an array
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    srv.log('Chat log error: ' + err);
    return [];
  }
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
  loadF: (f: string) => void;
  chat: (s: SocketExtended, req: ChatRequest) => void;
  chatUpdate: () => void;
  chatCleanup: (t: string) => string;
  originAllowed: () => number;
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
  [key: string]: unknown;
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

    srv.log('Using node version ' + majorVersion);

    server = {
      sockets: [],
    };

    try {
      // Load chat log asynchronously
      chatlog = await loadChatLog();
      srv.log('Chat log loaded successfully');
    } catch (err) {
      srv.log('Error loading chat log: ' + err);
      chatlog = [];
    }

    // Check if TLS is disabled (for testing)
    const USE_TLS = process.env.DISABLE_TLS !== '1';

    if (
      USE_TLS &&
      fs.existsSync('./cert.pem') &&
      fs.existsSync('./privkey.pem')
    ) {
      const cert = fs.readFileSync('./cert.pem');
      const key = fs.readFileSync('./privkey.pem');
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

        srv.logInfo('(ws) Using TLS/SSL');
        srv.logInfo(`  Certificate: ${subject}`, undefined, 'ssl');
        srv.logInfo(`  Issuer: ${issuer}`, undefined, 'ssl');
        srv.logInfo(
          `  Valid: ${validFrom} to ${validTo} (${daysUntilExpiry} days remaining)`,
          undefined,
          'ssl',
        );
      } catch (_err) {
        srv.logInfo('(ws) Using TLS/SSL (certificate details unavailable)');
      }
    } else if (!USE_TLS) {
      // Non-TLS mode for testing
      webserver = http.createServer();
      srv.log('(ws) Running without TLS (DISABLE_TLS=1)');
    } else {
      srv.log('Could not find cert and/or privkey files, exiting.');
      process.exit();
    }

    webserver.listen(srv.ws_port, function () {
      srv.log('(ws) server listening: port ' + srv.ws_port);
    });

    // Add health check endpoint
    webserver.on('request', (req: IncomingMessage, res: ServerResponse) => {
      if (req.url === '/health') {
        const stats = sessionIntegration.getStats();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            status: 'healthy',
            timestamp: new Date().toISOString(),
            version: '3.1.0',
            ...stats,
          }),
        );
      }
    });

    // Create WebSocket server based on Node.js version
    try {
      if (majorVersion >= 16) {
        // Dynamic import with destructuring
        const { WebSocketServer } = await import('ws');

        // Modern Node.js version (16+)
        wsServer = new WebSocketServer({ server: webserver });
      } else {
        // Legacy Node.js version (14 and below)
        wsServer = new (
          ws as unknown as {
            Server: new (opts: { server: HttpServer }) => ws.WebSocketServer;
          }
        ).Server({ server: webserver });
      }

      srv.log(`WebSocket server initialized (Node.js ${process.version})`);
    } catch (err) {
      srv.log('Error creating WebSocket server: ' + err);
      process.exit(1);
    }

    wsServer.on(
      'connection',
      function connection(socket: WS, req: IncomingMessage) {
        srv.log('(ws on connection) new connection');
        if (!srv.open) {
          socket.terminate();
          return;
        }

        if (!srv.originAllowed()) {
          socket.terminate();
          return;
        }

        const extendedSocket = socket as SocketExtended;
        if (!extendedSocket.req)
          extendedSocket.req = req as SocketExtended['req'];

        // Add compatibility methods for the WebSocket
        extendedSocket.sendUTF = extendedSocket.send.bind(extendedSocket);
        extendedSocket.terminate = () => extendedSocket.close();

        server.sockets.push(extendedSocket);
        srv.log(
          '(ws on connection) connection count: ' + server.sockets.length,
        );

        socket.on('message', function message(msg: Buffer) {
          // if (msg.type === 'utf8') {
          // msg = msg.utf8Data;
          if (!srv.parse(extendedSocket, msg)) {
            srv.forward(extendedSocket, msg);
          }
          // }
          // else {
          // srv.log('unrecognized msg type: ' + msg.type);
          // }
        });

        socket.on('close', () => {
          srv.log(
            new Date().toISOString() +
              ' (ws) peer ' +
              extendedSocket.req.connection.remoteAddress +
              ' disconnected.',
          );
          srv.closeSocket(extendedSocket);
        });

        socket.on('error', (error: Error) => {
          srv.log(
            new Date().toISOString() +
              ' (ws) peer ' +
              extendedSocket.req.connection.remoteAddress +
              ' error: ' +
              error,
          );
          srv.closeSocket(extendedSocket);
        });
      },
    );

    fs.watch(
      srv.path + '/wsproxy.js',
      function (_event: string, filename: string | Buffer | null) {
        if (filename === null || typeof filename !== 'string') return;
        const key = 'update-' + filename;
        if (
          (srv as Record<string, ReturnType<typeof setTimeout> | undefined>)[
            key
          ]
        )
          clearTimeout(
            (srv as Record<string, ReturnType<typeof setTimeout> | undefined>)[
              key
            ]!,
          );
        (srv as Record<string, ReturnType<typeof setTimeout>>)[key] =
          setTimeout(function () {
            srv.loadF(filename);
          }, 1000);
      },
    );
  },

  parse: function (s: SocketExtended, d: Buffer): number {
    if (d[0] != '{'.charCodeAt(0)) return 0;

    // Try new session-aware message format first
    try {
      const msg = d.toString();
      const parsed = JSON.parse(msg);
      if (parsed && parsed.type) {
        // New format with type field - handle via session integration
        // Session integration will handle connect, resume, input, naws
        // Returns 1 if handled, 0 if should fall through
        const handled = sessionIntegration.parseNewMessage(s, d, () => 0);
        if (handled) return 1;
      }
    } catch (_err) {
      // Not new format, fall through to legacy
    }

    let req: ClientRequest;

    try {
      req = eval('(' + d.toString() + ')');
    } catch (err) {
      srv.log('parse: ' + err);
      return 0;
    }

    if (req.host) {
      s.host = req.host;
      srv.log('Target host set to ' + s.host, s);
    }

    if (req.port) {
      s.port = req.port;
      srv.log('Target port set to ' + s.port, s);
    }

    if (req.ttype) {
      s.ttype = [req.ttype];
      srv.log('Client ttype set to ' + s.ttype, s);
    }

    if (req.name) s.name = req.name;

    if (req.client) s.client = req.client;

    if (req.mccp) s.mccp = req.mccp;

    if (req.utf8) s.utf8 = req.utf8;

    if (req.debug) s.debug = req.debug;

    if (req.chat) srv.chat(s, req);

    if (req.connect) srv.initT(s);

    if (req.bin && s.ts) {
      try {
        srv.log('Attempt binary send: ' + req.bin);
        s.ts.send(Buffer.from(req.bin));
      } catch (ex) {
        srv.log(ex);
      }
    }

    if (req.msdp && s.ts) {
      try {
        srv.log('Attempt msdp send: ' + stringify(req.msdp));
        srv.sendMSDP(s, req.msdp);
      } catch (ex) {
        srv.log(ex);
      }
    }

    return 1;
  },

  sendTTYPE: function (s: SocketExtended, msg: string): void {
    if (msg) {
      const p = srv.prt;
      s.ts!.write(p.WILL_TTYPE);
      s.ts!.write(Buffer.from([p.IAC, p.SB, p.TTYPE, p.IS]));
      s.ts!.send(msg);
      s.ts!.write(Buffer.from([p.IAC, p.SE]));
      srv.log(msg);
    }
  },

  sendGMCP: function (s: SocketExtended, msg: string): void {
    s.ts!.write(srv.prt.START);
    s.ts!.write(msg);
    s.ts!.write(srv.prt.STOP);
  },

  sendMXP: function (s: SocketExtended, msg: string): void {
    const p = srv.prt;
    s.ts!.write(Buffer.from([p.ESC]));
    s.ts!.write('[1z' + msg);
    s.ts!.write(Buffer.from([p.ESC]));
    s.ts!.write('[7z');
  },

  sendMSDP: function (s: SocketExtended, msdp: MSDPRequest): void {
    const p = srv.prt;
    srv.log('sendMSDP ' + stringify(msdp), s);

    if (!msdp.key || !msdp.val) return;

    s.ts!.write(Buffer.from([p.IAC, p.SB, p.MSDP, p.MSDP_VAR]));
    s.ts!.write(msdp.key);

    const values = Array.isArray(msdp.val) ? msdp.val : [msdp.val];

    for (let i = 0; i < values.length; i++) {
      s.ts!.write(Buffer.from([p.MSDP_VAL]));
      s.ts!.write(values[i]);
    }

    s.ts!.write(Buffer.from([p.IAC, p.SE]));
  },

  sendMSDPPair: function (s: SocketExtended, key: string, val: string): void {
    const p = srv.prt;
    srv.log('sendMSDPPair ' + key + '=' + val, s);
    s.ts!.write(Buffer.from([p.IAC, p.SB, p.MSDP, p.MSDP_VAR]));
    s.ts!.write(key);
    s.ts!.write(Buffer.from([p.MSDP_VAL]));
    s.ts!.write(val);
    s.ts!.write(Buffer.from([p.IAC, p.SE]));
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
      if (s.host !== srv.tn_host) {
        srv.log('avoid connection attempt to: ' + s.host + ':' + s.port, s);
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
        }, 500);
        return;
      }
    }

    s.ts = net.createConnection(port, host, function () {
      srv.log(
        'new connection to ' + host + ':' + port + ' for ' + s.remoteAddress,
      );
    }) as TelnetSocket;

    // s.ts.setEncoding('binary');

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
        srv.log('write bin: ' + raw.toString(), s);
      }

      try {
        data = iconv.encode(data as string, 'latin1');
      } catch (ex) {
        srv.log('error: ' + (ex as Error).toString(), s);
      }

      if (s.ts!.writable) s.ts!.write(data);
    };

    s.ts
      .on('connect', function () {
        // let p = srv.prt;

        srv.log('new telnet socket connected');

        setTimeout(function () {
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
        }, 12000);

        srv.chatUpdate();
      })
      .on('data', function (data: Buffer) {
        srv.sendClient(s, data);
      })
      .on('timeout', function () {
        srv.log('telnet socket timeout: ' + s);
        srv.sendClient(s, Buffer.from('Timeout: server port is down.\r\n'));
        setTimeout(function () {
          srv.closeSocket(s);
        }, 500);
      })
      .on('close', function () {
        srv.log('telnet socket closed: ' + s.remoteAddress);
        srv.chatUpdate();
        setTimeout(function () {
          srv.closeSocket(s);
        }, 500);
        // srv.initT(s);
      })
      .on('error', function (err: Error) {
        srv.log('error: ' + err.toString());
        // srv.sendClient(s, Buffer.from(err.toString()));
        srv.sendClient(s, Buffer.from('Error: maybe the mud server is down?'));
        setTimeout(function () {
          srv.closeSocket(s);
        }, 500);
      });
  },

  closeSocket: function (s: SocketExtended): void {
    // Check if this socket is part of a session
    if (sessionIntegration.hasSession(s)) {
      // Detach from session instead of fully closing
      sessionIntegration.handleSocketClose(s);

      // Remove from socket list
      const i = server.sockets.indexOf(s);
      if (i != -1) server.sockets.splice(i, 1);

      srv.log(
        '(ws) peer ' +
          s.req.connection.remoteAddress +
          ' detached from session',
      );
      srv.log('active sockets: ' + server.sockets.length);
      return;
    }

    // Legacy behavior - close everything
    if (s.ts) {
      srv.log(
        'closing telnet socket: ' + s.host ||
          srv.tn_host + ':' + s.port ||
          srv.tn_port,
      );
      // s.ts.destroy();
      s.terminate();
    }

    const i = server.sockets.indexOf(s);
    if (i != -1) server.sockets.splice(i, 1);

    srv.log('closing socket: ' + s.remoteAddress);

    if (s.terminate)
      // s.destroy();
      s.terminate();
    // s.socket.destroy();
    else
      (
        s as unknown as { socket: { terminate: () => void } }
      ).socket.terminate();

    srv.log('active sockets: ' + server.sockets.length);
  },

  sendClient: function (s: SocketExtended, data: Buffer): void {
    const p = srv.prt;

    if (s.mccp && !s.mccp_negotiated && !s.compressed) {
      for (let i = 0; i < data.length; i++) {
        if (
          data[i] == p.IAC &&
          data[i + 1] == p.WILL &&
          data[i + 2] == p.MCCP2
        ) {
          setTimeout(function () {
            srv.log('IAC DO MCCP2', s);
            s.ts!.write(p.DO_MCCP);
          }, 6000);
        } else if (
          data[i] == p.IAC &&
          data[i + 1] == p.SB &&
          data[i + 2] == p.MCCP2
        ) {
          if (i) srv.sendClient(s, data.slice(0, i));

          data = data.slice(i + 5);
          s.compressed = 1;
          srv.log('MCCP compression started', s);

          if (!data.length) return;
        }
      }
    }

    if (s.ttype.length) {
      for (let i = 0; i < data.length; i++) {
        if (
          data[i] == p.IAC &&
          data[i + 1] == p.DO &&
          data[i + 2] == p.TTYPE
        ) {
          srv.log('IAC DO TTYPE <- IAC FIRST TTYPE', s);
          srv.sendTTYPE(s, s.ttype.shift()!);
          /*
           * s.ts.send(p.WILL_TTYPE);
          for (i = 0; i < s.ttype.length; i++) {
            srv.sendTTYPE(s, s.ttype.shift());
          }*/
        } else if (
          data[i] == p.IAC &&
          data[i + 1] == p.SB &&
          data[i + 2] == p.TTYPE &&
          data[i + 3] == p.REQUEST
        ) {
          srv.log('IAC SB TTYPE <- IAC NEXT TTYPE');
          srv.sendTTYPE(s, s.ttype.shift()!);
        }
      }
    }

    if (!s.gmcp_negotiated) {
      for (let i = 0; i < data.length; i++) {
        if (
          data[i] == p.IAC &&
          (data[i + 1] == p.DO || data[i + 1] == p.WILL) &&
          data[i + 2] == p.GMCP
        ) {
          srv.log('IAC DO GMCP', s);

          if (data[i + 1] == p.DO) s.ts!.write(p.WILL_GMCP);
          else s.ts!.write(p.DO_GMCP);

          srv.log('IAC DO GMCP <- IAC WILL GMCP', s);

          s.gmcp_negotiated = 1;

          for (let t = 0; t < srv.gmcp.portal.length; t++) {
            if (t == 0 && s.client) {
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
          data[i] == p.IAC &&
          data[i + 1] == p.WILL &&
          data[i + 2] == p.MSDP
        ) {
          s.ts!.write(p.DO_MSDP);
          srv.log('IAC WILL MSDP <- IAC DO MSDP', s);
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
        if (data[i] == p.IAC && data[i + 1] == p.DO && data[i + 2] == p.MXP) {
          s.ts!.write(Buffer.from([p.IAC, p.WILL, p.MXP]));
          srv.log('IAC DO MXP <- IAC WILL MXP', s);
          s.mxp_negotiated = 1;
        } else if (
          data[i] == p.IAC &&
          data[i + 1] == p.WILL &&
          data[i + 2] == p.MXP
        ) {
          s.ts!.write(Buffer.from([p.IAC, p.DO, p.MXP]));
          srv.log('IAC WILL MXP <- IAC DO MXP', s);
          s.mxp_negotiated = 1;
        }
      }
    }

    if (!s.new_negotiated) {
      for (let i = 0; i < data.length; i++) {
        if (data[i] == p.IAC && data[i + 1] == p.DO && data[i + 2] == p.NEW) {
          s.ts!.write(Buffer.from([p.IAC, p.WILL, p.NEW]));
          srv.log('IAC WILL NEW-ENV', s);
          s.new_negotiated = 1;
        }
      }
    } else if (!s.new_handshake) {
      for (let i = 0; i < data.length; i++) {
        if (
          data[i] == p.IAC &&
          data[i + 1] == p.SB &&
          data[i + 2] == p.NEW &&
          data[i + 3] == p.REQUEST
        ) {
          s.ts!.write(Buffer.from([p.IAC, p.SB, p.NEW, p.IS, p.IS]));
          s.ts!.write('IPADDRESS');
          s.ts!.write(Buffer.from([p.REQUEST]));
          s.ts!.write(s.remoteAddress);
          s.ts!.write(Buffer.from([p.IAC, p.SE]));
          srv.log('IAC NEW-ENV IP VAR SEND');
          s.new_handshake = 1;
        }
      }
    }

    if (!s.echo_negotiated) {
      for (let i = 0; i < data.length; i++) {
        if (
          data[i] == p.IAC &&
          data[i + 1] == p.WILL &&
          data[i + 2] == p.ECHO
        ) {
          //s.ts.send(Buffer.from([p.IAC, p.WILL, p.ECHO]));
          srv.log('IAC WILL ECHO <- IAC WONT ECHO');
          // set a flag to avoid logging the next message (maybe passwords)
          s.password_mode = true;
          s.echo_negotiated = 1;
        }
      }
    }

    if (!s.sga_negotiated) {
      for (let i = 0; i < data.length; i++) {
        if (
          data[i] == p.IAC &&
          data[i + 1] == p.WILL &&
          data[i + 2] == p.SGA
        ) {
          s.ts!.write(Buffer.from([p.IAC, p.WONT, p.SGA]));
          srv.log('IAC WILL SGA <- IAC WONT SGA');
          s.sga_negotiated = 1;
        }
      }
    }

    if (!s.naws_negotiated) {
      for (let i = 0; i < data.length; i++) {
        if (
          data[i] == p.IAC &&
          data[i + 1] == p.WILL &&
          data[i + 2] == p.NAWS
        ) {
          s.ts!.write(Buffer.from([p.IAC, p.WONT, p.NAWS]));
          srv.log('IAC WILL SGA <- IAC WONT NAWS');
          s.naws_negotiated = 1;
        }
      }
    }

    if (!s.utf8_negotiated) {
      for (let i = 0; i < data.length; i++) {
        if (
          data[i] == p.IAC &&
          data[i + 1] == p.DO &&
          data[i + 2] == p.CHARSET
        ) {
          s.ts!.write(p.WILL_CHARSET);
          srv.log('IAC DO CHARSET <- IAC WILL CHARSET', s);
        }

        if (
          data[i] == p.IAC &&
          data[i + 1] == p.SB &&
          data[i + 2] == p.CHARSET
        ) {
          s.ts!.write(p.ACCEPT_UTF8);
          srv.log('UTF-8 negotiated', s);
          s.utf8_negotiated = 1;
        }
      }
    }

    if (srv.debug) {
      const raw: string[] = [];
      for (let i = 0; i < data.length; i++)
        raw.push(util.format('%d', data[i]));
      srv.log('raw bin: ' + raw, s);
      // srv.log('raw: ' + data, s);
    }

    if (!srv.compress || (s.mccp && s.compressed)) {
      s.send(data.toString('base64'));
      return;
    }

    /* Client<->Proxy only Compression */
    zlib.deflateRaw(data, function (err: Error | null, buffer: Buffer) {
      if (!err) {
        s.send(buffer.toString('base64'));
      } else {
        srv.log('zlib error: ' + err);
      }
    });
  },

  loadF: function (f: string): void {
    try {
      const fl = minify(srv.path + '/' + f).code;
      eval(fl + '');
      srv.log('dyn.reload: ' + f);
    } catch (err) {
      srv.log(f);
      srv.log('Minify/load error: ' + err);
      return;
    }
  },

  chat: function (s: SocketExtended, req: ChatRequest): void {
    srv.log('chat: ' + stringify(req), s);
    s.chat = 1;

    const ss = server.sockets;

    // Ensure chatlog is always an array
    if (!Array.isArray(chatlog)) {
      chatlog = [];
    }

    if (req.channel && req.channel == 'op') {
      // chatlog = chatlog.filter(function(l) { return (l[1].channel == 'status')?0:1 });
      // Create a copy of the last 300 messages
      const temp = Array.from(chatlog).slice(-300);
      const users: string[] = [];

      for (let i = 0; i < ss.length; i++) {
        if (!ss[i].ts && ss[i].name) continue;

        let u: string;
        if (ss[i].ts) {
          // let u = '\x1b<span style="color: #01c8d4"\x1b>' + (ss[i].name||'Guest') + '\x1b</span\x1b>@'+ss[i].host;
          u = (ss[i].name || 'Guest') + '@' + ss[i].host;
        } else {
          u = (ss[i].name || 'Guest') + '@chat';
        }

        if (users.indexOf(u) == -1) users.push(u);
      }

      temp.push({
        date: new Date(),
        data: { channel: 'status', name: 'online:', msg: users.join(', ') },
      });

      let t = stringify(temp);
      t = this.chatCleanup(t);

      // s.sendUTF('portal.chatlog ' + t);
      s.send('portal.chatlog ' + t);
      // fs.writeFileSync("./chat.json", stringify(chatlog));
      return;
    }

    delete req.chat;
    chatlog.push({ date: new Date(), data: req });
    req.msg = this.chatCleanup(req.msg!);

    for (let i = 0; i < ss.length; i++) {
      // if (ss[i].chat) ss[i].sendUTF('portal.chat ' + stringify(req));
      if (ss[i].chat) ss[i].send('portal.chat ' + stringify(req));
    }

    fs.writeFileSync('./chat.json', stringify(chatlog));
  },

  chatUpdate: function (): void {
    const ss = server.sockets;
    for (let i = 0; i < ss.length; i++)
      if (ss[i].chat) srv.chat(ss[i], { channel: 'op' });
  },

  chatCleanup: function (t: string): string {
    /* eslint-disable no-control-regex */
    t = t.replace(/([^\x1b])</g, '$1&lt;');
    t = t.replace(/([^\x1b])>/g, '$1&gt;');
    t = t.replace(/\x1b>/g, '>');
    t = t.replace(/\x1b</g, '<');
    /* eslint-enable no-control-regex */
    return t;
  },

  originAllowed: function (): number {
    return 1;
  },

  log: function (
    msg: unknown,
    s?: SocketExtended,
    level: LogLevel = LogLevel.INFO,
    context?: string,
  ): void {
    const currentLevel = getLogLevel();
    if (level < currentLevel) return;

    // Get client info
    const clientInfo = s?.req?.connection?.remoteAddress || '';
    const clientStr = clientInfo ? `[${clientInfo}] ` : '';

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
      ? ` ${Colors.cyan}[${context}]${Colors.reset}`
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
    const parts: string[] = [];
    if (useColors) {
      parts.push(
        `${Colors.dim}${timestamp}${Colors.reset}`,
        `${levelColor}${levelStr}${Colors.reset}`,
        `${Colors.bright}${clientStr}${Colors.reset}${contextStr}`,
        messageStr,
      );
    } else {
      parts.push(timestamp, levelStr, `${clientStr}${contextStr}`, messageStr);
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
    srv.log('Dying gracefully in 3 sec.');
    const ss = server.sockets;

    for (let i = 0; i < ss.length; i++) {
      /* inform clients so they can hop to another instance faster */
      if (
        ss[i] &&
        (ss[i] as unknown as { write: (msg: string) => void }).write
      )
        (ss[i] as unknown as { write: (msg: string) => void }).write(
          'Proxy server is going down...',
        );
      setTimeout(srv.closeSocket, 10, ss[i]);
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

    server.sockets.push(s);

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
    srv.log('(rs): new connection');
  },

  forward: function (s: SocketExtended, d: Buffer): void {
    if (s.ts) {
      if (s.debug) {
        if (s.password_mode) {
          srv.log('forward: **** (omitted)', s);
        } else {
          srv.log('forward: ' + d, s);
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
  chatlog = await loadChatLog();

  process.stdin.resume();

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
      srv.die(true);
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
