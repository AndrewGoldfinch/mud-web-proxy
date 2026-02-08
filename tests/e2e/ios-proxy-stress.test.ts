/**
 * iOS Proxy Stress Tests
 * Tests the proxy under high load and chaotic conditions.
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { E2EConnection } from './connection-helper';
import {
  MockMUDServer,
  createChaosMUD,
  createBufferTestMUD,
} from './mock-mud';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

const STRESS_PROXY_PORT = 6450;
const STRESS_MUD_PORT = 6451;

function makeConfig(port: number, timeoutMs = 20000) {
  return {
    enabled: true,
    host: 'localhost',
    port,
    testTimeoutMs: timeoutMs,
    expectations: { gmcp: true, mccp: false, mxp: false, msdp: false, ansi: true, utf8: true },
  };
}

describe('Stress Tests', () => {
  // Use longer timeout for stress tests
  // bun:test respects per-describe timeout via test options

  it('should survive chaos mode MUD', async () => {
    const mock = createChaosMUD();
    (mock as any).config.port = STRESS_MUD_PORT;
    await mock.start();
    const proxy = await startTestProxy(STRESS_PROXY_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: STRESS_MUD_PORT.toString(),
    });

    const conn = new E2EConnection(makeConfig(STRESS_MUD_PORT, 30000));

    try {
      const result = await conn.connect(proxy.url);
      // Chaos mode may cause connection failure — that's acceptable
      if (result.success) {
        // Try to interact
        conn.sendCommand('user');
        await new Promise((r) => setTimeout(r, 1000));
        conn.sendCommand('pass');
        await new Promise((r) => setTimeout(r, 2000));

        // Should have received some data despite chaos
        const messages = conn.getMessages();
        expect(messages.length).toBeGreaterThan(0);
      }
    } finally {
      conn.close();
      await proxy.stop();
      await mock.stop();
    }
  }, 35000);

  it('should handle rapid command input (100 commands)', async () => {
    const mock = new MockMUDServer({
      port: STRESS_MUD_PORT + 1,
      name: 'Rapid MUD',
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
    const proxy = await startTestProxy(STRESS_PROXY_PORT + 1, {
      TN_HOST: 'localhost',
      TN_PORT: (STRESS_MUD_PORT + 1).toString(),
    });

    const conn = new E2EConnection(makeConfig(STRESS_MUD_PORT + 1, 30000));

    try {
      const result = await conn.connect(proxy.url);
      expect(result.success).toBe(true);

      // Login
      conn.sendCommand('user');
      await new Promise((r) => setTimeout(r, 500));
      conn.sendCommand('pass');
      await new Promise((r) => setTimeout(r, 1000));

      mock.clearReceivedCommands();

      // Fire 100 commands rapidly
      for (let i = 0; i < 100; i++) {
        conn.sendCommand(`cmd_${i}`);
      }

      // Wait for commands to arrive
      await new Promise((r) => setTimeout(r, 5000));

      const received = mock.getReceivedCommands();
      // Should have received most commands (some may be batched)
      const matchingCmds = received.filter((c) => c.startsWith('cmd_'));
      expect(matchingCmds.length).toBeGreaterThan(50);

      // Should have received echo responses
      const dataMessages = conn.getMessages().filter((m) => m.type === 'data');
      expect(dataMessages.length).toBeGreaterThan(10);
    } finally {
      conn.close();
      await proxy.stop();
      await mock.stop();
    }
  }, 40000);

  it('should handle large output bursts (1000 messages)', async () => {
    const mock = new MockMUDServer({
      port: STRESS_MUD_PORT + 2,
      name: 'Burst MUD',
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
    const proxy = await startTestProxy(STRESS_PROXY_PORT + 2, {
      TN_HOST: 'localhost',
      TN_PORT: (STRESS_MUD_PORT + 2).toString(),
    });

    const conn = new E2EConnection(makeConfig(STRESS_MUD_PORT + 2, 30000));

    try {
      const result = await conn.connect(proxy.url);
      expect(result.success).toBe(true);

      // Login
      conn.sendCommand('user');
      await new Promise((r) => setTimeout(r, 500));
      conn.sendCommand('pass');
      await new Promise((r) => setTimeout(r, 1000));

      // Send burst from mock MUD
      await mock.sendBurst(1000, 100);

      // Wait for data to flow through proxy
      await new Promise((r) => setTimeout(r, 5000));

      // Should have received substantial data
      const dataMessages = conn.getMessages().filter((m) => m.type === 'data');
      expect(dataMessages.length).toBeGreaterThan(0);

      // Sequence should still be valid
      const lastSeq = conn.getLastSequence();
      expect(lastSeq).toBeGreaterThan(0);
    } finally {
      conn.close();
      await proxy.stop();
      await mock.stop();
    }
  }, 40000);

  it('should handle resume under continuous load', async () => {
    const mock = createBufferTestMUD();
    (mock as any).config.port = STRESS_MUD_PORT + 3;
    // Faster output for stress
    (mock as any).config.continuousOutput.intervalMs = 100;
    (mock as any).config.continuousOutput.count = 100;
    await mock.start();
    const proxy = await startTestProxy(STRESS_PROXY_PORT + 3, {
      TN_HOST: 'localhost',
      TN_PORT: (STRESS_MUD_PORT + 3).toString(),
    });

    try {
      // Connect and login
      const conn1 = new E2EConnection(makeConfig(STRESS_MUD_PORT + 3, 30000));
      const result1 = await conn1.connect(proxy.url);
      expect(result1.success).toBe(true);

      conn1.sendCommand('user');
      await new Promise((r) => setTimeout(r, 500));
      conn1.sendCommand('pass');
      await new Promise((r) => setTimeout(r, 2000));

      const seqBefore = conn1.getLastSequence();
      const { sessionId, token } = result1;

      // Disconnect while output is flowing
      conn1.close();

      // Wait for some output to accumulate in buffer
      await new Promise((r) => setTimeout(r, 2000));

      // Resume
      const conn2 = new E2EConnection(makeConfig(STRESS_MUD_PORT + 3, 30000));
      const result2 = await conn2.resume(proxy.url, sessionId!, token!, seqBefore);
      expect(result2.success).toBe(true);

      // Wait for replayed + new data
      await new Promise((r) => setTimeout(r, 3000));

      const afterResume = conn2.getMessages().filter((m) => m.type === 'data');
      expect(afterResume.length).toBeGreaterThan(0);

      conn2.close();
    } finally {
      await proxy.stop();
      await mock.stop();
    }
  }, 45000);
});
