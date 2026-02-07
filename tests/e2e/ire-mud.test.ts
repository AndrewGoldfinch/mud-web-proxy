/**
 * E2E Tests: IRE MUD
 * Tests: Heavy GMCP traffic, Achaea/Imperian/Lusternia/Aetolia
 * These MUDs use Iron Realms Engine with extensive GMCP
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig, shouldRunE2ETests } from './config-loader';
import { E2EConnection } from './connection-helper';

const PROXY_URL = process.env.E2E_PROXY_URL || 'ws://localhost:6200';
const MUD_NAME = 'ire-mud';

describe.skipIf(!shouldRunE2ETests(), 'IRE MUD E2E Tests')(
  'IRE MUD (heavy GMCP)',
  () => {
    const configResult = loadE2EConfig(MUD_NAME);
    const config = configResult.config;
    let connection: E2EConnection | null = null;

    beforeAll(() => {
      if (configResult.skip) {
        console.log(`❌ Skipping IRE MUD E2E tests: ${configResult.reason}`);
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
      'should connect and negotiate GMCP',
      async () => {
        if (!config) {
          expect(config).not.toBeNull();
          return;
        }

        connection = new E2EConnection(config);
        const result = await connection.connect(PROXY_URL);

        expect(result.success).toBe(true);

        // Wait for protocol negotiation
        await new Promise((resolve) => setTimeout(resolve, 3000));

        // Check if GMCP was negotiated
        const negotiated = connection.isProtocolNegotiated('gmcp');
        expect(negotiated).toBe(true);
      },
    );

    it.skipIf(configResult.skip, 'should receive GMCP packages', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Wait for GMCP data
      const gmcpMsg = await connection.waitForMessage('gmcp', 10000);

      expect(gmcpMsg).not.toBeNull();

      // Check for Char package (IRE sends Char.Vitals)
      if (gmcpMsg) {
        const data = gmcpMsg.data as { package?: string; data?: unknown };
        const hasCharPackage =
          data.package?.startsWith('Char.') ||
          JSON.stringify(data).includes('Char.');
        expect(hasCharPackage).toBe(true);
      }
    });

    it.skipIf(
      configResult.skip,
      'should handle high GMCP volume',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        // Wait and collect GMCP messages
        await new Promise((resolve) => setTimeout(resolve, 5000));

        const messages = connection.getMessages();
        const gmcpMessages = messages.filter((m) => m.type === 'gmcp');

        // IRE MUDs send lots of GMCP
        expect(gmcpMessages.length).toBeGreaterThan(3);
      },
    );

    it.skipIf(
      configResult.skip,
      'should handle GMCP without errors',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        const messages = connection.getMessages();
        const errorMessages = messages.filter(
          (m) => m.type === 'error' || (m.data as { error?: string }).error,
        );

        // No protocol errors
        expect(errorMessages.length).toBe(0);
      },
    );

    it.skipIf(configResult.skip, 'should display login prompt', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Wait for login prompt
      const promptFound = await connection.waitForText('name', 15000);
      expect(promptFound).toBe(true);
    });
  },
);
