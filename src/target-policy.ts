import { normalizeAddress, parseIPv4 } from './wsproxy-utils';

export type TargetMode = 'fixed' | 'allowlist' | 'arbitrary';

export interface TargetPolicyConfig {
  targetMode: TargetMode;
  defaultHost: string;
  defaultPort: number;
  allowedTargets?: string[];
  /** Ports and ranges permitted in arbitrary mode, e.g. ['23', '4000-4100']. */
  arbitraryAllowedPorts?: string[];
}

export interface TargetValidationResult {
  allowed: boolean;
  host?: string;
  port?: number;
  reason?: string;
}

const deny = (reason: string): TargetValidationResult => ({
  allowed: false,
  reason,
});

const normalizeHost = (host: unknown): string | null => {
  if (typeof host !== 'string') return null;
  const normalized = host.trim().toLowerCase().replace(/\.$/, '');
  return normalized.length > 0 ? normalized : null;
};

const normalizePort = (port: unknown): number | null => {
  if (typeof port !== 'number' || !Number.isInteger(port)) return null;
  if (port < 1 || port > 65_535) return null;
  return port;
};

const targetKey = (host: string, port: number): string => `${host}:${port}`;

export const parseAllowedTargets = (
  allowedTargets?: string[] | string,
): Set<string> => {
  const rawTargets = Array.isArray(allowedTargets)
    ? allowedTargets
    : (allowedTargets ?? '').split(',');
  const targets = new Set<string>();

  for (const rawTarget of rawTargets) {
    const trimmed = rawTarget.trim();
    if (!trimmed) continue;

    const separator = trimmed.lastIndexOf(':');
    if (separator <= 0 || separator === trimmed.length - 1) continue;

    const host = normalizeHost(trimmed.slice(0, separator));
    const port = normalizePort(Number(trimmed.slice(separator + 1)));
    if (!host || !port) continue;

    targets.add(targetKey(host, port));
  }

  return targets;
};

/** Does `port` fall inside any entry of a ports-and-ranges list? */
export const portIsAllowed = (port: number, ranges?: string[]): boolean => {
  if (!ranges?.length) return false;

  for (const raw of ranges) {
    const entry = raw.trim();
    if (!entry) continue;

    const dash = entry.indexOf('-');
    if (dash === -1) {
      if (normalizePort(Number(entry)) === port) return true;
      continue;
    }

    const low = normalizePort(Number(entry.slice(0, dash)));
    const high = normalizePort(Number(entry.slice(dash + 1)));
    if (low === null || high === null || low > high) continue;
    if (port >= low && port <= high) return true;
  }

  return false;
};

// ---------------------------------------------------------------------------
// Reserved networks
// ---------------------------------------------------------------------------

/** [network octets, prefix length] */
const RESERVED_V4: Array<[number[], number]> = [
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, incl. cloud metadata 169.254.169.254
  [[172, 16, 0, 0], 12], // private
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // TEST-NET-1
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, incl. 255.255.255.255
];

const inV4Network = (
  addr: number[],
  network: number[],
  prefix: number,
): boolean => {
  for (let i = 0; i < 4; i++) {
    const bits = Math.min(8, Math.max(0, prefix - i * 8));
    if (bits === 0) break;
    const mask = (0xff << (8 - bits)) & 0xff;
    if ((addr[i] & mask) !== (network[i] & mask)) return false;
  }
  return true;
};

/**
 * Is this address one we must never dial on a client's behalf?
 *
 * Fails closed: anything unparseable is treated as reserved. A target we
 * cannot classify is not one to connect to.
 */
/**
 * Expand an IPv6 literal into its eight 16-bit groups.
 *
 * Returns null if the value is not a well-formed IPv6 address. Comparing
 * IPv6 as strings does not work: `::1`, `0:0:0:0:0:0:0:1` and
 * `0000:...:0001` are the same address, and an exact-match check catches
 * only whichever spelling it was written with.
 */
const parseIPv6 = (value: string): number[] | null => {
  let text = value.split('%')[0]; // drop any zone index
  if (!text.includes(':')) return null;

  // A trailing IPv4 form (e.g. ::ffff:1.2.3.4) contributes two groups.
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(':');
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const octets = parseIPv4(maybeV4);
    if (!octets) return null;
    tail = [(octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]];
    text = text.slice(0, lastColon + 1) + '0';
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;

  const toGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
      groups.push(parseInt(piece, 16));
    }
    return groups;
  };

  const head = toGroups(halves[0]);
  if (head === null) return null;

  if (halves.length === 1) {
    const all = tail.length ? head.slice(0, -1).concat(tail) : head;
    return all.length === 8 ? all : null;
  }

  const rest = toGroups(halves[1]);
  if (rest === null) return null;

  const explicit = tail.length
    ? head.concat(rest.slice(0, -1), tail)
    : head.concat(rest);
  if (explicit.length > 8) return null;

  const zeros = new Array(8 - explicit.length).fill(0);
  const before = tail.length ? head : head;
  const after = tail.length ? rest.slice(0, -1).concat(tail) : rest;
  return before.concat(zeros, after);
};

/**
 * Is this address one we must never dial on a client's behalf?
 *
 * Fails closed: anything unparseable is treated as reserved. A target we
 * cannot classify is not one to connect to.
 */
