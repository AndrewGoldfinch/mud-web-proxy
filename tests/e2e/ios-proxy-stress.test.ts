/**
 * iOS Proxy Stress Tests
 * Tests the proxy under high load and chaotic conditions.
 */

import { describe, it, expect } from 'bun:test';
import { E2EConnection } from './connection-helper';
import {
  MockMUDServer,
  createChaosMUD,
  createBufferTestMUD,
} from './mock-mud';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

const STRESS_PROXY_PORT = 6470;
const STRESS_MUD_PORT = 6451;

function makeConfig(port: number, timeoutMs = 20000) {
  return {
    enabled: true,
    host: 'localhost',
    port,
    testTimeoutMs: timeoutMs,
    expectations: {
      gmcp: true,
      mccp: false,
      mxp: false,
      msdp: false,
      ansi: true,
      utf8: true,
    },
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
      supports: {
        gmcp: false,
        mccp: false,
        mxp: false,
        msdp: false,
        ansi: true,
        utf8: true,
      },
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
      // This measures command throughput, not rate limiting. At the default
      // 60/s a 100-command burst has ~40 frames silently dropped and they
      // are never resent, so the test could only ever observe ~60 — close
      // enough to its own >50 threshold to pass or fail on scheduling luck.
      // Rate limiting has dedicated coverage in tests/message-rate-limit.ts.
      MAX_MESSAGES_PER_SECOND: '1000',
      MAX_MESSAGES_PER_SECOND_PER_IP: '4000',
    });

    const conn = new E2EConnection(makeConfig(STRESS_MUD_PORT + 1, 30000));

    try {
      const result = await conn.connect(proxy.url);
      expect(result.success).toBe(true);

      // Wait for the login prompt before typing. The session frame is sent
      // before the telnet socket is established, so 'user' was written with
      // nowhere to go and dropped. That shifted the whole exchange by one:
      // 'pass' became the username and cmd_0 was consumed as the password,
      // which is why cmd_0 alone never produced an echo.
      await conn.waitForMessage('data', 5000);

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

      // Poll until all 100 land rather than betting they fit in a fixed 5s.
      const deadline = Date.now() + 20000;
      while (
        Date.now() < deadline &&
        mock.getReceivedCommands().filter((c) => c.startsWith('cmd_')).length <
          100
      ) {
        await new Promise((r) => setTimeout(r, 200));
      }

      const received = mock.getReceivedCommands();
      // Every command must arrive, in order and unmerged. The previous >50
      // bar was set around the rate limiter silently dropping ~40 of them,
      // so it passed while nearly half the input was lost.
      const matchingCmds = received.filter((c) => c.startsWith('cmd_'));
      expect(matchingCmds.length).toBe(100);
      expect(matchingCmds[0]).toBe('cmd_0');
      expect(matchingCmds[99]).toBe('cmd_99');

      // The echoes must come back. Assert on content, not on how many
      // WebSocket frames they were split across: the proxy coalesces a
      // burst of MUD output, so the frame count reflects scheduling rather
      // than delivery. A >10 bar on frame count read as 5 on CI and 20+
      // locally for identical, correct behaviour.
      const echoDeadline = Date.now() + 10000;
      while (
        Date.now() < echoDeadline &&
        !conn.getDataPayloads().join('').includes('cmd_99')
      ) {
        await new Promise((r) => setTimeout(r, 200));
      }

      const echoed = conn.getDataPayloads().join('');
      expect(echoed).toContain('cmd_0');
      expect(echoed).toContain('cmd_99');
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
      supports: {
        gmcp: false,
        mccp: false,
        mxp: false,
        msdp: false,
        ansi: true,
        utf8: true,
      },
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

      // Wait for the login prompt before typing — the same defect already
      // documented for 'should handle rapid command input' above. The session
      // frame is sent before the telnet socket exists, so 'user' was written
      // with nowhere to go and dropped; 'pass' then became the username,
      // login never completed, and sendWelcome — which starts the mock's
      // continuous output — never ran. This test therefore had no continuous
      // load at all, and passed only because replay used to be inclusive and
      // returned the frame at seqBefore.
      await conn1.waitForMessage('data', 5000);

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
      const result2 = await conn2.resume(
        proxy.url,
        sessionId!,
        token!,
        seqBefore,
      );
      expect(result2.success).toBe(true);

      // Poll for data rather than sleeping a fixed interval and hoping.
      //
      // This slept 3s and then asserted at least one data frame had arrived.
      // That passed for the wrong reason: replay used to be inclusive, so the
      // frame at seqBefore came back on every resume and satisfied the count
      // even when the sleep outlasted the mock's output. With replay now
      // exclusive the assertion depends entirely on new output landing inside
      // a fixed window, which is exactly the thing a loaded CI runner breaks —
      // and did, on this PR.
      await conn2.waitForMessage('data', 10000);

      const afterResume = conn2.getMessages().filter((m) => m.type === 'data');
      expect(afterResume.length).toBeGreaterThan(0);

      conn2.close();
    } finally {
      await proxy.stop();
      await mock.stop();
    }
  }, 45000);
});
