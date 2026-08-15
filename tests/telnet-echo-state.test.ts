/**
 * Tests for telnet ECHO-state forwarding (MUDBasher audit H1/N1 remediation).
 *
 * The MUD negotiates `IAC WILL ECHO` / `IAC WONT ECHO` around password prompts.
 * Previously this state was tracked internally by `TelnetParser` but never
 * forwarded to the client, so a proxied session had no way to suppress a
 * server-echoed password from its session log or resume buffer the way a
 * direct telnet connection already does.
 *
 * Part 1 exercises `TelnetParser.process()` directly — the safety-critical
 * ordering guarantee (text and echo-state must split at the exact transition
 * point, even within one TCP read).
 * Part 2 exercises the wire-protocol forwarding logic in `SessionIntegration`
 * (segment iteration, buffering, resume replay). It drives `Session` and its
 * private message handlers directly rather than through a real TCP MUD +
 * WebSocket, since none of that machinery is what changed — this keeps the
 * suite fast and deterministic instead of depending on Node's TLS-vs-plain
 * auto-detection handshake timing.
 */

import { z } from 'zod';
import { asDouble } from './support/doubles';
import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'events';
import { TelnetParser } from '../src/telnet-parser';
import { Session } from '../src/session';
import { SessionIntegration } from '../src/session-integration.js';
import type { SocketExtended } from '../src/types/index.js';
import type { ResumeRequest } from '../src/types/index.js';

const IAC = 255;
const WILL = 251;
const WONT = 252;
const ECHO = 1;

function willEcho(): Buffer {
  return Buffer.from([IAC, WILL, ECHO]);
}
function wontEcho(): Buffer {
  return Buffer.from([IAC, WONT, ECHO]);
}

/** Minimal stand-in for `Session` — TelnetParser only calls `sendToMud`/`sendNAWS`. */
function makeFakeSession(id = 'test-session'): Session {
  return asDouble<Session>()({
    id,
    sendToMud: () => true,
    sendNAWS: () => {},
  });
}

/** One frame this suite decodes, by the fields it asserts on. */
const echoFrameSchema = z.looseObject({
  type: z.string().optional(),
  payload: z.string().optional(),
  replayed: z.boolean().optional(),
  suppressed: z.boolean().optional(),
});

/** The comparable form the assertions below are written against. */
type DecodedFrame =
  | { type: 'data'; text: string; replayed?: boolean }
  | { type: 'echo'; suppressed?: boolean; replayed?: boolean };

/**
 * The two private methods this suite drives directly.
 *
 * Named rather than `(si as any)`: the suite bypasses the JSON `connect`
 * handshake on purpose, and this records exactly which internals that costs.
 */
interface SessionIntegrationInternals {
  processMudData: (
    session: Session,
    socket: SocketExtended,
    data: Buffer,
  ) => void;
  handleResume: (socket: SocketExtended, msg: ResumeRequest) => void;
}

const siInternals = (si: SessionIntegration): SessionIntegrationInternals =>
  asDouble<SessionIntegrationInternals>()(si);

