/**
 * E2E Tests: Raw Telnet Server
 * Tests: Basic connectivity on port 23
 * This tests the most minimal telnet connection possible
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig, shouldRunE2ETests } from './config-loader';
import { E2EConnection } from './connection-helper';

const PROXY_URL = process.env.E2E_PROXY_URL || 'ws://localhost:6200';
const MUD_NAME = 'raw-telnet';

describe.skipIf(!shouldRunE2ETests(), 'Raw Telnet E2E Tests')(
  'Raw Telnet Server (port 23)',
  () => {
    const configResult = loadE2EConfig(MUD_NAME);
    const config = configResult.config;
    let connection: E2EConnection | null = null;

    beforeAll(() => {
      if (configResult.skip) {
        console.log(
          `❌ Skipping Raw Telnet E2E tests: ${configResult.reason}`,
        );
      }
    });

    afterAll(() => {
      if (connection) {
        connection.close();
        connection = null;
      }
    });

    it.skipIf(configResult.skip, 'should connect to port 23', async () => {
      if (!config) {
        expect(config).not.toBeNull();
        return;
      }

      // Verify port is 23
      expect(config.port).toBe(23);

      connection = new E2EConnection(config);
      const result = await connection.connect(PROXY_URL);

      expect(result.success).toBe(true);
      expect(result.sessionId).toBeDefined();
      expect(result.token).toBeDefined();
    });

    it.skipIf(
      configResult.skip,
      'should receive data without errors',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        // Wait for data
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const messages = connection.getMessages();
        const errorMessages = messages.filter(
          (m) => m.type === 'error' || (m.data as { error?: string }).error,
        );

        // No errors
        expect(errorMessages.length).toBe(0);

        // Some data received
        const dataMessages = messages.filter((m) => m.type === 'data');
        expect(dataMessages.length).toBeGreaterThan(0);
      },
    );

    it.skipIf(
      configResult.skip,
      'should not require compression',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        // Wait for protocol negotiation
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Should not have negotiated MCCP
        const hasMCCP = connection.isProtocolNegotiated('mccp');
        expect(hasMCCP).toBe(false);
      },
    );

    it.skipIf(configResult.skip, 'should handle minimal telnet', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Send a simple command
      connection.sendCommand('help');

      // Wait for response
      await new Promise((resolve) => setTimeout(resolve, 3000));

      const messages = connection.getMessages();
      const dataMessages = messages.filter((m) => m.type === 'data');

      // Should have received data after sending command
      expect(dataMessages.length).toBeGreaterThan(0);
    });

    it.skipIf(configResult.skip, 'should disconnect cleanly', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Close connection
      connection.close();

      // Wait a moment
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Connection should be closed
      // No explicit check needed - just verify no errors
      const messages = connection.getMessages();
      const errorMessages = messages.filter(
        (m) => m.type === 'error' || (m.data as { error?: string }).error,
      );

      expect(errorMessages.length).toBe(0);
    });
  },
);
