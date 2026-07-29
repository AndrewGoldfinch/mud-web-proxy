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
import {
  resolveTargetAddress,
  validateTarget,
  type ResolvedTarget,
  type TargetPolicyConfig,
} from './target-policy';
import type { MudTlsMode } from './runtime-config';
import { resolveClientAddress } from './wsproxy-utils';
import {
  recognize,
  validateTyped,
  KNOWN_TYPES,
  type ParseOutcome,
  type KnownType,
} from './client-protocol';
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
  targets?: TargetPolicyConfig;
  /** Injectable for tests; defaults to real DNS resolution. */
  resolveTarget?: (host: string) => Promise<ResolvedTarget>;
  /** Upstream TLS policy. Defaults to `prefer`, matching prior behaviour. */
  mudTlsMode?: MudTlsMode;
  trustedProxyCidrs?: boolean | string[];
}

export class SessionIntegration {
  sessionManager: SessionManager;
  triggerMatcher: TriggerMatcher;
  notificationManager: NotificationManager;
  backgroundPushScheduler: BackgroundPushScheduler;
  config: SessionIntegrationConfig;
  private retryInterval: ReturnType<typeof setInterval> | null = null;
  private terminatingSessions: Set<string> = new Set();

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
   * Handle terminal telnet/MUD disconnect while preserving a clear signal to
   * any still-attached WebSocket clients.
   */
  private handleMudTermination(session: Session, reason: string): void {
    if (this.terminatingSessions.has(session.id)) {
      return;
    }
    this.terminatingSessions.add(session.id);

    this.log(`MUD terminated: ${reason}`, undefined, session.id);

    const hasClients = session.hasClients();
    if (hasClients) {
      const disconnectedResponse = {
        type: 'disconnected',
        sessionId: session.id,
        reason,
      };
      session.broadcastToClients(JSON.stringify(disconnectedResponse));
    }

    const cleanup = () => {
      this.removeSessionAndCleanup(session.id);
      this.terminatingSessions.delete(session.id);
    };

    if (hasClients) {
      // Give the socket a brief window to flush terminal state before close.
      setTimeout(cleanup, 150);
    } else {
      cleanup();
    }
  }

