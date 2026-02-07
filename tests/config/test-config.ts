/**
 * Test configuration
 */

export const TEST_CONFIG = {
  // WebSocket settings
  websocket: {
    port: 6201,
    host: 'localhost',
    secure: false,
  },

  // Telnet settings
  telnet: {
    port: 7000,
    host: 'localhost',
  },

  // Test timeouts
  timeouts: {
    default: 5000,
    short: 1000,
    long: 10000,
    connection: 2000,
  },

  // Test data
  testData: {
    mockHost: 'test.mud.example.com',
    mockPort: 5000,
    defaultTtype: 'xterm-256color',
    testUser: 'TestUser',
    testClient: 'test-client',
  },

  // Feature flags for testing
  features: {
    mccp: true,
    mxp: true,
    gmcp: true,
    msdp: true,
    utf8: true,
    debug: true,
  },

  // Protocol constants for testing
  protocols: {
    IAC: 255,
    DONT: 254,
    DO: 253,
    WONT: 252,
    WILL: 251,
    SB: 250,
    SE: 240,
    TTYPE: 24,
    NAWS: 31,
    SGA: 3,
    ECHO: 1,
    MCCP2: 86,
    MXP: 91,
    MSDP: 69,
    GMCP: 201,
    NEW: 39,
    CHARSET: 42,
  },
} as const;

// Environment configuration
export function getTestEnv(): string {
  return process.env.NODE_ENV || 'test';
}

export function isDebugMode(): boolean {
  return process.env.DEBUG === 'true' || TEST_CONFIG.features.debug;
}

// Test utility paths
export const PATHS = {
  root: process.cwd(),
  tests: `${process.cwd()}/tests`,
  mocks: `${process.cwd()}/tests/mocks`,
  fixtures: `${process.cwd()}/tests/fixtures`,
} as const;

// Mock server URLs
export function getMockWebSocketUrl(
  port: number = TEST_CONFIG.websocket.port,
): string {
  return `ws://${TEST_CONFIG.websocket.host}:${port}`;
}

export function getMockTelnetAddress(
  port: number = TEST_CONFIG.telnet.port,
): string {
  return `${TEST_CONFIG.telnet.host}:${port}`;
}
