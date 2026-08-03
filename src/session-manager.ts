import type { MudTlsMode } from './runtime-config';
/**
 * SessionManager - Manages all active sessions
 *
 * Responsibilities:
 * - Store sessions in Map with UUID keys
 * - Track device token to sessions mapping
 * - Track IP to connection count mapping
 * - Enforce connection limits
 * - Clean up timed-out sessions
 * - Validate session tokens
 */

import { timingSafeEqual } from 'crypto';
import { Session } from './session';
import type { SocketExtended } from './types';

const CLIENT_CLOSE_CLEANUP_DELAY_MS = 200;

export interface SessionManagerConfig {
  timeoutHours: number;
  maxPerDevice: number;
  maxPerIP: number;
  /**
   * Total concurrent sessions across every client, or undefined for no bound.
   *
   * A per-IP limit only limits an attacker who has one address, and addresses
   * are the cheapest thing to acquire: N sources each staying politely under
   * maxPerIP still exhaust the process. Undefined by default so an upgrade
   * does not impose a surprise ceiling on a working deployment.
   */
  maxGlobal?: number;
  /**
   * How long a session with no attached clients keeps its capacity before
   * being reclaimed, or undefined to keep it until the session timeout.
   *
   * Terminating an unresponsive socket does not free its slot — the session is
   * deliberately kept alive for resume — so without this the connection caps
   * bound live clients while dead sessions accumulate underneath for up to
   * timeoutHours. The window exists because a backgrounded mobile client is
   * indistinguishable from a dead one, and silent push runs every 20 minutes:
   * reaping sooner would delete the session before the push that would wake it.
   */
  resumeGraceMs?: number;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private socketToSession: Map<SocketExtended, Session> = new Map();
  private deviceSessions: Map<string, Set<Session>> = new Map();
  private ipConnections: Map<string, number> = new Map();
  private readonly pendingDialCounts = new Map<string, number>();

  // Running totals rather than summing the maps on every reservation, which
  // would be O(distinct addresses) on the hot path — the exact path a flood
  // drives hardest.
  private globalEstablished = 0;
  private globalPendingCount = 0;

