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
import type { MudTlsMode } from './runtime-config';
import { parseIPv4 } from './wsproxy-utils';
import type {
  BufferChunk,
  ProcessedData,
  SocketExtended,
  TelnetSocket,
  Trigger,
} from './types';
import { CircularBuffer } from './circular-buffer';
import { TelnetParser } from './telnet-parser';

/**
 * The value to present as TLS SNI, or undefined when there is none.
 *
 * Node rejects an IP address outright ("Setting the TLS ServerName to an IP
 * address is not permitted"), so a target given as a literal must be dialled
 * without SNI rather than with its own address.
 */
export type TlsFallbackTrigger = 'error' | 'close';

/**
 * Is this error evidence that the peer does not speak TLS, as opposed to a
 * transport problem?
 *
 * Fails closed: an error we cannot classify is not evidence of plaintext, so
 * it is not grounds to retry without encryption.
 */
/**
 * Node reports a peer closing during the TLS handshake as an *error* carrying
 * ECONNRESET, not as a close event. It is the primary signal that a MUD does
 * not speak TLS, so it has to be recognized before transport codes are used
 * to rule an error out.
 */
const TLS_HANDSHAKE_CLOSE =
  /socket disconnected before secure tls connection was established/;

/**
 * Diagnostics that only a TLS stack produces. Deliberately specific: matching
 * a bare "tls" or "ssl" substring also matches the *hostname* in messages like
 * `getaddrinfo ENOTFOUND ssl.example.org`, which would turn a DNS failure into
 * grounds for a plaintext retry.
 */
const TLS_DIAGNOSTICS = [
  'wrong version number',
  'packet length',
  'unable to verify',
  'certificate',
  'ssl routines',
  'tls_process',
  'tlsv1',
  'sslv3',
  'alert handshake failure',
  'unsupported protocol',
  'no cipher',
  'decryption failed',
  'bad record mac',
];

/** Transport failures: the host is unreachable, not asking for cleartext. */
const TRANSPORT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
]);

/**
 * Is this error evidence that the peer does not speak TLS, as opposed to a
 * transport problem?
 *
 * Fails closed: an error we cannot classify is not evidence of plaintext, so
 * it is not grounds to retry without encryption.
 */
export const isTlsNegotiationError = (err: Error): boolean => {
  const msg = err.message.toLowerCase();

  // The one transport-coded error that genuinely is a TLS signal.
  if (TLS_HANDSHAKE_CLOSE.test(msg)) return true;

  // Otherwise a transport code settles it, before any substring matching can
  // be fooled by a hostname.
  const code = (err as NodeJS.ErrnoException).code;
  if (code && TRANSPORT_CODES.has(code)) return false;

  return TLS_DIAGNOSTICS.some((pattern) => msg.includes(pattern));
};

/** Should a TLS connection be attempted at all? */
export const shouldAttemptTls = (mode: MudTlsMode): boolean =>
  mode !== 'plain';

/**
 * May this connection retry in plaintext?
 *
 * `required` never may — that is the whole point of the mode, and it holds for
 * a peer that closes mid-handshake as much as for one that errors. `prefer`
 * may, but only on evidence the peer does not speak TLS: a negotiation error,
 * or a close during the handshake, which is how a plaintext server typically
 * answers a ClientHello.
 */
export const shouldFallBackToPlain = (
  mode: MudTlsMode,
  trigger: TlsFallbackTrigger,
  err?: Error,
): boolean => {
  if (mode !== 'prefer') return false;
  if (trigger === 'close') return true;
  return err ? isTlsNegotiationError(err) : false;
};

export const sniServerName = (host: string): string | undefined => {
  if (!host) return undefined;
  const bare = host.startsWith('::ffff:') ? host.slice(7) : host;
  if (parseIPv4(bare)) return undefined;
  if (host.includes(':')) return undefined; // IPv6 literal
  return host;
};

export class Session {
  id: string;
  authToken: string;
  createdAt: number;
  lastClientConnection: number;

  mudHost: string;
  dialAddress: string;
  tlsMode: MudTlsMode;
  /** True when a `prefer` connection ended up in plaintext. */
  tlsDowngraded = false;
  mudPort: number;

  telnet: TelnetSocket | null = null;
  telnetConnected = false;
  private closing = false;

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

      const tryPlain = (reason = 'TLS failed') => {
        if (triedPlain) return;
        triedPlain = true;

        if (this.closing) {
          if (!settled) {
            settled = true;
            reject(new Error('Session closed during connect'));
          }
          return;
        }

        // A downgrade must be conspicuous. Logged at WARN with the reason,
        // because the failure this mode guards against is one that looks
        // exactly like normal operation.
        const level = this.tlsDowngraded ? 'WARN ' : 'INFO ';
        // eslint-disable-next-line no-console
        console.log(
          `[session] ${level}${reason}, using plain TCP for ${this.mudHost}:${this.mudPort}`,
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
            this.dialAddress,
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

      if (!shouldAttemptTls(this.tlsMode)) {
        tryPlain('MUD_TLS_MODE=plain');
        return;
      }

      try {
        const onTlsConnectError = (err: Error): void => {
          if (settled) return;
          if (shouldFallBackToPlain(this.tlsMode, 'error', err)) {
            this.tlsDowngraded = true;
            tryPlain(`TLS failed (${err.message})`);
          } else {
            settled = true;
            reject(err);
          }
        };
        const onTlsConnectClose = (): void => {
          if (settled || this.closing) return;
          if (!shouldFallBackToPlain(this.tlsMode, 'close')) {
            settled = true;
            reject(
              new Error(
                'MUD_TLS_MODE=required: peer closed the connection during the ' +
                  'TLS handshake and plaintext fallback is not permitted',
              ),
            );
            return;
          }
          this.tlsDowngraded = true;
          tryPlain('peer closed during TLS handshake');
        };

        const tlsSocket = tls.connect(this.mudPort, this.dialAddress, {
          // Present the requested hostname so certificate verification still
          // works against the name the user asked for, not the IP we dialled.
          // Omitted when the target is itself a literal — Node rejects an IP
          // as SNI.
          servername: sniServerName(this.mudHost),
        }) as unknown as TelnetSocket;
        this.telnet = tlsSocket;
        tlsSocket.once('secureConnect', () => {
          tlsSocket.off('error', onTlsConnectError);
          tlsSocket.off('close', onTlsConnectClose);
          if (abortIfClosing(tlsSocket)) return;
          this.setupTelnetHandlers((err: Error) => {
            if (!settled) reject(err);
          });
          this.telnetConnected = true;
          settled = true;
          resolve();
        });
        tlsSocket.once('error', onTlsConnectError);
        tlsSocket.once('close', onTlsConnectClose);
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
      this.notifyCloseCallbacks();
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
