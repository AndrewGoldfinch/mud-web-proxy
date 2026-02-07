/**
 * Mock Telnet server for testing
 */
import { EventEmitter } from 'events';
import { Socket } from 'net';
export declare const TELNET: {
    readonly IAC: 255;
    readonly DONT: 254;
    readonly DO: 253;
    readonly WONT: 252;
    readonly WILL: 251;
    readonly SB: 250;
    readonly SE: 240;
    readonly IS: 0;
    readonly REQUEST: 1;
    readonly TTYPE: 24;
    readonly NAWS: 31;
    readonly SGA: 3;
    readonly ECHO: 1;
    readonly MCCP2: 86;
    readonly MXP: 91;
    readonly MSDP: 69;
    readonly GMCP: 201;
    readonly NEW: 39;
    readonly CHARSET: 42;
};
export declare class MockTelnetServer extends EventEmitter {
    private _server;
    private _connections;
    private _port;
    private _host;
    constructor(port?: number, host?: string);
    start(): Promise<void>;
    stop(): Promise<void>;
    getConnections(): Set<MockTelnetSocket>;
    getConnectionCount(): number;
    getAddress(): {
        port: number;
        host: string;
    };
}
export declare class MockTelnetSocket extends EventEmitter {
    private _socket;
    private _buffer;
    private _closed;
    private _writable;
    constructor(socket?: Socket);
    private _setupSocketListeners;
    write(data: Buffer | string): boolean;
    send(data: string | Buffer): void;
    destroy(): void;
    end(data?: Buffer | string): void;
    setTimeout(timeout: number): void;
    setEncoding(encoding: BufferEncoding): void;
    simulateData(data: Buffer | number[]): void;
    getReceivedData(): Buffer;
    clearBuffer(): void;
    get writable(): boolean;
    isClosed(): boolean;
}
export declare function createTelnetCommand(...bytes: number[]): Buffer;
export declare function createWill(option: number): Buffer;
export declare function createDo(option: number): Buffer;
export declare function createSubnegotiation(option: number, data: number[]): Buffer;
export declare function parseTelnetSequence(buffer: Buffer): {
    command: string;
    option?: number;
    data?: number[];
} | null;
export declare function createMockTelnetServer(port?: number, host?: string): MockTelnetServer;
export declare function createMockTelnetSocket(): MockTelnetSocket;
//# sourceMappingURL=mock-telnet.d.ts.map