describe('TelnetParser — echo-state segment ordering', () => {
  test('WILL ECHO alone produces a single echo segment, no text', () => {
    const parser = new TelnetParser(makeFakeSession());
    const result = parser.process(willEcho());

    expect(result.segments).toEqual([{ kind: 'echo', suppressed: true }]);
    expect(result.text.length).toBe(0);
  });

  test('text, WILL ECHO, more text, WONT ECHO, more text — all in one chunk', () => {
    // The exact password-echo scenario: the MUD echoes the just-typed password back
    // and turns echo back off before the next line, all in a single TCP read.
    const parser = new TelnetParser(makeFakeSession());
    const chunk = Buffer.concat([
      Buffer.from('Password: '),
      willEcho(),
      Buffer.from('hunter2\r\n'),
      wontEcho(),
      Buffer.from('Welcome!\n'),
    ]);

    const result = parser.process(chunk);

    expect(result.segments).toEqual([
      { kind: 'text', data: Buffer.from('Password: ') },
      { kind: 'echo', suppressed: true },
      { kind: 'text', data: Buffer.from('hunter2\r\n') },
      { kind: 'echo', suppressed: false },
      { kind: 'text', data: Buffer.from('Welcome!\n') },
    ]);

    // Backward-compatible combined buffer still concatenates all text, unfiltered —
    // consumers that only look at `.text` (e.g. notification matching) are unaffected.
    expect(result.text.toString()).toBe('Password: hunter2\r\nWelcome!\n');
  });

  test('repeated WILL ECHO without an intervening WONT does not duplicate the segment', () => {
    const parser = new TelnetParser(makeFakeSession());
    const chunk = Buffer.concat([willEcho(), willEcho()]);

    const result = parser.process(chunk);

    expect(result.segments).toEqual([{ kind: 'echo', suppressed: true }]);
  });

  test('a second password prompt later in the same session still toggles suppression', () => {
    // Regression guard: passwordMode used to be gated by a one-time `echoNegotiated`
    // flag, so a *second* WILL ECHO later in the session (re-auth, change-password)
    // would never re-suppress. Split across two process() calls, like two MUD reads.
    const parser = new TelnetParser(makeFakeSession());

    const first = parser.process(
      Buffer.concat([
        Buffer.from('Password: '),
        willEcho(),
        wontEcho(),
        Buffer.from('Welcome!\n'),
      ]),
    );
    expect(first.segments.filter((s) => s.kind === 'echo')).toEqual([
      { kind: 'echo', suppressed: true },
      { kind: 'echo', suppressed: false },
    ]);

    const second = parser.process(
      Buffer.concat([
        Buffer.from('New password: '),
        willEcho(),
        wontEcho(),
        Buffer.from('Changed.\n'),
      ]),
    );
    expect(second.segments.filter((s) => s.kind === 'echo')).toEqual([
      { kind: 'echo', suppressed: true },
      { kind: 'echo', suppressed: false },
    ]);
  });

  test('echo transition split across two process() calls (chunk boundary)', () => {
    const parser = new TelnetParser(makeFakeSession());

    const r1 = parser.process(Buffer.from('Password: '));
    expect(r1.segments).toEqual([
      { kind: 'text', data: Buffer.from('Password: ') },
    ]);

    // IAC WILL ECHO arrives split across two reads: IAC WILL, then ECHO.
    const r2 = parser.process(Buffer.from([IAC, WILL]));
    expect(r2.segments).toEqual([]); // negotiation not complete yet, nothing to flush

    const r3 = parser.process(Buffer.from([ECHO]));
    expect(r3.segments).toEqual([{ kind: 'echo', suppressed: true }]);
  });

  test('escaped IAC (0xFF 0xFF) inside a suppressed segment is preserved as literal 0xFF', () => {
    const parser = new TelnetParser(makeFakeSession());
    const chunk = Buffer.concat([
      willEcho(),
      Buffer.from([0x41, IAC, IAC, 0x42]),
    ]);

    const result = parser.process(chunk);

    expect(result.segments).toEqual([
      { kind: 'echo', suppressed: true },
      { kind: 'text', data: Buffer.from([0x41, 0xff, 0x42]) },
    ]);
  });

  test('GMCP subnegotiation is unaffected by echo segmenting', () => {
    const GMCP = 201;
    const SB = 250;
    const SE = 240;
    const parser = new TelnetParser(makeFakeSession());
    const gmcpPayload = Buffer.from('Char.Vitals {"hp":100}');
    const chunk = Buffer.concat([
      Buffer.from('before '),
      Buffer.from([IAC, SB, GMCP]),
      gmcpPayload,
      Buffer.from([IAC, SE]),
      Buffer.from(' after'),
    ]);

    const result = parser.process(chunk);

    expect(result.gmcpMessages).toEqual([
      { package: 'Char.Vitals', data: '{"hp":100}' },
    ]);
    // GMCP bytes never entered the text stream; still one contiguous text segment.
    expect(result.segments).toEqual([
      { kind: 'text', data: Buffer.from('before  after') },
    ]);
  });
});

