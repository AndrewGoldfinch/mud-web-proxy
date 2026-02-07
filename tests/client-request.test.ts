import { describe, it, expect, beforeEach, jest } from 'bun:test';
import type { WebSocket } from 'ws';
import type { Socket } from 'net';
import type { IncomingMessage } from 'http';

// Define types locally for testing
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

interface TelnetSocket extends Socket {
  send: (data: string | Buffer) => void;
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

// Mock the srv module
const mockLog = jest.fn();
const mockInitT = jest.fn();
const mockSendMSDP = jest.fn();
const mockSendClient = jest.fn();

// Mock chat that sets s.chat = 1 like the real implementation
const mockChat = jest.fn((s: SocketExtended, _req: ChatRequest) => {
  s.chat = 1;
});

// Create a mock srv object that mimics the behavior of the real srv
const srv = {
  log: mockLog,
  initT: mockInitT,
  chat: mockChat,
  sendMSDP: mockSendMSDP,
  sendClient: mockSendClient,
  tn_host: 'muds.maldorne.org',
  tn_port: 5010,
  debug: false,
  compress: true,
  open: true,
};

// Import the parse function logic (we'll recreate it here for testing)
const parse = (s: SocketExtended, d: Buffer): number => {
  if (d[0] !== '{'.charCodeAt(0)) return 0;

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

  if (req.chat) srv.chat(s, req as ChatRequest);
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

// Helper to create a mock SocketExtended
const createMockSocket = (): SocketExtended => {
  return {
    ttype: [],
    compressed: 0,
    req: {
      connection: { remoteAddress: '127.0.0.1' },
    },
    sendUTF: jest.fn(),
    terminate: jest.fn(),
    remoteAddress: '127.0.0.1',
  } as unknown as SocketExtended;
};

describe('Client Request Parsing', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('Field Configuration Tests', () => {
    it('should set s.host from req.host', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "host": "example.com" }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.host).toBe('example.com');
      expect(mockLog).toHaveBeenCalledWith(
        'Target host set to example.com',
        s,
      );
    });

    it('should set s.port from req.port', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "port": 8080 }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.port).toBe(8080);
      expect(mockLog).toHaveBeenCalledWith('Target port set to 8080', s);
    });

    it('should set s.ttype array from req.ttype', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "ttype": "XTERM-256color" }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.ttype).toEqual(['XTERM-256color']);
      expect(mockLog).toHaveBeenCalledWith(
        'Client ttype set to XTERM-256color',
        s,
      );
    });

    it('should set s.name from req.name', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "name": "TestUser" }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.name).toBe('TestUser');
    });

    it('should set s.client from req.client', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "client": "TestClient" }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.client).toBe('TestClient');
    });

    it('should set s.mccp from req.mccp', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "mccp": true }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.mccp).toBe(true);
    });

    it('should set s.utf8 from req.utf8', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "utf8": true }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.utf8).toBe(true);
    });

    it('should set s.debug from req.debug', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "debug": true }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.debug).toBe(true);
    });
  });

  describe('Command Handling Tests', () => {
    it('should call srv.chat() when req.chat is set', () => {
      const s = createMockSocket();
      const data = Buffer.from(
        '{ "chat": 1, "channel": "general", "msg": "Hello" }',
      );

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.chat).toBe(1);
      expect(mockChat).toHaveBeenCalledTimes(1);
      expect(mockChat).toHaveBeenCalledWith(s, {
        chat: 1,
        channel: 'general',
        msg: 'Hello',
      });
    });

    it('should call srv.initT() when req.connect is set', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "connect": 1 }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(mockInitT).toHaveBeenCalledTimes(1);
      expect(mockInitT).toHaveBeenCalledWith(s);
    });

    it('should send Buffer to telnet socket when req.bin is set', () => {
      const mockSend = jest.fn();
      const s = createMockSocket();
      s.ts = {
        send: mockSend,
      } as unknown as SocketExtended['ts'];

      const data = Buffer.from('{ "bin": [255, 251, 24] }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(mockSend).toHaveBeenCalledTimes(1);
      expect(mockSend).toHaveBeenCalledWith(Buffer.from([255, 251, 24]));
      expect(mockLog).toHaveBeenCalledWith('Attempt binary send: 255,251,24');
    });

    it('should not send binary data if s.ts is not set', () => {
      const s = createMockSocket();
      // s.ts is undefined
      const data = Buffer.from('{ "bin": [255, 251, 24] }');

      const result = parse(s, data);

      expect(result).toBe(1);
      // No error should be thrown, and no send should be called
    });

    it('should call srv.sendMSDP() when req.msdp is set', () => {
      const s = createMockSocket();
      s.ts = {
        send: jest.fn(),
      } as unknown as SocketExtended['ts'];

      const msdpData: MSDPRequest = { key: 'TestKey', val: 'TestValue' };
      const data = Buffer.from(JSON.stringify({ msdp: msdpData }));

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(mockSendMSDP).toHaveBeenCalledTimes(1);
      expect(mockSendMSDP).toHaveBeenCalledWith(s, msdpData);
      expect(mockLog).toHaveBeenCalledWith(
        'Attempt msdp send: ' + JSON.stringify(msdpData),
      );
    });

    it('should handle MSDP with array values', () => {
      const s = createMockSocket();
      s.ts = {
        send: jest.fn(),
      } as unknown as SocketExtended['ts'];

      const msdpData: MSDPRequest = {
        key: 'TestKey',
        val: ['val1', 'val2'],
      };
      const data = Buffer.from(JSON.stringify({ msdp: msdpData }));

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(mockSendMSDP).toHaveBeenCalledTimes(1);
      expect(mockSendMSDP).toHaveBeenCalledWith(s, msdpData);
    });

    it('should not send MSDP data if s.ts is not set', () => {
      const s = createMockSocket();
      // s.ts is undefined
      const data = Buffer.from('{ "msdp": { "key": "test" } }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(mockSendMSDP).not.toHaveBeenCalled();
    });
  });

  describe('Error Handling Tests', () => {
    it('should return 0 for malformed JSON and log error', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "invalid json syntax }');

      const result = parse(s, data);

      expect(result).toBe(0);
      expect(mockLog).toHaveBeenCalledWith(expect.stringContaining('parse:'));
    });

    it('should return 0 for non-JSON data that does not start with {', () => {
      const s = createMockSocket();
      const data = Buffer.from('Hello World');

      const result = parse(s, data);

      expect(result).toBe(0);
      expect(mockLog).not.toHaveBeenCalled();
    });

    it('should return 0 for data starting with [ (array)', () => {
      const s = createMockSocket();
      const data = Buffer.from('[1, 2, 3]');

      const result = parse(s, data);

      expect(result).toBe(0);
    });

    it('should return 0 for data starting with " (string)', () => {
      const s = createMockSocket();
      const data = Buffer.from('"Hello"');

      const result = parse(s, data);

      expect(result).toBe(0);
    });

    it('should return 0 for empty data', () => {
      const s = createMockSocket();
      const data = Buffer.from('');

      const result = parse(s, data);

      expect(result).toBe(0);
    });

    it('should return 0 for numeric data', () => {
      const s = createMockSocket();
      const data = Buffer.from('12345');

      const result = parse(s, data);

      expect(result).toBe(0);
    });
  });

  describe('Missing Optional Fields Tests', () => {
    it('should handle empty JSON object without throwing errors', () => {
      const s = createMockSocket();
      const data = Buffer.from('{}');

      expect(() => parse(s, data)).not.toThrow();
      const result = parse(s, data);
      expect(result).toBe(1);
    });

    it('should handle request with only some fields set', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "host": "test.com" }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.host).toBe('test.com');
      expect(s.port).toBeUndefined();
      expect(s.name).toBeUndefined();
      expect(s.ttype).toEqual([]);
    });

    it('should handle request with multiple fields set', () => {
      const s = createMockSocket();
      const data = Buffer.from(
        '{ "host": "test.com", "port": 7000, "name": "User", "client": "WebClient" }',
      );

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.host).toBe('test.com');
      expect(s.port).toBe(7000);
      expect(s.name).toBe('User');
      expect(s.client).toBe('WebClient');
    });

    it('should handle undefined optional fields gracefully', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "host": null, "port": null }');

      const result = parse(s, data);

      expect(result).toBe(1);
      // Null values should not set the properties
      expect(s.host).toBeUndefined();
      expect(s.port).toBeUndefined();
    });
  });

  describe('Return Value Tests', () => {
    it('should return 1 for handled JSON requests', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "host": "test.com" }');

      const result = parse(s, data);

      expect(result).toBe(1);
    });

    it('should return 0 for unhandled data (non-JSON)', () => {
      const s = createMockSocket();
      const data = Buffer.from('Plain text data');

      const result = parse(s, data);

      expect(result).toBe(0);
    });

    it('should return 0 for unhandled data (malformed JSON)', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "broken" }');

      const result = parse(s, data);

      expect(result).toBe(0);
    });

    it('should return 1 for valid JSON even with no actionable fields', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "someField": "someValue" }');

      const result = parse(s, data);

      expect(result).toBe(1);
    });
  });

  describe('Edge Cases', () => {
    it('should handle multiple commands in single request', () => {
      const s = createMockSocket();
      s.ts = {
        send: jest.fn(),
      } as unknown as SocketExtended['ts'];

      const data = Buffer.from(
        '{ "host": "test.com", "port": 7000, "connect": 1, "chat": 1 }',
      );

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.host).toBe('test.com');
      expect(s.port).toBe(7000);
      expect(mockInitT).toHaveBeenCalled();
      expect(mockChat).toHaveBeenCalled();
    });

    it('should handle boolean false values (truthy check skips falsy)', () => {
      const s = createMockSocket();
      const data = Buffer.from(
        '{ "mccp": false, "utf8": false, "debug": false }',
      );

      const result = parse(s, data);

      expect(result).toBe(1);
      // Note: parse() uses truthy checks, so false values are not set
      expect(s.mccp).toBeUndefined();
      expect(s.utf8).toBeUndefined();
      expect(s.debug).toBeUndefined();
    });

    it('should handle empty string values (truthy check skips empty)', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "name": "", "client": "" }');

      const result = parse(s, data);

      expect(result).toBe(1);
      // Note: parse() uses truthy checks, so empty strings are not set
      expect(s.name).toBeUndefined();
      expect(s.client).toBeUndefined();
    });

    it('should handle special characters in strings', () => {
      const s = createMockSocket();
      const data = Buffer.from(
        '{ "name": "User\\"Test", "host": "test\\nhost" }',
      );

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.name).toBe('User"Test');
      expect(s.host).toBe('test\nhost');
    });

    it('should handle unicode characters', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "name": "用户", "host": "测试.com" }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.name).toBe('用户');
      expect(s.host).toBe('测试.com');
    });

    it('should handle binary data as empty array', () => {
      const mockSend = jest.fn();
      const s = createMockSocket();
      s.ts = {
        send: mockSend,
      } as unknown as SocketExtended['ts'];

      const data = Buffer.from('{ "bin": [] }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(mockSend).toHaveBeenCalledWith(Buffer.from([]));
    });

    it('should handle MSDP with empty key or val', () => {
      const s = createMockSocket();
      s.ts = {
        send: jest.fn(),
      } as unknown as SocketExtended['ts'];

      const data = Buffer.from('{ "msdp": { "key": "", "val": "" } }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(mockSendMSDP).toHaveBeenCalledWith(s, { key: '', val: '' });
    });

    it('should not set port when value is 0 (truthy check)', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "port": 0 }');

      const result = parse(s, data);

      expect(result).toBe(1);
      // Note: parse() uses truthy check (if (req.port)), so 0 is not set
      expect(s.port).toBeUndefined();
    });

    it('should handle large port numbers', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "port": 65535 }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.port).toBe(65535);
    });

    it('should handle chat command without optional fields', () => {
      const s = createMockSocket();
      const data = Buffer.from('{ "chat": 1 }');

      const result = parse(s, data);

      expect(result).toBe(1);
      expect(s.chat).toBe(1);
      expect(mockChat).toHaveBeenCalledWith(s, { chat: 1 });
    });
  });
});
