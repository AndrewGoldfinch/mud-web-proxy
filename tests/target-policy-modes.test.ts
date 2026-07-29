/**
 * Target policy: modes, default-deny, and reserved-network rejection.
 *
 * Covers MWP-86 (TARGET_MODE), MWP-87 (no unrestricted-relay fallback), and
 * MWP-88 (DNS resolution, reserved networks, rebinding).
 *
 * The governing rule: `validateTarget` must terminate in an explicit deny.
 * Every allow has to be a positively-matched branch, so a future mode added
 * without an allow rule fails closed rather than open.
 */

import { describe, expect, test } from 'bun:test';
import {
  isReservedAddress,
  resolveTargetAddress,
  validateTarget,
  type TargetPolicyConfig,
} from '../src/target-policy.js';

const fixed: TargetPolicyConfig = {
  targetMode: 'fixed',
  defaultHost: 'mud.example.org',
  defaultPort: 4000,
};

const allowlist: TargetPolicyConfig = {
  targetMode: 'allowlist',
  defaultHost: 'mud.example.org',
  defaultPort: 4000,
  allowedTargets: ['mud.example.org:4000', '10.0.0.5:23'],
};

const arbitrary: TargetPolicyConfig = {
  targetMode: 'arbitrary',
  defaultHost: 'mud.example.org',
  defaultPort: 4000,
  arbitraryAllowedPorts: ['23', '4000-4100'],
};

describe('default deny', () => {
  test('denies when no policy is supplied at all', () => {
    // The old behaviour returned allowed:true here, which made an
    // unconfigured proxy an open TCP relay.
    expect(validateTarget('anywhere.example', 4000).allowed).toBe(false);
  });

  test('denies an unrecognized mode rather than falling through', () => {
    const bogus = {
      ...fixed,
      targetMode: 'wide-open',
    } as unknown as TargetPolicyConfig;
    expect(validateTarget('anywhere.example', 4000, bogus).allowed).toBe(
      false,
    );
  });

  test('rejects a malformed host or port before any mode logic', () => {
    expect(validateTarget('', 4000, fixed).allowed).toBe(false);
    expect(validateTarget('mud.example.org', 0, fixed).allowed).toBe(false);
    expect(validateTarget('mud.example.org', 70000, fixed).allowed).toBe(
      false,
    );
    expect(validateTarget(null, null, fixed).allowed).toBe(false);
  });
});

describe('fixed mode', () => {
  test('allows exactly the configured target', () => {
    expect(validateTarget('mud.example.org', 4000, fixed).allowed).toBe(true);
  });

  test('normalizes case and a trailing dot on the host', () => {
    expect(validateTarget('MUD.Example.Org.', 4000, fixed).allowed).toBe(true);
  });

  test('denies a different host', () => {
    expect(validateTarget('evil.example', 4000, fixed).allowed).toBe(false);
  });

  test('denies the right host on the wrong port', () => {
    expect(validateTarget('mud.example.org', 4001, fixed).allowed).toBe(false);
  });

  test('denies when the configured target is itself invalid', () => {
    const broken = { ...fixed, defaultHost: '' };
    expect(validateTarget('mud.example.org', 4000, broken).allowed).toBe(
      false,
    );
  });
});

