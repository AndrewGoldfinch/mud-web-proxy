/**
 * Upstream TLS policy (MWP-89).
 *
 * The proxy used to attempt TLS and silently fall back to plaintext on almost
 * any failure. An operator who configured TLS to the MUD had no guarantee of
 * getting it, and nothing in the logs distinguished "this MUD has no TLS" from
 * "someone interfered with the handshake" — a downgrade indistinguishable from
 * normal operation, which is worse than no TLS, because it is advertised as
 * secure.
 *
 * The decision is extracted here so it can be exercised without sockets.
 */

import { describe, expect, test } from 'bun:test';
import {
  isTlsNegotiationError,
  shouldAttemptTls,
  shouldFallBackToPlain,
} from '../src/mud-transport.js';

const err = (message: string, code?: string): Error => {
  const e = new Error(message);
  if (code) (e as NodeJS.ErrnoException).code = code;
  return e;
};

describe('shouldAttemptTls', () => {
  test('plain never attempts TLS', () => {
    expect(shouldAttemptTls('plain')).toBe(false);
  });

  test('required attempts TLS', () => {
    expect(shouldAttemptTls('required')).toBe(true);
  });

  test('prefer attempts TLS', () => {
    expect(shouldAttemptTls('prefer')).toBe(true);
  });
});

describe('required never downgrades', () => {
  test('does not fall back on a TLS negotiation error', () => {
    expect(
      shouldFallBackToPlain('required', 'error', err('wrong version number')),
    ).toBe(false);
  });

  test('does not fall back on a certificate failure', () => {
    expect(
      shouldFallBackToPlain(
        'required',
        'error',
        err('unable to verify the first certificate'),
      ),
    ).toBe(false);
  });

  test('does not fall back when the peer closes during the handshake', () => {
    // The lever an attacker actually has: close the connection and let the
    // client retry in the clear.
    expect(shouldFallBackToPlain('required', 'close')).toBe(false);
  });

  test('does not fall back on a connection reset', () => {
    expect(
      shouldFallBackToPlain(
        'required',
        'error',
        err('read ECONNRESET', 'ECONNRESET'),
      ),
    ).toBe(false);
  });
});

describe('prefer falls back only on genuine TLS failure', () => {
  test('falls back on a TLS negotiation error', () => {
    expect(
      shouldFallBackToPlain('prefer', 'error', err('wrong version number')),
    ).toBe(true);
  });

  test('falls back when the peer closes during the handshake', () => {
    // A plaintext server receiving a ClientHello typically just closes; this
    // is the primary signal that a MUD does not speak TLS.
    expect(shouldFallBackToPlain('prefer', 'close')).toBe(true);
  });

  test('does NOT fall back on connection refused', () => {
    // The host is unreachable, not asking for cleartext. Retrying in the
    // clear here converts a reachability failure into a downgrade.
    expect(
      shouldFallBackToPlain(
        'prefer',
        'error',
        err('connect ECONNREFUSED', 'ECONNREFUSED'),
      ),
    ).toBe(false);
  });

  test('does NOT fall back on a connection reset', () => {
    expect(
      shouldFallBackToPlain(
        'prefer',
        'error',
        err('read ECONNRESET', 'ECONNRESET'),
      ),
    ).toBe(false);
  });

  test('does NOT fall back on an unrecognized error', () => {
    // Fail closed: an error we cannot classify is not evidence of plaintext.
    expect(
      shouldFallBackToPlain('prefer', 'error', err('something odd')),
    ).toBe(false);
  });
});

describe('plain never reaches the fallback decision', () => {
  test('reports no fallback, because TLS was never attempted', () => {
    expect(
      shouldFallBackToPlain('plain', 'error', err('wrong version number')),
    ).toBe(false);
    expect(shouldFallBackToPlain('plain', 'close')).toBe(false);
  });
});

