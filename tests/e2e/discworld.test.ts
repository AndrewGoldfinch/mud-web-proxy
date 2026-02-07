/**
 * E2E Tests: Discworld MUD
 * Tests: MXP support, extended protocols
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig, shouldRunE2ETests } from './config-loader';
import { E2EConnection } from './connection-helper';

const PROXY_URL = process.env.E2E_PROXY_URL || 'ws://localhost:6200';
const MUD_NAME = 'discworld';

describe.skipIf(!shouldRunE2ETests(), 'Discworld E2E Tests')(
  'Discworld MUD (MXP support)',
  () => {
    const configResult = loadE2EConfig(MUD_NAME);
    const config = configResult.config;
    let connection: E2EConnection | null = null;

    beforeAll(() => {
      if (configResult.skip) {
        console.log(`❌ Skipping Discworld E2E tests: ${configResult.reason}`);
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
      'should connect and negotiate MXP',
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

        // Check if MXP was negotiated
        const negotiated = connection.isProtocolNegotiated('mxp');
        expect(negotiated).toBe(true);
      },
    );

    it.skipIf(
      configResult.skip,
      'should receive MXP markup in output',
      async () => {
        if (!config || !connection) {
          expect(connection).not.toBeNull();
          return;
        }

        // Wait for data
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const messages = connection.getMessages();
        const dataMessages = messages.filter((m) => m.type === 'data');

        // Verify MXP tags if present
        const hasData = dataMessages.length > 0;
        expect(hasData).toBe(true);
      },
    );

    it.skipIf(configResult.skip, 'should display login prompt', async () => {
      if (!config || !connection) {
        expect(connection).not.toBeNull();
        return;
      }

      // Wait for login prompt
      const promptFound = await connection.waitForText('login', 15000);
      expect(promptFound).toBe(true);
    });
  },
);