describe('allowlist mode', () => {
  test('allows an exact configured entry', () => {
    expect(validateTarget('mud.example.org', 4000, allowlist).allowed).toBe(
      true,
    );
  });

  test('denies a target absent from the list', () => {
    expect(validateTarget('other.example', 4000, allowlist).allowed).toBe(
      false,
    );
  });

  test('denies a listed host on an unlisted port', () => {
    expect(validateTarget('mud.example.org', 9999, allowlist).allowed).toBe(
      false,
    );
  });

  test('an EMPTY allowlist denies everything, not everything', () => {
    // The old guard was `allowedTargets.size > 0 && ...`, so an empty or
    // mistyped list allowed every target.
    const empty = { ...allowlist, allowedTargets: [] };
    expect(validateTarget('anywhere.example', 4000, empty).allowed).toBe(
      false,
    );
    expect(validateTarget('mud.example.org', 4000, empty).allowed).toBe(false);
  });

  test('a malformed-only allowlist denies everything', () => {
    const junk = { ...allowlist, allowedTargets: ['nonsense', ':::', 'a:b'] };
    expect(validateTarget('anywhere.example', 4000, junk).allowed).toBe(false);
  });

  test('permits a private address when the operator listed it explicitly', () => {
    // Deliberate: an exact operator-configured entry may name a private
    // network. Client-supplied hostnames may not — that is arbitrary mode.
    expect(validateTarget('10.0.0.5', 23, allowlist).allowed).toBe(true);
  });
});

describe('arbitrary mode port policy', () => {
  test('allows a single configured port', () => {
    expect(validateTarget('somewhere.example', 23, arbitrary).allowed).toBe(
      true,
    );
  });

  test('allows a port inside a configured range', () => {
    expect(validateTarget('somewhere.example', 4050, arbitrary).allowed).toBe(
      true,
    );
  });

  test('allows both ends of a configured range', () => {
    expect(validateTarget('somewhere.example', 4000, arbitrary).allowed).toBe(
      true,
    );
    expect(validateTarget('somewhere.example', 4100, arbitrary).allowed).toBe(
      true,
    );
  });

  test('denies a port outside every configured range', () => {
    expect(validateTarget('somewhere.example', 22, arbitrary).allowed).toBe(
      false,
    );
    expect(validateTarget('somewhere.example', 4101, arbitrary).allowed).toBe(
      false,
    );
  });

  test('denies everything when no ports are configured', () => {
    const noPorts = { ...arbitrary, arbitraryAllowedPorts: [] };
    expect(validateTarget('somewhere.example', 23, noPorts).allowed).toBe(
      false,
    );
  });
});

describe('isReservedAddress', () => {
  const reserved = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.1.1',
    '169.254.169.254', // cloud metadata
    '172.16.0.1',
    '172.31.255.254',
    '192.0.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '240.0.0.1',
    '255.255.255.255',
  ];

  for (const addr of reserved) {
    test(`rejects ${addr}`, () => {
      expect(isReservedAddress(addr)).toBe(true);
    });
  }

  const publicAddrs = ['8.8.8.8', '1.1.1.1', '203.0.113.1', '172.32.0.1'];
  for (const addr of publicAddrs) {
    test(`permits public ${addr}`, () => {
      expect(isReservedAddress(addr)).toBe(false);
    });
  }

  const reservedV6 = ['::', '::1', 'fc00::1', 'fd12::1', 'fe80::1', 'ff02::1'];
  for (const addr of reservedV6) {
    test(`rejects IPv6 ${addr}`, () => {
      expect(isReservedAddress(addr)).toBe(true);
    });
  }

  test('permits a public IPv6 address', () => {
    expect(isReservedAddress('2606:4700:4700::1111')).toBe(false);
  });

  test('sees through IPv4-mapped IPv6 form', () => {
    // ::ffff:127.0.0.1 is loopback wearing a hat.
    expect(isReservedAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isReservedAddress('::ffff:169.254.169.254')).toBe(true);
    expect(isReservedAddress('::ffff:8.8.8.8')).toBe(false);
  });

  test('treats an unparseable address as reserved', () => {
    expect(isReservedAddress('not-an-address')).toBe(true);
    expect(isReservedAddress('')).toBe(true);
  });
});

