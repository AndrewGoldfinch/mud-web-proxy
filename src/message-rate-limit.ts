// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Per-session and per-address message rate limits (MWP-124).
 *
 * MWP-92 bounded *connections*. Nothing bounded *rate*, so a client inside every
 * connection cap could send frames as fast as the socket allowed. Each `input`
 * frame becomes a telnet write, which means the first casualty is not this
 * proxy but the upstream MUD — whose own flood protection sees a single abusive
 * address: ours. Authentication does not help; a shared secret proves a client
 * is entitled to connect, not that it is behaving.
 *
 * Two dimensions, because either alone is trivially defeated:
 *
 *  - **per session** alone is bypassed by opening several sessions;
 *  - **per address** alone throttles a legitimate multi-session user as though
 *    they were one noisy client.
 *
 * Both apply, with the address budget the larger of the two. The address is the
 * server-derived one from the trusted-proxy work — never a client-supplied
 * value, or the limit is advisory.
 *
 * There is deliberately no explicit release-on-disconnect hook. Wiring one
 * would mean threading one through the socket close path, and it buys nothing:
 * the windows are bounded by eviction, and if an active connection's window is
 * evicted early it simply gets a fresh allowance — at which point the
 * per-address dimension is still binding, which is one of the reasons both
 * dimensions exist. A method that is exported but never called is worse than its
 * absence, because a reader assumes the release happens somewhere.
 *
 * Built on SlidingWindowLimiter rather than a third mechanism. Measured at
 * ~0.5 microseconds per call at a 120/second allowance: the timestamp array is
 * bounded by the allowance, not by history, so the cost does not grow under the
 * flood it exists to damp.
 */

import { SlidingWindowLimiter } from './wsproxy-utils';

export interface MessageRateLimits {
  /**
   * Frames per second for one connection.
   *
   * Keyed on the connection rather than the session deliberately. A legacy
   * raw-telnet connection never has a Session, so keying on the session left
   * legacy traffic bound only by the address allowance — 240/second against the
   * 60/second this advertises. MWP-90 established that both wire protocols get
   * identical policy. The connection is also the right granularity for a
   * message rate: resume reuses one session across connections sequentially,
   * never concurrently, and a connection-scoped key cannot change mid-stream
   * the way a session id appearing partway through would.
   */
  perConnectionPerSecond: number;
  perAddressPerSecond: number;
}

export interface MessageRateLimiterOptions {
  now?: () => number;
  /** Bound on distinct keys held, so a client rotating ids cannot grow this. */
  maxTrackedSources?: number;
}

export type RateDecision =
  | { allowed: true }
  | {
      allowed: false;
      /** Which limit was hit — what an operator needs to know. */
      dimension: 'connection' | 'address';
      /**
       * True only for the first refusal in a window. Replying to every dropped
       * frame would amplify outbound traffic during exactly the flood being
       * damped, making the limiter the denial of service.
       */
      notify: boolean;
    };

const WINDOW_MS = 1_000;

export class MessageRateLimiter {
  private readonly connections: SlidingWindowLimiter;
  private readonly addresses: SlidingWindowLimiter;
  /** Keys already told they are throttled, cleared when their window rolls. */
  private readonly notified = new Map<string, number>();
  private readonly now: () => number;

  constructor(
    limits: MessageRateLimits,
    options: MessageRateLimiterOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    const maxTrackedSources = options.maxTrackedSources ?? 10_000;

    this.connections = new SlidingWindowLimiter({
      maxRequests: limits.perConnectionPerSecond,
      windowMs: WINDOW_MS,
      maxTrackedSources,
      now: this.now,
    });
    this.addresses = new SlidingWindowLimiter({
      maxRequests: limits.perAddressPerSecond,
      windowMs: WINDOW_MS,
      maxTrackedSources,
      now: this.now,
    });
  }

  /**
   * Account for one inbound message.
   *
   * `connectionKey` is always present, for both wire protocols. An earlier
   * version keyed this on the session id, which legacy raw-telnet connections
   * never have — so legacy traffic was bound only by the address allowance.
   *
   * The narrower dimension is checked first; see the body for why.
   */
  check(connectionKey: string, address: string): RateDecision {
    // Connection first, deliberately. Consuming address budget for a frame that
    // is then refused on connection grounds lets one abusive connection burn the
    // allowance its siblings share — and addresses are shared routinely, by NAT
    // and CGNAT, so that would throttle innocent players because of someone
    // else's client. Checking the narrower dimension first keeps the cost of
    // misbehaviour with the connection that caused it.
    //
    // This does not weaken the bypass protection: N connections each staying
    // inside their own allowance still meet the address limit below, which is
    // the dimension that exists to stop reconnecting for more throughput.
    if (!this.connections.tryConsume(connectionKey)) {
      return {
        allowed: false,
        dimension: 'connection',
        notify: this.shouldNotify(`conn:${connectionKey}`),
      };
    }

    if (!this.addresses.tryConsume(address)) {
      return {
        allowed: false,
        dimension: 'address',
        notify: this.shouldNotify(`addr:${address}`),
      };
    }

    return { allowed: true };
  }

  /** Distinct connections currently tracked. Exposed for tests. */
  trackedConnections(): number {
    return this.connections.size();
  }

  /**
   * True at most once per window per key, so a throttled client is told why
   * without the reply itself becoming traffic amplification.
   */
  private shouldNotify(key: string): boolean {
    const last = this.notified.get(key);
    const now = this.now();
    if (last !== undefined && now - last < WINDOW_MS) return false;

    // Bounded alongside the limiters themselves; without this the notification
    // bookkeeping would be the unbounded map.
    if (this.notified.size >= 10_000) {
      const oldest = this.notified.keys().next();
      if (!oldest.done) this.notified.delete(oldest.value);
    }
    this.notified.set(key, now);
    return true;
  }
}
