/**
 * An unterminated subnegotiation must not grow memory without bound (MWP-93).
 *
 * `TelnetParser` is stateful per session: `subnegBuffer` and `state` persist
 * across chunks, which is what lets it handle an IAC sequence split over a TCP
 * boundary. It is also what makes it a memory sink — a MUD that sends
 * `IAC SB <option>` and then streams bytes without ever sending `IAC SE` grows
 * that buffer for as long as it keeps talking.
 *
 * Measured before the cap: 12.5 MiB streamed produced 435 MiB RSS. The
 * amplification is roughly 35x, because `subnegBuffer` is a `number[]` — eight
 * bytes of heap per byte on the wire, plus array growth — not a Buffer. Per
 * session, multiplied by the session cap.
 *
 * In `arbitrary` target mode the MUD is chosen by the client, so this is memory
 * a client can make the server allocate on demand.
 *
 * Note what is deliberately NOT asserted here: that a cap constant exists.
 * These feed oversized input and assert the buffer stops growing, because a
 * test that only checks for a named constant passes whether or not the cap is
 * ever consulted.
 */

import { describe, expect, test } from 'bun:test';
import { TelnetParser } from '../src/telnet-parser.js';
import type { Session } from '../src/session.js';

const IAC = 255;
const SB = 250;
const SE = 240;
const GMCP = 201;

const fakeSession = () =>
  ({ id: 'test-session-id', echoOn: true }) as unknown as Session;

/** Reach into the parser's private accumulator; that is the thing under test. */
const bufferLength = (p: TelnetParser): number =>
  (p as unknown as { subnegBuffer: number[] }).subnegBuffer.length;

const parser = (maxSubnegBytes?: number) =>
  new TelnetParser(fakeSession(), maxSubnegBytes);

describe('a subnegotiation that never terminates is bounded', () => {
  test('the accumulator stops growing at the cap', () => {
    const p = parser(1024);
    p.process(Buffer.from([IAC, SB, GMCP]));

    for (let i = 0; i < 50; i++) {
      p.process(Buffer.alloc(4096, 0x41));
    }

    // 200 KiB streamed into a 1 KiB cap.
    expect(bufferLength(p)).toBeLessThanOrEqual(1024);
  });

  test('growth is bounded no matter how long the stream continues', () => {
    const p = parser(1024);
    p.process(Buffer.from([IAC, SB, GMCP]));

    p.process(Buffer.alloc(8192, 0x41));
    const afterFirst = bufferLength(p);
    for (let i = 0; i < 100; i++) p.process(Buffer.alloc(8192, 0x41));

    expect(bufferLength(p)).toBe(afterFirst);
  });
});

describe('overflow does not desynchronize the stream', () => {
  test('text after the real IAC SE is still parsed as text', () => {
    // The failure mode worth guarding: truncate-and-continue leaves the parser
    // treating subnegotiation payload as game text, so the player sees binary.
    const p = parser(64);
    p.process(Buffer.from([IAC, SB, GMCP]));
    p.process(Buffer.alloc(500, 0x41)); // overflows
    p.process(Buffer.from([IAC, SE]));

    const out = p.process(Buffer.from('hello world', 'utf8'));
    expect(out.text.toString()).toBe('hello world');
  });

  test('the overflowed sequence is dropped, not emitted truncated', () => {
    // A truncated GMCP payload is worse than none: it is invalid JSON at best,
    // and misleading at worst.
    const p = parser(64);
    p.process(Buffer.from([IAC, SB, GMCP]));
    p.process(Buffer.from('Core.Hello ' + 'x'.repeat(500), 'utf8'));
    const out = p.process(Buffer.from([IAC, SE]));

    expect(out.gmcpMessages).toEqual([]);
  });

  test('a later, well-formed subnegotiation still works', () => {
    // Overflow must not poison the parser for the rest of the session.
    const p = parser(64);
    p.process(Buffer.from([IAC, SB, GMCP]));
    p.process(Buffer.alloc(500, 0x41));
    p.process(Buffer.from([IAC, SE]));

    p.process(Buffer.from([IAC, SB, GMCP]));
    const out = p.process(
      Buffer.concat([
        Buffer.from('Core.Ping {}', 'utf8'),
        Buffer.from([IAC, SE]),
      ]),
    );

    expect(out.gmcpMessages.length).toBe(1);
    expect(out.gmcpMessages[0].package).toBe('Core.Ping');
  });
});

