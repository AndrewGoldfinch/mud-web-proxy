import type { Session } from './session';
import type { ActivityContentState } from './types';
import { NotificationManager } from './notification-manager';

interface TrackedSession {
  sessionId: string;
  worldName: string;
  connectedSince: number;
  deviceToken?: string;
  activityPushToken?: string;
  lastPushedSequence: number;
  lastSilentPushAt: number;
  lastActivityPushAt: number;
  trackedAt: number;
  lastSyncAckAt: number;
  lastAckSequence: number;
  lastActivityWakeAttemptAt: number;
  fallbackCooldownMs: number;
  fallbackBackoffMs: number;
  nextFallbackAllowedAt: number;
  fallbackCountHour: number;
  fallbackWindowStart: number;
}

export interface BackgroundPushSchedulerConfig {
  silentPushIntervalMs: number;
  activityPushIntervalMs: number;
  activityAckTimeoutMs: number;
  fallbackCooldownMs: number;
  maxFallbacksPerHour: number;
  maxSnippetLength: number;
}

export class BackgroundPushScheduler {
  private readonly notificationManager: NotificationManager;
  private readonly config: BackgroundPushSchedulerConfig;
  private readonly tracked = new Map<string, TrackedSession>();
  private readonly pendingAckTimeouts = new Map<string, NodeJS.Timeout>();

  constructor(
    notificationManager: NotificationManager,
    config: Partial<BackgroundPushSchedulerConfig> = {},
  ) {
    this.notificationManager = notificationManager;
    this.config = {
      silentPushIntervalMs: 20 * 60 * 1000,
      activityPushIntervalMs: 120 * 1000,
      activityAckTimeoutMs: 15 * 1000,
      fallbackCooldownMs: 60 * 1000,
      maxFallbacksPerHour: 6,
      maxSnippetLength: 100,
      ...config,
    };
  }

  trackSession(session: Session): void {
    const existing = this.tracked.get(session.id);
    if (existing) {
      existing.deviceToken = session.deviceToken;
      existing.activityPushToken = session.activityPushToken;
      existing.worldName = `${session.mudHost}:${session.mudPort}`;
      return;
    }

    const now = Date.now();
    this.tracked.set(session.id, {
      sessionId: session.id,
      worldName: `${session.mudHost}:${session.mudPort}`,
      connectedSince: session.createdAt,
      deviceToken: session.deviceToken,
      activityPushToken: session.activityPushToken,
      lastPushedSequence: session.getLastSequence(),
      lastSilentPushAt: 0,
      lastActivityPushAt: 0,
      trackedAt: now,
      lastSyncAckAt: 0,
      lastAckSequence: 0,
      lastActivityWakeAttemptAt: 0,
      fallbackCooldownMs: this.config.fallbackCooldownMs,
      fallbackBackoffMs: this.config.fallbackCooldownMs,
      nextFallbackAllowedAt: 0,
      fallbackCountHour: 0,
      fallbackWindowStart: now,
    });
  }

