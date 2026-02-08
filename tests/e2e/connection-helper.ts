/**
 * E2E Connection Helper
 * Manages WebSocket connections to proxy and verifies protocol negotiations
 */

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
        // Use native Bun WebSocket
        // Note: proxyUrl should be ws:// for non-TLS testing
        this.ws = new WebSocket(proxyUrl);

        const timeout = setTimeout(() => {
          resolve({
            success: false,
            error: 'Connection timeout',
            negotiatedProtocols: this.negotiatedProtocols,
            messages: this.messages,
          });
        }, this.config.testTimeoutMs);

        this.ws.onopen = () => {
          // Send connect request
          const connectMsg = {
            type: 'connect',
            host: this.config.host,
            port: this.config.port,
            deviceToken: 'e2e-test-device',
          };
          this.ws?.send(JSON.stringify(connectMsg));
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(event.data.toString());
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
        };

        this.ws.onerror = (event: Event) => {
          clearTimeout(timeout);
          resolve({
            success: false,
            error: 'WebSocket error: ' + (event as ErrorEvent).message,
            negotiatedProtocols: this.negotiatedProtocols,
            messages: this.messages,
          });
        };

        this.ws.onclose = () => {
          // Connection closed
        };
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
        // Use native Bun WebSocket
        this.ws = new WebSocket(proxyUrl);

        const timeout = setTimeout(() => {
          resolve({
            success: false,
            error: 'Resume timeout',
            negotiatedProtocols: this.negotiatedProtocols,
            messages: this.messages,
          });
        }, this.config.testTimeoutMs);

        this.ws.onopen = () => {
          // Send resume request
          const resumeMsg = {
            type: 'resume',
            sessionId,
            token,
            lastSeq,
            deviceToken: 'e2e-test-device',
          };
          this.ws?.send(JSON.stringify(resumeMsg));
        };

        this.ws.onmessage = (event: MessageEvent) => {
          try {
            const msg = JSON.parse(event.data.toString());
            this.messages.push({
              type: msg.type || 'unknown',
              data: msg,
              timestamp: Date.now(),
            });

            // Resume successful
            if (msg.type === 'resumed') {
              clearTimeout(timeout);
              resolve({
                success: true,
                sessionId: msg.sessionId || sessionId,
                token,
                lastSeq: lastSeq,
                negotiatedProtocols: this.negotiatedProtocols,
                messages: this.messages,
              });
            }

            // Also resolve on data/gmcp if resumed wasn't sent
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
        };

        this.ws.onerror = (event: Event) => {
          clearTimeout(timeout);
          resolve({
            success: false,
            error: 'WebSocket error: ' + (event as ErrorEvent).message,
            negotiatedProtocols: this.negotiatedProtocols,
            messages: this.messages,
          });
        };
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
      const data = Buffer.from(msg.payload, 'base64');

      // Check for protocol negotiations using telnet IAC codes
      // IAC = 0xFF (255)
      // WILL = 0xFB (251), DO = 0xFD (253)
      // GMCP = 0xC9 (201), MXP = 0x5B (91), MSDP = 0x45 (69), MCCP = 0x56 (86)

      for (let i = 0; i < data.length - 2; i++) {
        if (data[i] === 0xff) {
          // IAC found
          const cmd = data[i + 1];
          const option = data[i + 2];

          if (cmd === 0xfb || cmd === 0xfd) {
            // WILL or DO
            if (option === 0xc9) {
              this.negotiatedProtocols.gmcp = true;
            } else if (option === 0x5b) {
              this.negotiatedProtocols.mxp = true;
            } else if (option === 0x45) {
              this.negotiatedProtocols.msdp = true;
            } else if (option === 0x56) {
              this.negotiatedProtocols.mccp = true;
            }
          }
        }
      }

      // Also check for UTF-8 in string form
      const str = data.toString('utf8');
      if (str.includes('UTF-8') || str.includes('utf8')) {
        this.negotiatedProtocols.utf8 = true;
      }
    } catch (_err) {
      // Ignore decode errors
    }
  }

  /**
   * Get the last sequence number from received data/gmcp messages
   */
  getLastSequence(): number {
    let lastSeq = 0;
    for (const msg of this.messages) {
      if ((msg.type === 'data' || msg.type === 'gmcp') && typeof (msg.data as any)?.seq === 'number') {
        lastSeq = Math.max(lastSeq, (msg.data as any).seq);
      }
    }
    return lastSeq;
  }

  /**
   * Get all messages received after a given sequence number
   */
  getMessagesAfterSeq(seq: number): E2EMessage[] {
    return this.messages.filter(
      (m) => (m.type === 'data' || m.type === 'gmcp') && typeof (m.data as any)?.seq === 'number' && (m.data as any).seq > seq,
    );
  }

  /**
   * Get only data message payloads (base64 decoded to string)
   */
  getDataPayloads(): string[] {
    return this.messages
      .filter((m) => m.type === 'data' && (m.data as any)?.payload)
      .map((m) => {
        const payload = (m.data as any).payload;
        try {
          return Buffer.from(payload, 'base64').toString('utf8');
        } catch {
          return payload;
        }
      });
  }

  /**
   * Send NAWS (window size) to proxy
   */
  sendNAWS(width: number, height: number): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          type: 'naws',
          width,
          height,
        }),
      );
    }
  }

  /**
   * Wait for a minimum number of messages of a given type
   */
  async waitForMessageCount(
    type: string,
    count: number,
    timeoutMs: number = 10000,
  ): Promise<E2EMessage[]> {
    return new Promise((resolve) => {
      const startTime = Date.now();

      const check = () => {
        const matches = this.messages.filter((m) => m.type === type);
        if (matches.length >= count) {
          resolve(matches);
          return;
        }

        if (Date.now() - startTime > timeoutMs) {
          resolve(matches); // Return what we have
          return;
        }

        setTimeout(check, 100);
      };

      check();
    });
  }

  /**
   * Clear all stored messages
   */
  clearMessages(): void {
    this.messages.length = 0;
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
