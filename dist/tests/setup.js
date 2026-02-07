/**
 * Test setup file
 * Common utilities and mocks for all tests
 */
import { beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
// Global test configuration
export const TEST_CONFIG = {
    wsPort: 6201,
    tnHost: 'localhost',
    tnPort: 7000,
    debug: true,
    timeout: 5000,
};
// Helper to create a mock socket
export function createMockSocket(overrides = {}) {
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
        sendUTF: () => { },
        terminate: () => { },
        remoteAddress: '127.0.0.1',
        ...overrides,
    };
}
// Helper to create a mock telnet socket
export function createMockTelnetSocket(overrides = {}) {
    const mockSocket = {
        write: () => true,
        send: () => { },
        on: () => mockSocket,
        once: () => mockSocket,
        destroy: () => { },
        end: () => { },
        setEncoding: () => { },
        ...overrides,
    };
    return mockSocket;
}
// Test data factories
export function createMockBuffer(data) {
    if (typeof data === 'string') {
        return Buffer.from(data);
    }
    return Buffer.from(data);
}
// Lifecycle hooks
export function setupTestHooks() {
    beforeAll(() => {
        // Global test setup
        process.env.NODE_ENV = 'test';
    });
    afterAll(() => {
        // Global test teardown
        process.env.NODE_ENV = undefined;
    });
    beforeEach(() => {
        // Setup before each test
    });
    afterEach(() => {
        // Cleanup after each test
    });
}
// Export all test utilities
export { expect, describe, it, test, beforeAll, afterAll, beforeEach, afterEach, } from 'bun:test';
//# sourceMappingURL=setup.js.map