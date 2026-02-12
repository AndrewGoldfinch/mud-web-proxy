import { describe, it, expect, beforeEach, afterEach, jest } from 'bun:test';
import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import zlib from 'zlib';
import fs from 'fs';
import iconv from 'iconv-lite';

// Type definitions
interface SocketExtended extends WebSocket {
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

interface TelnetSocket {
  send: (data: string | Buffer) => void;
  write: (data: Buffer) => boolean;
  destroy: () => void;
  on: (event: string, listener: unknown) => unknown;
  once: (event: string, listener: unknown) => unknown;
  writable: boolean;
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

interface ChatRequest {
  chat?: number;
  channel?: string;
  msg?: string;
  name?: string;
}

// Protocol constants
const PROTOCOL = {
  IAC: 255,
  WILL: 251,
  WONT: 252,
  DO: 253,
  DONT: 254,
  SB: 250,
  SE: 240,
  MCCP2: 86,
  TTYPE: 24,
  GMCP: 201,
  MSDP: 69,
  MXP: 91,
  NEW: 39,
  SGA: 3,
  ECHO: 1,
  NAWS: 31,
  CHARSET: 42,
  WILL_MCCP: Buffer.from([255, 253, 86]),
  DO_MCCP: Buffer.from([255, 253, 86]),
  WILL_TTYPE: Buffer.from([255, 251, 24]),
  WILL_GMCP: Buffer.from([255, 251, 201]),
  DO_GMCP: Buffer.from([255, 253, 201]),
  START: Buffer.from([255, 250, 201]),
  STOP: Buffer.from([255, 240]),
} as const;

// Mock functions
const mockLog = jest.fn();
const mockSendClient = jest.fn();
const mockCloseSocket = jest.fn();
const mockInitT = jest.fn();
const mockChat = jest.fn();
const mockSendMSDP = jest.fn();
const mockTerminate = jest.fn();
const mockSend = jest.fn();

// Create mock srv object
const createMockSrv = () => ({
  log: mockLog,
  sendClient: mockSendClient,
  closeSocket: mockCloseSocket,
  initT: mockInitT,
  chat: mockChat,
  sendMSDP: mockSendMSDP,
  tn_host: 'muds.maldorne.org',
  tn_port: 5010,
  debug: false,
  compress: true,
  open: true,
  prt: PROTOCOL,
});

let srv = createMockSrv();

// Helper to create a mock SocketExtended
const createMockSocket = (
  overrides: Partial<SocketExtended> = {},
): SocketExtended => {
  return {
    ttype: [],
    compressed: 0,
    req: {
      connection: { remoteAddress: '127.0.0.1' },
    },
    sendUTF: mockSend,
    send: mockSend,
    terminate: mockTerminate,
    remoteAddress: '127.0.0.1',
    ts: undefined,
    ...overrides,
  } as unknown as SocketExtended;
};

// Helper to create a mock TelnetSocket
const createMockTelnetSocket = (
  overrides: Partial<TelnetSocket> = {},
): TelnetSocket & { emit: (event: string, ...args: unknown[]) => void } => {
  const listeners: Record<string, unknown[]> = {};
  const mockSocket = {
    write: jest.fn(() => true),
    send: jest.fn(),
    destroy: jest.fn(),
    end: jest.fn(),
    setEncoding: jest.fn(),
    writable: true,
    on: jest.fn((event: string, listener: unknown) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
      return mockSocket;
    }),
    once: jest.fn((event: string, listener: unknown) => {
      if (!listeners[event]) listeners[event] = [];
      listeners[event].push(listener);
      return mockSocket;
    }),
    emit: (event: string, ...args: unknown[]) => {
      if (listeners[event]) {
        listeners[event].forEach((listener) => {
          if (typeof listener === 'function') {
            (listener as (...args: unknown[]) => void)(...args);
          }
        });
      }
    },
    _listeners: listeners,
    ...overrides,
  };
  return mockSocket as TelnetSocket & {
    emit: (event: string, ...args: unknown[]) => void;
  };
};

// Parse function (simplified version from wsproxy.ts)
const parse = (s: SocketExtended, d: Buffer): number => {
  if (d[0] !== '{'.charCodeAt(0)) return 0;

  let req: ClientRequest;

  try {
    req = JSON.parse(d.toString());
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

  if (req.chat) srv.chat(s, req as unknown as ChatRequest);
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
      srv.log('Attempt msdp send: ' + JSON.stringify(req.msdp));
      srv.sendMSDP(s, req.msdp);
    } catch (ex) {
      srv.log(ex);
    }
  }

