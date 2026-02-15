/**
 * Session - Manages a persistent telnet connection independent of WebSocket
 *
 * A Session contains:
 * - Unique session ID and auth token
 * - Telnet socket connection to MUD
 * - Circular output buffer with sequence numbering
 * - Set of attached WebSocket clients
 * - Device token for push notifications
 */

import net from 'net';
import crypto from 'crypto';
import { WebSocket } from 'ws';
import type {
  BufferChunk,
  ProcessedData,
  SocketExtended,
  TelnetSocket,
  Trigger,
} from './types';
import { CircularBuffer } from './circular-buffer';

export class Session {
  id: string;
  authToken: string;
  createdAt: number;
  lastClientConnection: number;

  mudHost: string;
  mudPort: number;

  telnet: TelnetSocket | null = null;
  telnetConnected = false;

  clients: Set<SocketExtended> = new Set();
  clientConnected = false;

  buffer: CircularBuffer;

  deviceToken?: string;
  notificationTriggers: Trigger[] = [];

  windowWidth = 80;
  windowHeight = 24;

  private onDataCallback: ((data: Buffer) => void) | null = null;
  private onCloseCallback: (() => void) | null = null;
  private onErrorCallback: ((err: Error) => void) | null = null;

  constructor(
    host: string,
    port: number,
    bufferSizeBytes: number = 50 * 1024,
  ) {
    this.id = crypto.randomUUID();
    this.authToken = crypto.randomBytes(32).toString('hex');
    this.createdAt = Date.now();
    this.lastClientConnection = Date.now();
    this.mudHost = host;
    this.mudPort = port;
    this.buffer = new CircularBuffer(bufferSizeBytes);
  }

  /**
   * Connect to MUD server via telnet
   * Returns a promise that resolves when connected or rejects on error
   */
  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.telnet = net.createConnection(
          this.mudPort,
          this.mudHost,
        ) as TelnetSocket;

        // Add send method for compatibility
        this.telnet.send = (data: string | Buffer) => {
          this.telnet?.write(data);
        };

        this.telnet.on('connect', () => {
          this.telnetConnected = true;
          resolve();
        });

        this.telnet.on('data', (data: Buffer) => {
          if (this.onDataCallback) {
            this.onDataCallback(data);
          }
        });

        this.telnet.on('close', () => {
          this.telnetConnected = false;
          if (this.onCloseCallback) {
            this.onCloseCallback();
          }
        });

        this.telnet.on('error', (err: Error) => {
          this.telnetConnected = false;
          if (this.onErrorCallback) {
            this.onErrorCallback(err);
          }
          reject(err);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Set callback for telnet data
   */
  onData(callback: (data: Buffer) => void): void {
    this.onDataCallback = callback;
  }

  /**
   * Set callback for telnet close
   */
  onClose(callback: () => void): void {
    this.onCloseCallback = callback;
  }

  /**
   * Set callback for telnet error
   */
  onError(callback: (err: Error) => void): void {
    this.onErrorCallback = callback;
  }

  /**
   * Attach a WebSocket client to this session
   */
  attachClient(client: SocketExtended): void {
    this.clients.add(client);
    this.clientConnected = true;
    this.lastClientConnection = Date.now();
  }

  /**
   * Detach a WebSocket client from this session
   * Does NOT close the telnet connection
   */
  detachClient(client: SocketExtended): void {
    this.clients.delete(client);
    this.clientConnected = this.clients.size > 0;
  }

  /**
   * Get number of attached clients
   */
  getClientCount(): number {
    return this.clients.size;
  }

  /**
   * Check if any clients are connected
   */
  hasClients(): boolean {
    return this.clients.size > 0;
  }

  /**
   * Send data to all attached WebSocket clients
   */
  broadcastToClients(data: string): void {
    for (const client of this.clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
        }
      } catch (_err) {
        // Client disconnected, remove it
        this.clients.delete(client);
      }
    }
    this.clientConnected = this.clients.size > 0;
  }

  /**
   * Send data to the MUD via telnet
   */
  sendToMud(data: string | Buffer): boolean {
    if (!this.telnet || !this.telnetConnected) {
      return false;
    }
    try {
      this.telnet.write(data);
      return true;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(
        `[session] sendToMud failed for ${this.mudHost}:${this.mudPort}: ${err}`,
      );
      return false;
    }
  }

  /**
   * Buffer processed MUD output
   */
  bufferOutput(processed: ProcessedData): BufferChunk {
    const metadata: Partial<BufferChunk> = {};
    if (processed.type === 'gmcp') {
      metadata.gmcpPackage = processed.gmcpPackage;
      metadata.gmcpData = processed.gmcpData;
    }
    return this.buffer.append(processed.data, processed.type, metadata);
  }

  /**
   * Get buffered output from a specific sequence
   */
  replayFromSequence(sequence: number): BufferChunk[] {
    return this.buffer.replayFrom(sequence);
  }

  /**
   * Update window size (NAWS)
   */
  updateWindowSize(width: number, height: number): void {
    this.windowWidth = width;
    this.windowHeight = height;
  }

  /**
   * Set device token for push notifications
   */
  setDeviceToken(token: string): void {
    this.deviceToken = token;
  }

  /**
   * Get current buffer sequence number
   */
  getCurrentSequence(): number {
    return this.buffer.getCurrentSequence();
  }

  /**
   * Get the last sequence number in buffer
   */
  getLastSequence(): number {
    return this.buffer.getLastSequence();
  }

  /**
   * Get time since last client connection in milliseconds
   */
  getInactiveTime(): number {
    return Date.now() - this.lastClientConnection;
  }

  /**
   * Check if session has timed out
   */
  isTimedOut(timeoutHours: number): boolean {
    const timeoutMs = timeoutHours * 60 * 60 * 1000;
    return this.getInactiveTime() > timeoutMs;
  }

  /**
   * Gracefully close the session
   */
  close(): void {
    // Close all WebSocket clients
    for (const client of this.clients) {
      try {
        client.terminate();
      } catch (_err) {
        // Ignore errors during cleanup
      }
    }
    this.clients.clear();
    this.clientConnected = false;

    // Close telnet connection
    if (this.telnet) {
      try {
        this.telnet.end();
        this.telnet.destroy();
      } catch (_err) {
        // Ignore errors during cleanup
      }
      this.telnet = null;
      this.telnetConnected = false;
    }

    // Clear buffer
    this.buffer.clear();
  }

  /**
   * Get session metadata
   */
  getMetadata() {
    return {
      sessionId: this.id,
      authToken: this.authToken,
      createdAt: this.createdAt,
      lastClientConnection: this.lastClientConnection,
      mudHost: this.mudHost,
      mudPort: this.mudPort,
      telnetConnected: this.telnetConnected,
      clientConnected: this.clientConnected,
      clientCount: this.clients.size,
      windowWidth: this.windowWidth,
      windowHeight: this.windowHeight,
      currentSequence: this.getCurrentSequence(),
      bufferStats: this.buffer.getStats(),
    };
  }
}
