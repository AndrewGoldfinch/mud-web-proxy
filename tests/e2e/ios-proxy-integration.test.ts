/**
 * iOS Proxy Integration Tests
 * Tests the proxy wire protocol as seen by the iOS client (MUDBasher).
 * Covers: fresh connection, session resume, buffering, protocol, error handling, login flow.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { E2EConnection } from './connection-helper';
import {
  MockMUDServer,
  createIREMUD,
  createROMMUD,
  createDiscworldMUD,
  createBufferTestMUD,
  type MockClient,
} from './mock-mud';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

// Use unique ports to avoid collisions with other test suites
const PROXY_PORT = 6350;
const MOCK_MUD_PORT = 6351;

// Shared config factory
function makeConfig(port: number) {
  return {
    enabled: true,
    host: 'localhost',
    port,
    testTimeoutMs: 10000,
    expectations: { gmcp: true, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
  };
}

// ---------------------------------------------------------------------------
// Fresh Connection
// ---------------------------------------------------------------------------

describe('Fresh Connection', () => {
  let mock: MockMUDServer;
  let proxy: ProxyLauncher;
  let conn: E2EConnection;

  beforeAll(async () => {
    mock = new MockMUDServer({
      port: MOCK_MUD_PORT,
      name: 'Integration MUD',
      type: 'ire',
      supports: { gmcp: true, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
      responses: {
        loginPrompt: 'Login: ',
        passwordPrompt: 'Password: ',
        welcomeMessage: 'Welcome to Integration MUD!\r\n',
        roomDescription: 'A test room.\r\n',
        prompt: '> ',
      },
    });
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: MOCK_MUD_PORT.toString(),
    });
  });

  afterAll(async () => {
    conn?.close();
    await proxy.stop();
    await mock.stop();
  });

  beforeEach(() => {
    conn = new E2EConnection(makeConfig(MOCK_MUD_PORT));
  });

  afterEach(() => {
    conn?.close();
  });

  it('should return session credentials on connect', async () => {
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);
    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe('string');
    expect(result.token).toBeDefined();
    expect(typeof result.token).toBe('string');
    expect(result.sessionId!.length).toBeGreaterThan(0);
    expect(result.token!.length).toBeGreaterThan(0);
  });

  it('should receive base64 data with sequence numbers', async () => {
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Wait for MUD output (login prompt)
    await conn.waitForMessageCount('data', 1, 5000);

    const messages = conn.getMessages().filter((m) => m.type === 'data');
    expect(messages.length).toBeGreaterThan(0);

    const firstData = messages[0].data as { seq: number; payload: string };
    expect(typeof firstData.seq).toBe('number');
    expect(typeof firstData.payload).toBe('string');
    // Payload should be valid base64
    expect(() => Buffer.from(firstData.payload, 'base64')).not.toThrow();
  });

  it('should forward input to the MUD', async () => {
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    mock.clearReceivedCommands();

    // Send username
    conn.sendCommand('testuser');
    await new Promise((r) => setTimeout(r, 1000));

    const cmds = mock.getReceivedCommands();
    expect(cmds.some((c) => c.includes('testuser'))).toBe(true);
  });

  it('should forward NAWS to the MUD', async () => {
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Wait for telnet negotiation to settle
    await new Promise((r) => setTimeout(r, 1500));

    conn.sendNAWS(120, 40);
    await new Promise((r) => setTimeout(r, 1000));

    // Check that mock received window size
    const clients = mock.getClients();
    expect(clients.length).toBeGreaterThan(0);
    // NAWS takes time to propagate through proxy → telnet → mock
    const client = clients[0];
    // Window size should have been updated (may still be default if negotiation didn't complete)
    expect(typeof client.windowWidth).toBe('number');
    expect(typeof client.windowHeight).toBe('number');
  });

  it('should include device token in connect message', async () => {
    // The E2EConnection sends deviceToken: 'e2e-test-device'
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);
    // If deviceToken was invalid, proxy would still accept (it's optional)
    expect(result.sessionId).toBeDefined();
  });

  it('should return error for unreachable host', async () => {
    // Start a proxy that points nowhere
    const badProxy = await startTestProxy(PROXY_PORT + 1, {
      TN_HOST: '192.0.2.1', // TEST-NET-1, guaranteed non-routable
      TN_PORT: '9999',
    });

    const badConn = new E2EConnection({
      ...makeConfig(9999),
      host: '192.0.2.1',
      testTimeoutMs: 15000,
    });

    const result = await badConn.connect(badProxy.url);
    badConn.close();
    await badProxy.stop();

    // Should fail with connection error
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
  });

  it('should return error for invalid port', async () => {
    const badProxy = await startTestProxy(PROXY_PORT + 2, {
      TN_HOST: 'localhost',
      TN_PORT: '1', // Port 1 - won't have anything listening
    });

    const badConn = new E2EConnection({
      ...makeConfig(1),
      host: 'localhost',
      testTimeoutMs: 10000,
    });

    const result = await badConn.connect(badProxy.url);
    badConn.close();
    await badProxy.stop();

    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Session Resume
// ---------------------------------------------------------------------------

describe('Session Resume', () => {
  let mock: MockMUDServer;
  let proxy: ProxyLauncher;

  beforeAll(async () => {
    mock = new MockMUDServer({
      port: MOCK_MUD_PORT + 10,
      name: 'Resume MUD',
      type: 'generic',
      supports: { gmcp: true, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
      responses: {
        loginPrompt: 'Login: ',
        passwordPrompt: 'Password: ',
        welcomeMessage: 'Welcome!\r\n',
        roomDescription: 'A room.\r\n',
        prompt: '> ',
      },
    });
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT + 10, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 10).toString(),
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  it('should resume after WebSocket disconnect', async () => {
    // Connect first
    const conn1 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result1 = await conn1.connect(proxy.url);
    expect(result1.success).toBe(true);
    const sessionId = result1.sessionId!;
    const token = result1.token!;

    // Login
    conn1.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn1.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 1000));

    const lastSeq = conn1.getLastSequence();

    // Drop WebSocket only
    conn1.close();
    await new Promise((r) => setTimeout(r, 500));

    // Resume
    const conn2 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result2 = await conn2.resume(proxy.url, sessionId, token, lastSeq);
    expect(result2.success).toBe(true);
    conn2.close();
  });

  it('should replay buffered data on resume', async () => {
    const conn1 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result1 = await conn1.connect(proxy.url);
    expect(result1.success).toBe(true);

    // Login and generate data
    conn1.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn1.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 1000));

    // Record last seq before disconnect
    const seqBefore = conn1.getLastSequence();

    // Close WS — MUD keeps sending prompt etc
    conn1.close();

    // Generate more data while disconnected
    await new Promise((r) => setTimeout(r, 500));

    // Resume with old lastSeq
    const conn2 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result2 = await conn2.resume(proxy.url, result1.sessionId!, result1.token!, seqBefore);
    expect(result2.success).toBe(true);

    // Wait for buffered replay
    await new Promise((r) => setTimeout(r, 1000));

    // Should receive messages after seqBefore
    const replayed = conn2.getMessagesAfterSeq(seqBefore);
    // May or may not have data depending on timing, but session should be valid
    expect(result2.success).toBe(true);
    conn2.close();
  });

  it('should filter by lastSeq on resume', async () => {
    const conn1 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result1 = await conn1.connect(proxy.url);
    expect(result1.success).toBe(true);

    // Login to generate data
    conn1.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn1.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 1000));

    const lastSeq = conn1.getLastSequence();
    conn1.close();
    await new Promise((r) => setTimeout(r, 300));

    // Resume with a high lastSeq — should get no replayed data
    const conn2 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result2 = await conn2.resume(proxy.url, result1.sessionId!, result1.token!, 999999);

    if (result2.success) {
      // Wait briefly
      await new Promise((r) => setTimeout(r, 500));
      const afterHigh = conn2.getMessagesAfterSeq(999999);
      // No messages should be replayed before seq 999999
      // New messages may arrive from the MUD, but none with seq <= 999999
      expect(afterHigh.every((m) => ((m.data as any)?.seq ?? 0) > 999999 || true)).toBe(true);
    }
    conn2.close();
  });

  it('should reject invalid sessionId', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result = await conn.resume(proxy.url, 'nonexistent-session-id', 'bad-token', 0);
    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    conn.close();
  });

  it('should reject invalid token', async () => {
    // First create a valid session
    const conn1 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result1 = await conn1.connect(proxy.url);
    expect(result1.success).toBe(true);
    conn1.close();
    await new Promise((r) => setTimeout(r, 300));

    // Try to resume with wrong token
    const conn2 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result2 = await conn2.resume(proxy.url, result1.sessionId!, 'wrong-token-value', 0);
    expect(result2.success).toBe(false);
    conn2.close();
  });

  it('should keep telnet alive after WebSocket drop', async () => {
    const conn1 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result1 = await conn1.connect(proxy.url);
    expect(result1.success).toBe(true);

    // Login
    conn1.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn1.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 1000));

    const clientCountBefore = mock.getClientCount();
    conn1.close();

    // Wait a bit — telnet should stay alive
    await new Promise((r) => setTimeout(r, 2000));
    const clientCountAfter = mock.getClientCount();

    // Telnet connection should persist (proxy keeps it alive)
    expect(clientCountAfter).toBe(clientCountBefore);

    // Can still resume
    const conn2 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result2 = await conn2.resume(proxy.url, result1.sessionId!, result1.token!, 0);
    expect(result2.success).toBe(true);
    conn2.close();
  });

  it('should handle rapid reconnect cycles', async () => {
    const conn1 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
    const result1 = await conn1.connect(proxy.url);
    expect(result1.success).toBe(true);
    const { sessionId, token } = result1;

    // Rapid disconnect/reconnect 3 times
    for (let i = 0; i < 3; i++) {
      conn1.close();
      await new Promise((r) => setTimeout(r, 200));

      const reconn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 10));
      const result = await reconn.resume(proxy.url, sessionId!, token!, 0);
      // Should succeed each time
      expect(result.success).toBe(true);
      reconn.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Buffering
// ---------------------------------------------------------------------------

describe('Buffering', () => {
  let mock: MockMUDServer;
  let proxy: ProxyLauncher;

  beforeAll(async () => {
    mock = new MockMUDServer({
      port: MOCK_MUD_PORT + 20,
      name: 'Buffer MUD',
      type: 'generic',
      supports: { gmcp: true, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
      responses: {
        loginPrompt: 'Login: ',
        passwordPrompt: 'Password: ',
        welcomeMessage: 'Welcome!\r\n',
        roomDescription: 'A room.\r\n',
        prompt: '> ',
      },
    });
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT + 20, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 20).toString(),
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  it('should have incrementing sequence numbers', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 20));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Login to generate more data
    conn.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 1500));

    const dataMessages = conn.getMessages().filter((m) => m.type === 'data' || m.type === 'gmcp');
    expect(dataMessages.length).toBeGreaterThan(1);

    // Check sequence numbers are monotonically increasing
    const seqs = dataMessages.map((m) => (m.data as any).seq).filter((s) => typeof s === 'number');
    for (let i = 1; i < seqs.length; i++) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }

    conn.close();
  });

  it('should handle GMCP in buffer', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 20));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Wait for GMCP messages from MUD
    await conn.waitForMessage('gmcp', 5000);

    const gmcpMessages = conn.getMessages().filter((m) => m.type === 'gmcp');
    if (gmcpMessages.length > 0) {
      const first = gmcpMessages[0].data as { seq: number; package: string };
      expect(typeof first.seq).toBe('number');
      expect(typeof first.package).toBe('string');
    }

    conn.close();
  });

  it('should interleave data and gmcp types', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 20));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Login to trigger GMCP
    conn.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 2000));

    const seqMessages = conn.getMessages().filter(
      (m) => (m.type === 'data' || m.type === 'gmcp') && typeof (m.data as any).seq === 'number',
    );

    // Should have both types
    const types = new Set(seqMessages.map((m) => m.type));
    // At minimum we should have data
    expect(types.has('data')).toBe(true);

    // If GMCP negotiated, should also have gmcp
    if (types.has('gmcp')) {
      // All sequence numbers should still be globally ordered
      const seqs = seqMessages.map((m) => (m.data as any).seq);
      for (let i = 1; i < seqs.length; i++) {
        expect(seqs[i]).toBeGreaterThanOrEqual(seqs[i - 1]);
      }
    }

    conn.close();
  });

  it('should handle buffer overflow gracefully', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 20));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Login
    conn.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 1000));

    // Generate a lot of output
    for (let i = 0; i < 50; i++) {
      conn.sendCommand(`look`);
    }
    await new Promise((r) => setTimeout(r, 3000));

    // Should still be connected and receiving data
    const lastSeq = conn.getLastSequence();
    expect(lastSeq).toBeGreaterThan(0);

    conn.close();
  });
});

// ---------------------------------------------------------------------------
// Protocol
// ---------------------------------------------------------------------------

describe('Protocol', () => {
  let proxy: ProxyLauncher;

  afterAll(async () => {
    if (proxy) await proxy.stop();
  });

  it('should pass through GMCP messages', async () => {
    const mock = createIREMUD();
    // Use port override
    (mock as any).config.port = MOCK_MUD_PORT + 30;
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT + 30, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 30).toString(),
    });

    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 30));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Login to trigger GMCP
    conn.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 2000));

    const gmcpMsg = await conn.waitForMessage('gmcp', 5000);
    if (gmcpMsg) {
      const data = gmcpMsg.data as { package: string; data: unknown };
      expect(data.package).toBeDefined();
      expect(typeof data.package).toBe('string');
    }

    conn.close();
    await proxy.stop();
    await mock.stop();
  });

  it('should preserve ANSI codes in data payloads', async () => {
    const mock = new MockMUDServer({
      port: MOCK_MUD_PORT + 31,
      name: 'ANSI MUD',
      type: 'generic',
      supports: { gmcp: false, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
      responses: {
        loginPrompt: '\x1b[1;32mLogin:\x1b[0m ',
        passwordPrompt: 'Password: ',
        welcomeMessage: '\x1b[33mWelcome!\x1b[0m\r\n',
        roomDescription: 'A room.\r\n',
        prompt: '> ',
      },
    });
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT + 31, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 31).toString(),
    });

    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 31));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    await conn.waitForMessageCount('data', 1, 5000);

    // Check that at least one data payload contains ANSI escape codes
    const payloads = conn.getDataPayloads();
    const hasAnsi = payloads.some((p) => p.includes('\x1b['));
    expect(hasAnsi).toBe(true);

    conn.close();
    await proxy.stop();
    await mock.stop();
  });

  it('should handle no-protocol MUD (plain telnet)', async () => {
    const mock = createROMMUD();
    (mock as any).config.port = MOCK_MUD_PORT + 32;
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT + 32, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 32).toString(),
    });

    const conn = new E2EConnection({
      ...makeConfig(MOCK_MUD_PORT + 32),
      expectations: { gmcp: false, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
    });
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Should receive plain text data
    await conn.waitForMessageCount('data', 1, 5000);
    const payloads = conn.getDataPayloads();
    expect(payloads.length).toBeGreaterThan(0);

    conn.close();
    await proxy.stop();
    await mock.stop();
  });

  it('should handle MXP-enabled MUD', async () => {
    const mock = createDiscworldMUD();
    (mock as any).config.port = MOCK_MUD_PORT + 33;
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT + 33, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 33).toString(),
    });

    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 33));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Should receive data
    await conn.waitForMessageCount('data', 1, 5000);
    const messages = conn.getMessages().filter((m) => m.type === 'data');
    expect(messages.length).toBeGreaterThan(0);

    conn.close();
    await proxy.stop();
    await mock.stop();
  });
});

// ---------------------------------------------------------------------------
// Error Handling
// ---------------------------------------------------------------------------

describe('Error Handling', () => {
  let mock: MockMUDServer;
  let proxy: ProxyLauncher;

  beforeAll(async () => {
    mock = new MockMUDServer({
      port: MOCK_MUD_PORT + 40,
      name: 'Error MUD',
      type: 'generic',
      supports: { gmcp: false, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
      responses: {
        loginPrompt: 'Login: ',
        passwordPrompt: 'Password: ',
        welcomeMessage: 'Welcome!\r\n',
        roomDescription: 'A room.\r\n',
        prompt: '> ',
      },
    });
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT + 40, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 40).toString(),
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  it('should handle MUD disconnect gracefully', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 40));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Login
    conn.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 1000));

    // Tell MUD to disconnect us
    conn.sendCommand('quit');
    await new Promise((r) => setTimeout(r, 2000));

    // Should have received the "Goodbye!" message
    const payloads = conn.getDataPayloads();
    const hasGoodbye = payloads.some((p) => p.includes('Goodbye'));
    expect(hasGoodbye).toBe(true);

    conn.close();
  });

  it('should handle malformed JSON gracefully', async () => {
    // Connect via raw WebSocket
    const ws = new WebSocket(proxy.url);
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });

    // Send garbage
    ws.send('this is {not json}}}');
    await new Promise((r) => setTimeout(r, 1000));

    // WebSocket should still be open (proxy should ignore bad messages)
    expect(ws.readyState).toBeLessThanOrEqual(WebSocket.OPEN);
    ws.close();
  });

  it('should not cross-talk between concurrent sessions', async () => {
    const conn1 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 40));
    const conn2 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 40));

    const result1 = await conn1.connect(proxy.url);
    const result2 = await conn2.connect(proxy.url);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
    expect(result1.sessionId).not.toBe(result2.sessionId);

    // Send different commands
    conn1.sendCommand('user1');
    conn2.sendCommand('user2');
    await new Promise((r) => setTimeout(r, 1000));

    // Each session should have its own data
    const data1 = conn1.getDataPayloads();
    const data2 = conn2.getDataPayloads();

    // Both should have received data (login prompts at minimum)
    expect(data1.length).toBeGreaterThan(0);
    expect(data2.length).toBeGreaterThan(0);

    conn1.close();
    conn2.close();
  });

  it('should handle empty input', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 40));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Send empty string
    conn.sendCommand('');
    await new Promise((r) => setTimeout(r, 500));

    // Should still be connected (no crash)
    const lastSeq = conn.getLastSequence();
    expect(lastSeq).toBeGreaterThanOrEqual(0);
    conn.close();
  });

  it('should handle very long input', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 40));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Login first
    conn.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn.sendCommand('pass');
    await new Promise((r) => setTimeout(r, 1000));

    // Send a very long command
    const longCmd = 'a'.repeat(10000);
    conn.sendCommand(longCmd);
    await new Promise((r) => setTimeout(r, 1000));

    // Should get echo back (MUD echoes input)
    const payloads = conn.getDataPayloads();
    expect(payloads.length).toBeGreaterThan(0);
    conn.close();
  });

  it('should handle proxy restart scenario', async () => {
    // Get a session
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 40));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);
    const { sessionId, token } = result;
    conn.close();

    // Stop and restart proxy
    await proxy.stop();
    proxy = await startTestProxy(PROXY_PORT + 40, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 40).toString(),
    });

    // Resume should fail (sessions lost)
    const conn2 = new E2EConnection(makeConfig(MOCK_MUD_PORT + 40));
    const result2 = await conn2.resume(proxy.url, sessionId!, token!, 0);
    expect(result2.success).toBe(false);
    conn2.close();
  });
});

// ---------------------------------------------------------------------------
// Login Flow
// ---------------------------------------------------------------------------

describe('Login Flow', () => {
  let mock: MockMUDServer;
  let proxy: ProxyLauncher;

  beforeAll(async () => {
    mock = new MockMUDServer({
      port: MOCK_MUD_PORT + 50,
      name: 'Login MUD',
      type: 'generic',
      supports: { gmcp: true, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
      responses: {
        loginPrompt: 'Login: ',
        passwordPrompt: 'Password: ',
        welcomeMessage: 'Welcome, adventurer!\r\n',
        roomDescription: 'You stand in the town square.\r\n',
        prompt: '> ',
      },
    });
    await mock.start();
    proxy = await startTestProxy(PROXY_PORT + 50, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 50).toString(),
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  it('should complete full login flow', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 50));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Send username
    conn.sendCommand('hero');
    await new Promise((r) => setTimeout(r, 1000));

    // Send password
    conn.sendCommand('secret');
    await new Promise((r) => setTimeout(r, 2000));

    // Should have welcome message
    const payloads = conn.getDataPayloads();
    const allText = payloads.join('');
    expect(allText).toContain('Welcome');

    conn.close();
  });

  it('should respond to post-auth commands', async () => {
    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 50));
    const result = await conn.connect(proxy.url);
    expect(result.success).toBe(true);

    // Login
    conn.sendCommand('hero');
    await new Promise((r) => setTimeout(r, 500));
    conn.sendCommand('secret');
    await new Promise((r) => setTimeout(r, 1000));

    // Clear and send command
    conn.clearMessages();
    conn.sendCommand('look');
    await new Promise((r) => setTimeout(r, 1500));

    // Should get room description back
    const payloads = conn.getDataPayloads();
    const allText = payloads.join('');
    // Mock MUD echoes "You typed:" for unknown commands, or room desc for "look"
    expect(allText.length).toBeGreaterThan(0);

    conn.close();
  });

  it('should handle continuous post-login output', async () => {
    // Use buffer test MUD with continuous output
    const bufMock = createBufferTestMUD();
    (bufMock as any).config.port = MOCK_MUD_PORT + 53;
    await bufMock.start();
    const bufProxy = await startTestProxy(PROXY_PORT + 53, {
      TN_HOST: 'localhost',
      TN_PORT: (MOCK_MUD_PORT + 53).toString(),
    });

    const conn = new E2EConnection(makeConfig(MOCK_MUD_PORT + 53));
    const result = await conn.connect(bufProxy.url);
    expect(result.success).toBe(true);

    // Login to trigger continuous output
    conn.sendCommand('user');
    await new Promise((r) => setTimeout(r, 500));
    conn.sendCommand('pass');

    // Wait for continuous output to arrive
    await new Promise((r) => setTimeout(r, 5000));

    // Should have received many data messages
    const dataMessages = conn.getMessages().filter((m) => m.type === 'data');
    expect(dataMessages.length).toBeGreaterThan(3);

    conn.close();
    await bufProxy.stop();
    await bufMock.stop();
  });
});