describe('resolveTargetAddress', () => {
  const stubResolver =
    (...batches: string[][]) =>
    async () => {
      const next = batches.shift();
      if (!next) throw new Error('resolver called more times than expected');
      return next;
    };

  test('returns a validated public address', async () => {
    const result = await resolveTargetAddress('good.example', {
      resolve: stubResolver(['8.8.8.8']),
    });
    expect(result.allowed).toBe(true);
    expect(result.address).toBe('8.8.8.8');
  });

  test('rejects a hostname resolving to a reserved address', async () => {
    const result = await resolveTargetAddress('evil.example', {
      resolve: stubResolver(['127.0.0.1']),
    });
    expect(result.allowed).toBe(false);
  });

  test('rejects when ANY resolved address is reserved', async () => {
    // A mix of public and private is an attack, not a coincidence.
    const result = await resolveTargetAddress('mixed.example', {
      resolve: stubResolver(['8.8.8.8', '169.254.169.254']),
    });
    expect(result.allowed).toBe(false);
  });

  test('rejects when resolution returns nothing', async () => {
    const result = await resolveTargetAddress('empty.example', {
      resolve: stubResolver([]),
    });
    expect(result.allowed).toBe(false);
  });

  test('rejects when resolution fails', async () => {
    const result = await resolveTargetAddress('broken.example', {
      resolve: async () => {
        throw new Error('ENOTFOUND');
      },
    });
    expect(result.allowed).toBe(false);
  });

  test('resolves exactly once, so the answer cannot change underneath', async () => {
    // DNS rebinding: validate one answer, then connect to a different one.
    // Callers must dial the returned address, and we must not look up twice.
    let calls = 0;
    const result = await resolveTargetAddress('rebind.example', {
      resolve: async () => {
        calls += 1;
        return calls === 1 ? ['8.8.8.8'] : ['127.0.0.1'];
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.address).toBe('8.8.8.8');
    expect(calls).toBe(1);
  });

  test('accepts a literal public IP without resolving', async () => {
    const result = await resolveTargetAddress('8.8.8.8', {
      resolve: async () => {
        throw new Error('should not resolve a literal address');
      },
    });
    expect(result.allowed).toBe(true);
    expect(result.address).toBe('8.8.8.8');
  });

  test('rejects a literal reserved IP without resolving', async () => {
    const result = await resolveTargetAddress('169.254.169.254', {
      resolve: async () => {
        throw new Error('should not resolve a literal address');
      },
    });
    expect(result.allowed).toBe(false);
  });
});

describe('IPv6 literals are canonicalized before classification', () => {
  // Raised in review of #35. isReservedAddress compared exact strings, so
  // only `::` and `::1` were caught — an authenticated arbitrary-mode client
  // could ask for the same addresses written differently and reach loopback.

  const loopbackForms = [
    '::1',
    '0:0:0:0:0:0:0:1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
    '::0001',
    '0::1',
  ];
  for (const form of loopbackForms) {
    test(`rejects loopback written as ${form}`, () => {
      expect(isReservedAddress(form)).toBe(true);
    });
  }

  const unspecifiedForms = ['::', '0:0:0:0:0:0:0:0', '0000::0000', '0::0'];
  for (const form of unspecifiedForms) {
    test(`rejects the unspecified address written as ${form}`, () => {
      expect(isReservedAddress(form)).toBe(true);
    });
  }

  test('rejects expanded unique-local and link-local forms', () => {
    expect(isReservedAddress('fc00:0:0:0:0:0:0:1')).toBe(true);
    expect(isReservedAddress('fe80:0000:0000:0000:0000:0000:0000:0001')).toBe(
      true,
    );
    expect(isReservedAddress('ff02:0:0:0:0:0:0:1')).toBe(true);
  });

  test('still permits a genuinely public IPv6 address in expanded form', () => {
    expect(isReservedAddress('2606:4700:4700:0000:0000:0000:0000:1111')).toBe(
      false,
    );
  });

  test('rejects an IPv6 address with a zone index onto loopback', () => {
    expect(isReservedAddress('fe80::1%eth0')).toBe(true);
  });

  test('treats an unparseable IPv6-looking value as reserved', () => {
    expect(isReservedAddress('1:2:3:4:5:6:7:8:9')).toBe(true);
    expect(isReservedAddress('::gggg')).toBe(true);
  });
});
