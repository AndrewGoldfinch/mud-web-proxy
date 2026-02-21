/**
 * Session Integration - Integrates session persistence into wsproxy.ts
 *
 * This module extends the existing wsproxy.ts with session management.
 * It maintains backward compatibility while adding new functionality.
 */

import { SessionManager } from './session-manager';
import type { Session } from './session';
import type { SocketExtended } from './types';
import { TriggerMatcher } from './trigger-matcher';
import { NotificationManager } from './notification-manager';
import { BackgroundPushScheduler } from './background-push-scheduler';
import type {
  ConnectRequest,
  ResumeRequest,
  ActivityTokenRequest,
  SyncAckRequest,
  InputRequest,
  NAWSRequest,
  ClientMessage,
  ProcessedData,
} from './types';

export interface SessionIntegrationConfig {
  sessions: {
    timeoutHours: number;
    maxPerDevice: number;
    maxPerIP: number;
  };
  buffer: {
    sizeKB: number;
  };
  triggers: {
    rateLimit: {
      perTypePerMinute: number;
      totalPerHour: number;
    };
  };
  apns?: {
    keyPath: string;
    keyId: string;
    teamId: string;
    topic: string;
    environment: 'sandbox' | 'production';
  };
  backgroundPush?: {
    silentPushIntervalMs?: number;
    activityPushIntervalMs?: number;
    activityAckTimeoutMs?: number;
    fallbackCooldownMs?: number;
    maxFallbacksPerHour?: number;
    maxSnippetLength?: number;
  };
}

export class SessionIntegration {
  sessionManager: SessionManager;
  triggerMatcher: TriggerMatcher;
  notificationManager: NotificationManager;
  backgroundPushScheduler: BackgroundPushScheduler;
  config: SessionIntegrationConfig;
  private retryInterval: ReturnType<typeof setInterval> | null = null;

  private log(msg: string, ip?: string, sessionId?: string): void {
    const parts = [new Date().toISOString(), '[session]'];
    if (ip) parts.push(`[${ip}]`);
    if (sessionId) parts.push(`[sid:${sessionId}]`);
    parts.push(msg);
    // eslint-disable-next-line no-console
    console.log(parts.join(' '));
  }

  constructor(config: Partial<SessionIntegrationConfig> = {}) {
    this.config = {
      sessions: {
        timeoutHours: 24,
        maxPerDevice: 5,
        maxPerIP: 10,
      },
      buffer: {
        sizeKB: 50,
      },
      triggers: {
        rateLimit: {
          perTypePerMinute: 1,
          totalPerHour: 10,
        },
      },
      ...config,
    };

    this.sessionManager = new SessionManager(this.config.sessions);
    this.triggerMatcher = new TriggerMatcher(this.config.triggers);
    this.notificationManager = new NotificationManager(
      {
        enabled: !!this.config.apns,
        apns: this.config.apns,
      },
      this.triggerMatcher,
    );
    this.backgroundPushScheduler = new BackgroundPushScheduler(
      this.notificationManager,
      this.config.backgroundPush,
    );

    // Start notification retry processor and trigger cleanup
    this.retryInterval = setInterval(() => {
      this.notificationManager.processPending();
      this.triggerMatcher.cleanupOldEntries();
    }, 60 * 1000);

    this.log(
      'Initialized with buffer size: ' + this.config.buffer.sizeKB + 'KB',
    );
  }

  /**
   * Remove a session and clean up its rate limit state
   */
  private removeSessionAndCleanup(sessionId: string): void {
    this.notificationManager.cleanupSession(sessionId);
    this.backgroundPushScheduler.untrackSession(sessionId);
    this.sessionManager.removeSession(sessionId);
  }

