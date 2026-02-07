/**
 * Mock Telnet server for testing
 */

import { EventEmitter } from 'events';
import { createServer, Server, Socket } from 'net';

// Local type definition for TelnetSocket
interface TelnetSocket extends Socket {
  send: (data: string | Buffer) => void;
}

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
} as const;

export class MockTelnetServer extends EventEmitter {
  private _server: Server | null = null;
  private _connections: Set<MockTelnetSocket> = new Set();
  private _port: number;
  private _host: string;

  constructor(port: number = 7000, host: string = 'localhost') {
    super();
    this._port = port;
    this._host = host;
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this._server = createServer((socket: Socket) => {
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

  async stop(): Promise<void> {
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
      } else {
        resolve();
      }
    });
  }

  getConnections(): Set<MockTelnetSocket> {
    return new Set(this._connections);
  }

  getConnectionCount(): number {
    return this._connections.size;
  }

  getAddress(): { port: number; host: string } {
    return { port: this._port, host: this._host };
  }
}

export class MockTelnetSocket extends EventEmitter {
  private _socket: Socket | null = null;
  private _buffer: Buffer[] = [];
  private _closed = false;
  private _writable = true;

  constructor(socket?: Socket) {
    super();
    if (socket) {
      this._socket = socket;
      this._setupSocketListeners();
    }
  }

  private _setupSocketListeners(): void {
    if (!this._socket) return;

    this._socket.on('data', (data: Buffer) => {
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

  write(data: Buffer | string): boolean {
    if (this._closed || !this._writable) return false;

    if (this._socket) {
      return this._socket.write(data);
    }

    // Mock write for testing
    this.emit('write', data);
    return true;
  }

  send(data: string | Buffer): void {
    if (typeof data === 'string') {
      this.write(Buffer.from(data, 'utf8'));
    } else {
      this.write(data);
    }
  }

  destroy(): void {
    this._closed = true;
    this._writable = false;
    if (this._socket) {
      this._socket.destroy();
    }
    this.emit('close');
  }

  end(data?: Buffer | string): void {
    if (data) {
      this.write(data);
    }
    this.destroy();
  }

  setTimeout(timeout: number): void {
    if (this._socket) {
      this._socket.setTimeout(timeout);
    }
  }

  setEncoding(encoding: BufferEncoding): void {
    if (this._socket) {
      this._socket.setEncoding(encoding);
    }
  }

  // Simulate receiving data
  simulateData(data: Buffer | number[]): void {
    const buffer = Array.isArray(data) ? Buffer.from(data) : data;
    this._buffer.push(buffer);
    this.emit('data', buffer);
  }

  // Get received data
  getReceivedData(): Buffer {
    return Buffer.concat(this._buffer);
  }

  // Clear buffer
  clearBuffer(): void {
    this._buffer = [];
  }

  // Check if writable
  get writable(): boolean {
    return this._writable && !this._closed;
  }

  // Check if closed
  isClosed(): boolean {
    return this._closed;
  }
}

// Helper to create telnet command sequences
export function createTelnetCommand(...bytes: number[]): Buffer {
  return Buffer.from(bytes);
}

// Create WILL command
export function createWill(option: number): Buffer {
  return createTelnetCommand(TELNET.IAC, TELNET.WILL, option);
}

// Create DO command
export function createDo(option: number): Buffer {
  return createTelnetCommand(TELNET.IAC, TELNET.DO, option);
}

// Create SB sequence
export function createSubnegotiation(option: number, data: number[]): Buffer {
  return createTelnetCommand(
    TELNET.IAC,
    TELNET.SB,
    option,
    ...data,
    TELNET.IAC,
    TELNET.SE,
  );
}

// Parse telnet sequence from buffer
export function parseTelnetSequence(buffer: Buffer): {
  command: string;
  option?: number;
  data?: number[];
} | null {
  if (buffer.length < 2) return null;
  if (buffer[0] !== TELNET.IAC) return null;

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
export function createMockTelnetServer(
  port?: number,
  host?: string,
): MockTelnetServer {
  return new MockTelnetServer(port, host);
}

export function createMockTelnetSocket(): MockTelnetSocket {
  return new MockTelnetSocket();
}