  private config: SessionManagerConfig;
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config: Partial<SessionManagerConfig> = {}) {
    this.config = {
      timeoutHours: 24,
      maxPerDevice: 5,
      maxPerIP: 10,
      ...config,
    };

    // Start cleanup interval (every 5 minutes)
    this.cleanupInterval = setInterval(
      () => {
        this.cleanupInactiveSessions();
        // Reclaim capacity from sessions nobody came back to (MWP-92).
        this.reapClientlessSessions();
      },
      5 * 60 * 1000,
    );
  }

  /**
   * Create a new session
   */
  create(
    host: string,
    port: number,
    deviceToken?: string,
    bufferSizeBytes: number = 50 * 1024,
    dialAddress?: string,
    tlsMode?: MudTlsMode,
    maxSubnegotiationBytes?: number,
  ): Session {
    const session = new Session(
      host,
      port,
      bufferSizeBytes,
      dialAddress,
      tlsMode,
      maxSubnegotiationBytes,
    );

    if (deviceToken) {
      session.setDeviceToken(deviceToken);
      this.addDeviceSession(deviceToken, session);
    }

    this.sessions.set(session.id, session);

    // Set up session cleanup handlers
    session.onClose(() => {
      if (session.hasClients()) {
        // Other close observers may need to notify attached clients before
        // removeSession closes the sockets. Keep this longer than the
        // SessionIntegration MUD termination flush window.
        const cleanupTimer = setTimeout(() => {
          this.removeSession(session.id);
        }, CLIENT_CLOSE_CLEANUP_DELAY_MS);
        cleanupTimer.unref?.();
        return;
      }

      this.removeSession(session.id);
    });

    return session;
  }

  /**
   * Get a session by ID
   */
  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Find session by WebSocket
   */
  findByWebSocket(ws: SocketExtended): Session | undefined {
    return this.socketToSession.get(ws);
  }

  /**
   * Validate a session token
   */
  validateToken(sessionId: string, token: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }
    const expected = Buffer.from(session.authToken);
    const actual = Buffer.from(token);
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  /**
   * Associate a WebSocket with a session
   */
  attachWebSocket(sessionId: string, ws: SocketExtended): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    // Remove from old session if exists
    const oldSession = this.socketToSession.get(ws);
    if (oldSession) {
      oldSession.detachClient(ws);
    }

    session.attachClient(ws);
    this.socketToSession.set(ws, session);
    return true;
  }

  /**
   * Detach a WebSocket from its session
   */
  detachWebSocket(ws: SocketExtended, now: number = Date.now()): void {
    const session = this.socketToSession.get(ws);
    if (session) {
      session.detachClient(ws, now);
      this.socketToSession.delete(ws);
    }
  }

  /**
   * Remove a session
   */
  removeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return;
    }

    // Decrement IP count if this session was counted
    if (session.clientIp) {
      this.decrementIPCount(session.clientIp);
    }

    // Clean up device mapping
    if (session.deviceToken) {
      const deviceSessions = this.deviceSessions.get(session.deviceToken);
      if (deviceSessions) {
        deviceSessions.delete(session);
        if (deviceSessions.size === 0) {
          this.deviceSessions.delete(session.deviceToken);
        }
      }
    }

    // Clean up socket mappings
    for (const client of session.clients) {
      this.socketToSession.delete(client);
    }

    // Close the session
    session.close();
    this.sessions.delete(sessionId);
  }

  /**
   * Get all sessions for a device
   */
  getSessionsByDevice(deviceToken: string): Session[] {
    const deviceSessions = this.deviceSessions.get(deviceToken);
    if (!deviceSessions) {
      return [];
    }
    return Array.from(deviceSessions);
  }

  /**
   * Check if connection limits are exceeded
   */
  enforceConnectionLimits(
    deviceToken: string,
    ip: string,
  ): {
    allowed: boolean;
    reason?: string;
  } {
    // Check device limit
    const deviceSessions = this.deviceSessions.get(deviceToken);
    if (deviceSessions && deviceSessions.size >= this.config.maxPerDevice) {
      // Notify and remove oldest session
      const oldest = this.getOldestSession(deviceToken);
      if (oldest) {
        // Notify attached clients before eviction
        const evictionMsg = JSON.stringify({
          type: 'error',
          code: 'session_evicted',
          message: 'Session replaced by a newer connection',
        });
        oldest.broadcastToClients(evictionMsg);
        this.removeSession(oldest.id);
      }
    }

    // Check IP limit
    const ipCount = this.ipConnections.get(ip) || 0;
    if (ipCount >= this.config.maxPerIP) {
      return {
        allowed: false,
        reason: 'Connection limit exceeded for this IP address',
      };
    }

    return { allowed: true };
  }

  /**
   * Increment IP connection count
   */
  /**
   * Reserve capacity for a dial that has not happened yet.
   *
   * enforceConnectionLimits consults counters that are only incremented once
   * a dial succeeds, so concurrent connect frames all pass — nothing has been
   * counted at the moment they are checked. Holding a pending reservation
   * across the expensive steps (DNS, TCP) is what makes the limit real, and
   * is why MWP-92 asks for capacity to be reserved before that work begins.
   *
   * Keyed on the resolved client address, so it applies to clients that send
   * no device token.
   */
  reservePendingDial(ip: string): { allowed: boolean; reason?: string } {
    const established = this.ipConnections.get(ip) || 0;
    const pending = this.pendingDialCounts.get(ip) || 0;

    // Per-IP first, so a single address exhausting its own quota is reported
    // as such. Reporting that as global exhaustion would send an operator to
    // investigate the whole service over one noisy client.
    if (established + pending >= this.config.maxPerIP) {
      return {
        allowed: false,
        reason: 'Too many connections from this address',
      };
    }

    const { maxGlobal } = this.config;
    if (
      maxGlobal !== undefined &&
      this.globalEstablished + this.globalPendingCount >= maxGlobal
    ) {
      return {
        allowed: false,
        reason: 'Server is at global session capacity',
      };
    }

    this.pendingDialCounts.set(ip, pending + 1);
    this.globalPendingCount++;
    return { allowed: true };
  }

  /**
   * Remove sessions that have had no attached client for longer than the
   * configured grace window, releasing their per-IP and global capacity.
   *
   * Returns the number reclaimed. A session with a client attached is never
   * touched, and reattaching clears the timestamp, so a client woken by silent
   * push and resuming is safe.
   */
  reapClientlessSessions(now: number = Date.now()): number {
    const graceMs = this.config.resumeGraceMs;
    if (graceMs === undefined) return 0;

    const expired: string[] = [];
    for (const [id, session] of this.sessions) {
      if (session.hasClients()) continue;
      const since = session.clientlessSince;
      if (since === null) continue;
      // Strictly greater, so a session exactly at the window survives one more
      // pass rather than being reclaimed on the boundary.
      if (now - since > graceMs) expired.push(id);
    }

    for (const id of expired) this.removeSession(id);
    return expired.length;
  }

  /** Pending reservations across every address. Exposed for tests. */
  globalPending(): number {
    return this.globalPendingCount;
  }

  /**
   * Release a reservation. Must be called on every path out of the dial —
   * success, rejection, and error alike. A leaked reservation is capacity
   * that never returns until the process restarts.
   */
  releasePendingDial(ip: string): void {
    const pending = this.pendingDialCounts.get(ip) || 0;
    // A release with nothing reserved for this address must be a no-op.
    // Decrementing the global counter here would manufacture capacity and
    // silently raise the cap.
    if (pending <= 0) return;

    if (pending === 1) this.pendingDialCounts.delete(ip);
    else this.pendingDialCounts.set(ip, pending - 1);

    if (this.globalPendingCount > 0) this.globalPendingCount--;
  }

  /** Pending reservations for an address. Exposed for tests. */
  pendingDials(ip: string): number {
    return this.pendingDialCounts.get(ip) || 0;
  }

  incrementIPCount(ip: string): void {
    const count = this.ipConnections.get(ip) || 0;
    this.ipConnections.set(ip, count + 1);
    this.globalEstablished++;
  }

  /**
   * Decrement IP connection count
   */
  decrementIPCount(ip: string): void {
    const count = this.ipConnections.get(ip) || 0;
    if (count > 0 && this.globalEstablished > 0) this.globalEstablished--;
    if (count > 1) {
      this.ipConnections.set(ip, count - 1);
    } else {
      this.ipConnections.delete(ip);
    }
  }

  /**
   * Get the oldest session for a device
   */
  private getOldestSession(deviceToken: string): Session | undefined {
    const deviceSessions = this.deviceSessions.get(deviceToken);
    if (!deviceSessions || deviceSessions.size === 0) {
      return undefined;
    }

    let oldest: Session | undefined;
    let oldestTime = Infinity;

    for (const session of deviceSessions) {
      if (session.createdAt < oldestTime) {
        oldest = session;
        oldestTime = session.createdAt;
      }
    }

    return oldest;
  }

  /**
   * Add session to device mapping
   */
  private addDeviceSession(deviceToken: string, session: Session): void {
    let sessions = this.deviceSessions.get(deviceToken);
    if (!sessions) {
      sessions = new Set();
      this.deviceSessions.set(deviceToken, sessions);
    }
    sessions.add(session);
  }

  /**
   * Clean up inactive sessions
   */
  cleanupInactiveSessions(): number {
    const now = Date.now();
    const timeoutMs = this.config.timeoutHours * 60 * 60 * 1000;
    const toRemove: string[] = [];

    for (const [id, session] of this.sessions) {
      if (now - session.lastClientConnection > timeoutMs) {
        toRemove.push(id);
      }
    }

    for (const id of toRemove) {
      this.removeSession(id);
    }

    return toRemove.length;
  }

  /**
   * Get total number of active sessions
   */
  getActiveCount(): number {
    return this.sessions.size;
  }

  /**
   * Get all sessions
   */
  getAllSessions(): Session[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session statistics
   */
  getStats(): {
    totalSessions: number;
    connectedSessions: number;
    disconnectedSessions: number;
    uniqueDevices: number;
    uniqueIPs: number;
  } {
    let connected = 0;
    for (const session of this.sessions.values()) {
      if (session.clientConnected) {
        connected++;
      }
    }

    return {
      totalSessions: this.sessions.size,
      connectedSessions: connected,
      disconnectedSessions: this.sessions.size - connected,
      uniqueDevices: this.deviceSessions.size,
      uniqueIPs: this.ipConnections.size,
    };
  }

  /**
   * Stop the cleanup interval
   */
  stop(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Clear all sessions (for shutdown)
   */
  clearAll(): void {
    for (const session of this.sessions.values()) {
      session.close();
    }
    this.sessions.clear();
    this.socketToSession.clear();
    this.deviceSessions.clear();
    this.ipConnections.clear();
  }
}
