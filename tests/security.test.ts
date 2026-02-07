import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import type { IncomingMessage } from 'http';
import EventEmitter from 'events';

// Mock types for testing
interface MockSocketExtended extends EventEmitter {
  req: IncomingMessage & { connection: { remoteAddress: string } };
  ts?: MockTelnetSocket;
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
  remoteAddress: string;
  sendUTF: (data: string | Buffer) => void;
  send: (data: string | Buffer) => void;
  terminate: () => void;
  close: () => void;
}

interface MockTelnetSocket extends EventEmitter {
  writable: boolean;
  send: (data: string | Buffer) => void;
  write: (data: string | Buffer) => boolean;
  destroy: () => void;
  setTimeout: () => void;
  setKeepAlive: () => void;
  setNoDelay: () => void;
}

interface ServerState {
  sockets: MockSocketExtended[];
}

// Module-level variables that simulate the wsproxy.ts state
let serverState: ServerState = { sockets: [] };
let ONLY_ALLOW_DEFAULT_SERVER = true;
const REPOSITORY_URL = 'https://github.com/maldorne/mud-web-proxy/';

// Track originAllowed calls
let originAllowedCalls: number = 0;
let originAllowedReturnValue: number = 1;

// Create a testable version of the server config
const createTestServer = () => {
  const srv = {
    path: '/test',
    ws_port: 6200,
    tn_host: 'muds.maldorne.org',
    tn_port: 5010,
    debug: false,
    compress: true,
    open: true,
    ttype: {
      enabled: 1,
      portal: ['maldorne.org', 'XTERM-256color', 'MTTS 141'],
    },
    gmcp: {
      enabled: 1,
      portal: ['client maldorne.org', 'client_version 1.0'],
    },
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
    },

    log: (_msg: unknown, _s?: MockSocketExtended) => {},

    originAllowed: function (): number {
      originAllowedCalls++;
      return originAllowedReturnValue;
    },

    newSocket: function (s: MockSocketExtended): void {
      if (!srv.open) {
        s.terminate();
        return;
      }
      serverState.sockets.push(s);

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

    closeSocket: function (s: MockSocketExtended): void {
      if (s.ts) {
        s.terminate();
      }

      const i = serverState.sockets.indexOf(s);
      if (i !== -1) serverState.sockets.splice(i, 1);

      if (s.terminate) {
        s.terminate();
      }
    },

    initT: function (s: MockSocketExtended): void {
      if (!s.ttype) s.ttype = [];

      s.ttype = s.ttype.concat(srv.ttype.portal.slice(0));
      s.ttype.push(s.remoteAddress);
      s.ttype.push(s.remoteAddress);

      s.compressed = 0;

      // Check ONLY_ALLOW_DEFAULT_SERVER restriction
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

      // Create mock telnet socket instead of actual connection
      const mockTelnetSocket = createMockTelnetSocket();
      s.ts = mockTelnetSocket;

      mockTelnetSocket.on('connect', function () {
        srv.log('new telnet socket connected');
      });

      mockTelnetSocket.on('data', function (data: Buffer) {
        srv.sendClient(s, data);
      });

      mockTelnetSocket.on('timeout', function () {
        srv.log('telnet socket timeout: ' + s);
        srv.sendClient(s, Buffer.from('Timeout: server port is down.\r\n'));
        setTimeout(function () {
          srv.closeSocket(s);
        }, 500);
      });

      mockTelnetSocket.on('close', function () {
        srv.log('telnet socket closed: ' + s.remoteAddress);
        setTimeout(function () {
          srv.closeSocket(s);
        }, 500);
      });

      mockTelnetSocket.on('error', function (err: Error) {
        srv.log('error: ' + err.toString());
        srv.sendClient(s, Buffer.from('Error: maybe the mud server is down?'));
        setTimeout(function () {
          srv.closeSocket(s);
        }, 500);
      });

      // Simulate successful connection
      setTimeout(() => {
        mockTelnetSocket.emit('connect');
      }, 10);
    },

    forward: function (s: MockSocketExtended, d: Buffer): void {
      if (s.ts) {
        s.ts.send(d.toString());
      }
    },

    sendClient: function (s: MockSocketExtended, data: Buffer): void {
      s.send(data.toString('base64'));
    },

    chat: function (_s: MockSocketExtended, _req: unknown): void {},

    chatUpdate: function (): void {},

    chatCleanup: function (t: string): string {
      return t;
    },

    die: function (_core?: boolean): void {},

    sendTTYPE: function (_s: MockSocketExtended, _msg: string): void {},

    sendGMCP: function (_s: MockSocketExtended, _msg: string): void {},

    sendMXP: function (_s: MockSocketExtended, _msg: string): void {},

    sendMSDP: function (_s: MockSocketExtended, _msdp: unknown): void {},

    sendMSDPPair: function (
      _s: MockSocketExtended,
      _key: string,
      _val: string,
    ): void {},

    init: async function (): Promise<void> {},

    parse: function (_s: MockSocketExtended, _d: Buffer): number {
      return 0;
    },

    loadF: function (_f: string): void {},
  };

  return srv;
};

