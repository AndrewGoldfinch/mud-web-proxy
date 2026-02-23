/**
 * NotificationManager - Apple Push Notification Service integration
 *
 * Uses APNS HTTP/2 API with token-based authentication (.p8 key file)
 * Features:
 * - Token-based auth (no certificate renewal)
 * - Rate limiting
 * - Error handling with retry
 * - Graceful degradation
 */

import http2 from 'http2';
import fs from 'fs';
import crypto from 'crypto';
import type {
  APNSConfig,
  NotificationPayload,
  TriggerMatch,
  ActivityContentState,
} from './types';
import { TriggerMatcher } from './trigger-matcher';

export interface NotificationManagerConfig {
  apns?: APNSConfig;
  enabled: boolean;
}

export class NotificationManager {
  private config: NotificationManagerConfig;
  private triggerMatcher: TriggerMatcher;
  private authToken: string | null = null;
  private tokenExpiry: number = 0;
  private apnsHost: string;

  // Track pending notifications for retry
  private pendingNotifications: Map<
    string,
    {
      deviceToken: string;
      payload: NotificationPayload;
      retries: number;
      lastAttempt: number;
    }
  > = new Map();

  constructor(
    config: NotificationManagerConfig,
    triggerMatcher: TriggerMatcher,
  ) {
    this.config = config;
    this.triggerMatcher = triggerMatcher;
    this.apnsHost =
      config.apns?.environment === 'production'
        ? 'api.push.apple.com'
        : 'api.sandbox.push.apple.com';

    // Generate initial auth token if configured
    if (this.config.apns && this.config.enabled) {
      this.generateAuthToken();
    }

    this.logConfiguration();
  }

  private logConfiguration(): void {
    const apns = this.config.apns;
    if (!apns) {
      // eslint-disable-next-line no-console
      console.log(
        '[notification-manager] APNS disabled (missing configuration)',
      );
      return;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[notification-manager] APNS config enabled env=${apns.environment} host=${this.apnsHost} topic=${apns.topic || '<missing>'} keyId=${apns.keyId || '<missing>'} teamId=${apns.teamId || '<missing>'} keyPath=${apns.keyPath}`,
    );
  }

  /**
   * Generate JWT auth token for APNS
   * Tokens valid for 1 hour, but we refresh every 30 minutes
   * Uses ES256 algorithm
   */
  private generateAuthToken(): string | null {
    if (!this.config.apns) {
      return null;
    }

    try {
      const { keyPath, keyId, teamId } = this.config.apns;

      // Check if file exists
      if (!fs.existsSync(keyPath)) {
        this.logFailure(
          `[notification-manager] APNS key file not found: ${keyPath}`,
        );
        return null;
      }

      const privateKey = fs.readFileSync(keyPath, 'utf8');
      const now = Math.floor(Date.now() / 1000);

      // Build JWT header and payload manually for ES256
      const header = {
        alg: 'ES256',
        kid: keyId,
      };

      const payload = {
        iss: teamId,
        iat: now,
      };

      const headerB64 = Buffer.from(JSON.stringify(header))
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      const payloadB64 = Buffer.from(JSON.stringify(payload))
        .toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      const signingInput = `${headerB64}.${payloadB64}`;

      // Create signature using ES256
      const sign = crypto.createSign('SHA256');
      sign.update(signingInput);
      const signature = sign.sign(privateKey, 'base64');

      // Base64url encode signature
      const signatureB64 = signature
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');

      const token = `${signingInput}.${signatureB64}`;

      this.authToken = token;
      this.tokenExpiry = Date.now() + 30 * 60 * 1000; // Refresh in 30 min

      // eslint-disable-next-line no-console
      console.log(
        `[notification-manager] APNS auth token generated kid=${keyId} expiresAt=${new Date(this.tokenExpiry).toISOString()}`,
      );

      return token;
    } catch (err) {
      this.logFailure(
        `[notification-manager] Failed to generate auth token: ${err}`,
      );
      return null;
    }
  }

  /**
   * Get valid auth token (generates new if expired)
   */
  private getAuthToken(): string | null {
    if (!this.authToken || Date.now() > this.tokenExpiry) {
      // eslint-disable-next-line no-console
      console.log('[notification-manager] APNS auth token refresh required');
      return this.generateAuthToken();
    }
    return this.authToken;
  }

  /**
   * Check if APNS is configured and available
   */
  isAvailable(): boolean {
    return this.config.enabled && !!this.config.apns && !!this.getAuthToken();
  }

  /**
   * Process MUD output for trigger matching
   * Returns match if found
   */
  processOutput(text: string, sessionId: string): TriggerMatch | null {
    return this.triggerMatcher.match(text, sessionId);
  }

  /**
   * Send push notification
   */
  async sendNotification(
    deviceToken: string,
    match: TriggerMatch,
    sessionId: string,
  ): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    const payload = this.buildPayload(match, sessionId);
    return this.sendToAPNS(deviceToken, payload);
  }

  async sendSilentPush(
    deviceToken: string,
    sessionId: string,
  ): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[notification-manager] sendSilentPush session=${sessionId} deviceToken=${this.redactToken(deviceToken)}`,
    );

    const apnsPayload = {
      aps: {
        'content-available': 1,
      },
      sessionId,
    };

    return this.sendRawToAPNS(deviceToken, apnsPayload, {
      pushType: 'background',
      priority: '5',
      topic: this.config.apns!.topic,
    });
  }

