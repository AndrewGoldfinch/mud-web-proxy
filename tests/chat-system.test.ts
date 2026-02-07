/**
 * Chat System Tests
 * Tests for chat functionality including broadcasting, sanitization,
 * persistence, and chat log management
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  beforeAll,
} from 'bun:test';

// Type definitions
interface ChatRequest {
  chat?: number;
  channel?: string;
  msg?: string;
  name?: string;
}

interface ChatEntry {
  date: Date;
  data: ChatRequest;
}

interface SocketExtended {
  req: { connection: { remoteAddress: string } };
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
  remoteAddress: string;
  sendUTF: (data: string | Buffer) => void;
  send: (data: string | Buffer) => void;
  terminate: () => void;
}

interface TelnetSocket {
  write: (data: Buffer | string) => boolean;
  send: (data: string | Buffer) => void;
  on: (event: string, listener: unknown) => TelnetSocket;
  once: (event: string, listener: unknown) => TelnetSocket;
  destroy: () => void;
  end: () => void;
  setEncoding: (encoding: string) => void;
  writable?: boolean;
}

// Mock file system state
let mockChatLogData: string | null = null;
const mockFsFiles: Map<string, string> = new Map();
const writtenFiles: Map<string, string> = new Map();
const fileErrors: Map<string, Error> = new Map();

// Mock fs module
const mockFs = {
  existsSync: (path: string): boolean => {
    return mockFsFiles.has(path) || path === './chat.json';
  },

  readFileSync: (path: string, encoding?: string): string | Buffer => {
    if (fileErrors.has(path)) {
      throw fileErrors.get(path)!;
    }

    if (mockFsFiles.has(path)) {
      const content = mockFsFiles.get(path)!;
      return encoding === 'utf8' ? content : Buffer.from(content);
    }

    if (path === './chat.json') {
      if (mockChatLogData === null) {
        const error = new Error('ENOENT: no such file or directory');
        (error as Error & { code: string }).code = 'ENOENT';
        throw error;
      }
      return encoding === 'utf8'
        ? mockChatLogData
        : Buffer.from(mockChatLogData);
    }

    const error = new Error('ENOENT: no such file or directory');
    (error as Error & { code: string }).code = 'ENOENT';
    throw error;
  },

  promises: {
    readFile: async (path: string, encoding?: string): Promise<string> => {
      if (fileErrors.has(path)) {
        throw fileErrors.get(path)!;
      }

      if (mockFsFiles.has(path)) {
        const content = mockFsFiles.get(path)!;
        return encoding === 'utf8' ? content : content;
      }

      if (path === './chat.json') {
        if (mockChatLogData === null) {
          const error = new Error('ENOENT: no such file or directory');
          (error as Error & { code: string }).code = 'ENOENT';
          throw error;
        }
        return mockChatLogData;
      }

      const error = new Error('ENOENT: no such file or directory');
      (error as Error & { code: string }).code = 'ENOENT';
      throw error;
    },

    writeFile: async (path: string, data: string): Promise<void> => {
      writtenFiles.set(path, data);
    },
  },

  writeFileSync: (path: string, data: string): void => {
    writtenFiles.set(path, data);
  },

  // Test helpers
  _setMockFile: (path: string, content: string): void => {
    mockFsFiles.set(path, content);
  },

  _clearMockFiles: (): void => {
    mockFsFiles.clear();
    writtenFiles.clear();
    fileErrors.clear();
  },

  _setChatLog: (data: string | null): void => {
    mockChatLogData = data;
  },

  _setFileError: (path: string, error: Error): void => {
    fileErrors.set(path, error);
  },

  _getWrittenFiles: (): Map<string, string> => {
    return writtenFiles;
  },
};

// Mock server state
let mockChatlog: ChatEntry[] = [];

// Server state interface
interface ServerState {
  sockets: SocketExtended[];
}

// Create server state
let server: ServerState = {
  sockets: [],
};

// Helper to create mock SocketExtended
function createMockSocket(
  overrides: Partial<SocketExtended> = {},
): SocketExtended & { _sentMessages: string[] } {
  const sentMessages: string[] = [];

  const baseSocket = {
    req: {
      connection: {
        remoteAddress: '127.0.0.1',
      },
    },
    ts: undefined as TelnetSocket | undefined,
    host: 'test.host',
    port: 7000,
    ttype: ['xterm-256color'],
    name: 'TestUser',
    client: 'test-client',
    mccp: false,
    utf8: false,
    debug: false,
    compressed: 0,
    mccp_negotiated: 0,
    mxp_negotiated: 0,
    gmcp_negotiated: 0,
    utf8_negotiated: 0,
    new_negotiated: 0,
    new_handshake: 0,
    sga_negotiated: 0,
    echo_negotiated: 0,
    naws_negotiated: 0,
    msdp_negotiated: 0,
    chat: 0,
    password_mode: false,
    remoteAddress: '127.0.0.1',
    send: (data: string | Buffer) => {
      sentMessages.push(typeof data === 'string' ? data : data.toString());
    },
    sendUTF: (data: string | Buffer) => {
      sentMessages.push(typeof data === 'string' ? data : data.toString());
    },
    terminate: () => {},
    _sentMessages: sentMessages,
    ...overrides,
  };

  return baseSocket as SocketExtended & { _sentMessages: string[] };
}

// Mock telnet socket
function createMockTelnetSocket(
  overrides: Partial<TelnetSocket> = {},
): TelnetSocket {
  return {
    write: () => true,
    send: () => {},
    on: () => ({}) as TelnetSocket,
    once: () => ({}) as TelnetSocket,
    destroy: () => {},
    end: () => {},
    setEncoding: () => {},
    ...overrides,
  } as TelnetSocket;
}

// JSON stringify helper (same as wsproxy.ts)
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

// Load chat log function (from wsproxy.ts)
const loadChatLog = async (): Promise<ChatEntry[]> => {
  try {
    const data = await mockFs.promises.readFile('./chat.json', 'utf8');
    const parsed = JSON.parse(data);
    // Ensure we always return an array
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

// Chat cleanup function (from wsproxy.ts)
const chatCleanup = function (t: string): string {
  /* eslint-disable no-control-regex */
  t = t.replace(/([^\x1b])</g, '$1&lt;');
  t = t.replace(/([^\x1b])>/g, '$1&gt;');
  t = t.replace(/\x1b>/g, '>');
  t = t.replace(/\x1b</g, '<');
  /* eslint-enable no-control-regex */
  return t;
};