  /**
   * Parse new-style client messages (connect, resume, input, naws, disconnect)
   * Returns true if message was handled, false otherwise
   */
  parseNewMessage(socket: SocketExtended, data: Buffer): boolean {
    try {
      const msg = data.toString();

      // Check if it's JSON (starts with {)
      if (msg.trim()[0] !== '{') {
        return false;
      }

      const parsed = JSON.parse(msg) as ClientMessage;

      // Only handle messages with type field
      if (!('type' in parsed)) {
        return false;
      }

      const clientMsg = parsed;

      if (socket.debug) {
        // Redact sensitive fields before logging
        const sanitized = { ...parsed };
        if ('token' in sanitized) sanitized.token = '***';
        if ('deviceToken' in sanitized) sanitized.deviceToken = '***';
        this.log(
          `client msg: ${JSON.stringify(sanitized)}`,
          socket.remoteAddress,
        );
      }

      switch (clientMsg.type) {
        case 'connect':
          this.handleConnect(socket, clientMsg);
          return true;
        case 'resume':
          this.handleResume(socket, clientMsg);
          return true;
        case 'activityToken':
          this.handleActivityToken(socket, clientMsg);
          return true;
        case 'syncAck':
          this.handleSyncAck(socket, clientMsg);
          return true;
        case 'input':
          this.handleInput(socket, clientMsg);
          return true;
        case 'naws':
          this.handleNAWS(socket, clientMsg);
          return true;
        case 'disconnect':
          this.handleDisconnect(socket);
          return true;
        default:
          return false;
      }
    } catch (_err) {
      // Not valid JSON or new format
      return false;
    }
  }

  /**
   * Handle connect request - create new session
   */
  private async handleConnect(
    socket: SocketExtended,
    msg: ConnectRequest,
  ): Promise<void> {
    const ip =
      socket.remoteAddress ||
      socket.req?.connection?.remoteAddress ||
      'unknown';

    this.log(`connect request to ${msg.host}:${msg.port}`, ip);

    // Enable per-client debug logging if requested
    if (msg.debug) socket.debug = msg.debug;

    // Check connection limits
    if (msg.deviceToken) {
      const limits = this.sessionManager.enforceConnectionLimits(
        msg.deviceToken,
        ip,
      );
      if (!limits.allowed) {
        this.log(
          `connect rejected: ${limits.reason || 'Connection limit exceeded'}`,
          ip,
        );
        this.sendError(
          socket,
          'rate_limited',
          limits.reason || 'Connection limit exceeded',
        );
        return;
      }
    }

    // Create new session
    const session = this.sessionManager.create(
      msg.host,
      msg.port,
      msg.deviceToken,
      this.config.buffer.sizeKB * 1024,
    );

    // Set device token and window size
    if (msg.deviceToken) {
      session.setDeviceToken(msg.deviceToken);
    }
    if (msg.width && msg.height) {
      session.updateWindowSize(msg.width, msg.height);
    }

    // Attach WebSocket to session
    this.sessionManager.attachWebSocket(session.id, socket);
    session.markClientForegrounded();
    this.backgroundPushScheduler.untrackSession(session.id);

    if (msg.deviceToken) {
      this.sessionManager.incrementIPCount(ip);
    }

    // Send session response
    const response = {
      type: 'session',
      sessionId: session.id,
      token: session.authToken,
      capabilities: ['activityToken', 'syncAck'],
    };
    socket.sendUTF(JSON.stringify(response));

    this.log(`session created for ${msg.host}:${msg.port}`, ip, session.id);

    // Connect to MUD
    try {
      // Set up data and close handlers BEFORE connecting so no initial
      // MUD output (welcome banners, login prompts) is lost.
      session.onData((data: Buffer) => {
        this.processMudData(session, socket, data);
      });

      session.onClose(() => {
        this.sendError(socket, 'connection_failed', 'MUD connection closed');
        this.removeSessionAndCleanup(session.id);
      });

      await session.connect();

      // Set up error handler
      session.onError((err: Error) => {
        this.sendError(socket, 'connection_failed', err.message);
        this.removeSessionAndCleanup(session.id);
      });
    } catch (err) {
      this.log(`connect failed: ${(err as Error).message}`, ip, session.id);
      this.sendError(socket, 'connection_failed', (err as Error).message);
      this.removeSessionAndCleanup(session.id);
    }
  }

