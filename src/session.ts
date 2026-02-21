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
import tls from 'tls';
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
import { TelnetParser } from './telnet-parser';

export class Session {
  id: string;
  authToken: string;
  createdAt: number;
  lastClientConnection: number;

  mudHost: string;
  mudPort: number;

  telnet: TelnetSocket | null = null;
  telnetConnected = false;
  private closing = false;

  clients: Set<SocketExtended> = new Set();
  clientConnected = false;

  buffer: CircularBuffer;

  deviceToken?: string;
  activityPushToken?: string;
  clientBackgrounded = false;
  lastBackgroundedAt = 0;
  lastActivityPushAt = 0;
  notificationTriggers: Trigger[] = [];

  windowWidth = 80;
  windowHeight = 24;

  telnetParser: TelnetParser;

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
    this.telnetParser = new TelnetParser(this);
  }

  /**
   * Connect to MUD server via telnet
   * Auto-detects SSL: tries TLS first, falls back to plain TCP
   * Returns a promise that resolves when connected or rejects on error
   */
  async connect(): Promise<void> {
    this.closing = false;

    return new Promise((resolve, reject) => {
      let settled = false;
      let triedPlain = false;

      const isSSLError = (err: Error): boolean => {
        const msg = err.message.toLowerCase();
        return (
          msg.includes('tls') ||
          msg.includes('ssl') ||
          msg.includes('certificate') ||
          msg.includes('packet length') ||
          msg.includes('wrong version number') ||
          msg.includes('econnreset') ||
          msg.includes('econnrefused')
        );
      };

      const abortIfClosing = (socket: TelnetSocket): boolean => {
        if (!this.closing) return false;
        socket.removeAllListeners();
        socket.destroy();
        if (this.telnet === socket) {
          this.telnet = null;
        }
        if (!settled) {
          settled = true;
          reject(new Error('Session closed during connect'));
        }
        return true;
      };

      const tryPlain = () => {
        if (triedPlain) return;
        triedPlain = true;

        if (this.closing) {
          if (!settled) {
            settled = true;
            reject(new Error('Session closed during connect'));
          }
          return;
        }

        // eslint-disable-next-line no-console
        console.log(
          `[session] TLS failed, falling back to plain TCP for ${this.mudHost}:${this.mudPort}`,
        );

        // Destroy the old TLS socket to prevent stale handlers
        if (this.telnet) {
          this.telnet.removeAllListeners();
          this.telnet.destroy();
          this.telnet = null;
        }

        try {
          const plainSocket = net.createConnection(
            this.mudPort,
            this.mudHost,
            () => {
              if (abortIfClosing(plainSocket)) return;
              this.telnetConnected = true;
              settled = true;
              resolve();
            },
          ) as TelnetSocket;
          this.telnet = plainSocket;

          this.setupTelnetHandlers((err: Error) => {
            if (!settled) reject(err);
          });
        } catch (err) {
          if (!settled) reject(err as Error);
        }
      };

      try {
        const tlsSocket = tls.connect(this.mudPort, this.mudHost, {}, () => {
          if (abortIfClosing(tlsSocket)) return;
          this.telnetConnected = true;
          settled = true;
          resolve();
        }) as unknown as TelnetSocket;
        this.telnet = tlsSocket;

        this.setupTelnetHandlers((err: Error) => {
          if (settled) return;
          if (isSSLError(err)) {
            tryPlain();
          } else {
            reject(err);
          }
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private setupTelnetHandlers(onConnectError: (err: Error) => void): void {
    if (!this.telnet) return;

    this.telnet.send = (data: string | Buffer) => {
      this.telnet?.write(data);
    };

    this.telnet.on('connect', () => {
      this.telnetConnected = true;
    });

    this.telnet.on('data', (data: Buffer) => {
      if (this.onDataCallback) {
        this.onDataCallback(data);
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[session] [sid:${this.id.substring(0, 8)}] DATA DROPPED: ${data.length} bytes (no onDataCallback)`,
        );
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
      onConnectError(err);
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
    const clientCount = this.clients.size;
    let sentCount = 0;
    const failedClients: SocketExtended[] = [];
    for (const client of this.clients) {
      try {
        if (client.readyState === WebSocket.OPEN) {
          client.send(data);
          sentCount++;
        } else {
          // eslint-disable-next-line no-console
          console.log(
            `[session] [sid:${this.id.substring(0, 8)}] broadcastToClients: client readyState=${client.readyState}, not OPEN (${WebSocket.OPEN})`,
          );
        }
      } catch (_err) {
        // Client disconnected, remove after iteration
        failedClients.push(client);
      }
    }
    for (const client of failedClients) {
      this.clients.delete(client);
    }
    if (clientCount > 0 && sentCount === 0) {
      // eslint-disable-next-line no-console
      console.log(
        `[session] [sid:${this.id.substring(0, 8)}] broadcastToClients: WARNING: ${clientCount} clients but 0 sent`,
      );
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
    this.sendNAWS();
  }

  /**
   * Send NAWS telnet sequence to MUD
   */
  sendNAWS(): void {
    if (!this.telnet || !this.telnetConnected) {
      return;
    }
    const buf = Buffer.from([
      255, // IAC
      250, // SB
      31, // NAWS
      (this.windowWidth >> 8) & 0xff,
      this.windowWidth & 0xff,
      (this.windowHeight >> 8) & 0xff,
      this.windowHeight & 0xff,
      255, // IAC
      240, // SE
    ]);
    this.telnet.write(buf);
  }

  /**
   * Set device token for push notifications
   */
  setDeviceToken(token: string): void {
    this.deviceToken = token;
  }

  setActivityPushToken(token: string): void {
    this.activityPushToken = token;
  }

  markClientBackgrounded(): void {
    this.clientBackgrounded = true;
    this.lastBackgroundedAt = Date.now();
  }

  markClientForegrounded(): void {
    this.clientBackgrounded = false;
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
    this.closing = true;

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
      deviceToken: this.deviceToken,
      activityPushToken: this.activityPushToken,
      clientBackgrounded: this.clientBackgrounded,
      lastBackgroundedAt: this.lastBackgroundedAt,
      lastActivityPushAt: this.lastActivityPushAt,
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
