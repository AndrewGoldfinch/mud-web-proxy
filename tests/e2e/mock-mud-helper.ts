/**
 * Mock MUD Helper for E2E Tests
 * Manages mock MUD server lifecycle for testing
 */

import {
  MockMUDServer,
  createIREMUD,
  createAardwolfMUD,
  createDiscworldMUD,
  createROMMUD,
  createChaosMUD,
} from './mock-mud';
import { startTestProxy, type ProxyLauncher } from './proxy-launcher';

export interface MockMUDSetup {
  mockServer: MockMUDServer;
  proxy: ProxyLauncher;
  url: string;
  stop: () => Promise<void>;
}

export type MockMUDType = 'ire' | 'aardwolf' | 'discworld' | 'rom' | 'chaos';

/**
 * Start a mock MUD server and proxy for E2E testing
 */
export async function startMockMUDTest(
  type: MockMUDType = 'ire',
  proxyPort: number = 6299,
): Promise<MockMUDSetup> {
  // Create mock server
  let mockServer: MockMUDServer;

  switch (type) {
    case 'ire':
      mockServer = createIREMUD();
      break;
    case 'aardwolf':
      mockServer = createAardwolfMUD();
      break;
    case 'discworld':
      mockServer = createDiscworldMUD();
      break;
    case 'rom':
      mockServer = createROMMUD();
      break;
    case 'chaos':
      mockServer = createChaosMUD();
      break;
    default:
      mockServer = createIREMUD();
  }

  // Start mock server
  await mockServer.start();
  console.log(
    `[E2E] Mock ${type} MUD started on port ${mockServer['config'].port}`,
  );

  // Start proxy pointing to mock server
  const proxy = await startTestProxy(proxyPort, {
    TN_HOST: 'localhost',
    TN_PORT: mockServer['config'].port.toString(),
  });

  return {
    mockServer,
    proxy,
    url: proxy.url,
    stop: async () => {
      await proxy.stop();
      await mockServer.stop();
    },
  };
}

/**
 * Check if running in CI environment
 */
export function isCI(): boolean {
  return (
    process.env.CI === 'true' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.TRAVIS === 'true' ||
    process.env.CIRCLECI === 'true' ||
    process.env.USE_MOCK_MUD === '1'
  );
}

/**
 * Get test configuration based on environment
 * In CI: Use mock MUD
 * In dev: Use real MUD (from config)
 */
export function shouldUseMockMUD(): boolean {
  // Check for explicit override
  if (process.env.USE_MOCK_MUD === '1') {
    return true;
  }
  if (process.env.USE_MOCK_MUD === '0') {
    return false;
  }
  // Default: use mock in CI, real in dev
  return isCI();
}
