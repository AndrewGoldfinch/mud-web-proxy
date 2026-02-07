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
  sendUTF: ReturnType<typeof mock<(data: string | Buffer) => void>>;
  send: ReturnType<typeof mock<(data: string | Buffer) => void>>;
  terminate: ReturnType<typeof mock<() => void>>;
  close: ReturnType<typeof mock<() => void>>;
}

interface MockTelnetSocket extends EventEmitter {
  writable: boolean;
  send: ReturnType<typeof mock<(data: string | Buffer) => void>>;
  write: ReturnType<typeof mock<(data: string | Buffer) => boolean>>;
  destroy: ReturnType<typeof mock<() => void>>;
  setTimeout: ReturnType<typeof mock<() => void>>;
  setKeepAlive: ReturnType<typeof mock<() => void>>;
  setNoDelay: ReturnType<typeof mock<() => void>>;
}

interface ServerState {
  sockets: MockSocketExtended[];
}

// Module-level variables that simulate the wsproxy.ts state
let serverState: ServerState = { sockets: [] };
let ONLY_ALLOW_DEFAULT_SERVER = true;
const REPOSITORY_URL = 'https://github.com/maldorne/mud-web-proxy/';

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

    log: mock((_msg: unknown, _s?: MockSocketExtended) => {
      // console.log(msg);
    }),

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
        srv.log(
          'closing telnet socket: ' + s.host ||
            srv.tn_host + ':' + s.port ||
            srv.tn_port,
        );
        s.terminate();
      }

      const i = serverState.sockets.indexOf(s);
      if (i !== -1) serverState.sockets.splice(i, 1);

      srv.log('closing socket: ' + s.remoteAddress);

      if (s.terminate) {
        s.terminate();
      }

      srv.log('active sockets: ' + serverState.sockets.length);
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
        srv.chatUpdate();
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
        srv.chatUpdate();
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
        if (s.debug) {
          if (s.password_mode) {
            srv.log('forward: **** (omitted)', s);
          } else {
            srv.log('forward: ' + d, s);
          }
        }

        if (s.password_mode) {
          s.password_mode = false;
        }

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

    originAllowed: function (): number {
      return 1;
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

describe('Socket Lifecycle Management', () => {
  let srv: ReturnType<typeof createTestServer>;

  beforeEach(() => {
    serverState.sockets = [];
    ONLY_ALLOW_DEFAULT_SERVER = true;
    srv = createTestServer();
    srv.open = true;
  });

  afterEach(() => {
    serverState.sockets = [];
  });

  describe('WebSocket Socket Lifecycle', () => {
    test('1. newSocket() - adds socket to server.sockets array', () => {
      const mockSocket = createMockWebSocket('192.168.1.1');

      expect(serverState.sockets.length).toBe(0);

      srv.newSocket(mockSocket);

      expect(serverState.sockets.length).toBe(1);
      expect(serverState.sockets[0]).toBe(mockSocket);
    });

    test('2. closeSocket() - removes socket from server.sockets array', () => {
      const mockSocket = createMockWebSocket();
      srv.newSocket(mockSocket);

      expect(serverState.sockets.length).toBe(1);

      srv.closeSocket(mockSocket);

      expect(serverState.sockets.length).toBe(0);
      expect(serverState.sockets.indexOf(mockSocket)).toBe(-1);
    });

    test('3. Socket termination - calls s.terminate() properly', () => {
      const mockSocket = createMockWebSocket();
      srv.newSocket(mockSocket);

      srv.closeSocket(mockSocket);

      expect(mockSocket.terminate).toHaveBeenCalled();
    });

    test('4. Data forwarding - forwards data to srv.forward()', () => {
      const mockSocket = createMockWebSocket();
      let forwardCalled = false;
      let receivedSocket: MockSocketExtended | null = null;
      let receivedData: Buffer | null = null;

      // Override the forward method to capture calls
      const originalForward = srv.forward;
      srv.forward = (s: MockSocketExtended, d: Buffer) => {
        forwardCalled = true;
        receivedSocket = s;
        receivedData = d;
      };

      srv.newSocket(mockSocket);

      const testData = Buffer.from('test data');
      mockSocket.emit('data', testData);

      expect(forwardCalled).toBe(true);
      expect(receivedSocket).toBe(mockSocket);
      expect(receivedData).not.toBeNull();
      expect(receivedData!.toString()).toBe('test data');

      // Restore original
      srv.forward = originalForward;
    });

    test('5. End event handling - calls srv.closeSocket() on end', () => {
      const mockSocket = createMockWebSocket();
      let closeSocketCalled = false;
      let receivedSocket: MockSocketExtended | null = null;

      const originalCloseSocket = srv.closeSocket;
      srv.closeSocket = (s: MockSocketExtended) => {
        closeSocketCalled = true;
        receivedSocket = s;
      };

      srv.newSocket(mockSocket);
      mockSocket.emit('end');

      expect(closeSocketCalled).toBe(true);
      expect(receivedSocket).toBe(mockSocket);

      // Restore original
      srv.closeSocket = originalCloseSocket;
    });
  });

  describe('Telnet Socket Lifecycle', () => {
    test('6. initT() - creates net connection to telnet host', () => {
      const mockSocket = createMockWebSocket();
      mockSocket.host = 'muds.maldorne.org';
      mockSocket.port = 5010;

      srv.initT(mockSocket);

      expect(mockSocket.ts).toBeDefined();
      expect(mockSocket.ts).not.toBeNull();
    });

    test('7. Connection success - logs successful connection', async () => {
      const mockSocket = createMockWebSocket();
      let logCalled = false;
      const originalLog = srv.log;
      srv.log = (_msg: unknown, _s?: MockSocketExtended) => {
        logCalled = true;
      };

      srv.initT(mockSocket);

      // Wait for the simulated connection
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(logCalled).toBe(true);

      // Restore original
      srv.log = originalLog;
    });

    test('8. Connection failure - handles connection errors', async () => {
      const mockSocket = createMockWebSocket();
      // Set host to default server to bypass restriction
      mockSocket.host = 'muds.maldorne.org';
      let closeSocketCalled = false;
      const originalCloseSocket = srv.closeSocket;
      srv.closeSocket = () => {
        closeSocketCalled = true;
      };

      srv.initT(mockSocket);

      // Simulate connection error
      const error = new Error('Connection refused');
      mockSocket.ts!.emit('error', error);

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(closeSocketCalled).toBe(true);

      srv.closeSocket = originalCloseSocket;
    });

    test('9. Data receiving - forwards data to sendClient()', async () => {
      const mockSocket = createMockWebSocket();
      // Set host to default server to bypass restriction
      mockSocket.host = 'muds.maldorne.org';
      let sendClientCalled = false;
      let receivedSocket: MockSocketExtended | null = null;
      let receivedData: Buffer | null = null;
      const originalSendClient = srv.sendClient;
      srv.sendClient = (s: MockSocketExtended, data: Buffer) => {
        sendClientCalled = true;
        receivedSocket = s;
        receivedData = data;
      };

      srv.initT(mockSocket);

      const testData = Buffer.from('telnet server data');
      mockSocket.ts!.emit('data', testData);

      expect(sendClientCalled).toBe(true);
      expect(receivedSocket).toBe(mockSocket);
      expect(receivedData).toEqual(testData);

      srv.sendClient = originalSendClient;
    });

    test('10. Timeout handling - sends timeout message and closes socket', async () => {
      const mockSocket = createMockWebSocket();
      // Set host to default server to bypass restriction
      mockSocket.host = 'muds.maldorne.org';
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

      srv.initT(mockSocket);

      mockSocket.ts!.emit('timeout');

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(sendClientCalled).toBe(true);
      expect(receivedData).not.toBeNull();
      expect(receivedData!.toString()).toContain('Timeout');
      expect(closeSocketCalled).toBe(true);

      srv.sendClient = originalSendClient;
      srv.closeSocket = originalCloseSocket;
    });

    test('11. Close handling - cleans up socket', async () => {
      const mockSocket = createMockWebSocket();
      // Set host to default server to bypass restriction
      mockSocket.host = 'muds.maldorne.org';
      let closeSocketCalled = false;
      let receivedSocket: MockSocketExtended | null = null;
      const originalCloseSocket = srv.closeSocket;
      srv.closeSocket = (s: MockSocketExtended) => {
        closeSocketCalled = true;
        receivedSocket = s;
      };

      srv.initT(mockSocket);

      mockSocket.ts!.emit('close');

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(closeSocketCalled).toBe(true);
      expect(receivedSocket).toBe(mockSocket);

      srv.closeSocket = originalCloseSocket;
    });

    test('12. Error handling - sends error message and closes socket', async () => {
      const mockSocket = createMockWebSocket();
      // Set host to default server to bypass restriction
      mockSocket.host = 'muds.maldorne.org';
      let sendClientCalled = false;
      let closeSocketCalled = false;
      const originalSendClient = srv.sendClient;
      const originalCloseSocket = srv.closeSocket;
      srv.sendClient = () => {
        sendClientCalled = true;
      };
      srv.closeSocket = () => {
        closeSocketCalled = true;
      };

      srv.initT(mockSocket);

      const error = new Error('Network error');
      mockSocket.ts!.emit('error', error);

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(sendClientCalled).toBe(true);
      expect(closeSocketCalled).toBe(true);

      srv.sendClient = originalSendClient;
      srv.closeSocket = originalCloseSocket;
    });
  });

  describe('ONLY_ALLOW_DEFAULT_SERVER restriction', () => {
    test('13. Block connections to non-default servers when enabled', async () => {
      const mockSocket = createMockWebSocket();
      mockSocket.host = 'forbidden.host.com';
      mockSocket.port = 4000;

      let sendClientCalled = false;
      let receivedData: Buffer | null = null;
      let closeSocketCalled = false;
      let receivedSocket: MockSocketExtended | null = null;
      const originalSendClient = srv.sendClient;
      const originalCloseSocket = srv.closeSocket;
      srv.sendClient = (_s: MockSocketExtended, data: Buffer) => {
        sendClientCalled = true;
        receivedData = data;
      };
      srv.closeSocket = (s: MockSocketExtended) => {
        closeSocketCalled = true;
        receivedSocket = s;
      };

      ONLY_ALLOW_DEFAULT_SERVER = true;
      srv.initT(mockSocket);

      await new Promise((resolve) => setTimeout(resolve, 600));

      expect(sendClientCalled).toBe(true);
      expect(receivedData).not.toBeNull();
      expect(receivedData!.toString()).toContain('does not allow connections');
      expect(closeSocketCalled).toBe(true);
      expect(receivedSocket).toBe(mockSocket);

      srv.sendClient = originalSendClient;
      srv.closeSocket = originalCloseSocket;
    });

    test('14. Allow connections when connecting to default server', () => {
      const mockSocket = createMockWebSocket();
      mockSocket.host = 'muds.maldorne.org';
      mockSocket.port = 5010;

      ONLY_ALLOW_DEFAULT_SERVER = true;
      srv.initT(mockSocket);

      // Should create the telnet socket without blocking
      expect(mockSocket.ts).toBeDefined();
    });
  });

  describe('Socket tracking', () => {
    test('15. server.sockets array maintenance', () => {
      const socket1 = createMockWebSocket('192.168.1.1');
      const socket2 = createMockWebSocket('192.168.1.2');
      const socket3 = createMockWebSocket('192.168.1.3');

      expect(serverState.sockets.length).toBe(0);

      srv.newSocket(socket1);
      expect(serverState.sockets.length).toBe(1);
      expect(serverState.sockets).toContain(socket1);

      srv.newSocket(socket2);
      expect(serverState.sockets.length).toBe(2);
      expect(serverState.sockets).toContain(socket2);

      srv.newSocket(socket3);
      expect(serverState.sockets.length).toBe(3);
      expect(serverState.sockets).toContain(socket3);

      srv.closeSocket(socket2);
      expect(serverState.sockets.length).toBe(2);
      expect(serverState.sockets).not.toContain(socket2);
      expect(serverState.sockets).toContain(socket1);
      expect(serverState.sockets).toContain(socket3);

      srv.closeSocket(socket1);
      srv.closeSocket(socket3);
      expect(serverState.sockets.length).toBe(0);
    });

    test('16. Socket count logging', () => {
      let logCalled = false;
      const originalLog = srv.log;
      srv.log = () => {
        logCalled = true;
      };
      const mockSocket = createMockWebSocket();

      srv.newSocket(mockSocket);

      expect(logCalled).toBe(true);

      srv.log = originalLog;
    });
  });
});

describe('Mock factories', () => {
  test('createMockWebSocket creates proper mock', () => {
    const socket = createMockWebSocket('192.168.1.100');

    expect(socket.remoteAddress).toBe('192.168.1.100');
    expect(socket.ttype).toEqual([]);
    expect(socket.compressed).toBe(0);
    expect(typeof socket.send).toBe('function');
    expect(typeof socket.terminate).toBe('function');
    expect(typeof socket.on).toBe('function');
    expect(typeof socket.emit).toBe('function');
  });

  test('createMockTelnetSocket creates proper mock', () => {
    const socket = createMockTelnetSocket();

    expect(socket.writable).toBe(true);
    expect(typeof socket.send).toBe('function');
    expect(typeof socket.write).toBe('function');
    expect(typeof socket.destroy).toBe('function');
    expect(typeof socket.on).toBe('function');
    expect(typeof socket.emit).toBe('function');
  });
});