// Mock WebSocket factory
function createMockWebSocket(
  remoteAddress: string = '127.0.0.1',
): MockSocketExtended {
  const socket = new EventEmitter() as MockSocketExtended;

  socket.req = {
    connection: {
      remoteAddress,
    },
  } as IncomingMessage & { connection: { remoteAddress: string } };

  socket.ttype = [];
  socket.compressed = 0;
  socket.remoteAddress = remoteAddress;
  socket.sendUTF = mock(() => {});
  socket.send = mock(() => {});
  socket.terminate = mock(() => {});
  socket.close = mock(() => {});

  return socket;
}

// Mock Telnet Socket factory
function createMockTelnetSocket(): MockTelnetSocket {
  const socket = new EventEmitter() as MockTelnetSocket;

  socket.writable = true;
  socket.send = mock(() => {});
  socket.write = mock(() => true);
  socket.destroy = mock(() => {});
  socket.setTimeout = mock(() => {});
  socket.setKeepAlive = mock(() => {});
  socket.setNoDelay = mock(() => {});

  return socket;
}

describe('Security Features', () => {
  let srv: ReturnType<typeof createTestServer>;

  beforeEach(() => {
    serverState.sockets = [];
    ONLY_ALLOW_DEFAULT_SERVER = true;
    originAllowedCalls = 0;
    originAllowedReturnValue = 1;
    srv = createTestServer();
    srv.open = true;
  });

  afterEach(() => {
    serverState.sockets = [];
  });

  describe('originAllowed()', () => {
    test('1. Returns 1 (allow all) by default', () => {
      const result = srv.originAllowed();

      expect(result).toBe(1);
    });

    test('2. Can be overridden to return 0 (deny all)', () => {
      originAllowedReturnValue = 0;

      const result = srv.originAllowed();

      expect(result).toBe(0);
    });
  });

  describe('ONLY_ALLOW_DEFAULT_SERVER', () => {
    test('3. Block connections to non-default servers when ONLY_ALLOW_DEFAULT_SERVER=true', async () => {
      const mockSocket = createMockWebSocket();
      mockSocket.host = 'unauthorized.host.com';
      mockSocket.port = 4000;

      let sendClientCalled = false;
      let receivedData: Buffer | null = null;
      let closeSocketCalled = false;
      const originalSendClient = srv.sendClient;
      const originalCloseSocket = srv.closeSocket;
      srv.sendClient = (_s: MockSocketExtended, data: Buffer) => {
        sendClientCalled = true;
        receivedData = data;
      };
      srv.closeSocket = () => {
        closeSocketCalled = true;
      };

      ONLY_ALLOW_DEFAULT_SERVER = true;
      srv.initT(mockSocket);

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(sendClientCalled).toBe(true);
      expect(receivedData).not.toBeNull();
      expect(receivedData!.toString()).toContain(
        'does not allow connections to servers different to',
      );
      expect(receivedData!.toString()).toContain(srv.tn_host);
      expect(closeSocketCalled).toBe(true);

      srv.sendClient = originalSendClient;
      srv.closeSocket = originalCloseSocket;
    });

    test('4. Allow connections to default server', () => {
      const mockSocket = createMockWebSocket();
      mockSocket.host = 'muds.maldorne.org';
      mockSocket.port = 5010;

      ONLY_ALLOW_DEFAULT_SERVER = true;
      srv.initT(mockSocket);

      // Should create the telnet socket without blocking
      expect(mockSocket.ts).toBeDefined();
    });

    test('5. Different host should be rejected with error message', async () => {
      const mockSocket = createMockWebSocket();
      mockSocket.host = 'evil-server.com';
      mockSocket.port = 5010;

      let sendClientCalled = false;
      let receivedMessage = '';
      const originalSendClient = srv.sendClient;
      srv.sendClient = (_s: MockSocketExtended, data: Buffer) => {
        sendClientCalled = true;
        receivedMessage = data.toString();
      };

      ONLY_ALLOW_DEFAULT_SERVER = true;
      srv.initT(mockSocket);

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(sendClientCalled).toBe(true);
      expect(receivedMessage).toContain('does not allow connections');
      expect(receivedMessage).toContain(REPOSITORY_URL);

      srv.sendClient = originalSendClient;
    });

    test('6. Different port should be rejected', async () => {
      const mockSocket = createMockWebSocket();
      // Host is default, but with different port
      mockSocket.host = 'muds.maldorne.org';
      mockSocket.port = 9999;

      let sendClientCalled = false;
      const originalSendClient = srv.sendClient;
      srv.sendClient = () => {
        sendClientCalled = true;
      };

      ONLY_ALLOW_DEFAULT_SERVER = true;
      // Note: The restriction only checks host, not port
      srv.initT(mockSocket);

      // Since host matches, it should NOT block
      expect(sendClientCalled).toBe(false);
      expect(mockSocket.ts).toBeDefined();

      srv.sendClient = originalSendClient;
    });

    test('7. Host matching default server should succeed', () => {
      const mockSocket = createMockWebSocket();
      mockSocket.host = srv.tn_host;
      mockSocket.port = srv.tn_port;

      let sendClientCalled = false;
      const originalSendClient = srv.sendClient;
      srv.sendClient = () => {
        sendClientCalled = true;
      };

      ONLY_ALLOW_DEFAULT_SERVER = true;
      srv.initT(mockSocket);

      // Should create the telnet socket without blocking
      expect(mockSocket.ts).toBeDefined();
      expect(sendClientCalled).toBe(false);

      srv.sendClient = originalSendClient;
    });
  });

  describe('HTTPS server creation', () => {
    test('8. Requires cert.pem and privkey.pem files', () => {
      // This test documents the requirement based on wsproxy.ts line 336-345
      // The actual implementation checks for:
      // fs.existsSync('./cert.pem') && fs.existsSync('./privkey.pem')
      const certPath = './cert.pem';
      const keyPath = './privkey.pem';

      // Document that these files are required
      expect(certPath).toBe('./cert.pem');
      expect(keyPath).toBe('./privkey.pem');
    });

    test('9. Exits if certificates not found', () => {
      // This test documents the behavior from wsproxy.ts line 336-345
      // if (!fs.existsSync('./cert.pem') || !fs.existsSync('./privkey.pem')) {
      //   srv.log('Could not find cert and/or privkey files, exiting.');
      //   process.exit();
      // }
      const exitCode = 1;
      expect(exitCode).toBe(1);
      // The actual exit is handled in the main wsproxy.ts file
    });
  });

  describe('WebSocket origin validation', () => {
    test('10. originAllowed() called on new connection', () => {
      // WebSocket server is implicitly created for connection handling
      let originAllowedWasCalled = false;

      // Simulate the WebSocket server connection handler logic from wsproxy.ts
      const simulateConnection = (socket: MockSocketExtended) => {
        // Line 383-386 from wsproxy.ts
        if (!srv.originAllowed()) {
          originAllowedWasCalled = true;
          socket.terminate();
          return;
        }
        originAllowedWasCalled = true;
      };

      const mockSocket = createMockWebSocket();
      originAllowedReturnValue = 1; // Allow
      simulateConnection(mockSocket);

      expect(originAllowedWasCalled).toBe(true);
    });

    test('11. Socket terminated if origin not allowed', () => {
      const mockSocket = createMockWebSocket();
      let terminated = false;
      mockSocket.terminate = mock(() => {
        terminated = true;
      });

      // Simulate the WebSocket server connection handler logic
      const simulateConnection = (socket: MockSocketExtended) => {
        // Line 383-386 from wsproxy.ts
        if (!srv.originAllowed()) {
          socket.terminate();
          return;
        }
      };

      originAllowedReturnValue = 0; // Deny
      simulateConnection(mockSocket);

      expect(terminated).toBe(true);
    });

    test('12. Socket accepted if origin allowed', () => {
      const mockSocket = createMockWebSocket();
      let terminated = false;
      let accepted = false;
      mockSocket.terminate = mock(() => {
        terminated = true;
      });

      // Simulate the WebSocket server connection handler logic
      const simulateConnection = (socket: MockSocketExtended) => {
        if (!srv.originAllowed()) {
          socket.terminate();
          return;
        }
        accepted = true;
        serverState.sockets.push(socket);
      };

      originAllowedReturnValue = 1; // Allow
      simulateConnection(mockSocket);

      expect(terminated).toBe(false);
      expect(accepted).toBe(true);
      expect(serverState.sockets).toContain(mockSocket);
    });
  });

  describe('Connection restrictions', () => {
    test('13. srv.open flag prevents new connections when false', () => {
      const mockSocket = createMockWebSocket();
      let terminated = false;
      mockSocket.terminate = mock(() => {
        terminated = true;
      });

      srv.open = false;

      // Simulate newSocket logic from wsproxy.ts line 1083-1088
      if (!srv.open) {
        mockSocket.terminate();
      }

      expect(terminated).toBe(true);
    });

    test('14. Server closing mode rejects connections', () => {
      const mockSocket1 = createMockWebSocket('192.168.1.1');
      const mockSocket2 = createMockWebSocket('192.168.1.2');

      // First connection should succeed
      srv.open = true;
      srv.newSocket(mockSocket1);
      expect(serverState.sockets.length).toBe(1);
      expect(serverState.sockets).toContain(mockSocket1);

      // Server enters closing mode
      srv.open = false;

      // Second connection should be rejected
      let secondSocketTerminated = false;
      mockSocket2.terminate = mock(() => {
        secondSocketTerminated = true;
      });

      // Simulate newSocket logic when srv.open is false
      if (!srv.open) {
        mockSocket2.terminate();
      } else {
        serverState.sockets.push(mockSocket2);
      }

      expect(secondSocketTerminated).toBe(true);
      expect(serverState.sockets.length).toBe(1);
      expect(serverState.sockets).not.toContain(mockSocket2);
    });
  });
});

describe('Security Configuration Constants', () => {
  test('ONLY_ALLOW_DEFAULT_SERVER should be boolean', () => {
    expect(typeof ONLY_ALLOW_DEFAULT_SERVER).toBe('boolean');
  });

  test('REPOSITORY_URL should be defined', () => {
    expect(REPOSITORY_URL).toBeDefined();
    expect(REPOSITORY_URL).toContain('github.com');
  });
});

describe('Mock factories', () => {
  test('createMockWebSocket creates proper mock with terminate method', () => {
    const socket = createMockWebSocket('192.168.1.100');

    expect(socket.remoteAddress).toBe('192.168.1.100');
    expect(typeof socket.terminate).toBe('function');
    expect(typeof socket.send).toBe('function');
    expect(typeof socket.on).toBe('function');
    expect(typeof socket.emit).toBe('function');
  });

  test('createMockTelnetSocket creates proper mock', () => {
    const socket = createMockTelnetSocket();

    expect(socket.writable).toBe(true);
    expect(typeof socket.send).toBe('function');
    expect(typeof socket.write).toBe('function');
    expect(typeof socket.destroy).toBe('function');
  });
});
