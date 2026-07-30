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
 * There is deliberately no explicit release-on-session-end hook. Wiring one
 * would mean plumbing a callback through SessionManager.removeSession, and it
 * buys nothing: the windows are bounded by eviction, and if an active session's
 * window is evicted early it simply gets a fresh allowance — at which point the
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
  perSessionPerSecond: number;
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
      dimension: 'session' | 'address';
      /**
       * True only for the first refusal in a window. Replying to every dropped
       * frame would amplify outbound traffic during exactly the flood being
       * damped, making the limiter the denial of service.
       */
      notify: boolean;
    };

const WINDOW_MS = 1_000;

export class MessageRateLimiter {
  private readonly sessions: SlidingWindowLimiter;
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

    this.sessions = new SlidingWindowLimiter({
      maxRequests: limits.perSessionPerSecond,
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
   * `sessionKey` is undefined for legacy raw-telnet connections, which have no
   * Session. They are still bounded by address — skipping the check for them
   * would leave the older protocol as the unlimited one.
   *
   * The address budget is consumed first and unconditionally, so N sessions
   * cannot multiply one address's allowance.
   */
  check(sessionKey: string | undefined, address: string): RateDecision {
    if (!this.addresses.tryConsume(address)) {
      return {
        allowed: false,
        dimension: 'address',
        notify: this.shouldNotify(`addr:${address}`),
      };
    }

    if (sessionKey !== undefined && !this.sessions.tryConsume(sessionKey)) {
      return {
        allowed: false,
        dimension: 'session',
        notify: this.shouldNotify(`sess:${sessionKey}`),
      };
    }

    return { allowed: true };
  }

  /** Distinct sessions currently tracked. Exposed for tests. */
  trackedSessions(): number {
    return this.sessions.size();
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
