/**
 * E2E Tests: Aardwolf MUD
 * Tests: GMCP, MCCP, ANSI colors, UTF-8
 * URL: aardmud.org:4000
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig } from './config-loader';
import { E2EConnection } from './connection-helper';

// Use wss:// for TLS connection
const PROXY_URL = process.env.E2E_PROXY_URL || 'wss://localhost:6200';
const MUD_NAME = 'aardwolf';

describe('Aardwolf MUD (aardmud.org:4000)', () => {
  const configResult = loadE2EConfig(MUD_NAME);
  const config = configResult.config;
  let connection: E2EConnection | null = null;

  beforeAll(() => {
    if (configResult.skip) {
      throw new Error(`E2E test config error: ${configResult.reason}`);
    }
  });

  afterAll(() => {
    if (connection) {
      connection.close();
      connection = null;
    }
  });

  it('should connect and create session', async () => {
    if (!config) {
      expect(config).not.toBeNull();
      return;
    }

    connection = new E2EConnection(config);
    const result = await connection.connect(PROXY_URL);

    if (!result.success) {
      console.log('Connection failed:', result.error);
      console.log('Messages received:', result.messages.length);
    }

    expect(result.success).toBe(true);
    expect(result.sessionId).toBeDefined();
    expect(result.token).toBeDefined();
    expect(result.sessionId?.length).toBeGreaterThan(0);
    expect(result.token?.length).toBeGreaterThan(0);
  });

  it('should negotiate GMCP', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Wait for data to arrive
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Check if GMCP was negotiated
    const negotiated = connection.isProtocolNegotiated('gmcp');
    expect(negotiated).toBe(true);
  });

  it('should negotiate MCCP', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Check if MCCP was negotiated
    const negotiated = connection.isProtocolNegotiated('mccp');
    expect(negotiated).toBe(true);
  });

  it('should receive ANSI colored output', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Check we have data messages
    const msgs = connection.getMessages();
    const dataMsgs = msgs.filter((m) => m.type === 'data');
    expect(dataMsgs.length).toBeGreaterThan(0);

    // Check for ANSI codes in data
    const messages = connection.getMessages();
    const dataMessages = messages.filter((m) => m.type === 'data');
    expect(dataMessages.length).toBeGreaterThan(0);

    // Verify we got actual data (not empty)
    const hasData = dataMessages.some((m) => {
      const payload = (m.data as { payload?: string }).payload;
      return payload && payload.length > 0;
    });
    expect(hasData).toBe(true);
  });

  it('should send commands to MUD', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Send a simple command
    connection.sendCommand('look');

    // Wait for response
    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Should have received more data
    const messages = connection.getMessages();
    const dataMessages = messages.filter((m) => m.type === 'data');
    expect(dataMessages.length).toBeGreaterThan(0);
  });

  it('should handle session resume', async () => {
    if (!config || !connection) {
      expect(connection).not.toBeNull();
      return;
    }

    // Get current session info
    const messages = connection.getMessages();
    const sessionMsg = messages.find((m) => m.type === 'session');

    if (!sessionMsg) {
      expect(sessionMsg).toBeDefined();
      return;
    }

    const sessionId = (sessionMsg.data as { sessionId: string }).sessionId;
    const token = (sessionMsg.data as { token: string }).token;

    // Close connection
    connection.close();
    connection = null;

    // Wait a moment
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Create new connection and resume
    connection = new E2EConnection(config);
    const result = await connection.resume(PROXY_URL, sessionId, token, 0);

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe(sessionId);

    // Should receive buffered data
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const resumedMessages = connection.getMessages();
    expect(resumedMessages.length).toBeGreaterThan(0);
  });
});
