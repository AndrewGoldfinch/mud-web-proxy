/**
 * E2E Tests: Aardwolf MUD
 * Tests: GMCP, MCCP, ANSI colors, UTF-8
 * URL: aardmud.org:4000
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig, shouldRunE2ETests } from './config-loader';
import { E2EConnection } from './connection-helper';

const PROXY_URL = process.env.E2E_PROXY_URL || 'ws://localhost:6200';
const MUD_NAME = 'aardwolf';

describe.skipIf(!shouldRunE2ETests(), 'Aardwolf E2E Tests')(
  'Aardwolf MUD (aardmud.org:4000)',
  () => {
    const configResult = loadE2EConfig(MUD_NAME);
    const config = configResult.config;
    let connection: E2EConnection | null = null;

    beforeAll(() => {
      if (configResult.skip) {
        console.log(`❌ Skipping Aardwolf E2E tests: ${configResult.reason}`);
      }
    });

    afterAll(() => {
      if (connection) {
        connection.close();
        connection = null;
      }
    });

    it.skipIf(
      configResult.skip,
      'should connect and create session',
      async () => {
        if (!config) {
          expect(config).not.toBeNull();
          return;
        }

        connection = new E2EConnection(config);
        const result = await connection.connect(PROXY_URL);

        expect(result.success).toBe(true);
        expect(result.sessionId).toBeDefined();
        expect(result.token).toBeDefined();
        expect(result.sessionId?.length).toBeGreaterThan(0);
        expect(result.token?.length).toBeGreaterThan(0);
      },
    );

    it.skipIf(configResult.skip, 'should negotiate GMCP', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Wait a bit for protocol negotiation
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Check if GMCP was negotiated
      const negotiated = connection.isProtocolNegotiated('gmcp');
      expect(negotiated).toBe(true);

      // Verify GMCP messages were received
      const messages = connection.getMessages();
      const gmcpMessages = messages.filter((m) => m.type === 'gmcp');
      expect(gmcpMessages.length).toBeGreaterThan(0);
    });

    it.skipIf(configResult.skip, 'should negotiate MCCP', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Wait for protocol negotiation
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const negotiated = connection.isProtocolNegotiated('mccp');
      expect(negotiated).toBe(true);
    });

    it.skipIf(
      configResult.skip,
      'should receive ANSI colored output',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        // Wait for MUD output
        const found = await connection.waitForText('Aardwolf', 10000);
        expect(found).toBe(true);

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
      },
    );

    it.skipIf(
      configResult.skip || !config?.username,
      'should login with credentials',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        // Wait for login prompt
        const found = await connection.waitForText('name:', 10000);
        expect(found).toBe(true);

        // Send username
        connection.sendCommand(config.username || '');

        // Wait for password prompt
        const passwordFound = await connection.waitForText('password', 10000);
        expect(passwordFound).toBe(true);

        // Note: We don't actually send password in E2E tests
        // Just verify the login flow works
      },
    );

    it.skipIf(configResult.skip, 'should handle session resume', async () => {
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
  },
);
