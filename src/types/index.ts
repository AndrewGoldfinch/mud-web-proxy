/**
 * Type definitions for MUDBasher session persistence proxy
 */

import type { Socket } from 'net';
import type { IncomingMessage } from 'http';
import type { WebSocket as WS } from 'ws';

/**
 * Extended WebSocket type with our custom properties
 * Based on the existing SocketExtended from wsproxy.ts
 */
export interface SocketExtended extends WS {
  req: IncomingMessage & { connection: { remoteAddress: string } };
  ts?: Socket;
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
  chat?: number;
  password_mode?: boolean;
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
  width?: number;
  height?: number;
}

export interface ResumeRequest {
  type: 'resume';
  sessionId: string;
  token: string;
  lastSeq: number;
  deviceToken?: string;
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

export type ClientMessage =
  | ConnectRequest
  | ResumeRequest
  | InputRequest
  | NAWSRequest;

/**
 * Proxy → Client message types
 */
export interface SessionResponse {
  type: 'session';
  sessionId: string;
  token: string;
}

export interface DataResponse {
  type: 'data';
  seq: number;
  payload: string; // base64 encoded
}

export interface GMCPResponse {
  type: 'gmcp';
  seq: number;
  package: string;
  data: object;
}

export interface ErrorResponse {
  type: 'error';
  code:
    | 'invalid_resume'
    | 'session_expired'
    | 'rate_limited'
    | 'connection_failed'
    | 'unauthorized'
    | 'invalid_request';
  message: string;
}

export type ProxyMessage =
  | SessionResponse
  | DataResponse
  | GMCPResponse
  | ErrorResponse;

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
