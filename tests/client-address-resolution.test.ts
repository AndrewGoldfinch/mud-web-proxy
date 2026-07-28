/**
 * Resolving the real client address behind trusted proxies (MWP-83).
 *
 * Two gaps remained after #28 wired the trust check:
 *
 *  - the forwarded chain was read leftmost-first, so with a proxy that
 *    appends rather than overwrites, the attacker's injected entry wins;
 *  - malformed CIDR entries were accepted silently and matched nothing.
 *
 * The resolution itself also lived in two places. It is one function now,
 * because two copies of this logic already diverged once (#28).
 */

import { describe, expect, test } from 'bun:test';
import { isTrustedPeer, resolveClientAddress } from '../src/wsproxy-utils.js';

const LOCAL = ['127.0.0.1'];

describe('untrusted peers are never believed', () => {
  test('ignores forwarded headers entirely', () => {
    expect(
      resolveClientAddress(
        '203.0.113.9',
        { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '1.2.3.4' },
        LOCAL,
      ),
    ).toBe('203.0.113.9');
  });

  test('ignores them when the trust list is empty, the default', () => {
    expect(
      resolveClientAddress('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }, false),
    ).toBe('127.0.0.1');
  });
});

describe('trusted peers: walking the chain right to left', () => {
  test('returns the sole forwarded address', () => {
    expect(
      resolveClientAddress('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }, LOCAL),
    ).toBe('1.2.3.4');
  });

  test('strips trusted hops from the right', () => {
    // client -> cdn(198.51.100.7) -> nginx(127.0.0.1) -> us
    expect(
      resolveClientAddress(
        '127.0.0.1',
        { 'x-forwarded-for': '1.2.3.4, 198.51.100.7' },
        ['127.0.0.1', '198.51.100.7'],
      ),
    ).toBe('1.2.3.4');
  });

  test('returns the RIGHTMOST untrusted entry, not the leftmost', () => {
    // The attacker prepends a value; a proxy that appends leaves it at the
    // head of the list. Reading [0] hands them the answer.
    expect(
      resolveClientAddress(
        '127.0.0.1',
        { 'x-forwarded-for': '9.9.9.9, 1.2.3.4' },
        LOCAL,
      ),
    ).toBe('1.2.3.4');
  });

  test('falls back to the peer when every hop is trusted', () => {
    expect(
      resolveClientAddress(
        '127.0.0.1',
        { 'x-forwarded-for': '127.0.0.1' },
        LOCAL,
      ),
    ).toBe('127.0.0.1');
  });

  test('falls back to the peer on an empty or unparseable header', () => {
    expect(resolveClientAddress('127.0.0.1', { 'x-forwarded-for': '' }, LOCAL))
      .toBe('127.0.0.1');
    expect(
      resolveClientAddress('127.0.0.1', { 'x-forwarded-for': ' , , ' }, LOCAL),
    ).toBe('127.0.0.1');
  });

  test('prefers x-real-ip, which a proxy sets rather than appends', () => {
    expect(
      resolveClientAddress(
        '127.0.0.1',
        { 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '9.9.9.9, 5.5.5.5' },
        LOCAL,
      ),
    ).toBe('1.2.3.4');
  });

  test('handles array-valued headers by taking the first', () => {
    expect(
      resolveClientAddress(
        '127.0.0.1',
        { 'x-forwarded-for': ['1.2.3.4'] as unknown as string },
        LOCAL,
      ),
    ).toBe('1.2.3.4');
  });

  test('normalizes an IPv4-mapped peer so it still matches the trust list', () => {
    expect(
      resolveClientAddress(
        '::ffff:127.0.0.1',
        { 'x-forwarded-for': '1.2.3.4' },
        LOCAL,
      ),
    ).toBe('1.2.3.4');
  });
});

describe('IPv6 CIDR ranges are supported', () => {
  // Previously only exact IPv6 addresses matched, which is why the
  // limitation was carried in MWP-88's notes.

  test('matches an address inside a /64', () => {
    expect(isTrustedPeer('2001:db8::1', ['2001:db8::/64'])).toBe(true);
  });

  test('rejects an address outside a /64', () => {
    expect(isTrustedPeer('2001:db9::1', ['2001:db8::/64'])).toBe(false);
  });

  test('matches loopback via ::1/128', () => {
    expect(isTrustedPeer('::1', ['::1/128'])).toBe(true);
  });

  test('matches an expanded form against a range', () => {
    expect(
      isTrustedPeer('2001:0db8:0000:0000:0000:0000:0000:0005', ['2001:db8::/32']),
    ).toBe(true);
  });

  test('treats ::/0 as matching every IPv6 address', () => {
    expect(isTrustedPeer('2001:db8::1', ['::/0'])).toBe(true);
  });

  test('rejects a malformed IPv6 CIDR without matching anything', () => {
    expect(isTrustedPeer('2001:db8::1', ['2001:db8::/999'])).toBe(false);
    expect(isTrustedPeer('2001:db8::1', ['nonsense::/64'])).toBe(false);
  });
});

describe('trustedProxyCidrs = true cannot strip hops', () => {
  // `true` means "trust any peer", which says nothing about which entries in
  // the chain are proxies. Stripping trusted hops under it would consume the
  // whole list and resolve every client to the peer address — so it takes the
  // leftmost entry instead. That is exactly why a CIDR list is safer: only a
  // list can tell a proxy hop from a client-supplied one.

  test('takes the leftmost entry rather than collapsing to the peer', () => {
    expect(
      resolveClientAddress(
        '127.0.0.1',
        { 'x-forwarded-for': '10.0.0.1, 10.0.0.2, 10.0.0.3' },
        true,
      ),
    ).toBe('10.0.0.1');
  });

  test('a CIDR list, by contrast, strips the known hops', () => {
    expect(
      resolveClientAddress(
        '127.0.0.1',
        { 'x-forwarded-for': '10.0.0.1, 10.0.0.2' },
        ['127.0.0.1', '10.0.0.2'],
      ),
    ).toBe('10.0.0.1');
  });
});

describe('IPv4-mapped peers against IPv6 CIDRs', () => {
  // Raised in review of #37. `::ffff:0:0/96` is the canonical range covering
  // every IPv4-mapped address, and startup accepts it — but the peer is
  // normalized to bare IPv4 before comparison, so the range matched nothing
  // and forwarded headers were silently ignored.

  test('a mapped peer matches ::ffff:0:0/96', () => {
    expect(isTrustedPeer('::ffff:127.0.0.1', ['::ffff:0:0/96'])).toBe(true);
  });

  test('a bare IPv4 peer matches ::ffff:0:0/96 too', () => {
    // Node hands back either spelling depending on the listener; they are the
    // same address and must classify the same way.
    expect(isTrustedPeer('127.0.0.1', ['::ffff:0:0/96'])).toBe(true);
  });

  test('a narrower mapped range still discriminates', () => {
    expect(isTrustedPeer('127.0.0.1', ['::ffff:127.0.0.0/104'])).toBe(true);
    expect(isTrustedPeer('10.0.0.1', ['::ffff:127.0.0.0/104'])).toBe(false);
  });

  test('a genuine IPv6 peer does not match a mapped range', () => {
    expect(isTrustedPeer('2001:db8::1', ['::ffff:0:0/96'])).toBe(false);
  });
});

describe('malformed IPv6 with a pointless :: is rejected', () => {
  // RFC 4291: `::` must replace at least one group of zeros. An entry with
  // eight explicit groups plus `::` is malformed, and accepting it defeats
  // the fail-fast validation that mistyped trust boundaries depend on.

  test('eight explicit groups plus :: does not parse', () => {
    expect(isTrustedPeer('2001:db8::1', ['2001:db8:0:0:0:0:0:1::/128'])).toBe(
      false,
    );
  });

  test('the equivalent well-formed entry still works', () => {
    expect(isTrustedPeer('2001:db8::1', ['2001:db8:0:0:0:0:0:1/128'])).toBe(
      true,
    );
  });

  test(':: compressing one or more groups is still valid', () => {
    expect(isTrustedPeer('2001:db8::1', ['2001:db8:0:0:0:0:0::/112'])).toBe(
      true,
    );
  });
});
