/**
 * E2E Tests: Raw Telnet (port 23)
 * Automatically starts test proxy on port 6299
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { loadE2EConfig } from './config-loader';
import { E2EConnection } from './connection-helper';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

const MUD_NAME = 'raw_telnet';
const TEST_PROXY_PORT = 6299;

describe('Raw Telnet (port 23)', () => {
  const configResult = loadE2EConfig(MUD_NAME);
  const config = configResult.config;
  let connection: E2EConnection | null = null;
  let proxy: ProxyLauncher | null = null;

  beforeAll(async () => {
    if (configResult.skip) {
      console.log(`❌ Skipping tests: ${configResult.reason}`);
      return;
    }
    
    // Start test proxy
    proxy = await startTestProxy(TEST_PROXY_PORT);
  });

  afterAll(async () => {
    if (connection) {
      connection.close();
      connection = null;
    }
    
    if (proxy) {
      await proxy.stop();
      proxy = null;
    }
  });

  it('should connect and create session', async () => {
    if (!config || !proxy) {
      expect(config).not.toBeNull();
      expect(proxy).not.toBeNull();
      return;
    }

    connection = new E2EConnection(config);
    const result = await connection.connect(proxy.url);

    expect(result.success).toBe(true);
    expect(result.sessionId).toBeDefined();
    expect(result.token).toBeDefined();
  });

  // Skip remaining tests if connection failed or config is missing
  beforeEach(() => {
    if (!connection) {
      console.log('⚠️ Connection not available, skipping test');
    }
  });
});