  untrackSession(sessionId: string): void {
    this.tracked.delete(sessionId);
    const timer = this.pendingAckTimeouts.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingAckTimeouts.delete(sessionId);
    }
  }

  recordSyncAck(sessionId: string, lastSeq: number): void {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) {
      return;
    }

    const now = Date.now();
    tracked.lastSyncAckAt = now;
    tracked.lastAckSequence = Math.max(lastSeq, tracked.lastAckSequence);
    tracked.lastPushedSequence = Math.max(lastSeq, tracked.lastPushedSequence);
    tracked.nextFallbackAllowedAt = now + this.config.fallbackCooldownMs;
    tracked.fallbackBackoffMs = this.config.fallbackCooldownMs;

    const timer = this.pendingAckTimeouts.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      this.pendingAckTimeouts.delete(sessionId);
    }
  }

  async onBufferedOutput(
    session: Session,
    latestSequence: number,
    snippetSource: string,
  ): Promise<void> {
    if (session.hasClients()) {
      return;
    }

    const tracked = this.tracked.get(session.id);
    if (!tracked) {
      return;
    }

    if (latestSequence <= tracked.lastPushedSequence) {
      return;
    }

    tracked.deviceToken = session.deviceToken;
    tracked.activityPushToken = session.activityPushToken;

    const snippet = this.normalizeSnippet(snippetSource);
    const now = Date.now();

    const shouldSilentPush =
      !!tracked.deviceToken &&
      now - tracked.lastSilentPushAt >= this.config.silentPushIntervalMs;
    const shouldActivityPush =
      !!tracked.activityPushToken &&
      now - tracked.lastActivityPushAt >= this.config.activityPushIntervalMs;

    if (shouldActivityPush && tracked.activityPushToken) {
      const contentState: ActivityContentState = {
        status: 'connected',
        worldName: tracked.worldName,
        lastOutputSnippet: snippet,
        connectedSince: Math.floor(tracked.connectedSince / 1000),
        lastSyncTime: Math.floor(now / 1000),
      };

      const sent = await this.notificationManager.sendActivityKitPush(
        tracked.activityPushToken,
        contentState,
      );
      if (sent) {
        tracked.lastActivityPushAt = now;
        session.lastActivityPushAt = now;
        tracked.lastActivityWakeAttemptAt = now;
        tracked.lastPushedSequence = latestSequence;
        this.scheduleAckTimeout(session.id, latestSequence);
      }
    }

    if (shouldSilentPush && tracked.deviceToken) {
      const sent = await this.notificationManager.sendSilentPush(
        tracked.deviceToken,
        session.id,
      );
      if (sent) {
        tracked.lastSilentPushAt = now;
        tracked.lastPushedSequence = latestSequence;
      }
    }
  }

  private scheduleAckTimeout(sessionId: string, pushSequence: number): void {
    const existing = this.pendingAckTimeouts.get(sessionId);
    if (existing) {
      clearTimeout(existing);
    }

    const timeout = setTimeout(() => {
      void this.handleAckTimeout(sessionId, pushSequence);
    }, this.config.activityAckTimeoutMs);
    this.pendingAckTimeouts.set(sessionId, timeout);
  }

  private async handleAckTimeout(
    sessionId: string,
    pushSequence: number,
  ): Promise<void> {
    this.pendingAckTimeouts.delete(sessionId);
    const tracked = this.tracked.get(sessionId);
    if (!tracked || !tracked.deviceToken) {
      return;
    }

    if (tracked.lastAckSequence >= pushSequence) {
      return;
    }

    const now = Date.now();
    if (now < tracked.nextFallbackAllowedAt) {
      return;
    }
    if (now - tracked.lastSilentPushAt < this.config.silentPushIntervalMs) {
      return;
    }

    if (now - tracked.fallbackWindowStart >= 60 * 60 * 1000) {
      tracked.fallbackWindowStart = now;
      tracked.fallbackCountHour = 0;
    }
    if (tracked.fallbackCountHour >= this.config.maxFallbacksPerHour) {
      return;
    }

    const sent = await this.notificationManager.sendSilentPush(
      tracked.deviceToken,
      sessionId,
    );
    if (!sent) {
      return;
    }

    tracked.lastSilentPushAt = now;
    tracked.fallbackCountHour += 1;
    tracked.nextFallbackAllowedAt = now + tracked.fallbackBackoffMs;
    tracked.fallbackBackoffMs = Math.min(
      tracked.fallbackBackoffMs * 2,
      10 * 60 * 1000,
    );
  }

  private normalizeSnippet(text: string): string {
    if (!text) {
      return '';
    }

    const compact = text.replace(/\s+/g, ' ').trim();
    if (compact.length <= this.config.maxSnippetLength) {
      return compact;
    }
    return compact.slice(0, this.config.maxSnippetLength);
  }
}
