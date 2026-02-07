/**
 * Mock WebSocket server and client for testing
 */

import { EventEmitter } from 'events';
import type { IncomingMessage } from 'http';

export interface MockWebSocketMessage {
  type: 'utf8' | 'binary';
  data: Buffer | string;
}

export class MockWebSocketClient extends EventEmitter {
  public readyState = 1; // OPEN
  public url: string;
  public protocol: string;
  public bufferedAmount = 0;

  private _messages: MockWebSocketMessage[] = [];
  private _closed = false;

  constructor(url: string = 'ws://localhost:6200', protocol = '') {
    super();
    this.url = url;
    this.protocol = protocol;
  }

  send(data: string | Buffer | ArrayBuffer): void {
    const message: MockWebSocketMessage = {
      type: typeof data === 'string' ? 'utf8' : 'binary',
      data: data instanceof ArrayBuffer ? Buffer.from(data) : data,
    };
    this._messages.push(message);
    this.emit('message', data);
  }

  close(code = 1000, reason = ''): void {
    if (this._closed) return;
    this._closed = true;
    this.readyState = 3; // CLOSED
    this.emit('close', code, reason);
  }

  terminate(): void {
    this.close(1006, 'Connection terminated');
  }

  ping(): void {
    this.emit('ping');
  }

  pong(): void {
    this.emit('pong');
  }

  // Simulate receiving a message from server
  simulateMessage(data: Buffer | string): void {
    this.emit('message', data);
  }

  // Simulate error
  simulateError(error: Error): void {
    this.emit('error', error);
  }

  // Get sent messages
  getMessages(): MockWebSocketMessage[] {
    return [...this._messages];
  }

  // Get last sent message
  getLastMessage(): MockWebSocketMessage | undefined {
    return this._messages[this._messages.length - 1];
  }

  // Clear message history
  clearMessages(): void {
    this._messages = [];
  }

  // Check if socket is open
  isOpen(): boolean {
    return this.readyState === 1;
  }

  // Check if socket is closed
  isClosed(): boolean {
    return this.readyState === 3;
  }
}

export class MockWebSocketServer extends EventEmitter {
  public clients: Set<MockWebSocketClient> = new Set();
  private _listening = false;

  constructor(_options: { port?: number; server?: unknown } = {}) {
    super();
    // Options stored for future reference if needed
    void _options;
  }

  // Simulate new connection
  simulateConnection(
    client: MockWebSocketClient,
    req?: IncomingMessage,
  ): void {
    this.clients.add(client);
    this.emit('connection', client, req || createMockRequest());
  }

  // Broadcast to all clients
  broadcast(data: string | Buffer): void {
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  // Close all connections
  close(callback?: () => void): void {
    for (const client of this.clients) {
      client.close();
    }
    this.clients.clear();
    this._listening = false;
    if (callback) callback();
    this.emit('close');
  }

  // Check if server is listening
  isListening(): boolean {
    return this._listening;
  }

  // Get client count
  getClientCount(): number {
    return this.clients.size;
  }

  // Simulate server error
  simulateError(error: Error): void {
    this.emit('error', error);
  }
}

// Create mock request
function createMockRequest(): IncomingMessage {
  const req = new EventEmitter() as IncomingMessage;
  req.connection = {
    remoteAddress: '127.0.0.1',
  } as IncomingMessage['connection'];
  req.headers = {};
  req.url = '/';
  req.method = 'GET';
  return req;
}

// Factory functions
export function createMockWebSocketClient(url?: string): MockWebSocketClient {
  return new MockWebSocketClient(url);
}

export function createMockWebSocketServer(options?: {
  port?: number;
}): MockWebSocketServer {
  return new MockWebSocketServer(options);
}

// Helper to wait for WebSocket events
export function waitForEvent(
  emitter: EventEmitter,
  event: string,
  timeout = 5000,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for event: ${event}`));
    }, timeout);

    emitter.once(event, (data) => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}