  /**
   * Handle resume request - reattach to existing session
   */
  private handleResume(socket: SocketExtended, msg: ResumeRequest): void {
    const ip =
      socket.remoteAddress ||
      socket.req?.connection?.remoteAddress ||
      'unknown';
    this.log(
      `resume request for session ${msg.sessionId} from seq ${msg.lastSeq}`,
      ip,
      msg.sessionId,
    );

    // Validate token
    if (!this.sessionManager.validateToken(msg.sessionId, msg.token)) {
      this.log('resume rejected: invalid token', ip, msg.sessionId);
      this.sendError(
        socket,
        'invalid_resume',
        'Session not found or token invalid',
      );
      return;
    }

    // Get session
    const session = this.sessionManager.get(msg.sessionId);
    if (!session) {
      this.log('resume rejected: session not found', ip, msg.sessionId);
      this.sendError(socket, 'invalid_resume', 'Session not found');
      return;
    }

    // Check if session timed out
    if (session.isTimedOut(this.config.sessions.timeoutHours)) {
      this.log('resume rejected: session expired', ip, msg.sessionId);
      this.removeSessionAndCleanup(msg.sessionId);
      this.sendError(socket, 'session_expired', 'Session has expired');
      return;
    }

    // Attach WebSocket
    this.sessionManager.attachWebSocket(msg.sessionId, socket);
    session.markClientForegrounded();
    this.backgroundPushScheduler.untrackSession(msg.sessionId);

    // Update device token if provided
    if (msg.deviceToken) {
      session.setDeviceToken(msg.deviceToken);
    }

    // Replay buffered output
    const chunks = session.replayFromSequence(msg.lastSeq);
    for (const chunk of chunks) {
      if (chunk.type === 'gmcp') {
        const response = {
          type: 'gmcp',
          seq: chunk.sequence,
          package: chunk.gmcpPackage,
          data: chunk.gmcpData,
        };
        socket.sendUTF(JSON.stringify(response));
      } else {
        const response = {
          type: 'data',
          seq: chunk.sequence,
          payload: chunk.data.toString('base64'),
        };
        socket.sendUTF(JSON.stringify(response));
      }
    }

    this.log(
      `resume successful, replayed ${chunks.length} chunks`,
      ip,
      msg.sessionId,
    );
  }

  private handleActivityToken(
    socket: SocketExtended,
    msg: ActivityTokenRequest,
  ): void {
    const session = this.sessionManager.findByWebSocket(socket);
    if (!session) {
      return;
    }

    session.setActivityPushToken(msg.token);
  }

  private handleSyncAck(_socket: SocketExtended, msg: SyncAckRequest): void {
    this.backgroundPushScheduler.recordSyncAck(msg.sessionId, msg.lastSeq);
  }

  /**
   * Handle input - send command to MUD
   */
  private handleInput(socket: SocketExtended, msg: InputRequest): void {
    const session = this.sessionManager.findByWebSocket(socket);
    if (!session) {
      return;
    }

    session.sendToMud(msg.text);
  }

  /**
   * Handle NAWS - update window size
   */
  private handleNAWS(socket: SocketExtended, msg: NAWSRequest): void {
    const session = this.sessionManager.findByWebSocket(socket);
    if (session) {
      session.updateWindowSize(msg.width, msg.height);
    }
  }

  /**
   * Handle disconnect request - close session and telnet connection
   */
  private handleDisconnect(socket: SocketExtended): void {
    const ip =
      socket.remoteAddress ||
      socket.req?.connection?.remoteAddress ||
      'unknown';

    const session = this.sessionManager.findByWebSocket(socket);
    if (!session) {
      this.sendError(socket, 'invalid_request', 'No session found');
      return;
    }

    const sessionId = session.id;
    this.log('disconnect request', ip, sessionId);

    // Send ack to client before closing (session.close() terminates
    // all attached WebSocket clients, so we must send first)
    const response = {
      type: 'disconnected',
      sessionId,
    };
    try {
      socket.sendUTF(JSON.stringify(response));
    } catch (_err) {
      // Socket might be closed
    }

    // Close the telnet connection and clean up session
    session.close();
    this.removeSessionAndCleanup(sessionId);

    // Decrement IP count
    if (ip && ip !== 'unknown') {
      this.sessionManager.decrementIPCount(ip);
    }

    this.log('session disconnected and removed', ip, sessionId);
  }

