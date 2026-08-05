/**
 * The Compose topology's security contract.
 *
 * The systemd path has `systemd-contract.test.ts`, which asserts it keeps
 * plaintext on loopback behind one trusted hop and overwrites both accepted
 * client-IP headers. Compose had no equivalent, so a one-character edit to
 * `compose.yaml` or `Caddyfile` could reintroduce header spoofing with nothing
 * going red. MWP-112's evidence ledger recorded that as an uncovered claim.
 *
 * The header rule is the sharp one. Caddy's *default* is to append the peer
 * address to any `X-Forwarded-For` the client already sent. Under that default
 * a client prepends a forged address and the proxy — which trusts this hop via
 * TRUSTED_PROXY_CIDRS — reads the forged value as the client IP. Per-IP session
 * limits, the per-address message-rate budget, and pending-dial reservations
 * all become unenforceable, because the attacker picks the key they are
 * counted under.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';

const repoRoot = path.resolve(import.meta.dir, '../..');
const read = (rel: string): string =>
  readFileSync(path.join(repoRoot, rel), 'utf8');

const compose = read('compose.yaml');
const caddyfile = read('Caddyfile');

/** The `header_up` directives Caddy is configured with, name to value. */
const headerUps = (): Map<string, string> => {
  const out = new Map<string, string>();
  for (const [, name, value] of caddyfile.matchAll(
    /^\s*header_up\s+(\S+)\s+(.+)$/gm,
  )) {
    out.set(name, value.trim());
  }
  return out;
};

describe('Compose trusts exactly one hop', () => {
  test('TRUSTED_PROXY_CIDRS names the pinned stack subnet', () => {
    const match = compose.match(/^\s*TRUSTED_PROXY_CIDRS:\s*(.+)$/m);
    expect(match).not.toBeNull();
    expect(match?.[1].trim()).toBe('172.28.0.0/24');
  });

  test('it is not `true`, which would trust every peer', () => {
    const value = compose
      .match(/^\s*TRUSTED_PROXY_CIDRS:\s*(.+)$/m)?.[1]
      .trim();
    expect(value).not.toBe('true');
    expect(value).not.toBe('"true"');
  });

  test('it is not widened to the whole private range', () => {
    // 172.16.0.0/12 contains this stack's subnet and every other container
    // network on the host. The narrow value is the point.
    const value = compose
      .match(/^\s*TRUSTED_PROXY_CIDRS:\s*(.+)$/m)?.[1]
      .trim();
    expect(value).not.toContain('172.16.0.0/12');
    expect(value).not.toContain('/8');
    expect(value).not.toContain('0.0.0.0/0');
  });

  test('the subnet the proxy trusts is the one Compose actually pins', () => {
    // A trusted CIDR that does not match the declared network is trust
    // pointed at nothing — or worse, at something else.
    expect(compose).toContain('172.28.0.0/24');
  });
});

describe('the Compose edge replaces client-IP headers', () => {
  test('X-Forwarded-For is set to the real peer, not appended', () => {
    expect(headerUps().get('X-Forwarded-For')).toBe('{remote_host}');
  });

  test('X-Real-IP is set to the real peer', () => {
    expect(headerUps().get('X-Real-IP')).toBe('{remote_host}');
  });

  test('neither header uses an appending form', () => {
    // Caddy appends when the value references the incoming header, e.g.
    // `{http.request.header.X-Forwarded-For},{remote_host}`. Replacement is
    // the whole security property here.
    for (const name of ['X-Forwarded-For', 'X-Real-IP']) {
      const value = headerUps().get(name) ?? '';
      expect(value).not.toContain('http.request.header');
      expect(value).not.toContain(',');
      expect(value.startsWith('+')).toBe(false);
    }
  });

  test('both headers are configured at all', () => {
    // Guards the assertions above: an empty map would make them vacuous.
    const ups = headerUps();
    expect(ups.has('X-Forwarded-For')).toBe(true);
    expect(ups.has('X-Real-IP')).toBe(true);
  });
});

describe('the Compose application listener stays off the public interface', () => {
  test('only 80 and 443 are published', () => {
    const published = [
      ...compose.matchAll(/^\s*-\s*'?(\d+):(\d+)'?\s*$/gm),
    ].map((m) => m[1]);
    for (const port of published) {
      expect(['80', '443']).toContain(port);
    }
  });

  test('the proxy port is not published to the host', () => {
    expect(compose).not.toMatch(/^\s*-\s*'?6200:6200'?\s*$/m);
  });
});
