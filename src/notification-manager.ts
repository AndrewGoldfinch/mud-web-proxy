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

import https from 'https';
import fs from 'fs';
import crypto from 'crypto';
import type { APNSConfig, NotificationPayload, TriggerMatch } from './types';
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
        console.error(
          `[NotificationManager] APNS key file not found: ${keyPath}`,
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

      return token;
    } catch (err) {
      console.error(
        `[NotificationManager] Failed to generate auth token: ${err}`,
      );
      return null;
    }
  }

  /**
   * Get valid auth token (generates new if expired)
   */
  private getAuthToken(): string | null {
    if (!this.authToken || Date.now() > this.tokenExpiry) {
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
    const authToken = this.getAuthToken();
    if (!authToken || !this.config.apns) {
      return false;
    }

    const { topic } = this.config.apns;

    const apnsPayload = {
      aps: {
        alert: payload.alert,
        badge: payload.badge,
        sound: payload.sound,
      },
      ...payload.custom,
    };

    const postData = JSON.stringify(apnsPayload);

    const options: https.RequestOptions = {
      hostname: this.apnsHost,
      port: 443,
      path: `/3/device/${deviceToken}`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        Authorization: `Bearer ${authToken}`,
        'apns-topic': topic,
      },
    };

    return new Promise((resolve) => {
      const req = https.request(options, (res) => {
        const statusCode = res.statusCode || 0;

        if (statusCode >= 200 && statusCode < 300) {
          resolve(true);
        } else {
          console.error(`[NotificationManager] APNS error ${statusCode}`);
          resolve(false);
        }
      });

      req.on('error', (err) => {
        console.error(`[NotificationManager] Request error: ${err}`);
        resolve(false);
      });

      req.setTimeout(10000, () => {
        req.destroy();
        resolve(false);
      });

      req.write(postData);
      req.end();
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
}
