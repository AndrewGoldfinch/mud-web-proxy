/**
 * Mock WebSocket server and client for testing
 */
import { EventEmitter } from 'events';
export class MockWebSocketClient extends EventEmitter {
    readyState = 1; // OPEN
    url;
    protocol;
    bufferedAmount = 0;
    _messages = [];
    _closed = false;
    constructor(url = 'ws://localhost:6200', protocol = '') {
        super();
        this.url = url;
        this.protocol = protocol;
    }
    send(data) {
        const message = {
            type: typeof data === 'string' ? 'utf8' : 'binary',
            data: data instanceof ArrayBuffer ? Buffer.from(data) : data,
        };
        this._messages.push(message);
        this.emit('message', data);
    }
    close(code = 1000, reason = '') {
        if (this._closed)
            return;
        this._closed = true;
        this.readyState = 3; // CLOSED
        this.emit('close', code, reason);
    }
    terminate() {
        this.close(1006, 'Connection terminated');
    }
    ping() {
        this.emit('ping');
    }
    pong() {
        this.emit('pong');
    }
    // Simulate receiving a message from server
    simulateMessage(data) {
        this.emit('message', data);
    }
    // Simulate error
    simulateError(error) {
        this.emit('error', error);
    }
    // Get sent messages
    getMessages() {
        return [...this._messages];
    }
    // Get last sent message
    getLastMessage() {
        return this._messages[this._messages.length - 1];
    }
    // Clear message history
    clearMessages() {
        this._messages = [];
    }
    // Check if socket is open
    isOpen() {
        return this.readyState === 1;
    }
    // Check if socket is closed
    isClosed() {
        return this.readyState === 3;
    }
}
export class MockWebSocketServer extends EventEmitter {
    clients = new Set();
    _options = {};
    _listening = false;
    constructor(options = {}) {
        super();
        this._options = options;
    }
    // Simulate new connection
    simulateConnection(client, req) {
        this.clients.add(client);
        this.emit('connection', client, req || createMockRequest());
    }
    // Broadcast to all clients
    broadcast(data) {
        for (const client of this.clients) {
            if (client.readyState === 1) {
                client.send(data);
            }
        }
    }
    // Close all connections
    close(callback) {
        for (const client of this.clients) {
            client.close();
        }
        this.clients.clear();
        this._listening = false;
        if (callback)
            callback();
        this.emit('close');
    }
    // Check if server is listening
    isListening() {
        return this._listening;
    }
    // Get client count
    getClientCount() {
        return this.clients.size;
    }
    // Simulate server error
    simulateError(error) {
        this.emit('error', error);
    }
}
// Create mock request
function createMockRequest() {
    const req = new EventEmitter();
    req.connection = {
        remoteAddress: '127.0.0.1',
    };
    req.headers = {};
    req.url = '/';
    req.method = 'GET';
    return req;
}
// Factory functions
export function createMockWebSocketClient(url) {
    return new MockWebSocketClient(url);
}
export function createMockWebSocketServer(options) {
    return new MockWebSocketServer(options);
}
// Helper to wait for WebSocket events
export function waitForEvent(emitter, event, timeout = 5000) {
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
//# sourceMappingURL=mock-websocket.js.map