describe('legitimate payloads are unaffected', () => {
  test('a large but in-bounds GMCP message is delivered intact', () => {
    // Real MUDs send big MSDP/GMCP payloads. A cap that breaks Aardwolf is a
    // worse outcome than the memory growth it prevents.
    const p = parser(64 * 1024);
    const payload = `Char.Status ${JSON.stringify({ blob: 'y'.repeat(20000) })}`;

    p.process(Buffer.from([IAC, SB, GMCP]));
    const out = p.process(
      Buffer.concat([Buffer.from(payload, 'utf8'), Buffer.from([IAC, SE])]),
    );

    expect(out.gmcpMessages.length).toBe(1);
    expect(out.gmcpMessages[0].package).toBe('Char.Status');
  });

  test('a sequence split across chunks still assembles', () => {
    // The reason the parser is stateful at all; the cap must not break it.
    const p = parser(64 * 1024);
    p.process(Buffer.from([IAC, SB, GMCP]));
    p.process(Buffer.from('Core.Sup', 'utf8'));
    p.process(Buffer.from('ports {}', 'utf8'));
    const out = p.process(Buffer.from([IAC, SE]));

    expect(out.gmcpMessages.length).toBe(1);
    expect(out.gmcpMessages[0].package).toBe('Core.Supports');
  });
});

describe('the cap cannot be bypassed by escaped IAC bytes', () => {
  // Raised by Codex review of #77, and it defeated the whole fix. In
  // State.SUBNEG the `byte === IAC` branch was taken BEFORE the length check,
  // and SUBNEG_IAC then pushed 0xff unconditionally — so a payload made only of
  // legal `IAC IAC` pairs grew the buffer with the cap never consulted.
  // Reproduced: 10,000 entries against a cap of 8.

  test('a payload of only escaped IAC pairs is still bounded', () => {
    const p = parser(8);
    p.process(Buffer.from([IAC, SB, GMCP]));
    p.process(Buffer.alloc(20000, IAC));

    expect(bufferLength(p)).toBeLessThanOrEqual(8);
  });

  test('escaped IAC pairs mixed with ordinary bytes are bounded', () => {
    const p = parser(64);
    p.process(Buffer.from([IAC, SB, GMCP]));
    for (let i = 0; i < 200; i++) {
      p.process(Buffer.from([0x41, IAC, IAC, 0x42]));
    }

    expect(bufferLength(p)).toBeLessThanOrEqual(64);
  });

  test('an escaped IAC below the cap is still preserved verbatim', () => {
    // The cap must not break the escaping it interacts with: IAC IAC in a
    // payload means one literal 0xff byte, and MSDP payloads rely on it.
    const p = parser(64 * 1024);
    p.process(Buffer.from([IAC, SB, GMCP]));
    p.process(Buffer.from('Core.X ', 'utf8'));
    p.process(Buffer.from([IAC, IAC]));
    const out = p.process(Buffer.from([IAC, SE]));

    expect(out.gmcpMessages.length).toBe(1);
    expect(out.gmcpMessages[0].package).toBe('Core.X');
    // IAC IAC un-escapes to exactly one payload byte. Asserting the decoded
    // character would be asserting the decoder's choice — a lone 0xff is not
    // valid UTF-8, so it surfaces as U+FFFD. What matters is that one byte
    // arrived and the pair did not terminate the sequence.
    expect(out.gmcpMessages[0].data.length).toBe(1);
  });
});

describe('discarding continues to the real terminator', () => {
  // Raised by Codex review of #77. On any IAC <cmd> other than SE or escaped
  // IAC — IAC NOP, for instance — the discard state returned to TEXT
  // immediately. The rest of the payload was then emitted as game text and the
  // real IAC SE was no longer recognised as its terminator, which is exactly
  // the desynchronization the discard state exists to prevent.

  test('IAC NOP inside a discarded payload does not end the discard', () => {
    const NOP = 241;
    const p = parser(16);
    p.process(Buffer.from([IAC, SB, GMCP]));
    p.process(Buffer.alloc(100, 0x41)); // overflow -> discard
    p.process(Buffer.from([IAC, NOP])); // must NOT end the discard
    p.process(Buffer.from('still payload, not text', 'utf8'));

    // Only after the genuine terminator does text resume.
    const during = p.process(Buffer.from('more payload', 'utf8'));
    expect(during.text.toString()).toBe('');

    p.process(Buffer.from([IAC, SE]));
    const after = p.process(Buffer.from('now text', 'utf8'));
    expect(after.text.toString()).toBe('now text');
  });
});
