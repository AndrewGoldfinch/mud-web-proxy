/**
 * TelnetParser - Strips telnet IAC sequences from MUD data and handles negotiation.
 *
 * Processes raw TCP bytes, separating clean text from telnet protocol commands.
 * Responds to MUD negotiation offers (TTYPE, GMCP, CHARSET, etc.) and extracts
 * GMCP subnegotiation payloads as separate messages.
 *
 * State machine handles partial IAC sequences across chunk boundaries.
 */

import type { Session } from './session';

// Telnet protocol constants
const IAC = 255;
const SE = 240;
const NOP = 241;
// Commands 242-248 (DM, BRK, IP, AO, AYT, EC, EL) fall through to GA range check
const GA = 249;
const SB = 250;
const WILL = 251;
const WONT = 252;
const DO = 253;
const DONT = 254;

// Telnet option codes
const ECHO = 1;
const SGA = 3;
const TTYPE = 24;
const NAWS = 31;
const NEW_ENV = 39;
const CHARSET = 42;
const MSDP = 69;
const MCCP2 = 86;
const MXP = 91;
const GMCP = 201;

// Subneg constants
const IS = 0;
const REQUEST = 1;
const ACCEPTED = 2;
const MSDP_VAR = 1;
const MSDP_VAL = 2;

enum State {
  TEXT,
  IAC,
  NEGOTIATION,       // After WILL/WONT/DO/DONT, waiting for option byte
  SUBNEG,            // Collecting subnegotiation data until IAC SE
  SUBNEG_IAC,        // Saw IAC inside subneg, waiting for SE or escaped IAC
}

export interface GmcpMessage {
  package: string;
  data: string;
}

export interface TelnetParseResult {
  text: Buffer;
  gmcpMessages: GmcpMessage[];
}

export class TelnetParser {
  private state = State.TEXT;
  private negotiationCmd = 0;  // WILL/WONT/DO/DONT that started current negotiation
  private subnegOption = 0;    // Option code for current subnegotiation
  private subnegBuffer: number[] = [];

  // Negotiation state tracking
  private gmcpNegotiated = false;
  private ttypeNegotiated = false;
  private msdpNegotiated = false;
  private mxpNegotiated = false;
  private newEnvNegotiated = false;
  private echoNegotiated = false;
  private sgaNegotiated = false;
  private nawsNegotiated = false;
  private charsetNegotiated = false;

  passwordMode = false;

  // Terminal types to send (rotated through on TTYPE requests)
  private ttypeQueue: string[] = [];

  private readonly session: Session;

  constructor(session: Session) {
    this.session = session;
    // Set up terminal type queue like the old wsproxy
    this.ttypeQueue = ['MUDBasher', 'XTERM-256color', 'MTTS 141'];
  }

  /**
   * Process a raw data buffer from the MUD.
   * Returns clean text (IAC sequences stripped) and any extracted GMCP messages.
   */
  process(data: Buffer): TelnetParseResult {
    const textBytes: number[] = [];
    const gmcpMessages: GmcpMessage[] = [];

    for (let i = 0; i < data.length; i++) {
      const byte = data[i];

      switch (this.state) {
        case State.TEXT:
          if (byte === IAC) {
            this.state = State.IAC;
          } else {
            textBytes.push(byte);
          }
          break;

        case State.IAC:
          if (byte === IAC) {
            // Escaped IAC → literal 0xFF
            textBytes.push(0xff);
            this.state = State.TEXT;
          } else if (byte >= NOP && byte <= GA) {
            // 2-byte commands (NOP, GA, etc.) — just strip
            this.state = State.TEXT;
          } else if (byte >= WILL && byte <= DONT) {
            // 3-byte negotiation — need option byte next
            this.negotiationCmd = byte;
            this.state = State.NEGOTIATION;
          } else if (byte === SB) {
            // Start subnegotiation — need option byte, then data until IAC SE
            this.state = State.NEGOTIATION;
            this.negotiationCmd = SB;
          } else {
            // Unknown after IAC, skip
            this.state = State.TEXT;
          }
          break;

        case State.NEGOTIATION:
          if (this.negotiationCmd === SB) {
            // Starting subnegotiation for this option
            this.subnegOption = byte;
            this.subnegBuffer = [];
            this.state = State.SUBNEG;
          } else {
            // 3-byte: IAC WILL/WONT/DO/DONT <option>
            this.handleNegotiation(this.negotiationCmd, byte);
            this.state = State.TEXT;
          }
          break;

        case State.SUBNEG:
          if (byte === IAC) {
            this.state = State.SUBNEG_IAC;
          } else {
            this.subnegBuffer.push(byte);
          }
          break;

        case State.SUBNEG_IAC:
          if (byte === SE) {
            // End of subnegotiation
            this.handleSubnegotiation(this.subnegOption, this.subnegBuffer, gmcpMessages);
            this.state = State.TEXT;
          } else if (byte === IAC) {
            // Escaped IAC inside subneg
            this.subnegBuffer.push(0xff);
            this.state = State.SUBNEG;
          } else {
            // Unexpected byte after IAC in subneg, treat as end
            this.state = State.TEXT;
          }
          break;
      }
    }

    return {
      text: Buffer.from(textBytes),
      gmcpMessages,
    };
  }

