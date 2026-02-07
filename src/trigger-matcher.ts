/**
 * TriggerMatcher - Pattern matching for notification triggers
 *
 * Built-in patterns:
 * - Tell/page: "Soandso tells you: message"
 * - Combat: "You are under attack" or "X attacks you"
 * - Death: "You have died" or "You are DEAD"
 *
 * Rate limiting: 1 per trigger type per minute, 10 total per hour
 */

import type {
  Trigger,
  RateLimitEntry,
  RateLimitConfig,
  TriggerMatch,
} from './types';

export interface TriggerMatcherConfig {
  rateLimit: RateLimitConfig;
}

export class TriggerMatcher {
  private triggers: Map<string, Trigger> = new Map();
  private rateLimits: Map<string, RateLimitEntry> = new Map();
  private config: TriggerMatcherConfig;

  constructor(config: Partial<TriggerMatcherConfig> = {}) {
    this.config = {
      rateLimit: {
        perTypePerMinute: 1,
        totalPerHour: 10,
      },
      ...config,
    };

    // Initialize built-in triggers
    this.initializeBuiltInTriggers();
  }

  /**
   * Initialize built-in trigger patterns
   */
  private initializeBuiltInTriggers(): void {
    const builtIns: Trigger[] = [
      {
        id: 'tell',
        type: 'tell',
        pattern:
          /^(?:\[?\w+\]?\s+)?([A-Za-z_-]+)\s+tells\s+(?:you|the\s+group)[:,]\s*(.+)$/im,
        enabled: true,
      },
      {
        id: 'page',
        type: 'tell',
        pattern: /^(?:\[?\w+\]?\s+)?([A-Za-z_-]+)\s+pages?[:,]?\s*(.+)$/im,
        enabled: true,
      },
      {
        id: 'whisper',
        type: 'tell',
        pattern:
          /^(?:\[?\w+\]?\s+)?([A-Za-z_-]+)\s+whispers(?:\s+to\s+you)?[:,]\s*(.+)$/im,
        enabled: true,
      },
      {
        id: 'combat',
        type: 'combat',
        pattern: /^(?:You are under attack|(.+?)\s+attacks\s+you)[!.]?$/im,
        enabled: true,
      },
      {
        id: 'death',
        type: 'death',
        pattern: /^(?:You have died|You are DEAD|You have been slain)[!.]?$/im,
        enabled: true,
      },
      {
        id: 'party-invite',
        type: 'custom',
        pattern:
          /^(?:\[?\w+\]?\s+)?([A-Za-z_-]+)\s+invites?\s+you\s+(?:to join|into)\s+(?:a\s+party|their\s+group)/im,
        enabled: true,
        label: 'Party Invite',
      },
    ];

    for (const trigger of builtIns) {
      this.triggers.set(trigger.id, trigger);
    }
  }

  /**
   * Add a custom trigger
   */
  addTrigger(trigger: Trigger): void {
    this.triggers.set(trigger.id, trigger);
  }

  /**
   * Remove a trigger
   */
  removeTrigger(triggerId: string): boolean {
    return this.triggers.delete(triggerId);
  }

  /**
   * Enable or disable a trigger
   */
  setTriggerEnabled(triggerId: string, enabled: boolean): boolean {
    const trigger = this.triggers.get(triggerId);
    if (trigger) {
      trigger.enabled = enabled;
      return true;
    }
    return false;
  }

  /**
   * Match text against all enabled triggers
   * Returns match info if found and passes rate limiting
   */
  match(text: string, sessionId: string): TriggerMatch | null {
    for (const trigger of this.triggers.values()) {
      if (!trigger.enabled) {
        continue;
      }

      const match = trigger.pattern.exec(text);
      if (match) {
        // Check rate limiting
        if (!this.checkRateLimit(sessionId, trigger.id)) {
          continue;
        }

        // Extract capture groups
        const extractedData: Record<string, string> = {};
        if (match.length > 1) {
          extractedData['sender'] = match[1] || '';
        }
        if (match.length > 2) {
          extractedData['message'] = match[2] || '';
        }

        return {
          triggerId: trigger.id,
          triggerType: trigger.type,
          matchedText: match[0],
          extractedData,
        };
      }
    }

    return null;
  }

  /**
   * Check if rate limit allows this notification
   */
  private checkRateLimit(sessionId: string, triggerId: string): boolean {
    const now = Date.now();
    const entry = this.rateLimits.get(sessionId);

    if (!entry) {
      // First notification for this session
      this.rateLimits.set(sessionId, {
        count: 1,
        lastReset: now,
        lastNotification: new Map([[triggerId, now]]),
      });
      return true;
    }

    // Check if we need to reset hourly counter
    const hourMs = 60 * 60 * 1000;
    if (now - entry.lastReset > hourMs) {
      entry.count = 0;
      entry.lastReset = now;
    }

    // Check total hourly limit
    if (entry.count >= this.config.rateLimit.totalPerHour) {
      return false;
    }

    // Check per-type per-minute limit
    const lastTime = entry.lastNotification.get(triggerId);
    if (lastTime) {
      const minuteMs = 60 * 1000;
      if (now - lastTime < minuteMs) {
        return false;
      }
    }

    // Update rate limit tracking
    entry.count++;
    entry.lastNotification.set(triggerId, now);
    return true;
  }

  /**
   * Get all triggers
   */
  getTriggers(): Trigger[] {
    return Array.from(this.triggers.values());
  }

  /**
   * Get enabled triggers
   */
  getEnabledTriggers(): Trigger[] {
    return this.getTriggers().filter((t) => t.enabled);
  }

  /**
   * Clear rate limits for a session
   */
  clearRateLimits(sessionId: string): void {
    this.rateLimits.delete(sessionId);
  }

  /**
   * Get rate limit stats for a session
   */
  getRateLimitStats(sessionId: string): {
    count: number;
    lastReset: number;
    timeUntilReset: number;
  } | null {
    const entry = this.rateLimits.get(sessionId);
    if (!entry) {
      return null;
    }

    const hourMs = 60 * 60 * 1000;
    const timeUntilReset = Math.max(0, entry.lastReset + hourMs - Date.now());

    return {
      count: entry.count,
      lastReset: entry.lastReset,
      timeUntilReset,
    };
  }

  /**
   * Clean up old rate limit entries
   */
  cleanupOldEntries(maxAgeHours: number = 48): number {
    const now = Date.now();
    const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
    const toDelete: string[] = [];

    for (const [sessionId, entry] of this.rateLimits) {
      if (now - entry.lastReset > maxAgeMs) {
        toDelete.push(sessionId);
      }
    }

    for (const sessionId of toDelete) {
      this.rateLimits.delete(sessionId);
    }

    return toDelete.length;
  }
}
