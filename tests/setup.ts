/**
 * Test setup file
 * Common utilities and mocks for all tests
 */

import { beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import type { WebSocket } from 'ws';
import type { Socket } from 'net';
import type { IncomingMessage } from 'http';

// Type definitions for SocketExtended and TelnetSocket (local copies)
interface SocketExtended extends WebSocket {
  req: IncomingMessage & { connection: { remoteAddress: string } };
  ts?: TelnetSocket;
  host?: string;
  port?: number;
  ttype: string[];
  name?: string;
  client?: string;
  mccp?: boolean;
  utf8?: boolean;
  debug?: boolean;
  compressed: number;
  mccp_negotiated?: number;
  mxp_negotiated?: number;
  gmcp_negotiated?: number;
  utf8_negotiated?: number;
  new_negotiated?: number;
  new_handshake?: number;
  sga_negotiated?: number;
  echo_negotiated?: number;
  naws_negotiated?: number;
  msdp_negotiated?: number;
  chat?: number;
  password_mode?: boolean;
  sendUTF: (data: string | Buffer) => void;
  terminate: () => void;
  remoteAddress: string;
}

interface TelnetSocket extends Socket {
  send: (data: string | Buffer) => void;
}

// Global test configuration
export const TEST_CONFIG = {
  wsPort: 6201,
  tnHost: 'localhost',
  tnPort: 7000,
  debug: true,
  timeout: 5000,
} as const;

// Helper to create a mock socket
export function createMockSocket(
  overrides: Partial<SocketExtended> = {},
): SocketExtended {
  return {
    req: {
      connection: {
        remoteAddress: '127.0.0.1',
      },
    },
    ts: undefined,
    host: TEST_CONFIG.tnHost,
    port: TEST_CONFIG.tnPort,
    ttype: ['xterm-256color'],
    name: 'TestUser',
    client: 'test-client',
    mccp: false,
    utf8: false,
    debug: false,
    compressed: 0,
    mccp_negotiated: 0,
    mxp_negotiated: 0,
    gmcp_negotiated: 0,
    utf8_negotiated: 0,
    new_negotiated: 0,
    new_handshake: 0,
    sga_negotiated: 0,
    echo_negotiated: 0,
    naws_negotiated: 0,
    msdp_negotiated: 0,
    chat: 0,
    password_mode: false,
    sendUTF: () => {},
    terminate: () => {},
    remoteAddress: '127.0.0.1',
    ...overrides,
  } as SocketExtended;
}

// Helper to create a mock telnet socket
export function createMockTelnetSocket(
  overrides: Partial<TelnetSocket> = {},
): TelnetSocket {
  const mockSocket: {
    write: () => boolean;
    send: () => void;
    on: () => unknown;
    once: () => unknown;
    destroy: () => void;
    end: () => void;
    setEncoding: () => void;
  } = {
    write: (): boolean => true,
    send: (): void => {},
    on: (): unknown => mockSocket,
    once: (): unknown => mockSocket,
    destroy: (): void => {},
    end: (): void => {},
    setEncoding: (): void => {},
    ...overrides,
  };
  return mockSocket as TelnetSocket;
}

// Test data factories
export function createMockBuffer(data: string | number[]): Buffer {
  if (typeof data === 'string') {
    return Buffer.from(data);
  }
  return Buffer.from(data);
}

// Lifecycle hooks
export function setupTestHooks(): void {
  beforeAll(() => {
    // Global test setup
    process.env.NODE_ENV = 'test';
    process.env.REQUIRE_APP_AUTH = 'false';
  });

  afterAll(() => {
    // Global test teardown
    process.env.NODE_ENV = undefined;
    process.env.REQUIRE_APP_AUTH = undefined;
  });

  beforeEach(() => {
    // Setup before each test
  });

  afterEach(() => {
    // Cleanup after each test
  });
}

// Export all test utilities
export {
  expect,
  describe,
  it,
  test,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
} from 'bun:test';