  /**
   * Handle 3-byte negotiation: IAC WILL/WONT/DO/DONT <option>
   */
  private handleNegotiation(cmd: number, option: number): void {
    const cmdName = cmd === WILL ? 'WILL' : cmd === WONT ? 'WONT' : cmd === DO ? 'DO' : 'DONT';
    // eslint-disable-next-line no-console
    console.log(`[telnet] ${cmdName} ${this.optionName(option)}`);

    switch (option) {
      case GMCP:
        if (!this.gmcpNegotiated) {
          this.gmcpNegotiated = true;
          // Mirror: if server says DO, respond WILL; if WILL, respond DO
          if (cmd === DO) {
            this.writeToMud(Buffer.from([IAC, WILL, GMCP]));
          } else if (cmd === WILL) {
            this.writeToMud(Buffer.from([IAC, DO, GMCP]));
          }
          // Send client info via GMCP
          this.sendGMCP('client MUDBasher');
          this.sendGMCP('client_version 1.0');
        }
        break;

      case TTYPE:
        if (cmd === DO && !this.ttypeNegotiated) {
          // MUD asks us to send TTYPE
          this.ttypeNegotiated = true;
          this.sendNextTtype();
        }
        break;

      case MSDP:
        if (cmd === WILL && !this.msdpNegotiated) {
          this.msdpNegotiated = true;
          this.writeToMud(Buffer.from([IAC, DO, MSDP]));
          this.sendMSDPPair('CLIENT_ID', 'MUDBasher');
          this.sendMSDPPair('CLIENT_VERSION', '1.0');
          this.sendMSDPPair('XTERM_256_COLORS', '1');
          this.sendMSDPPair('MXP', '1');
          this.sendMSDPPair('UTF_8', '1');
        }
        break;

      case MXP:
        if (!this.mxpNegotiated) {
          this.mxpNegotiated = true;
          if (cmd === DO) {
            this.writeToMud(Buffer.from([IAC, WILL, MXP]));
          } else if (cmd === WILL) {
            this.writeToMud(Buffer.from([IAC, DO, MXP]));
          }
        }
        break;

      case NEW_ENV:
        if (cmd === DO && !this.newEnvNegotiated) {
          this.newEnvNegotiated = true;
          this.writeToMud(Buffer.from([IAC, WILL, NEW_ENV]));
        }
        break;

      case ECHO:
        if (cmd === WILL && !this.echoNegotiated) {
          this.echoNegotiated = true;
          this.passwordMode = true;
          // eslint-disable-next-line no-console
          console.log('[telnet] Password mode enabled');
        } else if (cmd === WONT) {
          this.passwordMode = false;
        }
        break;

      case SGA:
        if (cmd === WILL && !this.sgaNegotiated) {
          this.sgaNegotiated = true;
          this.writeToMud(Buffer.from([IAC, WONT, SGA]));
        }
        break;

      case NAWS:
        if (cmd === DO && !this.nawsNegotiated) {
          this.nawsNegotiated = true;
          // We handle NAWS via session.sendNAWS() which the client triggers
          this.session.sendNAWS();
        } else if (cmd === WILL && !this.nawsNegotiated) {
          this.nawsNegotiated = true;
          this.writeToMud(Buffer.from([IAC, WONT, NAWS]));
        }
        break;

      case CHARSET:
        if (cmd === DO && !this.charsetNegotiated) {
          // Respond WILL CHARSET
          this.writeToMud(Buffer.from([IAC, WILL, CHARSET]));
        }
        break;

      case MCCP2:
        // Don't negotiate compression — we want raw data
        break;

      default:
        // Unknown option — respond WONT/DONT to refuse
        if (cmd === DO) {
          this.writeToMud(Buffer.from([IAC, WONT, option]));
        } else if (cmd === WILL) {
          this.writeToMud(Buffer.from([IAC, DONT, option]));
        }
        break;
    }
  }

