/**
 * E2E Tests: ROM-based MUD
 * Tests: Basic telnet, minimal protocols
 * ROM MUDs are typically simpler with basic telnet support
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig, shouldRunE2ETests } from './config-loader';
import { E2EConnection } from './connection-helper';

const PROXY_URL = process.env.E2E_PROXY_URL || 'ws://localhost:6200';
const MUD_NAME = 'rom-mud';

describe.skipIf(!shouldRunE2ETests(), 'ROM MUD E2E Tests')(
  'ROM-based MUD (basic telnet)',
  () => {
    const configResult = loadE2EConfig(MUD_NAME);
    const config = configResult.config;
    let connection: E2EConnection | null = null;

    beforeAll(() => {
      if (configResult.skip) {
        console.log(`❌ Skipping ROM MUD E2E tests: ${configResult.reason}`);
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
      'should connect via basic telnet',
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
      },
    );

    it.skipIf(configResult.skip, 'should receive login prompt', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Wait for login prompt - look for common ROM prompts
      const promptFound = await connection.waitForText('login:', 15000);
      expect(promptFound).toBe(true);
    });

    it.skipIf(configResult.skip, 'should handle basic commands', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Send 'look' command
      connection.sendCommand('look');

      // Wait for response
      const responseFound = await connection.waitForText('here', 10000);
      expect(responseFound).toBe(true);
    });

    it.skipIf(
      configResult.skip,
      'should not require advanced protocols',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        // Wait for data
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Should work without GMCP/MCCP/MXP
        const messages = connection.getMessages();
        const dataMessages = messages.filter((m) => m.type === 'data');

        // Should have received data
        expect(dataMessages.length).toBeGreaterThan(0);

        // Should not have negotiated GMCP
        expect(connection.isProtocolNegotiated('gmcp')).toBe(false);

        // Should not have negotiated MCCP
        expect(connection.isProtocolNegotiated('mccp')).toBe(false);
      },
    );

    it.skipIf(
      configResult.skip,
      'should handle disconnect gracefully',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        // Close connection
        connection.close();

        // Wait a moment
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Session should still exist server-side (tested via resume)
        const messages = connection.getMessages();
        const sessionMsg = messages.find((m) => m.type === 'session');

        if (sessionMsg) {
          const sessionId = (sessionMsg.data as { sessionId: string })
            .sessionId;
          const token = (sessionMsg.data as { token: string }).token;

          // Create new connection
          connection = new E2EConnection(config);
          const result = await connection.resume(
            PROXY_URL,
            sessionId,
            token,
            0,
          );

          expect(result.success).toBe(true);
        }
      },
    );
  },
);
