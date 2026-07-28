/**
 * Tests for the shared trusted-proxy peer matcher.
 *
 * Both wsproxy.ts (getClientIP / requestPeer) and SessionIntegration
 * (getClientIP) must reach the SAME trust decision for a given TRUSTED_PROXY_CIDRS
 * value — otherwise per-IP rate limiting and logging disagree about who the
 * client is.
 */

import { describe, expect, test } from 'bun:test';
import { isTrustedPeer } from '../src/wsproxy-utils.js';

describe('isTrustedPeer: blanket values', () => {
  test('trusts every peer when the trust list is true', () => {
    expect(isTrustedPeer('203.0.113.7', true)).toBe(true);
  });

  test('trusts no peer when the trust list is false', () => {
    expect(isTrustedPeer('127.0.0.1', false)).toBe(false);
  });

  test('trusts no peer when the trust list is undefined', () => {
    expect(isTrustedPeer('127.0.0.1', undefined)).toBe(false);
  });

  test('trusts no peer when the trust list is empty', () => {
    expect(isTrustedPeer('127.0.0.1', [])).toBe(false);
  });

  test('does not trust an undefined peer address', () => {
    expect(isTrustedPeer(undefined, true)).toBe(false);
  });
});

describe('isTrustedPeer: exact addresses', () => {
  test('matches an exact IPv4 entry', () => {
    expect(isTrustedPeer('127.0.0.1', ['127.0.0.1'])).toBe(true);
  });

  test('rejects an IPv4 address absent from the list', () => {
    expect(isTrustedPeer('10.0.0.5', ['127.0.0.1'])).toBe(false);
  });

  test('matches an exact IPv6 entry', () => {
    expect(isTrustedPeer('::1', ['::1'])).toBe(true);
  });
});

describe('isTrustedPeer: IPv4 CIDR ranges', () => {
  test('matches an address inside a /8', () => {
    expect(isTrustedPeer('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });

  test('rejects an address outside a /8', () => {
    expect(isTrustedPeer('11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  test('matches an address inside a /24', () => {
    expect(isTrustedPeer('192.168.1.55', ['192.168.1.0/24'])).toBe(true);
  });

  test('rejects an address one octet outside a /24', () => {
    expect(isTrustedPeer('192.168.2.55', ['192.168.1.0/24'])).toBe(false);
  });

  test('treats /0 as matching every IPv4 address', () => {
    expect(isTrustedPeer('203.0.113.7', ['0.0.0.0/0'])).toBe(true);
  });

  test('treats /32 as an exact address match', () => {
    expect(isTrustedPeer('10.0.0.1', ['10.0.0.1/32'])).toBe(true);
    expect(isTrustedPeer('10.0.0.2', ['10.0.0.1/32'])).toBe(false);
  });

  test('matches against any entry in a multi-entry list', () => {
    const list = ['127.0.0.1', '172.16.0.0/12'];
    expect(isTrustedPeer('172.18.4.9', list)).toBe(true);
  });
});

describe('isTrustedPeer: IPv4-mapped IPv6 peers', () => {
  // Node reports peers as ::ffff:a.b.c.d on a dual-stack listener, which is
  // the default when the server binds all interfaces. Operators configure
  // TRUSTED_PROXY_CIDRS with the bare IPv4 form.

  test('matches a bare IPv4 entry against a mapped peer', () => {
    expect(isTrustedPeer('::ffff:127.0.0.1', ['127.0.0.1'])).toBe(true);
  });

  test('matches an IPv4 CIDR entry against a mapped peer', () => {
    expect(isTrustedPeer('::ffff:10.1.2.3', ['10.0.0.0/8'])).toBe(true);
  });

  test('rejects a mapped peer outside the configured range', () => {
    expect(isTrustedPeer('::ffff:11.1.2.3', ['10.0.0.0/8'])).toBe(false);
  });

  test('matches a mapped entry against a bare IPv4 peer', () => {
    expect(isTrustedPeer('127.0.0.1', ['::ffff:127.0.0.1'])).toBe(true);
  });
});

describe('isTrustedPeer: malformed configuration fails closed', () => {
  test('does not match when the network part is not numeric', () => {
    // Naive Number() parsing yields NaN, and NaN & mask === 0, which would
    // wrongly match the all-zero address.
    expect(isTrustedPeer('0.0.0.0', ['a.b.c.d/24'])).toBe(false);
  });

  test('does not match when the prefix is not numeric', () => {
    expect(isTrustedPeer('10.0.0.1', ['10.0.0.0/xx'])).toBe(false);
  });

  test('does not match when the prefix exceeds 32', () => {
    expect(isTrustedPeer('10.0.0.1', ['10.0.0.0/33'])).toBe(false);
  });

  test('does not match when the prefix is negative', () => {
    expect(isTrustedPeer('10.0.0.1', ['10.0.0.0/-1'])).toBe(false);
  });

  test('does not match when an octet is out of range', () => {
    expect(isTrustedPeer('10.0.0.1', ['10.0.0.999/24'])).toBe(false);
  });

  test('ignores a malformed entry but still honours a valid sibling', () => {
    expect(isTrustedPeer('10.0.0.1', ['garbage/24', '10.0.0.0/8'])).toBe(true);
  });

  test('does not throw on an empty entry', () => {
    expect(isTrustedPeer('10.0.0.1', [''])).toBe(false);
  });

  test('rejects a CIDR carrying extra slash components', () => {
    // Destructuring `split('/')` silently drops anything past the second
    // component, which would treat this as a valid 10.0.0.0/8.
    expect(isTrustedPeer('10.0.0.1', ['10.0.0.0/8/oops'])).toBe(false);
  });

  test('rejects an entry with a trailing slash and no prefix', () => {
    expect(isTrustedPeer('10.0.0.1', ['10.0.0.0/'])).toBe(false);
  });
});
