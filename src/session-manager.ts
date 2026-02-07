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

import { Session } from './session';
import type { SocketExtended } from './types';

export interface SessionManagerConfig {
  timeoutHours: number;
  maxPerDevice: number;
  maxPerIP: number;
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private socketToSession: Map<SocketExtended, Session> = new Map();
  private deviceSessions: Map<string, Set<Session>> = new Map();
  private ipConnections: Map<string, number> = new Map();

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
  ): Session {
    const session = new Session(host, port, bufferSizeBytes);

    if (deviceToken) {
      session.setDeviceToken(deviceToken);
      this.addDeviceSession(deviceToken, session);
    }

    this.sessions.set(session.id, session);

    // Set up session cleanup handlers
    session.onClose(() => {
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
    return session.authToken === token;
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
  detachWebSocket(ws: SocketExtended): void {
    const session = this.socketToSession.get(ws);
    if (session) {
      session.detachClient(ws);
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
      // Remove oldest session
      const oldest = this.getOldestSession(deviceToken);
      if (oldest) {
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
  incrementIPCount(ip: string): void {
    const count = this.ipConnections.get(ip) || 0;
    this.ipConnections.set(ip, count + 1);
  }

  /**
   * Decrement IP connection count
   */
  decrementIPCount(ip: string): void {
    const count = this.ipConnections.get(ip) || 0;
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
