/**
 * Mock Telnet server for testing
 */
import { EventEmitter } from 'events';
import { createServer } from 'net';
// Telnet protocol constants
export const TELNET = {
    IAC: 255,
    DONT: 254,
    DO: 253,
    WONT: 252,
    WILL: 251,
    SB: 250,
    SE: 240,
    IS: 0,
    REQUEST: 1,
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
};
export class MockTelnetServer extends EventEmitter {
    _server = null;
    _connections = new Set();
    _port;
    _host;
    constructor(port = 7000, host = 'localhost') {
        super();
        this._port = port;
        this._host = host;
    }
    async start() {
        return new Promise((resolve, reject) => {
            this._server = createServer((socket) => {
                const mockSocket = new MockTelnetSocket(socket);
                this._connections.add(mockSocket);
                this.emit('connection', mockSocket);
            });
            this._server.on('error', (err) => {
                this.emit('error', err);
                reject(err);
            });
            this._server.listen(this._port, this._host, () => {
                this.emit('listening');
                resolve();
            });
        });
    }
    async stop() {
        return new Promise((resolve) => {
            // Close all connections
            for (const conn of this._connections) {
                conn.destroy();
            }
            this._connections.clear();
            if (this._server) {
                this._server.close(() => {
                    this.emit('close');
                    resolve();
                });
            }
            else {
                resolve();
            }
        });
    }
    getConnections() {
        return new Set(this._connections);
    }
    getConnectionCount() {
        return this._connections.size;
    }
    getAddress() {
        return { port: this._port, host: this._host };
    }
}
export class MockTelnetSocket extends EventEmitter {
    _socket = null;
    _buffer = [];
    _closed = false;
    _writable = true;
    constructor(socket) {
        super();
        if (socket) {
            this._socket = socket;
            this._setupSocketListeners();
        }
    }
    _setupSocketListeners() {
        if (!this._socket)
            return;
        this._socket.on('data', (data) => {
            this._buffer.push(data);
            this.emit('data', data);
        });
        this._socket.on('close', () => {
            this._closed = true;
            this.emit('close');
        });
        this._socket.on('error', (err) => {
            this.emit('error', err);
        });
        this._socket.on('timeout', () => {
            this.emit('timeout');
        });
        this._socket.on('connect', () => {
            this.emit('connect');
        });
    }
    write(data) {
        if (this._closed || !this._writable)
            return false;
        if (this._socket) {
            return this._socket.write(data);
        }
        // Mock write for testing
        this.emit('write', data);
        return true;
    }
    send(data) {
        if (typeof data === 'string') {
            this.write(Buffer.from(data, 'utf8'));
        }
        else {
            this.write(data);
        }
    }
    destroy() {
        this._closed = true;
        this._writable = false;
        if (this._socket) {
            this._socket.destroy();
        }
        this.emit('close');
    }
    end(data) {
        if (data) {
            this.write(data);
        }
        this.destroy();
    }
    setTimeout(timeout) {
        if (this._socket) {
            this._socket.setTimeout(timeout);
        }
    }
    setEncoding(encoding) {
        if (this._socket) {
            this._socket.setEncoding(encoding);
        }
    }
    // Simulate receiving data
    simulateData(data) {
        const buffer = Array.isArray(data) ? Buffer.from(data) : data;
        this._buffer.push(buffer);
        this.emit('data', buffer);
    }
    // Get received data
    getReceivedData() {
        return Buffer.concat(this._buffer);
    }
    // Clear buffer
    clearBuffer() {
        this._buffer = [];
    }
    // Check if writable
    get writable() {
        return this._writable && !this._closed;
    }
    // Check if closed
    isClosed() {
        return this._closed;
    }
}
// Helper to create telnet command sequences
export function createTelnetCommand(...bytes) {
    return Buffer.from(bytes);
}
// Create WILL command
export function createWill(option) {
    return createTelnetCommand(TELNET.IAC, TELNET.WILL, option);
}
// Create DO command
export function createDo(option) {
    return createTelnetCommand(TELNET.IAC, TELNET.DO, option);
}
// Create SB sequence
export function createSubnegotiation(option, data) {
    return createTelnetCommand(TELNET.IAC, TELNET.SB, option, ...data, TELNET.IAC, TELNET.SE);
}
// Parse telnet sequence from buffer
export function parseTelnetSequence(buffer) {
    if (buffer.length < 2)
        return null;
    if (buffer[0] !== TELNET.IAC)
        return null;
    const command = buffer[1];
    const option = buffer[2];
    switch (command) {
        case TELNET.WILL:
            return { command: 'WILL', option };
        case TELNET.WONT:
            return { command: 'WONT', option };
        case TELNET.DO:
            return { command: 'DO', option };
        case TELNET.DONT:
            return { command: 'DONT', option };
        case TELNET.SB:
            // Parse subnegotiation
            const endIndex = buffer.indexOf(TELNET.SE);
            if (endIndex > 3) {
                return {
                    command: 'SB',
                    option,
                    data: Array.from(buffer.slice(3, endIndex)),
                };
            }
            return { command: 'SB', option };
        default:
            return null;
    }
}
// Factory functions
export function createMockTelnetServer(port, host) {
    return new MockTelnetServer(port, host);
}
export function createMockTelnetSocket() {
    return new MockTelnetSocket();
}
//# sourceMappingURL=mock-telnet.js.map