/**
 * Mock WebSocket server and client for testing
 */
import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';
export interface MockWebSocketMessage {
    type: 'utf8' | 'binary';
    data: Buffer | string;
}
export declare class MockWebSocketClient extends EventEmitter {
    readyState: number;
    url: string;
    protocol: string;
    bufferedAmount: number;
    private _messages;
    private _closed;
    constructor(url?: string, protocol?: string);
    send(data: string | Buffer | ArrayBuffer): void;
    close(code?: number, reason?: string): void;
    terminate(): void;
    ping(): void;
    pong(): void;
    simulateMessage(data: Buffer | string): void;
    simulateError(error: Error): void;
    getMessages(): MockWebSocketMessage[];
    getLastMessage(): MockWebSocketMessage | undefined;
    clearMessages(): void;
    isOpen(): boolean;
    isClosed(): boolean;
}
export declare class MockWebSocketServer extends EventEmitter {
    clients: Set<MockWebSocketClient>;
    private _options;
    private _listening;
    constructor(options?: {
        port?: number;
        server?: unknown;
    });
    simulateConnection(client: MockWebSocketClient, req?: IncomingMessage): void;
    broadcast(data: string | Buffer): void;
    close(callback?: () => void): void;
    isListening(): boolean;
    getClientCount(): number;
    simulateError(error: Error): void;
}
export declare function createMockWebSocketClient(url?: string): MockWebSocketClient;
export declare function createMockWebSocketServer(options?: {
    port?: number;
}): MockWebSocketServer;
export declare function waitForEvent(emitter: EventEmitter, event: string, timeout?: number): Promise<unknown>;
//# sourceMappingURL=mock-websocket.d.ts.map