// SPDX-License-Identifier: GPL-3.0-or-later
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

import crypto from 'crypto';
import { WebSocket } from 'ws';
import type { MudTlsMode } from './runtime-config';
import { connectMudTransport } from './mud-transport';
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
  dialAddress: string;
  tlsMode: MudTlsMode;
  dialTimeoutMs: number;
  /** True when a `prefer` connection ended up in plaintext. */
  tlsDowngraded = false;
  mudPort: number;

  telnet: TelnetSocket | null = null;
  telnetConnected = false;
  private connectAbortController?: AbortController;

  clients: Set<SocketExtended> = new Set();
  clientConnected = false;

  buffer: CircularBuffer;

  deviceToken?: string;
  clientIp?: string;
  activityPushToken?: string;
  clientBackgrounded = false;
  lastBackgroundedAt = 0;
  lastActivityPushAt = 0;

  /**
   * When this session last dropped to zero attached clients, or null while a
   * client is attached. Drives the resume grace window (MWP-92): the slot is
   * held long enough for a backgrounded client to be woken and resume, then
   * reclaimed.
   */
  clientlessSince: number | null = null;
  notificationTriggers: Trigger[] = [];

  windowWidth = 80;
  windowHeight = 24;

  telnetParser: TelnetParser;

  private onDataCallback: ((data: Buffer) => void) | null = null;
  private onCloseCallbacks: Set<() => void> = new Set();
  private onErrorCallback: ((err: Error) => void) | null = null;

  constructor(
    host: string,
    port: number,
    bufferSizeBytes: number = 50 * 1024,
    dialAddress?: string,
    tlsMode: MudTlsMode = 'prefer',
    dialTimeoutMs = 10_000,
    maxSubnegotiationBytes?: number,
  ) {
    this.id = crypto.randomUUID();
    this.authToken = crypto.randomBytes(32).toString('hex');
    this.createdAt = Date.now();
    this.lastClientConnection = Date.now();
    this.mudHost = host;
    this.mudPort = port;
    // The address actually dialled. In arbitrary mode this is the IP that was
    // validated against the reserved ranges; connecting to the name instead
    // would re-resolve it and reopen the rebinding hole. Defaults to the host
    // so every other mode is unchanged.
    this.dialAddress = dialAddress || host;
    this.tlsMode = tlsMode;
    this.dialTimeoutMs = dialTimeoutMs;
    this.buffer = new CircularBuffer(bufferSizeBytes);
    // Threaded from configuration rather than left to the parser's default, so
    // MAX_SUBNEGOTIATION_BYTES is a setting that is actually consulted. A value
    // parsed by config while enforcement reads something else is the recurring
    // defect on this project (MWP-80).
    this.telnetParser = new TelnetParser(this, maxSubnegotiationBytes);
  }

  /**
   * Connect to MUD server via telnet
   * Auto-detects SSL: tries TLS first, falls back to plain TCP
   * Returns a promise that resolves when connected or rejects on error
   */
  async connect(): Promise<void> {
    if (this.telnetConnected) {
      throw new Error('Session is already connected');
    }

    this.connectAbortController?.abort();
    const controller = new AbortController();
    this.connectAbortController = controller;

    if (this.tlsMode === 'plain') {
      // eslint-disable-next-line no-console
      console.log(
        `[session] INFO MUD_TLS_MODE=plain, using plain TCP for ${this.mudHost}:${this.mudPort}`,
      );
    }

    try {
      await connectMudTransport({
        requestedHost: this.mudHost,
        dialAddress: this.dialAddress,
        port: this.mudPort,
        mode: this.tlsMode,
        dialTimeoutMs: this.dialTimeoutMs,
        signal: controller.signal,
        onDowngrade: (reason) => {
          // eslint-disable-next-line no-console
          console.log(
            `[session] WARN ${reason}, using plain TCP for ${this.mudHost}:${this.mudPort}`,
          );
        },
        onConnected: ({ socket, downgraded }) => {
          this.telnet = socket;
          this.tlsDowngraded = downgraded;
          this.setupTelnetHandlers();
          this.telnetConnected = true;
          if (this.connectAbortController === controller) {
            this.connectAbortController = undefined;
          }
        },
      });
    } finally {
      if (this.connectAbortController === controller) {
        this.connectAbortController = undefined;
      }
    }
  }

  private setupTelnetHandlers(): void {
    if (!this.telnet) return;

    this.telnet.send = (data: string | Buffer) => {
      this.telnet?.write(data);
    };

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
      this.notifyCloseCallbacks();
    });

    this.telnet.on('error', (err: Error) => {
      this.telnetConnected = false;
      if (this.onErrorCallback) {
        this.onErrorCallback(err);
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
    this.onCloseCallbacks.add(callback);
  }

  /**
   * Set callback for telnet error
   */
  onError(callback: (err: Error) => void): void {
    this.onErrorCallback = callback;
  }

  private notifyCloseCallbacks(): void {
    const callbacks = Array.from(this.onCloseCallbacks);
    for (const callback of callbacks) {
      try {
        callback();
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error(
          `[session] close callback failed for ${this.mudHost}:${this.mudPort}: ${err}`,
        );
      }
    }
  }

  /**
   * Attach a WebSocket client to this session
   */
  attachClient(client: SocketExtended): void {
    this.clients.add(client);
    this.clientConnected = true;
    this.lastClientConnection = Date.now();
    // No longer a candidate for the clientless reaper.
    this.clientlessSince = null;
  }

  /**
   * Detach a WebSocket client from this session
   * Does NOT close the telnet connection
   */
  detachClient(client: SocketExtended, now: number = Date.now()): void {
    this.clients.delete(client);
    this.clientConnected = this.clients.size > 0;
    // Stamped only on the transition to zero clients, and re-stamped on each
    // subsequent transition: a client that reattaches and leaves again gets a
    // fresh window rather than inheriting the remains of the old one.
    this.clientlessSince = this.clients.size === 0 ? now : null;
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
    } else if (processed.type === 'echo') {
      metadata.echoSuppressed = processed.echoSuppressed;
    }
    return this.buffer.append(processed.data, processed.type, metadata);
  }

  /**
   * Get buffered output strictly after a sequence the client already has.
   */
  replayAfterSequence(sequence: number): BufferChunk[] {
    return this.buffer.replayAfter(sequence);
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
    const pendingController = this.connectAbortController;
    this.connectAbortController = undefined;
    pendingController?.abort();

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
