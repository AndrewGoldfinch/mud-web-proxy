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
  NEGOTIATION, // After WILL/WONT/DO/DONT, waiting for option byte
  SUBNEG, // Collecting subnegotiation data until IAC SE
  SUBNEG_IAC, // Saw IAC inside subneg, waiting for SE or escaped IAC
  SUBNEG_DISCARD, // Over the cap: consume to the real IAC SE, keeping nothing
  SUBNEG_DISCARD_IAC, // Saw IAC while discarding
}

/**
 * Default cap on one subnegotiation payload.
 *
 * Chosen above what real MUDs send — Aardwolf, Achaea and Discworld all push
 * large MSDP/GMCP blobs, and a cap that breaks a legitimate game is a worse
 * outcome than the memory it saves. 64 KiB also matches the inbound WebSocket
 * frame cap, so the two directions are bounded alike.
 */
export const DEFAULT_MAX_SUBNEGOTIATION_BYTES = 64 * 1024;

export interface GmcpMessage {
  package: string;
  data: string;
}

/**
 * Ordered output unit: either a run of clean text, or an ECHO-suppression state
 * transition. Split at the exact transition point (not just an end-of-chunk flag) so
 * a chunk that both echoes suppressed text back *and* toggles ECHO in the same TCP
 * read — e.g. the MUD echoing a password and then sending `WONT ECHO` before the
 * next line — can be forwarded with the suppression boundary in the right place.
 */
export type TelnetSegment =
  { kind: 'text'; data: Buffer } | { kind: 'echo'; suppressed: boolean };

export interface TelnetParseResult {
  /** All text bytes this call, concatenated — unchanged from before segments existed. */
  text: Buffer;
  /** Ordered text/echo segments, split at each ECHO transition. */
  segments: TelnetSegment[];
  gmcpMessages: GmcpMessage[];
}

/** Per-call accumulator threaded through `process()` and the negotiation handlers. */
interface ParseOutput {
  currentText: number[];
  allText: number[];
  segments: TelnetSegment[];
  gmcpMessages: GmcpMessage[];
}

export class TelnetParser {
  private state = State.TEXT;
  private negotiationCmd = 0; // WILL/WONT/DO/DONT that started current negotiation
  private subnegOption = 0; // Option code for current subnegotiation
  private subnegBuffer: number[] = [];
  /** Set while discarding, so overflow is logged once per sequence, not per byte. */
  private subnegOverflowLogged = false;

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
  private negotiationLoggedOnce = false;

  passwordMode = false;

  // Terminal types to send (rotated through on TTYPE requests)
  private ttypeQueue: string[] = [];

  private readonly session: Session;
  private readonly sessionIdShort: string;

  constructor(
    session: Session,
    private readonly maxSubnegotiationBytes: number = DEFAULT_MAX_SUBNEGOTIATION_BYTES,
  ) {
    this.session = session;
    this.sessionIdShort = session.id.substring(0, 8);
    // Set up terminal type queue like the old wsproxy
    this.ttypeQueue = ['MUDBasher', 'XTERM-256color', 'MTTS 141'];
  }