  async sendActivityKitPush(
    activityPushToken: string,
    contentState: ActivityContentState,
  ): Promise<boolean> {
    if (!this.isAvailable()) {
      return false;
    }

    // eslint-disable-next-line no-console
    console.log(
      `[notification-manager] sendActivityKitPush world=${contentState.worldName} activityToken=${this.redactToken(activityPushToken)}`,
    );

    const nowSeconds = Math.floor(Date.now() / 1000);
    const apnsPayload = {
      aps: {
        timestamp: nowSeconds,
        event: 'update',
      },
      'content-state': contentState,
    };

    return this.sendRawToAPNS(activityPushToken, apnsPayload, {
      pushType: 'liveactivity',
      priority: '10',
      topic: `${this.config.apns!.topic}.push-type.liveactivity`,
    });
  }

  /**
   * Build notification payload
   */
  private buildPayload(
    match: TriggerMatch,
    sessionId: string,
  ): NotificationPayload {
    const { triggerType, matchedText, extractedData } = match;

    let title = 'MUDBasher';
    let body = matchedText.substring(0, 100); // Truncate long messages

    switch (triggerType) {
      case 'tell':
        title = 'New Tell';
        if (extractedData?.['sender']) {
          const msg = extractedData['message'] || '';
          body = `${extractedData['sender']}: ${msg.substring(0, 80)}`;
        }
        break;
      case 'combat':
        title = 'Under Attack!';
        body = 'You are being attacked!';
        break;
      case 'death':
        title = 'You Died';
        body = 'You have died. Tap to reconnect.';
        break;
      case 'custom':
        title = extractedData?.['label'] || 'Notification';
        break;
    }

    return {
      alert: {
        title,
        body: body.substring(0, 100), // APNS limit
      },
      badge: 1,
      sound: 'default',
      custom: {
        sessionId,
        type: triggerType,
      },
    };
  }

  /**
   * Send notification to APNS
   */
  private async sendToAPNS(
    deviceToken: string,
    payload: NotificationPayload,
  ): Promise<boolean> {
    const apnsPayload = {
      aps: {
        alert: payload.alert,
        badge: payload.badge,
        sound: payload.sound,
      },
      ...payload.custom,
    };

    return this.sendRawToAPNS(deviceToken, apnsPayload, {
      pushType: 'alert',
      priority: '10',
      topic: this.config.apns!.topic,
    });
  }