  /**
   * Process MUD data - strip telnet, buffer, and forward to clients
   */
  private processMudData(
    session: Session,
    _socket: SocketExtended,
    data: Buffer,
  ): void {
    // Run through telnet parser to strip IAC sequences and extract GMCP
    const result = session.telnetParser.process(data);

    // Check for notifications when no clients connected
    if (!session.hasClients() && result.text.length > 0) {
      const text = result.text.toString('utf8');
      const match = this.notificationManager.processOutput(text, session.id);

      if (match && session.deviceToken) {
        this.notificationManager
          .sendNotification(session.deviceToken, match, session.id)
          .catch((err) => {
            this.log(
              'Failed to send notification: ' + err,
              undefined,
              session.id,
            );
          });
      }
    }

    // Buffer and forward GMCP messages
    for (const gmcp of result.gmcpMessages) {
      let gmcpData: object;
      try {
        gmcpData = gmcp.data ? JSON.parse(gmcp.data) : {};
      } catch {
        gmcpData = { raw: gmcp.data };
      }

      const processed: ProcessedData = {
        data: Buffer.from(gmcp.data || '', 'utf8'),
        type: 'gmcp',
        gmcpPackage: gmcp.package,
        gmcpData,
      };
      const chunk = session.bufferOutput(processed);

      const response = {
        type: 'gmcp',
        seq: chunk.sequence,
        package: gmcp.package,
        data: gmcpData,
      };
      session.broadcastToClients(JSON.stringify(response));
    }

    // Buffer and forward clean text (skip if empty — pure negotiation chunk)
    if (result.text.length > 0) {
      const processed: ProcessedData = {
        data: result.text,
        type: 'data',
      };
      const chunk = session.bufferOutput(processed);

      const response = {
        type: 'data',
        seq: chunk.sequence,
        payload: result.text.toString('base64'),
      };
      session.broadcastToClients(JSON.stringify(response));

      if (!session.hasClients()) {
        void this.backgroundPushScheduler.onBufferedOutput(
          session,
          chunk.sequence,
          result.text.toString('utf8'),
        );
      }
    }
  }

  /**
   * Send error response to client
   */
  private sendError(
    socket: SocketExtended,
    code: string,
    message: string,
  ): void {
    const response = {
      type: 'error',
      code,
      message,
    };
    try {
      socket.sendUTF(JSON.stringify(response));
    } catch (_err) {
      // Socket might be closed
    }
  }

  /**
   * Handle WebSocket close - detach from session
   */
  handleSocketClose(socket: SocketExtended): void {
    const session = this.sessionManager.findByWebSocket(socket);
    if (session) {
      const ip =
        socket.remoteAddress ||
        socket.req?.connection?.remoteAddress ||
        'unknown';
      this.log('client detached from session', ip, session.id);

      // Detach instead of terminate
      this.sessionManager.detachWebSocket(socket);
      if (!session.hasClients() && session.telnetConnected) {
        session.markClientBackgrounded();
        this.backgroundPushScheduler.trackSession(session);
      }

      // Decrement IP count
      if (ip && ip !== 'unknown') {
        this.sessionManager.decrementIPCount(ip);
      }
    }
  }

  /**
   * Check if socket is part of a session
   */
  hasSession(socket: SocketExtended): boolean {
    return !!this.sessionManager.findByWebSocket(socket);
  }

  /**
   * Get session for socket
   */
  getSession(socket: SocketExtended) {
    return this.sessionManager.findByWebSocket(socket);
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      sessions: this.sessionManager.getStats(),
      notifications: this.notificationManager.getStatus(),
    };
  }

  /**
   * Clean up on shutdown
   */
  shutdown(): void {
    if (this.retryInterval) {
      clearInterval(this.retryInterval);
      this.retryInterval = null;
    }
    this.sessionManager.stop();
    this.sessionManager.clearAll();
  }
}

// Export singleton instance creator
export function createSessionIntegration(
  config?: Partial<SessionIntegrationConfig>,
): SessionIntegration {
  return new SessionIntegration(config);
}