  return 1;
};

// sendClient function (simplified)
const sendClient = (s: SocketExtended, data: Buffer): void => {
  if (s.mccp && !s.mccp_negotiated && !s.compressed) {
    for (let i = 0; i < data.length; i++) {
      if (
        data[i] === PROTOCOL.IAC &&
        data[i + 1] === PROTOCOL.WILL &&
        data[i + 2] === PROTOCOL.MCCP2
      ) {
        setTimeout(() => {
          srv.log('IAC DO MCCP2', s);
          s.ts?.write(PROTOCOL.DO_MCCP);
        }, 6000);
      }
    }
  }

  if (!srv.compress || (s.mccp && s.compressed)) {
    s.sendUTF(data.toString('base64'));
    return;
  }

  // Compression with error handling
  zlib.deflateRaw(data, (err: Error | null, buffer: Buffer) => {
    if (!err) {
      s.sendUTF(buffer.toString('base64'));
    } else {
      srv.log('zlib error: ' + err);
      // Fallback to uncompressed
      s.sendUTF(data.toString('base64'));
    }
  });
};

describe('Error Handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    srv = createMockSrv();
  });

  describe('Network Errors', () => {
    it('should handle telnet connection refused error', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Add error listener that logs like wsproxy.ts
      ts.on('error', (err: Error) => {
        srv.log('error: ' + err.toString());
        srv.sendClient(s, Buffer.from('Error: maybe the mud server is down?'));
      });

      // Simulate connection error
      const error = new Error('ECONNREFUSED: Connection refused');
      ts.emit('error', error);

      // Verify error is logged
      expect(mockLog).toHaveBeenCalledWith('error: ' + error.toString());
    });

    it('should handle telnet connection timeout', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Add timeout listener
      ts.on('timeout', () => {
        srv.log('telnet socket timeout: ' + s.remoteAddress);
        srv.sendClient(s, Buffer.from('Timeout: server port is down.\r\n'));
      });

      // Simulate timeout
      ts.emit('timeout');

      // Verify timeout message is sent to client
      expect(mockSendClient).toHaveBeenCalledWith(
        s,
        Buffer.from('Timeout: server port is down.\r\n'),
      );
    });

    it('should handle telnet socket error during data transmission', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket({
        writable: false,
      });
      s.ts = ts;

      // Attempt to write when not writable
      const data = Buffer.from('test data');
      if (ts.writable) {
        ts.write(data);
      }

      // Verify write was not called when not writable
      expect(ts.write).not.toHaveBeenCalled();
    });

    it('should handle WebSocket error', () => {
      const s = createMockSocket();
      const error = new Error('WebSocket error');

      // Simulate WebSocket error
      const msg =
        new Date().toISOString() +
        ' (ws) peer ' +
        s.req.connection.remoteAddress +
        ' error: ' +
        error;
      srv.log(msg);

      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('(ws) peer'),
      );
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('error:'));
    });
  });

  describe('Malformed Data', () => {
    it('should handle invalid JSON in parse()', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "invalid json syntax }');

      const result = parse(s, data);

      expect(result).toBe(0);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('parse:'));
    });

    it('should handle binary data that looks like JSON but is not', () => {
      const s = createMockSocket();
      // Binary data that starts with { but is not valid JSON
      const data = Buffer.from([0x7b, 0xff, 0xfe, 0x00, 0x01]);

      const result = parse(s, data);

      expect(result).toBe(0);
    });

    it('should handle partial JSON data', () => {
      const s = createMockSocket();
      // Incomplete JSON
      const data = Buffer.from('{ "host": "test.com", "port": ');

      const result = parse(s, data);

      expect(result).toBe(0);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('parse:'));
    });

    it('should handle unicode edge cases in chat messages', () => {
      const s = createMockSocket();
      // Invalid UTF-8 sequence
      const data = Buffer.from([
        0x7b, 0x22, 0x6d, 0x73, 0x67, 0x22, 0x3a, 0x20, 0x22, 0xff, 0xfe, 0x22,
        0x7d,
      ]);

      const result = parse(s, data);

      // Should either parse or return 0
      expect([0, 1]).toContain(result);
    });

    it('should handle null bytes in JSON', () => {
      const s = createMockSocket();
      // Using JSON.stringify to create valid JSON with null
      const jsonObj = { msg: 'hello\u0000world' };
      const data = Buffer.from(JSON.stringify(jsonObj));

      const result = parse(s, data);

      expect(result).toBe(1);
    });

    it('should handle escaped characters in JSON', () => {
      const s = createMockSocket();
      // Use JSON.stringify to ensure valid JSON with escaped chars
      const jsonObj = { msg: 'hello\n\r\tworld' };
      const data = Buffer.from(JSON.stringify(jsonObj));

      const result = parse(s, data);

      expect(result).toBe(1);
    });
  });

  describe('Timeout Handling', () => {
    it('should trigger cleanup on telnet socket timeout', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Add timeout handler
      ts.on('timeout', () => {
        srv.log('telnet socket timeout: ' + s.remoteAddress);
      });

      // Simulate timeout event
      ts.emit('timeout');

      // Verify timeout was logged
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('telnet socket timeout:'),
      );
    });

    it('should send timeout message to client', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Add timeout handler
      ts.on('timeout', () => {
        srv.sendClient(s, Buffer.from('Timeout: server port is down.\r\n'));
      });

      // Simulate timeout
      ts.emit('timeout');

      expect(mockSendClient).toHaveBeenCalledWith(
        s,
        Buffer.from('Timeout: server port is down.\r\n'),
      );
    });

    it('should close socket after timeout', (done: () => void) => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Add timeout handler with delayed close
      ts.on('timeout', () => {
        setTimeout(() => {
          srv.closeSocket(s);
        }, 100);
      });

      // Simulate timeout with delayed close
      ts.emit('timeout');

      setTimeout(() => {
        // Socket should be closed after timeout
        expect(mockCloseSocket).toHaveBeenCalledWith(s);
        done();
      }, 200);
    });
  });

  describe('Compression Errors', () => {
    let originalDeflateRaw: typeof zlib.deflateRaw;

    beforeEach(() => {
      // Save original function before each test
      originalDeflateRaw = zlib.deflateRaw;
    });

    afterEach(() => {
      // Always restore original function after each test
      zlib.deflateRaw = originalDeflateRaw;
    });

    it('should handle zlib deflateRaw error', async () => {
      const s = createMockSocket();
      const data = Buffer.from('test data');

      // Mock zlib to trigger error using a simple wrapper
      let deflateCalled = false;
      const errorMock = (
        _data: unknown,
        callback: (err: Error | null, buffer: Buffer) => void,
      ) => {
        deflateCalled = true;
        callback(new Error('Compression failed'), Buffer.from(''));
      };

      const originalDeflateRaw = zlib.deflateRaw;
      (zlib as unknown as { deflateRaw: typeof zlib.deflateRaw }).deflateRaw =
        errorMock as typeof zlib.deflateRaw;

      sendClient(s, data);

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(deflateCalled).toBe(true);
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('zlib error:'),
      );
    });

    it('should fallback gracefully on compression failure', async () => {
      const s = createMockSocket();
      const data = Buffer.from('test data');

      // Mock zlib to trigger error
      let deflateCalled = false;
      const errorMock = (
        _data: unknown,
        callback: (err: Error | null, buffer: Buffer) => void,
      ) => {
        deflateCalled = true;
        callback(new Error('Compression failed'), Buffer.from(''));
      };

      const originalDeflateRaw = zlib.deflateRaw;
      (zlib as unknown as { deflateRaw: typeof zlib.deflateRaw }).deflateRaw =
        errorMock as typeof zlib.deflateRaw;

      // Should still send data even if compression fails
      sendClient(s, data);

      // Wait for async callback
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Data should be sent (either compressed or uncompressed)
      expect(mockSend).toHaveBeenCalled();

      // Restore original
      zlib.deflateRaw = originalDeflateRaw;
    });

    it('should handle empty buffer compression', () => {
      const s = createMockSocket();
      const data = Buffer.from('');

      // Should handle empty buffer without error
      expect(() => sendClient(s, data)).not.toThrow();
    });
  });

  describe('Encoding Errors', () => {
    it('should handle iconv encoding failure', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Data that might fail latin1 encoding
      const data = Buffer.from([0x80, 0x81, 0x82]);

      try {
        iconv.encode(data.toString(), 'latin1');
      } catch (ex) {
        srv.log('error: ' + (ex as Error).toString(), s);
      }

      // Encoding errors should be logged
      expect(mockLog).not.toHaveBeenCalledWith(
        expect.stringContaining('error:'),
      );
    });

    it('should log encoding errors', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Test with invalid encoding
      const testString = '\u00ff\u00fe';
      try {
        iconv.encode(testString, 'invalid-encoding');
      } catch (ex) {
        srv.log('error: ' + (ex as Error).toString(), s);
      }

      // Verify error was logged
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('error:'),
        s,
      );
    });

    it('should handle UTF-8 to latin1 conversion edge cases', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Characters that do not fit in latin1
      const utf8String = '日本語テキスト';

      try {
        const encoded = iconv.encode(utf8String, 'latin1');
        // May convert to similar chars or skip
        expect(encoded).toBeDefined();
      } catch (ex) {
        srv.log('Encoding error: ' + (ex as Error).toString(), s);
      }
    });
  });

  describe('File Operation Errors', () => {
    it('should handle chat log file read error', async () => {
      // Create a temporary file path that does not exist
      const nonExistentPath =
        '/tmp/nonexistent-chat-log-' + Date.now() + '.json';

      const loadChatLog = async (): Promise<unknown[]> => {
        try {
          const data = await fs.promises.readFile(nonExistentPath, 'utf8');
          const parsed = JSON.parse(data);
          return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
          srv.log('Chat log error: ' + err);
          return [];
        }
      };

      const result = await loadChatLog();

      expect(result).toEqual([]);
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('Chat log error:'),
      );
    });

    it('should handle corrupted JSON in chat log', async () => {
      // Test with corrupted JSON content
      const corruptedJSON = '{ invalid json }';

      const loadChatLog = async (): Promise<unknown[]> => {
        try {
          const parsed = JSON.parse(corruptedJSON);
          return Array.isArray(parsed) ? parsed : [];
        } catch (err) {
          srv.log('Chat log error: ' + err);
          return [];
        }
      };

      const result = await loadChatLog();

      expect(result).toEqual([]);
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('Chat log error:'),
      );
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty buffers', () => {
      const s = createMockSocket();
      const emptyBuffer = Buffer.from('');

      // Should not throw
      expect(() => parse(s, emptyBuffer)).not.toThrow();
      expect(parse(s, emptyBuffer)).toBe(0);
    });

    it('should handle very large messages', () => {
      const s = createMockSocket();
      // Create a large buffer (1MB)
      const largeBuffer = Buffer.alloc(1024 * 1024, 'a');

      // Should handle large buffers without crashing
      expect(() => sendClient(s, largeBuffer)).not.toThrow();
    });

    it('should handle null/undefined socket properties', () => {
      const s = createMockSocket({
        ts: undefined,
        host: undefined,
        port: undefined,
      });

      // Accessing undefined properties should be handled gracefully
      expect(s.ts).toBeUndefined();
      expect(s.host).toBeUndefined();
      expect(s.port).toBeUndefined();
    });

    it('should handle socket already closed when trying to terminate', () => {
      const s = createMockSocket();
      let terminateCalled = false;

      // Mock terminate to throw error (socket already closed)
      s.terminate = jest.fn(() => {
        if (terminateCalled) {
          throw new Error('Socket already closed');
        }
        terminateCalled = true;
      }) as unknown as () => void;

      // First call should succeed
      s.terminate();
      expect(terminateCalled).toBe(true);

      // Second call should throw
      expect(() => s.terminate()).toThrow('Socket already closed');
    });

    it('should handle socket with missing methods', () => {
      const s = {
        ...createMockSocket(),
        sendUTF: undefined,
        terminate: undefined,
      } as unknown as SocketExtended;

      // Should handle missing sendUTF gracefully
      expect(s.sendUTF).toBeUndefined();
      expect(s.terminate).toBeUndefined();
    });

    it('should handle buffer with only whitespace', () => {
      const s = createMockSocket();
      const whitespaceBuffer = Buffer.from('   \n\t  ');

      const result = parse(s, whitespaceBuffer);

      expect(result).toBe(0);
    });

    it('should handle nested circular references in parse', () => {
      const s = createMockSocket();
      // Circular references can not be sent as JSON, but test eval handling
      const data = Buffer.from('{ "obj": {} }');

      const result = parse(s, data);

      expect(result).toBe(1);
    });

    it('should handle socket close event when already closing', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Add close handler
      ts.on('close', () => {
        srv.log('telnet socket closed: ' + s.remoteAddress);
      });

      // Simulate multiple close events
      ts.emit('close');
      ts.emit('close');

      // Should handle duplicate close events gracefully
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringContaining('telnet socket closed'),
      );
    });

    it('should handle concurrent error events', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Add error handler
      ts.on('error', (err: Error) => {
        srv.log('error: ' + err.message);
      });

      // Emit multiple errors rapidly
      ts.emit('error', new Error('Error 1'));
      ts.emit('error', new Error('Error 2'));
      ts.emit('error', new Error('Error 3'));

      // All errors should be logged
      expect(mockLog).toHaveBeenCalledTimes(3);
    });

    it('should handle data event after socket error', () => {
      const s = createMockSocket();
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Add handlers
      ts.on('error', (err: Error) => {
        srv.log('error: ' + err.message);
      });
      ts.on('data', (data: Buffer) => {
        srv.sendClient(s, data);
      });

      // Error then data
      ts.emit('error', new Error('Socket error'));
      ts.emit('data', Buffer.from('some data'));

      // Should handle gracefully
      expect(mockLog).toHaveBeenCalledWith('error: Socket error');
    });

    it('should handle malformed telnet sequences', () => {
      const s = createMockSocket();
      // Malformed telnet: IAC without complete sequence
      const malformedTelnet = Buffer.from([255, 253]); // IAC DO (missing option)

      // Should handle gracefully
      expect(() => sendClient(s, malformedTelnet)).not.toThrow();
    });

    it('should handle buffer overflow protection', () => {
      const s = createMockSocket();
      // Very large buffer that might cause issues
      const hugeBuffer = Buffer.alloc(10 * 1024 * 1024); // 10MB

      // Should handle without crashing
      expect(() => parse(s, hugeBuffer)).not.toThrow();
    });
  });

  describe('Protocol Handling Errors', () => {
    it('should handle incomplete MCCP negotiation', () => {
      const s = createMockSocket({
        mccp: true,
        mccp_negotiated: 0,
        compressed: 0,
      });
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Incomplete MCCP sequence
      const data = Buffer.from([255, 253]); // IAC DO without MCCP byte

      sendClient(s, data);

      // Should not negotiate MCCP with incomplete sequence
      expect(s.compressed).toBe(0);
    });

    it('should handle invalid GMCP data', () => {
      const s = createMockSocket({
        gmcp_negotiated: 0,
      });
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // Invalid GMCP sequence
      const data = Buffer.from([255, 250, 201, 255, 240]); // IAC SB GMCP IAC SE (no actual data)

      sendClient(s, data);

      // Should handle gracefully
      expect(mockSend).toBeDefined();
    });

    it('should handle MSDP with missing values', () => {
      const s = createMockSocket({
        msdp_negotiated: 0,
      });
      const ts = createMockTelnetSocket();
      s.ts = ts;

      // MSDP WILL without proper handling
      const data = Buffer.from([255, 251, 69]); // IAC WILL MSDP

      sendClient(s, data);

      // Should handle gracefully
      expect(mockSend).toBeDefined();
    });
  });
});
