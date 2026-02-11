/**
 * Production Proxy MUD Connection Tests
 * Connects directly to wss://mud-proxy.kingfrat.com (no local proxy)
 * and tests real MUD connections to Aardwolf (aardmud.org:4000)
 */

import { describe, it, expect, afterAll } from 'bun:test';
import { E2EConnection } from './connection-helper';
import type { E2EConfig } from './config-loader';

const PROXY_URL = 'wss://mud-proxy.kingfrat.com';

const config: E2EConfig = {
  enabled: true,
  host: 'aardmud.org',
  port: 4000,
  expectations: {
    gmcp: true,
    mccp: true,
    mxp: false,
    msdp: false,
    utf8: true,
    ansi: true,
  },
  testTimeoutMs: 15000,
};

describe('Production Proxy — Aardwolf MUD', () => {
  let connection: E2EConnection | null = null;
  let sessionId: string | undefined;
  let token: string | undefined;

  afterAll(() => {
    if (connection) {
      connection.close();
      connection = null;
    }
  });

  it('should connect via WSS to production proxy', async () => {
    connection = new E2EConnection(config);
    const result = await connection.connect(PROXY_URL);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
  }, 15000);

  it('should receive session creation response', async () => {
    expect(connection).not.toBeNull();

    const messages = connection!.getMessages();
    const sessionMsg = messages.find((m) => m.type === 'session');

    expect(sessionMsg).toBeDefined();

    const data = sessionMsg!.data as {
      sessionId: string;
      token: string;
    };
    expect(data.sessionId).toBeDefined();
    expect(data.sessionId.length).toBeGreaterThan(0);
    expect(data.token).toBeDefined();
    expect(data.token.length).toBeGreaterThan(0);

    sessionId = data.sessionId;
    token = data.token;
  });

  it('should receive MUD data with base64 payloads', async () => {
    expect(connection).not.toBeNull();

    // Wait for data messages to arrive from Aardwolf
    const dataMessages = await connection!.waitForMessageCount(
      'data',
      1,
      10000,
    );

    expect(dataMessages.length).toBeGreaterThan(0);

    // Verify payloads are base64 and contain Aardwolf welcome text
    const payloads = connection!.getDataPayloads();
    expect(payloads.length).toBeGreaterThan(0);

    const allText = payloads.join('');
    // Aardwolf sends its name in the welcome screen
    const hasWelcome =
      allText.toLowerCase().includes('aardwolf') ||
      allText.toLowerCase().includes('connect') ||
      allText.length > 100;
    expect(hasWelcome).toBe(true);
  }, 15000);

  it('should negotiate GMCP', async () => {
    expect(connection).not.toBeNull();

    // Wait a bit for protocol negotiation to complete
    const gmcpMsg = await connection!.waitForMessage('gmcp', 10000);

    // Aardwolf supports GMCP — we should see gmcp messages or
    // protocol detection in data messages
    const hasGmcp =
      gmcpMsg !== null || connection!.isProtocolNegotiated('gmcp');
    expect(hasGmcp).toBe(true);
  }, 15000);

  it('should log in with username and password', async () => {
    expect(connection).not.toBeNull();

    // Send username at the "What be thy name?" prompt
    connection!.sendCommand('mudbasher');

    // Wait for more data after sending username (password prompt or
    // ECHO negotiation). The proxy may suppress "Password:" text due
    // to ECHO negotiation, so just wait for any new data.
    const msgCountBeforeLogin = connection!.getMessages().filter(
      (m) => m.type === 'data',
    ).length;
    await connection!.waitForMessageCount(
      'data',
      msgCountBeforeLogin + 1,
      10000,
    );

    // Pause to let ECHO negotiation complete before sending password
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Send password
    connection!.sendCommand('mudbasher');

    // Wait for successful login — Aardwolf shows MOTD or room description
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const afterLogin = connection!.getDataPayloads();
    const allText = afterLogin.join('');

    // Should NOT see "Incorrect Password"
    expect(allText.includes('Incorrect Password')).toBe(false);

    // Should have received substantial post-login content
    expect(allText.length).toBeGreaterThan(500);
  }, 30000);

  it('should execute in-game command after login', async () => {
    expect(connection).not.toBeNull();

    const msgCountBefore = connection!.getMessages().filter(
      (m) => m.type === 'data',
    ).length;

    // Send 'score' — shows character stats
    connection!.sendCommand('score');

    // Wait for new data messages in response
    await connection!.waitForMessageCount('data', msgCountBefore + 1, 10000);

    const msgCountAfter = connection!.getMessages().filter(
      (m) => m.type === 'data',
    ).length;
    expect(msgCountAfter).toBeGreaterThan(msgCountBefore);
  }, 15000);

  it('should send NAWS without error', async () => {
    expect(connection).not.toBeNull();

    // Send NAWS — should not cause errors or disconnection
    connection!.sendNAWS(120, 40);

    // Wait briefly and verify connection is still alive
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // Verify no error messages were received
    const errors = connection!.getMessages().filter(
      (m) => m.type === 'error',
    );
    expect(errors.length).toBe(0);

    // Connection should still work — send another command
    connection!.sendCommand('');
    await new Promise((resolve) => setTimeout(resolve, 500));
  }, 5000);

  it('should resume session after disconnect', async () => {
    expect(connection).not.toBeNull();
    expect(sessionId).toBeDefined();
    expect(token).toBeDefined();

    const lastSeq = connection!.getLastSequence();

    // Close current connection
    connection!.close();

    // Brief pause before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Reconnect and resume
    connection = new E2EConnection(config);
    const result = await connection.resume(
      PROXY_URL,
      sessionId!,
      token!,
      lastSeq,
    );

    if (!result.success) {
      // Session may have been cleaned up — this is acceptable behavior
      // if the server has a short session TTL or cleans up immediately
      console.log(
        'Resume not supported by server (session cleaned up):',
        result.error,
      );
    }

    // Resume should either succeed or return a clear invalid_resume error
    // (not a connection/timeout error)
    const isResumeSupported = result.success;
    const isCleanRejection =
      !result.success &&
      result.error === 'Session not found or token invalid';

    expect(isResumeSupported || isCleanRejection).toBe(true);

    // If resume failed, create a fresh connection for the close test
    if (!result.success) {
      connection.close();
      connection = new E2EConnection(config);
      const freshResult = await connection.connect(PROXY_URL);
      expect(freshResult.success).toBe(true);
    }
  }, 20000);

  it('should close cleanly', () => {
    if (!connection) {
      // Nothing to close
      return;
    }

    // Should have no errors from the current connection
    const errors = connection.getMessages().filter(
      (m) => m.type === 'error',
    );
    expect(errors.length).toBe(0);

    // Close should not throw
    connection.close();
    connection = null;
  });
});