  /**
   * Classify and dispatch one client message.
   *
   * Three outcomes, not two. The old boolean conflated "not my message,
   * forward it to the MUD" with "my message, but I could not handle it",
   * which is how malformed control messages ended up typed into the game.
   */
  parseNewMessage(socket: SocketExtended, data: Buffer): ParseOutcome {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.toString());
    } catch (_err) {
      // Not JSON: ordinary player input, belongs to the MUD.
      return { kind: 'not-ours' };
    }

    const recognition = recognize(parsed);
    if (recognition.shape === 'unrecognized') {
      return {
        kind: 'not-ours',
        parsedObject:
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined,
      };
    }

    const o = parsed as Record<string, unknown>;

    if (recognition.shape === 'legacy') {
      // Wired in Task 4. Until then a legacy message is rejected rather than
      // forwarded, which is already an improvement on the current behaviour.
      return {
        kind: 'invalid',
        code: 'invalid_request',
        field: 'connect',
        reason: 'Legacy connect is not yet supported',
      };
    }

    if (!(KNOWN_TYPES as readonly string[]).includes(recognition.type)) {
      return {
        kind: 'invalid',
        code: 'invalid_request',
        field: 'type',
        reason: `Unknown message type: ${recognition.type}`,
      };
    }

    const validation = validateTyped(recognition.type, o);
    if (!validation.ok) {
      return {
        kind: 'invalid',
        code: 'invalid_request',
        field: validation.field,
        reason: validation.reason,
      };
    }

    const clientMsg = parsed as ClientMessage;

    if (socket.debug) {
      // Redact sensitive fields before logging
      const sanitized = { ...o };
      if ('token' in sanitized) sanitized.token = '***';
      if ('deviceToken' in sanitized) sanitized.deviceToken = '***';
      this.log(
        `client msg: ${JSON.stringify(sanitized)}`,
        this.getClientIP(socket),
      );
    }

    switch (recognition.type as KnownType) {
      case 'connect':
        void this.handleConnect(socket, clientMsg as ConnectRequest);
        return { kind: 'handled' };
      case 'resume':
        this.handleResume(socket, clientMsg as ResumeRequest);
        return { kind: 'handled' };
      case 'activityToken':
        this.handleActivityToken(socket, clientMsg as ActivityTokenRequest);
        return { kind: 'handled' };
      case 'syncAck':
        this.handleSyncAck(socket, clientMsg as SyncAckRequest);
        return { kind: 'handled' };
      case 'input':
        this.handleInput(socket, clientMsg as InputRequest);
        return { kind: 'handled' };
      case 'naws':
        this.handleNAWS(socket, clientMsg as NAWSRequest);
        return { kind: 'handled' };
      case 'disconnect':
        this.handleDisconnect(socket);
        return { kind: 'handled' };
    }
  }

  /**
   * Render a protocol-level rejection to a typed client. Legacy clients are
   * handled separately in openTelnetSession, which writes plaintext into the
   * telnet stream instead.
   */
  sendProtocolError(
    socket: SocketExtended,
    outcome: { code: string; field?: string; reason: string },
  ): void {
    const response = {
      type: 'error',
      code: outcome.code,
      field: outcome.field,
      message: outcome.reason,
    };
    try {
      socket.sendUTF(JSON.stringify(response));
    } catch (_err) {
      // Socket might be closed
    }
  }

  /**
   * Handle connect request - create new session
   */
  private async handleConnect(
    socket: SocketExtended,
    msg: ConnectRequest,
  ): Promise<void> {
    const ip = this.getClientIP(socket);

    this.log(`connect request to ${msg.host}:${msg.port}`, ip);

    // Enable per-client debug logging if requested
    if (msg.debug) socket.debug = msg.debug;

    const target = validateTarget(msg.host, msg.port, this.config.targets);
    if (!target.allowed || !target.host || !target.port) {
      this.log(
        `connect rejected: ${target.reason || 'Target not allowed'}`,
        ip,
      );
      this.sendError(
        socket,
        'invalid_request',
        target.reason || 'Target not allowed',
      );
      return;
    }

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

    // Reserve capacity BEFORE any DNS or TCP work. enforceConnectionLimits
    // above consults counters that are only incremented once a dial
    // succeeds, so without this a client could issue many concurrent connect
    // frames and pass every check — and omitting deviceToken skipped the
    // device limit entirely. The reservation is released on every path out
    // of here; a leaked one is capacity that never returns (MWP-92).
    const reservation = this.sessionManager.reservePendingDial(ip);
    if (!reservation.allowed) {
      const reason = reservation.reason || 'Connection limit exceeded';
      this.log(`connect rejected: ${reason}`, ip);
      this.sendError(socket, 'rate_limited', reason);
      return;
    }

    // In arbitrary mode the hostname is client-supplied, so resolve it and
    // confirm every answer is publicly routable before dialling. Resolution
    // happens once and we dial the address it returned — re-resolving between
    // validation and connect is the DNS rebinding hole.
    //
    // Deliberately last of the three checks: policy and connection limits are
    // both cheap and must gate the expensive step, so a client cannot drive
    // unbounded DNS lookups without consuming quota (MWP-92). Skipped entirely
    // in fixed and allowlist mode, where the target is operator-configured
    // rather than client-supplied.
    let dialAddress = target.host;
    if (this.config.targets?.targetMode === 'arbitrary') {
      const resolve = this.config.resolveTarget ?? resolveTargetAddress;
      const resolved = await resolve(target.host);
      if (!resolved.allowed || !resolved.address) {
        this.sessionManager.releasePendingDial(ip);
        const reason = resolved.reason || 'Target address is not permitted';
        this.log(`connect rejected: ${reason}`, ip);
        this.sendError(socket, 'invalid_request', reason);
        return;
      }
      dialAddress = resolved.address;
    }

    // Create new session
    const session = this.sessionManager.create(
      target.host,
      target.port,
      msg.deviceToken,
      this.config.buffer.sizeKB * 1024,
      dialAddress,
      this.config.mudTlsMode ?? 'prefer',
    );
    // The session now owns this client's capacity; hand off from the
    // reservation so it is not counted twice.
    this.sessionManager.releasePendingDial(ip);

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

    // Send session response
    const response = {
      type: 'session',
      sessionId: session.id,
      token: session.authToken,
      capabilities: ['activityToken', 'syncAck', 'echoState'],
    };
    socket.sendUTF(JSON.stringify(response));

    this.log(
      `session created for ${target.host}:${target.port}`,
      ip,
      session.id,
    );

    // Connect to MUD
    try {
      // Set up data and close handlers BEFORE connecting so no initial
      // MUD output (welcome banners, login prompts) is lost.
      session.onData((data: Buffer) => {
        this.processMudData(session, socket, data);
      });

      session.onClose(() => {
        this.handleMudTermination(session, 'MUD connection closed');
      });

      await session.connect();

      // Count this IP only after a successful connection; clientIp on the
      // session is what removeSession uses to decrement on teardown.
      if (msg.deviceToken && ip !== 'unknown') {
        session.clientIp = ip;
        this.sessionManager.incrementIPCount(ip);
      }

      // Set up error handler
      session.onError((err: Error) => {
        this.handleMudTermination(session, err.message);
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
    const ip = this.getClientIP(socket);
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

    // Confirm resume before replay so client can complete resume handshake
    // without waiting for buffered data timing.
    const resumedResponse = {
      type: 'resumed',
      sessionId: session.id,
      capabilities: ['activityToken', 'syncAck', 'echoState'],
    };
    socket.sendUTF(JSON.stringify(resumedResponse));

    // Replay buffered output
    const chunks = session.replayFromSequence(msg.lastSeq);
    for (const chunk of chunks) {
      if (chunk.type === 'gmcp') {
        const response = {
          type: 'gmcp',
          seq: chunk.sequence,
          package: chunk.gmcpPackage,
          data: chunk.gmcpData,
          replayed: true,
        };
        socket.sendUTF(JSON.stringify(response));
      } else if (chunk.type === 'echo') {
        const response = {
          type: 'echo',
          seq: chunk.sequence,
          suppressed: chunk.echoSuppressed,
          replayed: true,
        };
        socket.sendUTF(JSON.stringify(response));
      } else {
        const response = {
          type: 'data',
          seq: chunk.sequence,
          payload: chunk.data.toString('base64'),
          replayed: true,
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
    const ip = this.getClientIP(socket);

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
    // (removeSessionAndCleanup → removeSession handles IP count decrement)
    session.close();
    this.removeSessionAndCleanup(sessionId);

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

    // Buffer and forward text/echo segments in the exact order the MUD produced them.
    // Splitting at each ECHO transition (rather than combining all text for the chunk)
    // lets the client apply suppression at the right boundary — e.g. a password the MUD
    // echoes back followed by `WONT ECHO` in the same TCP read.
    for (const segment of result.segments) {
      if (segment.kind === 'text') {
        if (segment.data.length === 0) continue;

        const processed: ProcessedData = {
          data: segment.data,
          type: 'data',
        };
        const chunk = session.bufferOutput(processed);

        const response = {
          type: 'data',
          seq: chunk.sequence,
          payload: segment.data.toString('base64'),
        };
        session.broadcastToClients(JSON.stringify(response));

        if (!session.hasClients()) {
          void this.backgroundPushScheduler.onBufferedOutput(
            session,
            chunk.sequence,
            segment.data.toString('utf8'),
          );
        }
      } else {
        const processed: ProcessedData = {
          data: Buffer.alloc(0),
          type: 'echo',
          echoSuppressed: segment.suppressed,
        };
        const chunk = session.bufferOutput(processed);

        const response = {
          type: 'echo',
          seq: chunk.sequence,
          suppressed: segment.suppressed,
        };
        session.broadcastToClients(JSON.stringify(response));
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
      this.log(
        'client detached from session',
        this.getClientIP(socket),
        session.id,
      );

      // Detach instead of terminate — session stays alive for resume.
      // IP count is NOT decremented here; it tracks sessions, not sockets,
      // and is decremented only when the session itself is destroyed.
      this.sessionManager.detachWebSocket(socket);
      if (!session.hasClients() && session.telnetConnected) {
        session.markClientBackgrounded();
        this.backgroundPushScheduler.trackSession(session);
      }
    }
  }

  /**
   * Check if socket is part of a session
   */
  private getClientIP(socket: SocketExtended): string {
    // Shared with wsproxy.ts. Two copies of this diverged once already,
    // leaving the rate limiter and the logger disagreeing about the client.
    return (
      resolveClientAddress(
        socket.remoteAddress || socket.req?.connection?.remoteAddress,
        socket.req?.headers ?? {},
        this.config.trustedProxyCidrs,
      ) || 'unknown'
    );
  }

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
      apnsReadiness: this.notificationManager.getReadiness(),
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