  /**
   * Process a raw data buffer from the MUD.
   * Returns clean text (IAC sequences stripped), ordered text/echo segments, and any
   * extracted GMCP messages.
   */
  process(data: Buffer): TelnetParseResult {
    const output: ParseOutput = {
      currentText: [],
      allText: [],
      segments: [],
      gmcpMessages: [],
    };

    for (let i = 0; i < data.length; i++) {
      const byte = data[i];

      switch (this.state) {
        case State.TEXT:
          if (byte === IAC) {
            this.state = State.IAC;
          } else {
            this.pushTextByte(output, byte);
          }
          break;

        case State.IAC:
          if (byte === IAC) {
            // Escaped IAC → literal 0xFF
            this.pushTextByte(output, 0xff);
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
            this.handleNegotiation(this.negotiationCmd, byte, output);
            this.state = State.TEXT;
          }
          break;

        case State.SUBNEG:
          if (byte === IAC) {
            this.state = State.SUBNEG_IAC;
          } else {
            this.appendSubnegByte(byte);
          }
          break;

        case State.SUBNEG_DISCARD:
          // Everything here is thrown away; only IAC matters, to find the end.
          if (byte === IAC) this.state = State.SUBNEG_DISCARD_IAC;
          break;

        case State.SUBNEG_DISCARD_IAC:
          if (byte === SE) {
            this.state = State.TEXT;
            this.subnegOverflowLogged = false;
          } else {
            // Anything else — an escaped IAC, or IAC NOP and friends — keeps
            // the discard going. Returning to TEXT here emitted the rest of the
            // payload as game text and left the real IAC SE unrecognised as its
            // terminator, which is the desynchronization this state exists to
            // prevent. Only the genuine terminator ends the sequence.
            this.state = State.SUBNEG_DISCARD;
          }
          break;

        case State.SUBNEG_IAC:
          if (byte === SE) {
            // End of subnegotiation
            this.handleSubnegotiation(
              this.subnegOption,
              this.subnegBuffer,
              output.gmcpMessages,
            );
            this.state = State.TEXT;
          } else if (byte === IAC) {
            // Escaped IAC inside subneg. Goes through the same choke point as
            // any other payload byte: this push used to be unconditional, so a
            // payload of nothing but legal IAC IAC pairs grew the buffer with
            // the cap never consulted — 10,000 entries against a cap of 8.
            if (this.appendSubnegByte(0xff)) {
              this.state = State.SUBNEG;
            }
          } else {
            // Unexpected byte after IAC in subneg, treat as end
            this.state = State.TEXT;
          }
          break;
      }
    }

    // Flush any trailing text accumulated after the last echo transition (or all of it,
    // if there was none this call).
    this.flushText(output);

    // Log a one-time summary once negotiation options have been seen
    if (!this.negotiationLoggedOnce && this.hasAnyNegotiation()) {
      this.negotiationLoggedOnce = true;
      // eslint-disable-next-line no-console
      console.log(
        `[telnet] [sid:${this.sessionIdShort}] negotiated: ${this.negotiationSummary()}`,
      );
    }

    return {
      text: Buffer.from(output.allText),
      segments: output.segments,
      gmcpMessages: output.gmcpMessages,
    };
  }

  /**
   * Append one payload byte, or begin discarding if that would exceed the cap.
   *
   * Every path that grows subnegBuffer goes through here. It was previously
   * checked in one branch only, and the escaped-IAC branch pushed
   * unconditionally — so the cap was bypassable by a payload made entirely of
   * legal `IAC IAC` pairs. One choke point is the difference between a cap and
   * the appearance of one.
   *
   * Returns true if the byte was stored, false if the sequence is now being
   * discarded.
   */
  private appendSubnegByte(byte: number): boolean {
    if (this.subnegBuffer.length >= this.maxSubnegotiationBytes) {
      // Drop what was collected and consume the rest without keeping it, rather
      // than truncating and carrying on: a truncated GMCP payload is invalid at
      // best and misleading at worst, and treating the remaining payload as
      // text would hand the player binary.
      this.logSubnegOverflow();
      this.subnegBuffer = [];
      this.state = State.SUBNEG_DISCARD;
      return false;
    }
    this.subnegBuffer.push(byte);
    return true;
  }

  /**
   * Report an over-long subnegotiation once per sequence.
   *
   * Per byte this would itself be the denial of service — a MUD streaming
   * megabytes would produce a log line for each one.
   */
  private logSubnegOverflow(): void {
    if (this.subnegOverflowLogged) return;
    this.subnegOverflowLogged = true;
    // eslint-disable-next-line no-console
    console.warn(
      `[telnet] [sid:${this.sessionIdShort}] subnegotiation option=${this.subnegOption} exceeded ${this.maxSubnegotiationBytes} bytes; sequence discarded`,
    );
  }

  /** Record a clean text byte in both the running segment buffer and the full-call buffer. */
  private pushTextByte(output: ParseOutput, byte: number): void {
    output.currentText.push(byte);
    output.allText.push(byte);
  }

