/**
 * The proxy declines MCCP, deliberately (MWP-128).
 *
 * There were two MCCP code paths and they disagreed. The legacy data plane in
 * `wsproxy.ts` tried to answer `IAC WILL MCCP2` with `IAC DO MCCP2`, gated on
 * `SocketExtended.mccp` — a flag that was declared and never assigned, so the
 * branch was unreachable and MCCP never negotiated. The session stack's
 * `TelnetParser` refuses it on purpose, to keep the MUD stream raw.
 *
 * MWP-128 resolved the disagreement by removing the dead legacy branch, so
 * refusal is now the single decided behaviour rather than an accident of an
 * unset flag. This pins it.
 *
 * Two things this file is careful about, both learned the hard way while
 * writing it:
 *
 *  - **It tests the parser, not an end-to-end session.** The first attempt was
 *    an e2e assertion in `tests/e2e/mock-mud.test.ts`. That suite drives the
 *    *typed* protocol, which never touches the legacy `sendClient` path, so
 *    reintroducing the legacy MCCP reply left it green. A test that cannot
 *    fail is worse than no test, so it was deleted rather than kept as
 *    reassurance.
 *  - **Refusal is asserted as "no DO reply", against a real offer.** Asserting
 *    that "nothing happened" passes trivially if nothing was offered, so every
 *    case below feeds an actual `IAC WILL MCCP2` and a control proves the
 *    parser does answer other options.
 */

import { describe, expect, test } from 'bun:test';
import { TelnetParser } from '../src/telnet-parser.js';
import type { Session } from '../src/session.js';

const IAC = 255;
const WILL = 251;
const DO = 253;
const DONT = 254;
const WONT = 252;
const MCCP2 = 86;
const GMCP = 201;

/** A session that records everything the parser sends upstream. */
function harness(): { parser: TelnetParser; sent: () => Buffer } {
  const chunks: Buffer[] = [];
  const session = {
    id: 'mccp-test-session',
    echoOn: true,
    sendToMud: (data: Buffer) => {
      chunks.push(Buffer.from(data));
    },
  } as unknown as Session;

  return {
    parser: new TelnetParser(session),
    sent: () => Buffer.concat(chunks),
  };
}

/** Does the parser's upstream traffic contain this three-byte command? */
const contains = (buf: Buffer, cmd: number, opt: number): boolean => {
  for (let i = 0; i + 2 < buf.length; i++) {
    if (buf[i] === IAC && buf[i + 1] === cmd && buf[i + 2] === opt)
      return true;
  }
  return false;
};

describe('an MCCP offer is not accepted', () => {
  test('IAC WILL MCCP2 is never answered with IAC DO MCCP2', () => {
    const { parser, sent } = harness();
    parser.process(Buffer.from([IAC, WILL, MCCP2]));
    expect(contains(sent(), DO, MCCP2)).toBe(false);
  });

  test('a repeated offer is still not accepted', () => {
    // A MUD that does not get an answer may well ask again. Refusal must not
    // be an artefact of only seeing one offer.
    const { parser, sent } = harness();
    for (let i = 0; i < 5; i++) {
      parser.process(Buffer.from([IAC, WILL, MCCP2]));
    }
    expect(contains(sent(), DO, MCCP2)).toBe(false);
  });

  test('an offer split across two reads is still not accepted', () => {
    // The parser is stateful across chunks by design; the refusal has to hold
    // on the reassembled sequence too, not just a whole-sequence read.
    const { parser, sent } = harness();
    parser.process(Buffer.from([IAC, WILL]));
    parser.process(Buffer.from([MCCP2]));
    expect(contains(sent(), DO, MCCP2)).toBe(false);
  });

  test('the offer is swallowed rather than refused with DONT', () => {
    // Documents the actual choice: MCCP2 has its own case that breaks without
    // replying, so it does not fall through to the default WONT/DONT arm.
    // Asserted so that a future refactor collapsing the case into the default
    // is a visible decision rather than a silent behaviour change.
    const { parser, sent } = harness();
    parser.process(Buffer.from([IAC, WILL, MCCP2]));
    expect(contains(sent(), DONT, MCCP2)).toBe(false);
    expect(sent().length).toBe(0);
  });
});

describe('the harness can observe a reply at all', () => {
  // The control. Without this, every assertion above passes if `sendToMud` is
  // never wired up or the parser silently does nothing with any input.

  test('a GMCP offer does produce an upstream reply', () => {
    const { parser, sent } = harness();
    parser.process(Buffer.from([IAC, WILL, GMCP]));
    expect(sent().length).toBeGreaterThan(0);
    expect(contains(sent(), DO, GMCP)).toBe(true);
  });

  test('an unknown option is refused, proving the default arm runs', () => {
    const { parser, sent } = harness();
    const UNKNOWN = 0x7d;
    parser.process(Buffer.from([IAC, WILL, UNKNOWN]));
    expect(contains(sent(), DONT, UNKNOWN)).toBe(true);
  });

  test('an unknown DO is refused with WONT', () => {
    const { parser, sent } = harness();
    const UNKNOWN = 0x7d;
    parser.process(Buffer.from([IAC, DO, UNKNOWN]));
    expect(contains(sent(), WONT, UNKNOWN)).toBe(true);
  });
});