describe('isTlsNegotiationError', () => {
  const negotiation = [
    'wrong version number',
    'packet length too long',
    'unable to verify the first certificate',
    'SSL routines failure',
    'tlsv1 alert protocol version',
  ];
  for (const m of negotiation) {
    test(`treats "${m}" as a TLS failure`, () => {
      expect(isTlsNegotiationError(err(m))).toBe(true);
    });
  }

  const transport = [
    ['connect ECONNREFUSED', 'ECONNREFUSED'],
    ['read ECONNRESET', 'ECONNRESET'],
    ['connect ETIMEDOUT', 'ETIMEDOUT'],
    ['getaddrinfo ENOTFOUND', 'ENOTFOUND'],
  ] as const;
  for (const [m, code] of transport) {
    test(`treats "${m}" as transport, not TLS`, () => {
      expect(isTlsNegotiationError(err(m, code))).toBe(false);
    });
  }
});

describe("Node's real mid-handshake close message", () => {
  // Found by behavioural testing, not by the unit tests above: Node reports a
  // peer closing during the handshake as an ERROR carrying ECONNRESET, not as
  // a close event. Excluding on the code alone therefore rejected the very
  // signal that tells us a MUD speaks plaintext, breaking autodetect for
  // every plaintext server.
  const nodeClose = (): Error => {
    const e = new Error(
      'Client network socket disconnected before secure TLS connection was established',
    );
    (e as NodeJS.ErrnoException).code = 'ECONNRESET';
    return e;
  };

  test('is classified as a TLS failure despite the ECONNRESET code', () => {
    expect(isTlsNegotiationError(nodeClose())).toBe(true);
  });

  test('prefer falls back on it, so plaintext MUDs still work', () => {
    expect(shouldFallBackToPlain('prefer', 'error', nodeClose())).toBe(true);
  });

  test('required still refuses it — this is the attacker lever', () => {
    // A plaintext MUD closing and an attacker closing are indistinguishable.
    // `prefer` accepts that ambiguity; `required` must not.
    expect(shouldFallBackToPlain('required', 'error', nodeClose())).toBe(
      false,
    );
  });

  test('a bare reset with no TLS wording is still transport, not TLS', () => {
    const bare = new Error('read ECONNRESET');
    (bare as NodeJS.ErrnoException).code = 'ECONNRESET';
    expect(isTlsNegotiationError(bare)).toBe(false);
    expect(shouldFallBackToPlain('prefer', 'error', bare)).toBe(false);
  });
});

describe('a hostname containing "tls" or "ssl" is not a TLS diagnostic', () => {
  // Raised in review of #36. Classifying on a bare "tls"/"ssl" substring means
  // `getaddrinfo ENOTFOUND ssl.example.org` reads as a TLS failure, so a
  // transient DNS error triggers a plaintext retry for a host that was never
  // negotiated with. MUD hostnames like ssl.aardmud.org make this ordinary,
  // not contrived.

  const dnsFailures = [
    ['getaddrinfo ENOTFOUND tls.invalid', 'ENOTFOUND'],
    ['getaddrinfo ENOTFOUND ssl.example.org', 'ENOTFOUND'],
    ['getaddrinfo EAI_AGAIN ssl-mud.example.org', 'EAI_AGAIN'],
  ] as const;
  for (const [m, code] of dnsFailures) {
    test(`treats "${m}" as transport`, () => {
      expect(isTlsNegotiationError(err(m, code))).toBe(false);
      expect(shouldFallBackToPlain('prefer', 'error', err(m, code))).toBe(
        false,
      );
    });
  }

  test('a refused connection to an ssl-named host is still transport', () => {
    const e = err('connect ECONNREFUSED ssl.example.org:4000', 'ECONNREFUSED');
    expect(isTlsNegotiationError(e)).toBe(false);
  });

  test('the mid-handshake close is still recognized despite ECONNRESET', () => {
    // The reason content was checked first in the first place; it must
    // survive putting transport codes ahead of the generic patterns.
    const e = err(
      'Client network socket disconnected before secure TLS connection was established',
      'ECONNRESET',
    );
    expect(isTlsNegotiationError(e)).toBe(true);
  });

  test('genuine TLS diagnostics with no transport code still match', () => {
    expect(isTlsNegotiationError(err('ssl routines:tls_process: alert'))).toBe(
      true,
    );
    expect(isTlsNegotiationError(err('wrong version number'))).toBe(true);
  });
});
