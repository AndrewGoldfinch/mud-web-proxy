/**
 * Origin checking (MWP-84).
 *
 * Origin is browser hardening, not authentication: it stops a page on another
 * site opening a WebSocket to this proxy with a victim's ambient credentials.
 * Any non-browser client sends whatever Origin it likes. Authentication is
 * AUTH_MODE.
 *
 * The config parsed ALLOWED_ORIGINS and ALLOW_MISSING_ORIGIN, but enforcement
 * read process.env directly and never consulted either — so the wildcard
 * rejection was bypassed and ALLOW_MISSING_ORIGIN could not be turned on.
 */

import { describe, expect, test } from 'bun:test';
import { isOriginAllowed } from '../src/wsproxy-utils.js';

describe('no allowlist configured', () => {
  test('permits any origin', () => {
    expect(isOriginAllowed('https://evil.example', [], false)).toBe(true);
  });

  test('permits a missing origin', () => {
    expect(isOriginAllowed(undefined, [], false)).toBe(true);
  });
});

describe('with an allowlist', () => {
  const list = ['https://app.example.com', 'https://beta.example.com'];

  test('permits a listed origin', () => {
    expect(isOriginAllowed('https://app.example.com', list, false)).toBe(true);
  });

  test('rejects an unlisted origin', () => {
    expect(isOriginAllowed('https://evil.example', list, false)).toBe(false);
  });

  test('is case-insensitive on scheme and host', () => {
    // Origins are compared as ASCII-lowercase; a browser may vary the case.
    expect(isOriginAllowed('HTTPS://App.Example.com', list, false)).toBe(true);
  });

  test('ignores a trailing slash, which some clients append', () => {
    expect(isOriginAllowed('https://app.example.com/', list, false)).toBe(
      true,
    );
  });

  test('rejects a same-prefix impostor', () => {
    expect(
      isOriginAllowed('https://app.example.com.evil.test', list, false),
    ).toBe(false);
  });

  test('rejects a different scheme on a listed host', () => {
    expect(isOriginAllowed('http://app.example.com', list, false)).toBe(false);
  });

  test('never honours a literal wildcard entry at runtime', () => {
    // Startup rejects "*", but enforcement must not accept it either — a
    // runtime branch that trusts it is a second door to the same room.
    expect(isOriginAllowed('https://evil.example', ['*'], false)).toBe(false);
  });
});

describe('ALLOW_MISSING_ORIGIN', () => {
  const list = ['https://app.example.com'];

  test('rejects a missing origin by default', () => {
    expect(isOriginAllowed(undefined, list, false)).toBe(false);
    expect(isOriginAllowed('', list, false)).toBe(false);
  });

  test('permits a missing origin when explicitly allowed', () => {
    // Native clients send no Origin at all. Operators who need them set this
    // and are then relying on AUTH_MODE, not on Origin.
    expect(isOriginAllowed(undefined, list, true)).toBe(true);
    expect(isOriginAllowed('', list, true)).toBe(true);
  });

  test('still rejects a present but unlisted origin when allowed', () => {
    // The flag permits absence, not any value.
    expect(isOriginAllowed('https://evil.example', list, true)).toBe(false);
  });
});