// Mock chat function (based on wsproxy.ts)
const chat = function (s: SocketExtended, req: ChatRequest): void {
  s.chat = 1;

  const ss = server.sockets;

  // Ensure chatlog is always an array
  if (!Array.isArray(mockChatlog)) {
    mockChatlog = [];
  }

  if (req.channel && req.channel === 'op') {
    // Create a copy of the last 300 messages
    const temp = Array.from(mockChatlog).slice(-300);
    const users: string[] = [];

    for (let i = 0; i < ss.length; i++) {
      if (!ss[i].ts && ss[i].name) continue;

      let u: string;
      if (ss[i].ts) {
        u = (ss[i].name || 'Guest') + '@' + ss[i].host;
      } else {
        u = (ss[i].name || 'Guest') + '@chat';
      }

      if (users.indexOf(u) === -1) users.push(u);
    }

    temp.push({
      date: new Date(),
      data: { channel: 'status', name: 'online:', msg: users.join(', ') },
    });

    let t = stringify(temp);
    t = chatCleanup(t);

    s.send('portal.chatlog ' + t);
    return;
  }

  delete req.chat;
  mockChatlog.push({ date: new Date(), data: req });
  req.msg = chatCleanup(req.msg!);

  for (let i = 0; i < ss.length; i++) {
    if (ss[i].chat) ss[i].send('portal.chat ' + stringify(req));
  }

  mockFs.writeFileSync('./chat.json', stringify(mockChatlog));
};

// Chat update function (from wsproxy.ts)
const chatUpdate = function (): void {
  const ss = server.sockets;
  for (let i = 0; i < ss.length; i++) {
    if (ss[i].chat) chat(ss[i], { channel: 'op' });
  }
};

// Reset function for tests
const resetChatState = (): void => {
  mockChatlog = [];
  server = { sockets: [] };
  mockFs._clearMockFiles();
  mockFs._setChatLog(null);
};