describe('Echo-state forwarding over the wire (SessionIntegration)', () => {
  interface MockSocket extends SocketExtended {
    messages: string[];
  }

  function makeClientSocket(): MockSocket {
    const messages: string[] = [];
    const s = asDouble<MockSocket>()(new EventEmitter());
    s.readyState = 1;
    s.remoteAddress = '127.0.0.1';
    s.messages = messages;
    s.sendUTF = (data: string | Buffer) => {
      messages.push(String(data));
    };
    s.send = (data: Parameters<MockSocket['send']>[0]) => {
      messages.push(String(data));
    };
    s.terminate = () => {};
    s.ttype = [];
    s.compressed = 0;
    s.req = asDouble<MockSocket['req']>()({
      headers: {},
      connection: { remoteAddress: '127.0.0.1' },
      url: '/',
      method: 'GET',
    });
    return s;
  }

  function decodedMessages(socket: MockSocket): DecodedFrame[] {
    return socket.messages
      .map((m) => echoFrameSchema.parse(JSON.parse(m)))
      .filter((m) => m.type === 'data' || m.type === 'echo')
      .map((m) =>
        m.type === 'data'
          ? {
              type: 'data',
              text: Buffer.from(m.payload ?? '', 'base64').toString(),
              replayed: m.replayed,
            }
          : { type: 'echo', suppressed: m.suppressed, replayed: m.replayed },
      );
  }

  // Drives Session + SessionIntegration directly (bypassing the JSON `connect` message
  // and any real TCP/TLS negotiation, which this suite has no need to exercise) so the
  // segment-forwarding logic under test runs deterministically and fast.
  function makeIntegration(): SessionIntegration {
    return new SessionIntegration({
      targets: {
        targetMode: 'arbitrary' as const,
        defaultHost: 'mud.test',
        defaultPort: 23,
        arbitraryAllowedPorts: ['1-65535'],
      },
      // These fixtures exercise session accounting, not DNS. Stub resolution
      // so arbitrary mode does not perform real lookups for test hostnames.
      resolveTarget: async (host: string) => ({
        allowed: true,
        address: host,
      }),
    });
  }

  test('session response advertises the echoState capability', async () => {
    // Stub out the real network connect (TLS-vs-plain auto-detection + an actual MUD
    // socket) since this test only cares about the synchronous "session" response
    // handleConnect sends before it ever calls connect(). The data/close handlers it
    // wires beforehand are harmless no-ops here.
    const originalConnect = Session.prototype.connect;
    Session.prototype.connect = async function (this: Session) {
      this.telnetConnected = true;
    };

    const si = makeIntegration();
    try {
      const socket = makeClientSocket();
      si.parseNewMessage(
        socket,
        Buffer.from(
          JSON.stringify({ type: 'connect', host: 'mud.test', port: 4000 }),
        ),
      );

      // handleConnect now awaits DNS resolution in arbitrary mode before it
      // sends the "session" response, so this no longer completes within
      // parseNewMessage. Yield once before reading the socket.
      await Bun.sleep(0);

      const [sessionMsg] = socket.messages.map((m) => JSON.parse(m));
      expect(sessionMsg.type).toBe('session');
      expect(sessionMsg.capabilities).toContain('echoState');
    } finally {
      Session.prototype.connect = originalConnect;
      si.shutdown();
    }
  });

  test('a password prompt from the MUD forwards an ordered echo message', () => {
    const si = makeIntegration();
    const session = si.sessionManager.create('mud.test', 4000);
    const socket = makeClientSocket();
    si.sessionManager.attachWebSocket(session.id, socket);

    const chunk = Buffer.concat([
      Buffer.from('Password: '),
      willEcho(),
      Buffer.from('hunter2\r\n'),
      wontEcho(),
      Buffer.from('Welcome!\n'),
    ]);
    siInternals(si).processMudData(session, socket, chunk);

    expect(decodedMessages(socket)).toEqual([
      { type: 'data', text: 'Password: ', replayed: undefined },
      { type: 'echo', suppressed: true, replayed: undefined },
      { type: 'data', text: 'hunter2\r\n', replayed: undefined },
      { type: 'echo', suppressed: false, replayed: undefined },
      { type: 'data', text: 'Welcome!\n', replayed: undefined },
    ]);
  });

  test('resume replay reproduces the echo transition in order', () => {
    const si = makeIntegration();
    const session = si.sessionManager.create('mud.test', 4000);
    const firstSocket = makeClientSocket();
    si.sessionManager.attachWebSocket(session.id, firstSocket);

    const chunk = Buffer.concat([
      Buffer.from('Password: '),
      willEcho(),
      Buffer.from('secret\r\n'),
      wontEcho(),
      Buffer.from('Welcome!\n'),
    ]);
    siInternals(si).processMudData(session, firstSocket, chunk);

    const resumeSocket = makeClientSocket();
    const resumeMsg: ResumeRequest = {
      type: 'resume',
      sessionId: session.id,
      token: session.authToken,
      lastSeq: 0,
    };
    siInternals(si).handleResume(resumeSocket, resumeMsg);

    const replayed = decodedMessages(resumeSocket);
    expect(replayed).toEqual([
      { type: 'data', text: 'Password: ', replayed: true },
      { type: 'echo', suppressed: true, replayed: true },
      { type: 'data', text: 'secret\r\n', replayed: true },
      { type: 'echo', suppressed: false, replayed: true },
      { type: 'data', text: 'Welcome!\n', replayed: true },
    ]);
  });
});