export const isReservedAddress = (address: string): boolean => {
  if (!address) return true;

  // Strips ::ffff: only when the remainder is genuinely IPv4, so a real
  // IPv6 address is left intact.
  const normalized = normalizeAddress(address);

  const v4 = parseIPv4(normalized);
  if (v4) {
    return RESERVED_V4.some(([net, prefix]) => inV4Network(v4, net, prefix));
  }

  if (!normalized.includes(':')) return true;

  const v6 = parseIPv6(normalized);
  if (!v6) return true; // unparseable — fail closed

  // An IPv4-mapped address that survived normalizeAddress (e.g. written with
  // a different prefix spelling) is still IPv4; classify it as such.
  const isV4Mapped = v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff;
  if (isV4Mapped) {
    const octets = [v6[6] >> 8, v6[6] & 0xff, v6[7] >> 8, v6[7] & 0xff];
    return RESERVED_V4.some(([net, prefix]) =>
      inV4Network(octets, net, prefix),
    );
  }

  if (v6.every((g) => g === 0)) return true; // ::   unspecified
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return true; // ::1

  const leading = v6[0];
  if ((leading & 0xfe00) === 0xfc00) return true; // fc00::/7  unique-local
  if ((leading & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((leading & 0xff00) === 0xff00) return true; // ff00::/8  multicast

  return false;
};

// ---------------------------------------------------------------------------
// DNS resolution
// ---------------------------------------------------------------------------

export interface ResolveTargetOptions {
  /** Injectable for tests; defaults to resolving all A/AAAA records. */
  resolve?: (host: string) => Promise<string[]>;
}

export interface ResolvedTarget {
  allowed: boolean;
  /** The validated address to dial. Never re-resolve the hostname. */
  address?: string;
  reason?: string;
}

const defaultResolve = async (host: string): Promise<string[]> => {
  const { lookup } = await import('dns/promises');
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((entry) => entry.address);
};

/**
 * Resolve a client-supplied hostname and confirm every answer is publicly
 * routable.
 *
 * Resolution happens exactly once and the caller must dial the returned
 * address. Re-resolving between validation and connection is the DNS
 * rebinding hole: the second answer can differ from the one we approved.
 *
 * Rejects if ANY resolved address is reserved. A hostname answering with
 * one public and one private address is an attack, not a coincidence.
 */
export const resolveTargetAddress = async (
  host: string,
  options: ResolveTargetOptions = {},
): Promise<ResolvedTarget> => {
  const normalized = normalizeHost(host);
  if (!normalized) return { allowed: false, reason: 'Invalid target host' };

  // A literal address needs no lookup — classify it directly.
  const literal = normalizeAddress(normalized);
  if (parseIPv4(literal) || literal.includes(':')) {
    if (isReservedAddress(literal)) {
      return {
        allowed: false,
        reason: 'Target address is in a reserved network',
      };
    }
    return { allowed: true, address: literal };
  }

  const resolve = options.resolve ?? defaultResolve;

  let addresses: string[];
  try {
    addresses = await resolve(normalized);
  } catch {
    return { allowed: false, reason: 'Target hostname could not be resolved' };
  }

  if (!addresses?.length) {
    return { allowed: false, reason: 'Target hostname has no addresses' };
  }

  for (const address of addresses) {
    if (isReservedAddress(address)) {
      return {
        allowed: false,
        reason: 'Target resolves to a reserved network',
      };
    }
  }

  return { allowed: true, address: addresses[0] };
};

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Decide whether a target is permitted by policy.
 *
 * Every branch terminates in an explicit allow or deny, and the function ends
 * in a denial — so a mode added without an allow rule fails closed. The
 * previous implementation returned allowed:true when no policy was supplied
 * and when the allowlist was empty, either of which made the proxy an open
 * TCP relay.
 *
 * Arbitrary mode is only checked for shape here; DNS and reserved-network
 * safety is `resolveTargetAddress`, which the connect path must also call.
 */
export const validateTarget = (
  hostInput: unknown,
  portInput: unknown,
  policy?: TargetPolicyConfig,
): TargetValidationResult => {
  const host = normalizeHost(hostInput);
  const port = normalizePort(portInput);

  if (!host || !port) return deny('Invalid target host or port');

  if (!policy) return deny('Target policy is not configured');

  switch (policy.targetMode) {
    case 'fixed': {
      const defaultHost = normalizeHost(policy.defaultHost);
      const defaultPort = normalizePort(policy.defaultPort);
      if (!defaultHost || !defaultPort) {
        return deny('Server target policy is misconfigured');
      }
      if (host !== defaultHost || port !== defaultPort) {
        return deny(
          `This proxy only allows connections to ${defaultHost}:${defaultPort}`,
        );
      }
      return { allowed: true, host, port };
    }

    case 'allowlist': {
      const allowedTargets = parseAllowedTargets(policy.allowedTargets);
      // An empty allowlist permits nothing. Startup validation should have
      // rejected this configuration already; deny regardless.
      if (allowedTargets.size === 0) {
        return deny('No allowed targets are configured');
      }
      if (!allowedTargets.has(targetKey(host, port))) {
        return deny('Target is not in ALLOWED_TARGETS');
      }
      // Exact operator-configured entries may name private networks; that is
      // a deliberate choice, unlike a client-supplied hostname.
      return { allowed: true, host, port };
    }

    case 'arbitrary': {
      if (!portIsAllowed(port, policy.arbitraryAllowedPorts)) {
        return deny('Target port is not permitted');
      }
      return { allowed: true, host, port };
    }

    default:
      return deny('Target policy mode is not recognized');
  }
};
