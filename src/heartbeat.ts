/**
 * Liveness bookkeeping for WebSocket peers (MWP-92).
 *
 * A half-open connection — a closed laptop lid, a NAT that dropped its mapping
 * without telling either end — holds its session slot until the 24-hour
 * session timeout. The connection caps then bound live clients while dead ones
 * accumulate underneath, which is the opposite of what a capacity limit is
 * for. Pings are what actually reclaim that capacity.
 *
 * This class deliberately knows nothing about sockets or timers. It answers
 * one question — which peers have stopped responding — against an injected
 * clock, so the behaviour can be tested at a boundary rather than by waiting
 * out a real interval. The caller owns pinging and terminating.
 */

export interface HeartbeatOptions {
  /** How often the caller intends to ping. */
  intervalMs: number;
  /** Silence beyond this is treated as a dead peer. */
  timeoutMs: number;
  /** Injectable clock; defaults to Date.now. */
  now?: () => number;
}

export class HeartbeatMonitor<T> {
  private readonly lastSeen = new Map<T, number>();
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(options: HeartbeatOptions) {
    const { intervalMs, timeoutMs } = options;

    if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
      throw new Error(
        `Heartbeat interval must be a positive number of milliseconds (got ${intervalMs}).`,
      );
    }
    // A timeout at or below the interval reclaims every peer before the first
    // ping could possibly be answered, so it is a misconfiguration rather than
    // an aggressive setting.
    if (!Number.isFinite(timeoutMs) || timeoutMs <= intervalMs) {
      throw new Error(
        `Heartbeat timeout (${timeoutMs}ms) must be greater than the interval (${intervalMs}ms), ` +
          'or peers are reclaimed before they can answer.',
      );
    }

    this.intervalMs = intervalMs;
    this.timeoutMs = timeoutMs;
    this.now = options.now ?? Date.now;
  }

  /** Begin watching a peer. Idempotent. */
  track(peer: T): void {
    if (!this.lastSeen.has(peer)) this.lastSeen.set(peer, this.now());
  }

  /**
   * Record evidence the peer is alive — a pong, or any inbound frame.
   *
   * Only for peers already tracked. A pong arriving after close must not
   * re-add an entry that nothing will subsequently remove.
   */
  markAlive(peer: T): void {
    if (this.lastSeen.has(peer)) this.lastSeen.set(peer, this.now());
  }

  /** Stop watching a peer, on close or termination. */
  untrack(peer: T): void {
    this.lastSeen.delete(peer);
  }

  /**
   * Return the peers that have been silent for longer than the timeout, and
   * forget them.
   *
   * They are removed as they are reported: leaving them would terminate an
   * already-closed socket on every subsequent tick and keep the entry forever.
   * The caller terminates — this class does not own the socket.
   */
  sweep(): T[] {
    const deadline = this.now() - this.timeoutMs;
    const dead: T[] = [];

    for (const [peer, seen] of this.lastSeen) {
      // Strictly older than the deadline: a peer exactly at the timeout may
      // have a pong in flight.
      if (seen < deadline) dead.push(peer);
    }
    for (const peer of dead) this.lastSeen.delete(peer);

    return dead;
  }

  /** Peers currently watched. */
  size(): number {
    return this.lastSeen.size;
  }

  /** The configured ping interval, for the caller's timer. */
  get pingIntervalMs(): number {
    return this.intervalMs;
  }
}
