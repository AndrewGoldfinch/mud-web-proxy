/**
 * SNI is only valid for hostnames.
 *
 * The connect path dials a validated IP while presenting the original
 * hostname as `servername`, so certificate verification still works. But when
 * the target *is* an IP literal there is no hostname to present, and Node
 * throws outright:
 *
 *   The property 'options.servername' Setting the TLS ServerName to an IP
 *   address is not permitted.
 *
 * That breaks TLS to any IP-addressed target. Caught by CI on #35.
 */

import { describe, expect, test } from 'bun:test';
import { sniServerName } from '../src/mud-transport.js';

describe('sniServerName', () => {
  test('returns a hostname unchanged', () => {
    expect(sniServerName('mud.example.org')).toBe('mud.example.org');
  });

  test('omits SNI for an IPv4 literal', () => {
    expect(sniServerName('127.0.0.1')).toBeUndefined();
    expect(sniServerName('10.0.0.5')).toBeUndefined();
    expect(sniServerName('203.0.113.7')).toBeUndefined();
  });

  test('omits SNI for an IPv6 literal', () => {
    expect(sniServerName('::1')).toBeUndefined();
    expect(sniServerName('2606:4700:4700::1111')).toBeUndefined();
  });

  test('omits SNI for an IPv4-mapped IPv6 literal', () => {
    expect(sniServerName('::ffff:127.0.0.1')).toBeUndefined();
  });

  test('keeps a hostname that merely contains digits', () => {
    expect(sniServerName('mud4.example.org')).toBe('mud4.example.org');
    expect(sniServerName('1.2.3.4.example.org')).toBe('1.2.3.4.example.org');
  });

  test('omits SNI for an empty host rather than passing it through', () => {
    expect(sniServerName('')).toBeUndefined();
  });
});