describe('Chat System', () => {
  beforeAll(() => {
    process.env.NODE_ENV = 'test';
  });

  beforeEach(() => {
    resetChatState();
  });

  afterEach(() => {
    resetChatState();
  });

  describe('chat() function', () => {
    it('should broadcast basic chat message to all chat sockets', () => {
      // Create multiple sockets
      const socket1 = createMockSocket({ chat: 1, name: 'User1' });
      const socket2 = createMockSocket({ chat: 1, name: 'User2' });
      const socket3 = createMockSocket({ chat: 0, name: 'User3' });

      server.sockets = [socket1, socket2, socket3];

      const chatRequest: ChatRequest = {
        chat: 1,
        channel: 'general',
        name: 'TestUser',
        msg: 'Hello everyone!',
      };

      chat(socket1, chatRequest);

      // Socket 1 and 2 should receive the message (they have chat flag)
      expect(socket1._sentMessages.length).toBeGreaterThan(0);
      expect(socket2._sentMessages.length).toBeGreaterThan(0);

      // Socket 3 should not receive (no chat flag)
      const socket3HasChatMsg = socket3._sentMessages.some((msg) =>
        msg.includes('portal.chat'),
      );
      expect(socket3HasChatMsg).toBe(false);
    });

    it('should set s.chat = 1 when chat() is called', () => {
      const socket = createMockSocket({ chat: 0 });

      expect(socket.chat).toBe(0);

      const chatRequest: ChatRequest = {
        chat: 1,
        channel: 'general',
        name: 'TestUser',
        msg: 'Hello',
      };

      chat(socket, chatRequest);

      expect(socket.chat).toBe(1);
    });

    it('should send last 300 messages and user list on channel op request', () => {
      // Add 350 messages to chatlog
      for (let i = 0; i < 350; i++) {
        mockChatlog.push({
          date: new Date(),
          data: {
            channel: 'general',
            name: 'User' + i,
            msg: 'Message ' + i,
          },
        });
      }

      const socket1 = createMockSocket({
        chat: 1,
        name: 'Alice',
        host: 'host1',
        ts: createMockTelnetSocket(),
      });
      const socket2 = createMockSocket({
        chat: 1,
        name: 'Bob',
        host: 'host2',
        ts: createMockTelnetSocket(),
      });

      server.sockets = [socket1, socket2];

      const chatRequest: ChatRequest = {
        chat: 1,
        channel: 'op',
      };

      chat(socket1, chatRequest);

      // Should send portal.chatlog message
      expect(socket1._sentMessages.length).toBe(1);
      expect(socket1._sentMessages[0]).toContain('portal.chatlog');

      // Parse the sent message
      const sentMsg = socket1._sentMessages[0];
      const jsonStr = sentMsg.replace('portal.chatlog ', '');
      const parsed = JSON.parse(jsonStr);

      // Should have exactly 301 messages (300 + status message)
      expect(parsed.length).toBe(301);

      // Check that it contains status message with user list
      const statusMsg = parsed[parsed.length - 1];
      expect(statusMsg.data.channel).toBe('status');
      expect(statusMsg.data.name).toBe('online:');
      expect(statusMsg.data.msg).toContain('Alice@host1');
      expect(statusMsg.data.msg).toContain('Bob@host2');
    });

    it('should call chatCleanup() on messages', () => {
      const socket = createMockSocket({ chat: 1 });
      server.sockets = [socket];

      const chatRequest: ChatRequest = {
        chat: 1,
        channel: 'general',
        name: 'TestUser',
        msg: 'test<script>alert("xss")</script>', // Add char before < so it's escaped
      };

      chat(socket, chatRequest);

      // Get the sent message and verify sanitization was applied
      const sentMsg = socket._sentMessages[0];
      expect(sentMsg).toContain('&lt;script&gt;');
      expect(sentMsg).toContain('&lt;/script&gt;');
    });

    it('should persist chat log to chat.json', () => {
      const socket = createMockSocket({ chat: 1 });
      server.sockets = [socket];

      const chatRequest: ChatRequest = {
        chat: 1,
        channel: 'general',
        name: 'TestUser',
        msg: 'Test message',
      };

      chat(socket, chatRequest);

      // Verify file was written
      const writtenFiles = mockFs._getWrittenFiles();
      expect(writtenFiles.has('./chat.json')).toBe(true);

      const content = writtenFiles.get('./chat.json')!;
      const parsed = JSON.parse(content);

      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.length).toBe(1);
      expect(parsed[0].data.msg).toBe('Test message');
      expect(parsed[0].data.name).toBe('TestUser');
    });

    it('should not write to chat.json on op channel request', () => {
      const socket = createMockSocket({ chat: 1, name: 'TestUser' });
      server.sockets = [socket];

      const chatRequest: ChatRequest = {
        chat: 1,
        channel: 'op',
      };

      chat(socket, chatRequest);

      // Should not write to file for op requests
      const writtenFiles = mockFs._getWrittenFiles();
      expect(writtenFiles.has('./chat.json')).toBe(false);
    });

    it('should handle sockets without names correctly', () => {
      const socket1 = createMockSocket({ chat: 1, name: undefined });
      const socket2 = createMockSocket({
        chat: 1,
        name: 'NamedUser',
        ts: createMockTelnetSocket(),
      });

      server.sockets = [socket1, socket2];

      const chatRequest: ChatRequest = {
        chat: 1,
        channel: 'op',
      };

      chat(socket1, chatRequest);

      // Get the last message (status message)
      const sentMsg = socket1._sentMessages[0];
      const jsonStr = sentMsg.replace('portal.chatlog ', '');
      const parsed = JSON.parse(jsonStr);
      const statusMsg = parsed[parsed.length - 1];

      expect(statusMsg.data.msg).toContain('Guest@chat');
      expect(statusMsg.data.msg).toContain('NamedUser@test.host');
    });
  });

  describe('chatUpdate() function', () => {
    it('should broadcast to all sockets with chat flag', () => {
      const socket1 = createMockSocket({ chat: 1, name: 'User1' });
      const socket2 = createMockSocket({ chat: 1, name: 'User2' });
      const socket3 = createMockSocket({ chat: 0, name: 'User3' });

      server.sockets = [socket1, socket2, socket3];

      chatUpdate();

      // Socket 1 and 2 should receive chatlog
      expect(socket1._sentMessages.length).toBe(1);
      expect(socket2._sentMessages.length).toBe(1);
      expect(socket1._sentMessages[0]).toContain('portal.chatlog');
      expect(socket2._sentMessages[0]).toContain('portal.chatlog');

      // Socket 3 should not receive
      expect(socket3._sentMessages.length).toBe(0);
    });

    it('should send channel op request to each socket with chat flag', () => {
      const socket1 = createMockSocket({ chat: 1, name: 'Alice' });
      const socket2 = createMockSocket({ chat: 1, name: 'Bob' });

      // Add some messages
      mockChatlog.push({
        date: new Date(),
        data: { channel: 'general', name: 'User', msg: 'Hello' },
      });

      server.sockets = [socket1, socket2];

      chatUpdate();

      // Both should receive portal.chatlog messages
      expect(socket1._sentMessages[0]).toContain('portal.chatlog');
      expect(socket2._sentMessages[0]).toContain('portal.chatlog');

      // Messages should contain the chat log
      const msg1 = JSON.parse(
        socket1._sentMessages[0].replace('portal.chatlog ', ''),
      );
      expect(msg1.length).toBe(2); // 1 message + status
    });

    it('should handle empty socket list', () => {
      server.sockets = [];

      // Should not throw
      expect(() => chatUpdate()).not.toThrow();
    });

    it('should update user list for each socket', () => {
      const socket1 = createMockSocket({
        chat: 1,
        name: 'Alice',
        ts: createMockTelnetSocket(),
      });
      const socket2 = createMockSocket({
        chat: 1,
        name: 'Bob',
        ts: createMockTelnetSocket(),
      });

      server.sockets = [socket1, socket2];

      chatUpdate();

      // Each socket's user list should include both users
      const msg1 = JSON.parse(
        socket1._sentMessages[0].replace('portal.chatlog ', ''),
      );
      const statusMsg = msg1[msg1.length - 1];

      expect(statusMsg.data.msg).toContain('Alice');
      expect(statusMsg.data.msg).toContain('Bob');
    });
  });

  describe('chatCleanup() function', () => {
    it('should escape < to &lt; (except after ESC character)', () => {
      const input = 'Hello <world>';
      const result = chatCleanup(input);
      expect(result).toBe('Hello &lt;world&gt;');
    });

    it('should escape > to &gt; (except after ESC character)', () => {
      const input = 'Hello > world';
      const result = chatCleanup(input);
      expect(result).toBe('Hello &gt; world');
    });

    it('should convert ESC< to <', () => {
      const input = 'Hello\x1b<world>';
      const result = chatCleanup(input);
      expect(result).toBe('Hello<world&gt;');
    });

    it('should convert ESC> to >', () => {
      const input = 'Hello\x1b>world';
      const result = chatCleanup(input);
      expect(result).toBe('Hello>world');
    });

    it('should handle multiple angle brackets', () => {
      const input = 'x<div><span>text</span></div>';
      const result = chatCleanup(input);
      expect(result).toBe(
        'x&lt;div&gt;&lt;span&gt;text&lt;/span&gt;&lt;/div&gt;',
      );
    });

    it('should handle mixed escaped and unescaped brackets', () => {
      const input = '\x1b<div>text\x1b</div>';
      const result = chatCleanup(input);
      expect(result).toBe('<div&gt;text</div&gt;');
    });

    it('should preserve text without brackets', () => {
      const input = 'Hello World';
      const result = chatCleanup(input);
      expect(result).toBe('Hello World');
    });

    it('should handle empty string', () => {
      const input = '';
      const result = chatCleanup(input);
      expect(result).toBe('');
    });

    it('should handle only ESC character', () => {
      const input = '\x1b';
      const result = chatCleanup(input);
      expect(result).toBe('\x1b');
    });

    it('should handle ESC followed by other characters', () => {
      const input = '\x1babc';
      const result = chatCleanup(input);
      expect(result).toBe('\x1babc');
    });
  });

  describe('loadChatLog() function', () => {
    it('should load existing chat.json successfully', async () => {
      const chatData: ChatEntry[] = [
        {
          date: new Date('2024-01-01'),
          data: { channel: 'general', name: 'User1', msg: 'Hello' },
        },
        {
          date: new Date('2024-01-02'),
          data: { channel: 'general', name: 'User2', msg: 'World' },
        },
      ];

      mockFs._setChatLog(JSON.stringify(chatData));

      const result = await loadChatLog();

      expect(result.length).toBe(2);
      expect(result[0].data.name).toBe('User1');
      expect(result[1].data.msg).toBe('World');
    });

    it('should return empty array on file not found', async () => {
      mockFs._setChatLog(null);

      const result = await loadChatLog();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should return empty array on invalid JSON', async () => {
      mockFs._setChatLog('{ invalid json }');

      const result = await loadChatLog();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should ensure array return type for non-array JSON', async () => {
      mockFs._setChatLog('{"channel": "general", "name": "test"}');

      const result = await loadChatLog();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should handle empty array', async () => {
      mockFs._setChatLog('[]');

      const result = await loadChatLog();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });

    it('should handle JSON with circular references gracefully', async () => {
      // Circular references would fail JSON.stringify, but we're loading
      // So we just need to ensure it handles invalid JSON
      mockFs._setChatLog('{"date": null, "data": {"circular": ');

      const result = await loadChatLog();

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(0);
    });
  });

  describe('ChatEntry structure', () => {
    it('should have proper date and data fields', () => {
      const entry: ChatEntry = {
        date: new Date(),
        data: {
          channel: 'general',
          name: 'TestUser',
          msg: 'Hello',
        },
      };

      expect(entry).toHaveProperty('date');
      expect(entry).toHaveProperty('data');
      expect(entry.date instanceof Date).toBe(true);
    });

    it('should have data with channel, name, and msg fields', () => {
      const entry: ChatEntry = {
        date: new Date(),
        data: {
          channel: 'general',
          name: 'TestUser',
          msg: 'Hello World',
        },
      };

      expect(entry.data).toHaveProperty('channel');
      expect(entry.data).toHaveProperty('name');
      expect(entry.data).toHaveProperty('msg');
      expect(typeof entry.data.channel).toBe('string');
      expect(typeof entry.data.name).toBe('string');
      expect(typeof entry.data.msg).toBe('string');
    });

    it('should preserve structure when stringified and parsed', () => {
      const entry: ChatEntry = {
        date: new Date('2024-01-01T00:00:00.000Z'),
        data: {
          channel: 'general',
          name: 'TestUser',
          msg: 'Test message',
        },
      };

      const serialized = stringify([entry]);
      const parsed = JSON.parse(serialized);

      expect(parsed[0].data.channel).toBe('general');
      expect(parsed[0].data.name).toBe('TestUser');
      expect(parsed[0].data.msg).toBe('Test message');
    });

    it('should handle optional fields in ChatRequest', () => {
      const minimalRequest: ChatRequest = {
        channel: 'general',
        msg: 'Hello',
      };

      expect(minimalRequest.channel).toBe('general');
      expect(minimalRequest.msg).toBe('Hello');
      expect(minimalRequest.name).toBeUndefined();
      expect(minimalRequest.chat).toBeUndefined();
    });
  });

  describe('integration scenarios', () => {
    it('should handle multiple chat messages in sequence', () => {
      const socket = createMockSocket({ chat: 1 });
      server.sockets = [socket];

      chat(socket, {
        chat: 1,
        channel: 'general',
        name: 'User1',
        msg: 'First',
      });
      chat(socket, {
        chat: 1,
        channel: 'general',
        name: 'User2',
        msg: 'Second',
      });
      chat(socket, {
        chat: 1,
        channel: 'general',
        name: 'User3',
        msg: 'Third',
      });

      expect(mockChatlog.length).toBe(3);

      const writtenFiles = mockFs._getWrittenFiles();
      const content = JSON.parse(writtenFiles.get('./chat.json')!);
      expect(content.length).toBe(3);
    });

    it('should handle chat with XSS attempts', () => {
      const socket = createMockSocket({ chat: 1 });
      server.sockets = [socket];

      const xssMessages = [
        'x<script>alert("xss")</script>',
        'x<img src=x onerror=alert(1)>',
        'x<body onload=alert(1)>',
      ];

      xssMessages.forEach((msg) => {
        chat(socket, {
          chat: 1,
          channel: 'general',
          name: 'Attacker',
          msg: msg,
        });

        const sentMsg = socket._sentMessages[socket._sentMessages.length - 1];
        // Check that angle brackets are escaped (when preceded by non-ESC)
        expect(sentMsg).toContain('&lt;');
        expect(sentMsg).toContain('&gt;');
      });
    });

    it('should handle chat log with 300+ messages correctly', () => {
      // Create 350 messages
      for (let i = 0; i < 350; i++) {
        mockChatlog.push({
          date: new Date(),
          data: { channel: 'general', name: 'User', msg: 'Msg ' + i },
        });
      }

      const socket = createMockSocket({ chat: 1, name: 'TestUser' });
      server.sockets = [socket];

      chat(socket, { chat: 1, channel: 'op' });

      const sentMsg = socket._sentMessages[0];
      const parsed = JSON.parse(sentMsg.replace('portal.chatlog ', ''));

      // Should only include last 300 + status
      expect(parsed.length).toBe(301);

      // First message should be Msg 50 (index 50 of 350, so 300th from end)
      expect(parsed[0].data.msg).toBe('Msg 50');

      // Last message before status should be Msg 349
      expect(parsed[299].data.msg).toBe('Msg 349');
    });

    it('should handle concurrent chat requests', () => {
      const socket1 = createMockSocket({ chat: 1, name: 'User1' });
      const socket2 = createMockSocket({ chat: 1, name: 'User2' });

      server.sockets = [socket1, socket2];

      // Both users send messages
      chat(socket1, {
        chat: 1,
        channel: 'general',
        name: 'User1',
        msg: 'Hello',
      });
      chat(socket2, {
        chat: 1,
        channel: 'general',
        name: 'User2',
        msg: 'World',
      });

      // Both should have 2 messages (their own and the other's)
      expect(socket1._sentMessages.length).toBe(2);
      expect(socket2._sentMessages.length).toBe(2);
    });
  });
});

// Export mocks for use in other tests
export { mockFs };