  private async sendRawToAPNS(
    deviceToken: string,
    apnsPayload: Record<string, unknown>,
    optionsIn: { pushType: string; priority: string; topic: string },
  ): Promise<boolean> {
    const authToken = this.getAuthToken();
    if (!authToken || !this.config.apns) {
      return false;
    }

    const postData = JSON.stringify(apnsPayload);
    const start = Date.now();

    return new Promise((resolve) => {
      // eslint-disable-next-line no-console
      console.log(
        `[notification-manager] APNS request start pushType=${optionsIn.pushType} priority=${optionsIn.priority} topic=${optionsIn.topic} target=${this.redactToken(deviceToken)} payloadBytes=${Buffer.byteLength(postData)}`,
      );
      const client = http2.connect(`https://${this.apnsHost}`);
      let settled = false;

      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        client.close();
        resolve(ok);
      };

      client.on('error', (err) => {
        const elapsedMs = Date.now() - start;
        this.logFailure(
          `[notification-manager] APNS connection error elapsedMs=${elapsedMs}: ${err}`,
        );
        finish(false);
      });

      const req = client.request({
        ':method': 'POST',
        ':path': `/3/device/${deviceToken}`,
        authorization: `Bearer ${authToken}`,
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(postData)),
        'apns-topic': optionsIn.topic,
        'apns-push-type': optionsIn.pushType,
        'apns-priority': optionsIn.priority,
      });

      let statusCode = 0;
      let apnsId = '';
      const chunks: Buffer[] = [];

      req.setEncoding('utf8');
      req.on('response', (headers) => {
        const statusHeader = headers[':status'];
        statusCode =
          typeof statusHeader === 'number'
            ? statusHeader
            : Number(statusHeader || 0);
        const apnsIdHeader = headers['apns-id'];
        apnsId = Array.isArray(apnsIdHeader)
          ? String(apnsIdHeader[0] || '')
          : String(apnsIdHeader || '');
      });

      req.on('data', (chunk: string) => {
        chunks.push(Buffer.from(chunk));
      });

      req.on('end', () => {
        const elapsedMs = Date.now() - start;
        const bodyText = Buffer.concat(chunks).toString('utf8');
        let reason = '';
        try {
          const parsed = bodyText
            ? (JSON.parse(bodyText) as { reason?: string })
            : undefined;
          reason = parsed?.reason || '';
        } catch {
          reason = '';
        }

        if (statusCode >= 200 && statusCode < 300) {
          // eslint-disable-next-line no-console
          console.log(
            `[notification-manager] APNS request success status=${statusCode} apnsId=${apnsId || '<none>'} elapsedMs=${elapsedMs}`,
          );
          finish(true);
          return;
        }

        this.logFailure(
          `[notification-manager] APNS request failed status=${statusCode} apnsId=${apnsId || '<none>'} reason=${reason || '<none>'} elapsedMs=${elapsedMs}`,
        );
        finish(false);
      });

      req.on('error', (err) => {
        const elapsedMs = Date.now() - start;
        this.logFailure(
          `[notification-manager] APNS request error elapsedMs=${elapsedMs}: ${err}`,
        );
        finish(false);
      });

      req.setTimeout(10000, () => {
        const elapsedMs = Date.now() - start;
        this.logFailure(
          `[notification-manager] APNS request timeout after ${elapsedMs}ms`,
        );
        req.close(http2.constants.NGHTTP2_CANCEL);
        finish(false);
      });

      req.end(postData);
    });
  }

  /**
   * Queue notification for retry
   */
  queueNotification(deviceToken: string, payload: NotificationPayload): void {
    const id = `${deviceToken}_${Date.now()}`;
    this.pendingNotifications.set(id, {
      deviceToken,
      payload,
      retries: 0,
      lastAttempt: Date.now(),
    });
  }

  /**
   * Process pending notifications (call periodically)
   */
  async processPending(): Promise<number> {
    const processed: string[] = [];
    const now = Date.now();
    const retryDelay = 60 * 1000; // 1 minute between retries
    const maxRetries = 3;

    for (const [id, pending] of this.pendingNotifications) {
      if (now - pending.lastAttempt < retryDelay) {
        continue;
      }

      if (pending.retries >= maxRetries) {
        processed.push(id);
        continue;
      }

      pending.retries++;
      pending.lastAttempt = now;

      // Reconstruct match from payload for retry
      // This is simplified - in practice you'd store the original match
      const success = await this.sendToAPNS(
        pending.deviceToken,
        pending.payload,
      );

      if (success) {
        processed.push(id);
      }
    }

    for (const id of processed) {
      this.pendingNotifications.delete(id);
    }

    return processed.length;
  }

  /**
   * Get pending notification count
   */
  getPendingCount(): number {
    return this.pendingNotifications.size;
  }

  /**
   * Clean up rate limits for a session
   */
  cleanupSession(sessionId: string): void {
    this.triggerMatcher.clearRateLimits(sessionId);
  }

  /**
   * Get configuration status
   */
  getStatus(): {
    enabled: boolean;
    configured: boolean;
    tokenValid: boolean;
    pendingNotifications: number;
  } {
    return {
      enabled: this.config.enabled,
      configured: !!this.config.apns,
      tokenValid: !!this.getAuthToken(),
      pendingNotifications: this.pendingNotifications.size,
    };
  }

  private redactToken(token: string): string {
    const trimmed = token.trim();
    if (!trimmed) {
      return '<empty>';
    }
    return `${trimmed.slice(0, 8)}... (len=${trimmed.length})`;
  }

  private logFailure(message: string): void {
    // Mirror to both stdout/stderr so PM2 setups that only show one stream
    // still capture APNS failure diagnostics.
    // eslint-disable-next-line no-console
    console.error(message);
    // eslint-disable-next-line no-console
    console.log(message);
  }
}