  /** Close out the current text run as a segment, if any bytes have accumulated. */
  private flushText(output: ParseOutput): void {
    if (output.currentText.length > 0) {
      output.segments.push({
        kind: 'text',
        data: Buffer.from(output.currentText),
      });
      output.currentText = [];
    }
  }

  /**
   * Update ECHO-suppression state and, if it actually changed, flush pending text and
   * push an ordered echo segment at this exact point in the stream. No-ops on a
   * repeated negotiation for the same state (e.g. two WILL ECHOs in a row) so replay
   * consumers don't see duplicate transitions.
   */
  private setPasswordMode(suppressed: boolean, output: ParseOutput): void {
    if (this.passwordMode === suppressed) return;
    this.passwordMode = suppressed;
    this.flushText(output);
    output.segments.push({ kind: 'echo', suppressed });
  }

  /**
   * Handle 3-byte negotiation: IAC WILL/WONT/DO/DONT <option>
   */
  private handleNegotiation(
    cmd: number,
    option: number,
    output: ParseOutput,
  ): void {
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
          this.sendMSDPPair('UTF_8', '1');
        }
        break;

      case MXP:
        // Refuse MXP — client doesn't render it and markup leaks into text
        if (!this.mxpNegotiated) {
          this.mxpNegotiated = true;
          if (cmd === DO) {
            this.writeToMud(Buffer.from([IAC, WONT, MXP]));
          } else if (cmd === WILL) {
            this.writeToMud(Buffer.from([IAC, DONT, MXP]));
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
        // Tracked per-transition (not gated on a one-time `echoNegotiated` flag) so a
        // second password prompt later in the same session (re-auth, change-password)
        // is suppressed too. `echoNegotiated` still records "ECHO was seen at all" for
        // the one-time negotiation summary log below.
        this.echoNegotiated =
          this.echoNegotiated || cmd === WILL || cmd === WONT;
        if (cmd === WILL) {
          this.setPasswordMode(true, output);
        } else if (cmd === WONT) {
          this.setPasswordMode(false, output);
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
          this.writeToMud(
            Buffer.concat([ipBuf, varName, valSep, ipAddr, end]),
          );
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
  }

  /**
   * Send the next terminal type in the queue
   */
  private sendNextTtype(): void {
    const ttype =
      this.ttypeQueue.length > 0 ? this.ttypeQueue.shift()! : 'MUDBasher';

    // IAC SB TTYPE IS <name> IAC SE
    const nameBytes = Buffer.from(ttype, 'ascii');
    const header = Buffer.from([IAC, SB, TTYPE, IS]);
    const footer = Buffer.from([IAC, SE]);

    // Also send WILL TTYPE first
    this.writeToMud(Buffer.from([IAC, WILL, TTYPE]));
    this.writeToMud(Buffer.concat([header, nameBytes, footer]));
  }

  /**
   * Send a GMCP message to the MUD
   */
  private sendGMCP(msg: string): void {
    const start = Buffer.from([IAC, SB, GMCP]);
    const body = Buffer.from(msg, 'utf8');
    const end = Buffer.from([IAC, SE]);
    this.writeToMud(Buffer.concat([start, body, end]));
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

  private hasAnyNegotiation(): boolean {
    return (
      this.gmcpNegotiated ||
      this.ttypeNegotiated ||
      this.echoNegotiated ||
      this.sgaNegotiated ||
      this.nawsNegotiated ||
      this.charsetNegotiated
    );
  }

  private negotiationSummary(): string {
    const opts: string[] = [];
    if (this.gmcpNegotiated) opts.push('GMCP');
    if (this.ttypeNegotiated) opts.push('TTYPE');
    if (this.msdpNegotiated) opts.push('MSDP');
    if (this.mxpNegotiated) opts.push('MXP');
    if (this.newEnvNegotiated) opts.push('NEW-ENV');
    if (this.echoNegotiated) opts.push('ECHO');
    if (this.sgaNegotiated) opts.push('SGA');
    if (this.nawsNegotiated) opts.push('NAWS');
    if (this.charsetNegotiated) opts.push('CHARSET');
    return opts.join(', ');
  }
}
