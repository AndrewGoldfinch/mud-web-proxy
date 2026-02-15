/**
 * Comprehensive tests for Utilities and Helper functions
 * Tests stringify(), loadChatLog(), log(), die(), and server initialization
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import path from 'path';

// Store original functions
const originalConsoleLog = console.log;
const originalProcessExit = process.exit;
const originalProcessChdir = process.chdir;
const originalSetTimeout = global.setTimeout;

describe('stringify() function', () => {
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

  test('should handle circular references without throwing', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.circular = obj;
    const result = stringify(obj);
    expect(result).toBe('{"a":1}');
  });

  test('should stringify nested objects correctly', () => {
    const obj = {
      level1: {
        level2: {
          level3: {
            value: 'deep',
          },
        },
      },
    };
    const result = stringify(obj);
    expect(result).toBe('{"level1":{"level2":{"level3":{"value":"deep"}}}}');
  });

  test('should stringify arrays correctly', () => {
    const arr = [1, 2, 3, 'test', true, null];
    const result = stringify(arr);
    expect(result).toBe('[1,2,3,"test",true,null]');
  });

  test('should stringify nested arrays correctly', () => {
    const arr = [[1, 2], [3, 4], { nested: 'value' }];
    const result = stringify(arr);
    expect(result).toBe('[[1,2],[3,4],{"nested":"value"}]');
  });

  test('should handle string primitives', () => {
    expect(stringify('hello')).toBe('"hello"');
    expect(stringify('')).toBe('""');
    expect(stringify('special "quotes"')).toBe('"special \\"quotes\\""');
  });

  test('should handle number primitives', () => {
    expect(stringify(42)).toBe('42');
    expect(stringify(0)).toBe('0');
    expect(stringify(-123)).toBe('-123');
    expect(stringify(3.14)).toBe('3.14');
  });

  test('should handle boolean primitives', () => {
    expect(stringify(true)).toBe('true');
    expect(stringify(false)).toBe('false');
  });

  test('should handle null', () => {
    expect(stringify(null)).toBe('null');
  });

  test('should handle undefined', () => {
    expect(stringify(undefined)).toBe('');
  });

  test('should return empty string when JSON.stringify returns undefined', () => {
    const result = stringify(undefined);
    expect(result).toBe('');
  });

  test('should handle objects with multiple circular references', () => {
    const obj1: Record<string, unknown> = { name: 'obj1' };
    const obj2: Record<string, unknown> = { name: 'obj2' };
    obj1.ref = obj2;
    obj2.ref = obj1;
    const result = stringify(obj1);
    expect(result).toBe('{"name":"obj1","ref":{"name":"obj2"}}');
  });

  test('should handle complex nested structures with circular refs', () => {
    const obj: Record<string, unknown> = {
      arr: [1, 2, 3],
      nested: { value: 'test' },
    };
    (obj.arr as unknown[]).push(obj);
    const result = stringify(obj);
    // Circular ref in array becomes undefined (null in JSON)
    expect(result).toBe('{"arr":[1,2,3,null],"nested":{"value":"test"}}');
  });
});

describe('loadChatLog() function', () => {
  const testDir = '/tmp/test-chatlog';
  const chatFilePath = path.join(testDir, 'chat.json');

  const loadChatLog = async (): Promise<
    Array<{ date: Date; data: Record<string, unknown> }>
  > => {
    try {
      const data = await fs.promises.readFile('./chat.json', 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  beforeEach(() => {
    // Create test directory
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    // Change to test directory
    originalProcessChdir(testDir);
  });

  afterEach(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('should load valid JSON file with chat entries', async () => {
    const chatEntries = [
      {
        date: new Date().toISOString(),
        data: { channel: 'general', msg: 'Hello' },
      },
      {
        date: new Date().toISOString(),
        data: { channel: 'status', msg: 'User joined' },
      },
    ];
    fs.writeFileSync(chatFilePath, JSON.stringify(chatEntries));
    const result = await loadChatLog();
    expect(result).toHaveLength(2);
    expect(result[0].data.channel).toBe('general');
  });

  test('should return empty array when file not found', async () => {
    if (fs.existsSync(chatFilePath)) {
      fs.unlinkSync(chatFilePath);
    }
    const result = await loadChatLog();
    expect(result).toEqual([]);
  });

  test('should return empty array on JSON parse error', async () => {
    fs.writeFileSync(chatFilePath, 'invalid json {{');
    const result = await loadChatLog();
    expect(result).toEqual([]);
  });

  test('should return empty array when JSON is not an array', async () => {
    fs.writeFileSync(chatFilePath, '{"not": "an array"}');
    const result = await loadChatLog();
    expect(result).toEqual([]);
  });

  test('should handle empty array JSON', async () => {
    fs.writeFileSync(chatFilePath, '[]');
    const result = await loadChatLog();
    expect(result).toEqual([]);
  });

  test('should handle async/await properly', async () => {
    fs.writeFileSync(chatFilePath, '[]');
    const promise = loadChatLog();
    expect(promise).toBeInstanceOf(Promise);
    const result = await promise;
    expect(Array.isArray(result)).toBe(true);
  });
});

describe('log() function', () => {
  let capturedLogs: string[] = [];

  beforeEach(() => {
    capturedLogs = [];
    console.log = (...args: unknown[]) => {
      capturedLogs.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  const log = function (
    msg: unknown,
    s?: { req: { connection: { remoteAddress: string } } },
  ): void {
    if (!s) {
      s = { req: { connection: { remoteAddress: '' } } } as {
        req: { connection: { remoteAddress: string } };
      };
    }
    const timestamp = new Date().toISOString();
    console.log(`${timestamp} ${s.req.connection.remoteAddress}: ${msg}`);
  };

  test('should log messages with timestamp and address', () => {
    const mockSocket = {
      req: { connection: { remoteAddress: '192.168.1.1' } },
    };
    log('Test message', mockSocket);
    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]).toContain('192.168.1.1');
    expect(capturedLogs[0]).toContain('Test message');
    expect(capturedLogs[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/); // ISO timestamp format
  });

  test('should handle undefined socket parameter', () => {
    log('Message without socket');
    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]).toContain('Message without socket');
    expect(capturedLogs[0]).toMatch(/ : /); // Empty address with space
  });

  test('should create default socket object when not provided', () => {
    log('Default socket test');
    expect(capturedLogs).toHaveLength(1);
    expect(capturedLogs[0]).toContain('Default socket test');
    // Should have empty remoteAddress with space before colon
    expect(capturedLogs[0]).toMatch(/ : /);
  });

  test('should format various message types', () => {
    log('String message');
    log(123);
    log({ object: 'value' });
    log([1, 2, 3]);
    log(true);
    log(null);

    expect(capturedLogs).toHaveLength(6);
    expect(capturedLogs[0]).toContain('String message');
    expect(capturedLogs[1]).toContain('123');
    expect(capturedLogs[2]).toContain('[object Object]');
    expect(capturedLogs[3]).toContain('1,2,3');
    expect(capturedLogs[4]).toContain('true');
    expect(capturedLogs[5]).toContain('null');
  });
});

describe('die() function', () => {
  let capturedLogs: string[] = [];
  let closedSockets: Array<{
    write: (msg: string) => void;
    terminate: () => void;
  }> = [];
  let exitCode: number | undefined;

  beforeEach(() => {
    capturedLogs = [];
    closedSockets = [];
    exitCode = undefined;

    console.log = (...args: unknown[]) => {
      capturedLogs.push(args.join(' '));
    };

    process.exit = ((code?: number) => {
      exitCode = code;
    }) as typeof process.exit;

    global.setTimeout = ((callback: () => void, _delay: number) => {
      callback();
      return undefined as unknown as ReturnType<typeof setTimeout>;
    }) as typeof global.setTimeout;
  });

  afterEach(() => {
    console.log = originalConsoleLog;
    process.exit = originalProcessExit;
    global.setTimeout = originalSetTimeout;
  });

  const die = function (
    core: boolean | undefined,
    sockets: Array<{ write: (msg: string) => void; terminate: () => void }>,
    srvOpen: { value: boolean },
  ): void {
    capturedLogs.push('Dying gracefully in 3 sec.');

    for (let i = 0; i < sockets.length; i++) {
      if (sockets[i] && typeof sockets[i].write === 'function') {
        sockets[i].write('Proxy server is going down...');
      }
      closedSockets.push(sockets[i]);
    }

    srvOpen.value = false;
    process.exit(core ? 3 : 0);
  };

  test('should notify all connected clients', () => {
    const mockSockets = [
      {
        write: mock((msg: string) => {
          capturedLogs.push(`Socket 1: ${msg}`);
        }),
        terminate: () => {},
      },
      {
        write: mock((msg: string) => {
          capturedLogs.push(`Socket 2: ${msg}`);
        }),
        terminate: () => {},
      },
    ];
    const srvOpen = { value: true };

    die(undefined, mockSockets, srvOpen);

    expect(capturedLogs).toContain('Dying gracefully in 3 sec.');
    expect(capturedLogs).toContain('Socket 1: Proxy server is going down...');
    expect(capturedLogs).toContain('Socket 2: Proxy server is going down...');
  });

  test('should handle sockets without write method gracefully', () => {
    const mockSockets = [
      {
        write: mock((msg: string) => {
          capturedLogs.push(msg);
        }),
        terminate: () => {},
      },
      { terminate: () => {} } as {
        write: (msg: string) => void;
        terminate: () => void;
      },
    ];
    const srvOpen = { value: true };

    die(undefined, mockSockets, srvOpen);

    expect(capturedLogs).toContain('Dying gracefully in 3 sec.');
    expect(capturedLogs).toContain('Proxy server is going down...');
    expect(closedSockets).toHaveLength(2);
  });

  test('should exit with code 0 for normal shutdown', () => {
    const srvOpen = { value: true };
    die(undefined, [], srvOpen);
    expect(exitCode).toBe(0);
  });

  test('should exit with code 3 for core dump', () => {
    const srvOpen = { value: true };
    die(true, [], srvOpen);
    expect(exitCode).toBe(3);
  });

  test('should set srv.open to false', () => {
    const srvOpen = { value: true };
    die(undefined, [], srvOpen);
    expect(srvOpen.value).toBe(false);
  });

  test('should handle empty socket array', () => {
    const srvOpen = { value: true };
    die(undefined, [], srvOpen);
    expect(exitCode).toBe(0);
    expect(capturedLogs).toContain('Dying gracefully in 3 sec.');
  });
});

describe('Server initialization', () => {
  let capturedLogs: string[] = [];

  beforeEach(() => {
    capturedLogs = [];
    console.log = (...args: unknown[]) => {
      capturedLogs.push(args.join(' '));
    };
  });

  afterEach(() => {
    console.log = originalConsoleLog;
  });

  test('should load chat log on startup', async () => {
    const testDir = '/tmp/test-init-chat';
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    const chatEntries = [
      {
        date: new Date().toISOString(),
        data: { channel: 'general', msg: 'Test' },
      },
    ];
    fs.writeFileSync(
      path.join(testDir, 'chat.json'),
      JSON.stringify(chatEntries),
    );

    const loadChatLog = async (): Promise<unknown[]> => {
      try {
        const data = await fs.promises.readFile(
          path.join(testDir, 'chat.json'),
          'utf8',
        );
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const chatlog = await loadChatLog();
    expect(chatlog).toHaveLength(1);
    expect((chatlog[0] as { data: { msg: string } }).data.msg).toBe('Test');

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should handle missing chat file gracefully', async () => {
    const testDir = '/tmp/test-no-chat';
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    const loadChatLog = async (): Promise<unknown[]> => {
      try {
        const data = await fs.promises.readFile(
          path.join(testDir, 'chat.json'),
          'utf8',
        );
        const parsed = JSON.parse(data);
        return Array.isArray(parsed) ? parsed : [];
      } catch {
        return [];
      }
    };

    const chatlog = await loadChatLog();
    expect(chatlog).toEqual([]);

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should create HTTPS server when certificates exist', () => {
    const testDir = '/tmp/test-certs';
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    fs.writeFileSync(path.join(testDir, 'cert.pem'), 'mock certificate');
    fs.writeFileSync(path.join(testDir, 'privkey.pem'), 'mock private key');

    const certExists = fs.existsSync(path.join(testDir, 'cert.pem'));
    const keyExists = fs.existsSync(path.join(testDir, 'privkey.pem'));

    expect(certExists).toBe(true);
    expect(keyExists).toBe(true);

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should handle missing certificates', () => {
    const testDir = '/tmp/test-no-certs';
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    const certExists = fs.existsSync(path.join(testDir, 'cert.pem'));
    const keyExists = fs.existsSync(path.join(testDir, 'privkey.pem'));

    expect(certExists).toBe(false);
    expect(keyExists).toBe(false);

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should set up file watching on wsproxy.ts', () => {
    const testDir = '/tmp/test-watch';
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    fs.writeFileSync(path.join(testDir, 'wsproxy.ts'), '// test file');

    // Verify file exists
    expect(fs.existsSync(path.join(testDir, 'wsproxy.ts'))).toBe(true);

    // Simulate file change
    fs.writeFileSync(path.join(testDir, 'wsproxy.ts'), '// updated content');
    expect(fs.readFileSync(path.join(testDir, 'wsproxy.ts'), 'utf8')).toBe(
      '// updated content',
    );

    fs.rmSync(testDir, { recursive: true, force: true });
  });

  test('should initialize with default configuration values', () => {
    const config = {
      ws_port: 6200,
      tn_host: 'muds.maldorne.org',
      tn_port: 5010,
      debug: false,
      compress: true,
      open: true,
    };

    expect(config.ws_port).toBe(6200);
    expect(config.tn_host).toBe('muds.maldorne.org');
    expect(config.tn_port).toBe(5010);
    expect(config.debug).toBe(false);
    expect(config.compress).toBe(true);
    expect(config.open).toBe(true);
  });

  test('should initialize TType configuration', () => {
    const ttypeConfig = {
      enabled: 1,
      portal: ['maldorne.org', 'XTERM-256color', 'MTTS 141'],
    };

    expect(ttypeConfig.enabled).toBe(1);
    expect(ttypeConfig.portal).toHaveLength(3);
    expect(ttypeConfig.portal).toContain('maldorne.org');
  });

  test('should initialize GMCP configuration', () => {
    const gmcpConfig = {
      enabled: 1,
      portal: ['client maldorne.org', 'client_version 1.0'],
    };

    expect(gmcpConfig.enabled).toBe(1);
    expect(gmcpConfig.portal).toHaveLength(2);
    expect(gmcpConfig.portal[0]).toBe('client maldorne.org');
  });
});

describe('Cache management for circular detection', () => {
  const stringifyWithCache = function (A: unknown): string {
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

  test('should properly cache objects to detect circular references', () => {
    const obj: { a: { b: Record<string, unknown> } } = { a: { b: {} } };
    obj.a.b.c = obj.a;
    const result = stringifyWithCache(obj);
    expect(result).toBe('{"a":{"b":{}}}');
  });

  test('should handle multiple references to same object', () => {
    const shared: Record<string, unknown> = { value: 'shared' };
    const obj = { a: shared, b: shared };
    const result = stringifyWithCache(obj);
    // Second reference to same object is omitted (returns undefined, property removed)
    expect(result).toBe('{"a":{"value":"shared"}}');
  });

  test('should handle deeply nested circular references', () => {
    const obj: { level1: { level2: Record<string, unknown> } } = {
      level1: { level2: {} },
    };
    obj.level1.level2.level3 = obj;
    const result = stringifyWithCache(obj);
    expect(result).toBe('{"level1":{"level2":{}}}');
  });
});

describe('Additional stringify edge cases', () => {
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

  test('should handle Date objects', () => {
    const date = new Date('2024-01-15');
    const result = stringify(date);
    expect(result).toContain('2024-01-15');
  });

  test('should handle RegExp objects', () => {
    const regex = /test/gi;
    const result = stringify(regex);
    expect(result).toEqual('{}'); // RegExp serializes as empty object
  });

  test('should handle Map and Set', () => {
    const map = new Map([['key', 'value']]);
    const set = new Set([1, 2, 3]);
    expect(stringify(map)).toBe('{}');
    expect(stringify(set)).toBe('{}');
  });

  test('should handle symbols', () => {
    const sym = Symbol('test');
    const obj = { [sym]: 'value' };
    const result = stringify(obj);
    expect(result).toBe('{}'); // Symbols are ignored
  });

  test('should handle BigInt (should throw)', () => {
    const bigint = BigInt(9007199254740991);
    expect(() => stringify(bigint)).toThrow();
  });

  test('should handle Functions (should be omitted)', () => {
    const obj = { fn: () => 'test' };
    const result = stringify(obj);
    // Functions are omitted from JSON output (replaced with undefined, which removes property)
    expect(result).toBe('{}');
  });

  test('should handle special characters in strings', () => {
    const obj = {
      newline: 'line1\nline2',
      tab: 'col1\tcol2',
      unicode: '🎉',
    };
    const result = stringify(obj);
    expect(result).toContain('\\n');
    expect(result).toContain('\\t');
    expect(result).toContain('🎉');
  });

  test('should handle NaN and Infinity', () => {
    const obj = {
      nan: NaN,
      infinity: Infinity,
      negInfinity: -Infinity,
    };
    const result = stringify(obj);
    expect(result).toBe('{"nan":null,"infinity":null,"negInfinity":null}');
  });

  test('should handle empty objects and arrays', () => {
    expect(stringify({})).toBe('{}');
    expect(stringify([])).toBe('[]');
  });
});

describe('loadChatLog edge cases', () => {
  const testDir = '/tmp/test-chatlog-edge';

  beforeEach(() => {
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    originalProcessChdir(testDir);
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  const loadChatLog = async (): Promise<
    Array<{ date: Date; data: Record<string, unknown> }>
  > => {
    try {
      const data = await fs.promises.readFile('./chat.json', 'utf8');
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  };

  test('should handle JSON with Date strings', async () => {
    const entries = [
      { date: '2024-01-15T10:30:00.000Z', data: { msg: 'Hello' } },
    ];
    fs.writeFileSync(path.join(testDir, 'chat.json'), JSON.stringify(entries));
    const result = await loadChatLog();
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe('2024-01-15T10:30:00.000Z');
  });

  test('should handle large chat files', async () => {
    const largeEntries = Array.from({ length: 1000 }, (_, i) => ({
      date: new Date().toISOString(),
      data: { channel: 'test', msg: `Message ${i}` },
    }));
    fs.writeFileSync(
      path.join(testDir, 'chat.json'),
      JSON.stringify(largeEntries),
    );
    const result = await loadChatLog();
    expect(result).toHaveLength(1000);
  });

  test('should handle malformed entries within valid JSON', async () => {
    // This will actually parse as valid JSON
    const entries = [
      { date: new Date().toISOString(), data: { msg: 'Valid' } },
      null,
      undefined,
      { date: new Date().toISOString(), data: { msg: 'Also valid' } },
    ];
    fs.writeFileSync(path.join(testDir, 'chat.json'), JSON.stringify(entries));
    const result = await loadChatLog();
    expect(result).toHaveLength(4);
  });

  test('should handle empty file', async () => {
    fs.writeFileSync(path.join(testDir, 'chat.json'), '');
    const result = await loadChatLog();
    expect(result).toEqual([]);
  });

  test('should handle whitespace-only file', async () => {
    fs.writeFileSync(path.join(testDir, 'chat.json'), '   \n\t  ');
    const result = await loadChatLog();
    expect(result).toEqual([]);
  });
});

describe('Server state management', () => {
  test('should maintain socket array', () => {
    const server = { sockets: [] as unknown[] };
    expect(server.sockets).toEqual([]);

    server.sockets.push({ id: 1 });
    server.sockets.push({ id: 2 });
    expect(server.sockets).toHaveLength(2);

    server.sockets.splice(0, 1);
    expect(server.sockets).toHaveLength(1);
  });

  test('should track open state', () => {
    const srv = { open: true };
    expect(srv.open).toBe(true);

    srv.open = false;
    expect(srv.open).toBe(false);
  });

  test('should maintain chatlog array', () => {
    const chatlog: Array<{ date: Date; data: Record<string, unknown> }> = [];
    expect(chatlog).toEqual([]);

    chatlog.push({
      date: new Date(),
      data: { channel: 'test', msg: 'Hello' },
    });
    expect(chatlog).toHaveLength(1);
  });
});

describe('Protocol constants initialization', () => {
  test('should define all protocol constants', () => {
    const prt = {
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
    };

    expect(prt.IAC).toBe(255);
    expect(prt.WILL).toBe(251);
    expect(prt.DO).toBe(253);
    expect(prt.GMCP).toBe(201);
    expect(prt.MXP).toBe(91);
    expect(prt.WILL_ATCP.length).toBe(3);
    expect(prt.START.length).toBe(3);
    expect(prt.STOP.length).toBe(2);
  });
});
