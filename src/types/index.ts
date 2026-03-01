/**
 * Type definitions for MUDBasher session persistence proxy
 */

import type { IncomingMessage } from 'http';
import type { WebSocket as WS } from 'ws';
import type { Socket } from 'net';

/**
 * Extended WebSocket type with our custom properties
 * Based on the existing SocketExtended from wsproxy.ts
 */
export interface SocketExtended extends WS {
  req: IncomingMessage & { connection: { remoteAddress: string } };
  ts?: TelnetSocket;
  host?: string;
  port?: number;
  ttype: string[];
  name?: string;
  client?: string;
  mccp?: boolean;
  utf8?: boolean;
  debug?: boolean;
  compressed: number;
  mccp_negotiated?: number;
  mxp_negotiated?: number;
  gmcp_negotiated?: number;
  utf8_negotiated?: number;
  new_negotiated?: number;
  new_handshake?: number;
  sga_negotiated?: number;
  echo_negotiated?: number;
  naws_negotiated?: number;
  msdp_negotiated?: number;
  password_mode?: boolean;
  appAttested?: boolean;
  appKeyId?: string;
  appBundleId?: string;
  appDeviceToken?: string;
  sendUTF: (data: string | Buffer) => void;
  terminate: () => void;
  remoteAddress: string;
}

/**
 * Buffer chunk with sequence numbering
 */
export interface BufferChunk {
  sequence: number;
  timestamp: number;
  data: Buffer;
  type: 'data' | 'gmcp';
  gmcpPackage?: string;
  gmcpData?: object;
}

/**
 * Trigger configuration for notifications
 */
export interface Trigger {
  id: string;
  type: 'tell' | 'combat' | 'death' | 'custom';
  pattern: RegExp;
  enabled: boolean;
  label?: string;
}

/**
 * Session metadata stored in SessionManager
 */
export interface SessionMetadata {
  sessionId: string;
  authToken: string;
  createdAt: number;
  lastClientConnection: number;
  mudHost: string;
  mudPort: number;
  deviceToken?: string;
  activityPushToken?: string;
  clientBackgrounded: boolean;
  lastBackgroundedAt: number;
  lastActivityPushAt: number;
  windowWidth: number;
  windowHeight: number;
}

/**
 * Processed data from MUD output
 */
export interface ProcessedData {
  data: Buffer;
  type: 'data' | 'gmcp';
  gmcpPackage?: string;
  gmcpData?: object;
}

/**
 * Client → Proxy message types
 */
export interface ConnectRequest {
  type: 'connect';
  host: string;
  port: number;
  deviceToken?: string;
  apiKey?: string;
  appToken?: string;
  width?: number;
  height?: number;
  debug?: boolean;
}

export interface ResumeRequest {
  type: 'resume';
  sessionId: string;
  token: string;
  lastSeq: number;
  deviceToken?: string;
  appToken?: string;
}

export interface ActivityTokenRequest {
  type: 'activityToken';
  token: string;
}

export interface SyncAckRequest {
  type: 'syncAck';
  sessionId: string;
  lastSeq: number;
}

export interface InputRequest {
  type: 'input';
  text: string;
}

export interface NAWSRequest {
  type: 'naws';
  width: number;
  height: number;
}

export interface DisconnectRequest {
  type: 'disconnect';
}

/**
 * App Attest message types
 */
export interface ChallengeRequest {
  type: 'challenge';
}

export interface ChallengeResponse {
  type: 'challenge';
  challenge: string;
  expiresAt: number;
}

export interface AttestRequest {
  type: 'attest';
  keyId: string;
  attestation: string;
  challenge: string;
  deviceToken?: string;
}

export interface AttestResponse {
  type: 'attested';
  success: boolean;
  appToken?: string;
  nextChallenge?: string;
  error?: string;
}

export interface AssertionRequest {
  type: 'assert';
  keyId: string;
  assertion: string;
  challenge: string;
}

export interface AttestationCacheEntry {
  keyId: string;
  publicKey: string;
  bundleId: string;
  teamId: string;
  deviceToken?: string;
  verifiedAt: number;
  expiresAt: number;
}

export interface AppTokenPayload {
  keyId: string;
  bundleId: string;
  deviceToken?: string;
  iat: number;
  exp: number;
}

export interface AppAttestConfig {
  enabled: boolean;
  requireInProduction: boolean;
  teamId: string;
  bundleId: string;
  apnsEnvironment: 'sandbox' | 'production';
  cacheTtlHours: number;
  challengeTtlSeconds: number;
}

export type ClientMessage =
  | ConnectRequest
  | ResumeRequest
  | ActivityTokenRequest
  | SyncAckRequest
  | InputRequest
  | NAWSRequest
  | DisconnectRequest
  | ChallengeRequest
  | AttestRequest
  | AssertionRequest;

/**
 * Proxy → Client message types
 */
export interface SessionResponse {
  type: 'session';
  sessionId: string;
  token: string;
  capabilities?: string[];
}

export interface ResumedResponse {
  type: 'resumed';
  sessionId: string;
  capabilities?: string[];
}

export interface DataResponse {
  type: 'data';
  seq: number;
  payload: string; // base64 encoded
  replayed?: boolean;
}

export interface GMCPResponse {
  type: 'gmcp';
  seq: number;
  package: string;
  data: object;
  replayed?: boolean;
}

export interface ErrorResponse {
  type: 'error';
  code:
    | 'invalid_resume'
    | 'session_expired'
    | 'rate_limited'
    | 'connection_failed'
    | 'invalid_request';
  message: string;
}

export interface DisconnectedResponse {
  type: 'disconnected';
  sessionId: string;
  reason?: string;
}

export type ProxyMessage =
  | SessionResponse
  | ResumedResponse
  | DataResponse
  | GMCPResponse
  | ErrorResponse
  | DisconnectedResponse;

/**
 * APNS configuration
 */
export interface APNSConfig {
  keyPath: string;
  keyId: string;
  teamId: string;
  topic: string;
  environment: 'sandbox' | 'production';
}

/**
 * Session configuration
 */
export interface SessionConfig {
  timeoutHours: number;
  maxPerDevice: number;
  maxPerIP: number;
}

/**
 * Buffer configuration
 */
export interface BufferConfig {
  sizeKB: number;
  maxReplayChunks: number;
}

/**
 * Notification rate limit configuration
 */
export interface RateLimitConfig {
  perTypePerMinute: number;
  totalPerHour: number;
}

/**
 * Complete proxy configuration
 */
export interface ProxyConfig {
  sessions: SessionConfig;
  buffer: BufferConfig;
  triggers: {
    rateLimit: RateLimitConfig;
  };
}

/**
 * Telnet socket with our extensions
 */
export interface TelnetSocket extends Socket {
  send: (data: string | Buffer) => void;
}

/**
 * Rate limit entry for notifications
 */
export interface RateLimitEntry {
  count: number;
  lastReset: number;
  lastNotification: Map<string, number>; // triggerId -> timestamp
}

/**
 * Trigger match result
 */
export interface TriggerMatch {
  triggerId: string;
  triggerType: string;
  matchedText: string;
  extractedData?: Record<string, string>;
}

/**
 * Notification payload for APNS
 */
export interface NotificationPayload {
  alert: {
    title: string;
    body: string;
  };
  badge: number;
  sound?: string;
  custom?: {
    sessionId: string;
    type: string;
  };
}

export interface ActivityContentState {
  status: 'connected' | 'disconnected';
  worldName: string;
  lastOutputSnippet: string;
  connectedSince: number;
  lastSyncTime: number;
}
