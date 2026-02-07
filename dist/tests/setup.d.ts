/**
 * Test setup file
 * Common utilities and mocks for all tests
 */
import type { WebSocket } from 'ws';
import type { Socket } from 'net';
import type { IncomingMessage } from 'http';
interface SocketExtended extends WebSocket {
    req: IncomingMessage & {
        connection: {
            remoteAddress: string;
        };
    };
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
export declare const TEST_CONFIG: {
    readonly wsPort: 6201;
    readonly tnHost: "localhost";
    readonly tnPort: 7000;
    readonly debug: true;
    readonly timeout: 5000;
};
export declare function createMockSocket(overrides?: Partial<SocketExtended>): SocketExtended;
export declare function createMockTelnetSocket(overrides?: Partial<TelnetSocket>): TelnetSocket;
export declare function createMockBuffer(data: string | number[]): Buffer;
export declare function setupTestHooks(): void;
export { expect, describe, it, test, beforeAll, afterAll, beforeEach, afterEach, } from 'bun:test';
//# sourceMappingURL=setup.d.ts.map