  /**
   * Handle subnegotiation: IAC SB <option> <data...> IAC SE
   */
  private handleSubnegotiation(
    option: number,
    data: number[],
    gmcpMessages: GmcpMessage[],
  ): void {
    switch (option) {
      case TTYPE:
        // Server requesting terminal type (SB TTYPE REQUEST)
        if (data.length > 0 && data[0] === REQUEST) {
          this.sendNextTtype();
        }
        break;

      case GMCP:
        this.handleGMCPSubneg(data, gmcpMessages);
        break;

      case CHARSET:
        // Server offering charset negotiation — accept UTF-8
        if (!this.charsetNegotiated) {
          this.charsetNegotiated = true;
          // IAC SB CHARSET ACCEPTED "UTF-8" IAC SE
          const utf8Bytes = Buffer.from('UTF-8', 'ascii');
          const response = Buffer.alloc(utf8Bytes.length + 5);
          response[0] = IAC;
          response[1] = SB;
          response[2] = CHARSET;
          response[3] = ACCEPTED;
          utf8Bytes.copy(response, 4);
          response[response.length - 2] = IAC;
          response[response.length - 1] = SE;
          this.writeToMud(response);
          // eslint-disable-next-line no-console
          console.log('[telnet] CHARSET accepted UTF-8');
        }
        break;

      case NEW_ENV:
        // Server requesting environment variables
        if (data.length > 0 && data[0] === REQUEST) {
          // Respond with IPADDRESS
          const ipBuf = Buffer.from([IAC, SB, NEW_ENV, IS, IS]);
          const varName = Buffer.from('IPADDRESS', 'ascii');
          const valSep = Buffer.from([REQUEST]);
          const ipAddr = Buffer.from('0.0.0.0', 'ascii');
          const end = Buffer.from([IAC, SE]);
          this.writeToMud(Buffer.concat([ipBuf, varName, valSep, ipAddr, end]));
          // eslint-disable-next-line no-console
          console.log('[telnet] NEW-ENV sent IPADDRESS');
        }
        break;

      default:
        break;
    }
  }

  /**
   * Extract GMCP message from subnegotiation data
   */
  private handleGMCPSubneg(data: number[], gmcpMessages: GmcpMessage[]): void {
    // GMCP format: <package> <json-data> or just <package>
    const raw = Buffer.from(data).toString('utf8');
    const spaceIdx = raw.indexOf(' ');

    if (spaceIdx === -1) {
      gmcpMessages.push({ package: raw, data: '' });
    } else {
      gmcpMessages.push({
        package: raw.substring(0, spaceIdx),
        data: raw.substring(spaceIdx + 1),
      });
    }
    // eslint-disable-next-line no-console
    console.log(`[telnet] GMCP: ${gmcpMessages[gmcpMessages.length - 1].package}`);
  }

  /**
   * Send the next terminal type in the queue
   */
  private sendNextTtype(): void {
    const ttype = this.ttypeQueue.length > 0
      ? this.ttypeQueue.shift()!
      : 'MUDBasher';

    // IAC SB TTYPE IS <name> IAC SE
    const nameBytes = Buffer.from(ttype, 'ascii');
    const header = Buffer.from([IAC, SB, TTYPE, IS]);
    const footer = Buffer.from([IAC, SE]);

    // Also send WILL TTYPE first
    this.writeToMud(Buffer.from([IAC, WILL, TTYPE]));
    this.writeToMud(Buffer.concat([header, nameBytes, footer]));
    // eslint-disable-next-line no-console
    console.log(`[telnet] TTYPE sent: ${ttype}`);
  }

  /**
   * Send a GMCP message to the MUD
   */
  private sendGMCP(msg: string): void {
    const start = Buffer.from([IAC, SB, GMCP]);
    const body = Buffer.from(msg, 'utf8');
    const end = Buffer.from([IAC, SE]);
    this.writeToMud(Buffer.concat([start, body, end]));
    // eslint-disable-next-line no-console
    console.log(`[telnet] GMCP sent: ${msg}`);
  }

  /**
   * Send an MSDP key-value pair to the MUD
   */
  private sendMSDPPair(key: string, val: string): void {
    const header = Buffer.from([IAC, SB, MSDP, MSDP_VAR]);
    const keyBuf = Buffer.from(key, 'ascii');
    const sep = Buffer.from([MSDP_VAL]);
    const valBuf = Buffer.from(val, 'ascii');
    const footer = Buffer.from([IAC, SE]);
    this.writeToMud(Buffer.concat([header, keyBuf, sep, valBuf, footer]));
  }

  /**
   * Write raw bytes to the MUD via session
   */
  private writeToMud(data: Buffer): void {
    this.session.sendToMud(data);
  }

  /**
   * Human-readable option name for logging
   */
  private optionName(option: number): string {
    const names: Record<number, string> = {
      [ECHO]: 'ECHO',
      [SGA]: 'SGA',
      [TTYPE]: 'TTYPE',
      [NAWS]: 'NAWS',
      [NEW_ENV]: 'NEW-ENV',
      [CHARSET]: 'CHARSET',
      [MSDP]: 'MSDP',
      [MCCP2]: 'MCCP2',
      [MXP]: 'MXP',
      [GMCP]: 'GMCP',
    };
    return names[option] || `OPT(${option})`;
  }
}
