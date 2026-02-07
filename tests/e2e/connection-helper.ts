/**
 * E2E Connection Helper
 * Manages WebSocket connections to proxy and verifies protocol negotiations
 */

import WebSocket from 'ws';
import type { E2EConfig } from './config-loader';

export interface ConnectionResult {
  success: boolean;
  sessionId?: string;
  token?: string;
  lastSeq?: number;
  error?: string;
  negotiatedProtocols: {
    gmcp: boolean;
    mccp: boolean;
    mxp: boolean;
    msdp: boolean;
    utf8: boolean;
  };
  messages: E2EMessage[];
}

export interface E2EMessage {
  type: string;
  data: unknown;
  timestamp: number;
}

export class E2EConnection {
  private ws: WebSocket | null = null;
  private config: E2EConfig;
  private messages: E2EMessage[] = [];
  private negotiatedProtocols = {
    gmcp: false,
    mccp: false,
    mxp: false,
    msdp: false,
    utf8: false,
  };

  constructor(config: E2EConfig) {
    this.config = config;
  }

  /**
   * Connect to proxy and create session
   */
  async connect(proxyUrl: string): Promise<ConnectionResult> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(proxyUrl);

        const timeout = setTimeout(() => {
          resolve({
            success: false,
            error: 'Connection timeout',
            negotiatedProtocols: this.negotiatedProtocols,
            messages: this.messages,
          });
        }, this.config.testTimeoutMs);

        this.ws.on('open', () => {
          // Send connect request
          const connectMsg = {
            type: 'connect',
            host: this.config.host,
            port: this.config.port,
            deviceToken: 'e2e-test-device',
          };
          this.ws?.send(JSON.stringify(connectMsg));
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString());
            this.messages.push({
              type: msg.type || 'unknown',
              data: msg,
              timestamp: Date.now(),
            });

            // Track session creation
            if (msg.type === 'session') {
              clearTimeout(timeout);
              resolve({
                success: true,
                sessionId: msg.sessionId,
                token: msg.token,
                lastSeq: 0,
                negotiatedProtocols: this.negotiatedProtocols,
                messages: this.messages,
              });
            }

            // Track protocol negotiations
            if (msg.type === 'data') {
              this.detectProtocols(msg);
            }

            // Track errors
            if (msg.type === 'error') {
              clearTimeout(timeout);
              resolve({
                success: false,
                error: msg.message || msg.code,
                negotiatedProtocols: this.negotiatedProtocols,
                messages: this.messages,
              });
            }
          } catch (_err) {
            // Not JSON, probably telnet data
          }
        });

        this.ws.on('error', (err: Error) => {
          clearTimeout(timeout);
          resolve({
            success: false,
            error: err.message,
            negotiatedProtocols: this.negotiatedProtocols,
            messages: this.messages,
          });
        });

        this.ws.on('close', () => {
          // Connection closed
        });
      } catch (err) {
        resolve({
          success: false,
          error: (err as Error).message,
          negotiatedProtocols: this.negotiatedProtocols,
          messages: this.messages,
        });
      }
    });
  }

  /**
   * Resume existing session
   */
  async resume(
    proxyUrl: string,
    sessionId: string,
    token: string,
    lastSeq: number,
  ): Promise<ConnectionResult> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(proxyUrl);

        const timeout = setTimeout(() => {
          resolve({
            success: false,
            error: 'Resume timeout',
            negotiatedProtocols: this.negotiatedProtocols,
            messages: this.messages,
          });
        }, this.config.testTimeoutMs);

        this.ws.on('open', () => {
          // Send resume request
          const resumeMsg = {
            type: 'resume',
            sessionId,
            token,
            lastSeq,
            deviceToken: 'e2e-test-device',
          };
          this.ws?.send(JSON.stringify(resumeMsg));
        });

        this.ws.on('message', (data: WebSocket.Data) => {
          try {
            const msg = JSON.parse(data.toString());
            this.messages.push({
              type: msg.type || 'unknown',
              data: msg,
              timestamp: Date.now(),
            });

            // Resume successful - start receiving data
            if (msg.type === 'data' || msg.type === 'gmcp') {
              clearTimeout(timeout);
              resolve({
                success: true,
                sessionId,
                token,
                lastSeq: msg.seq || lastSeq,
                negotiatedProtocols: this.negotiatedProtocols,
                messages: this.messages,
              });
            }

            // Track errors
            if (msg.type === 'error') {
              clearTimeout(timeout);
              resolve({
                success: false,
                error: msg.message || msg.code,
                negotiatedProtocols: this.negotiatedProtocols,
                messages: this.messages,
              });
            }
          } catch (_err) {
            // Not JSON, probably telnet data
          }
        });

        this.ws.on('error', (err: Error) => {
          clearTimeout(timeout);
          resolve({
            success: false,
            error: err.message,
            negotiatedProtocols: this.negotiatedProtocols,
            messages: this.messages,
          });
        });
      } catch (err) {
        resolve({
          success: false,
          error: (err as Error).message,
          negotiatedProtocols: this.negotiatedProtocols,
          messages: this.messages,
        });
      }
    });
  }

  /**
   * Send command to MUD
   */
  sendCommand(command: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'input',
          text: command,
        }),
      );
    }
  }

  /**
   * Wait for specific message type
   */
  async waitForMessage(
    type: string,
    timeoutMs: number = 5000,
  ): Promise<E2EMessage | null> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const check = () => {
        const msg = this.messages.find((m) => m.type === type);
        if (msg) {
          resolve(msg);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          resolve(null);
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  /**
   * Wait for text in MUD output
   */
  async waitForText(
    text: string,
    timeoutMs: number = 10000,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const check = () => {
        // Check all data messages for text
        for (const msg of this.messages) {
          if (msg.type === 'data' || msg.type === 'gmcp') {
            const msgStr = JSON.stringify(msg.data).toLowerCase();
            if (msgStr.includes(text.toLowerCase())) {
              resolve(true);
              return;
            }
          }
        }

        if (Date.now() - startTime > timeoutMs) {
          resolve(false);
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  /**
   * Detect protocol negotiations from data
   */
  private detectProtocols(msg: { payload?: string }): void {
    if (!msg.payload) return;

    try {
      const data = Buffer.from(msg.payload, 'base64').toString();

      // Check for protocol negotiations
      if (data.includes('IAC DO GMCP') || data.includes('IAC WILL GMCP')) {
        this.negotiatedProtocols.gmcp = true;
      }
      if (data.includes('IAC DO MXP') || data.includes('IAC WILL MXP')) {
        this.negotiatedProtocols.mxp = true;
      }
      if (data.includes('IAC DO MSDP') || data.includes('IAC WILL MSDP')) {
        this.negotiatedProtocols.msdp = true;
      }
      if (data.includes('IAC DO MCCP') || data.includes('MCCP')) {
        this.negotiatedProtocols.mccp = true;
      }
      if (data.includes('UTF-8') || data.includes('utf8')) {
        this.negotiatedProtocols.utf8 = true;
      }
    } catch (_err) {
      // Ignore decode errors
    }
  }

  /**
   * Close connection
   */
  close(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Get all messages
   */
  getMessages(): E2EMessage[] {
    return [...this.messages];
  }

  /**
   * Check if protocol was negotiated
   */
  isProtocolNegotiated(
    protocol: keyof typeof this.negotiatedProtocols,
  ): boolean {
    return this.negotiatedProtocols[protocol];
  }
}
