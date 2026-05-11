export interface TargetPolicyConfig {
  onlyAllowDefaultServer: boolean;
  defaultHost: string;
  defaultPort: number;
  allowedTargets?: string[];
}

export interface TargetValidationResult {
  allowed: boolean;
  host?: string;
  port?: number;
  reason?: string;
}

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

export const validateTarget = (
  hostInput: unknown,
  portInput: unknown,
  policy?: TargetPolicyConfig,
): TargetValidationResult => {
  const host = normalizeHost(hostInput);
  const port = normalizePort(portInput);

  if (!host || !port) {
    return {
      allowed: false,
      reason: 'Invalid target host or port',
    };
  }

  if (!policy) {
    return { allowed: true, host, port };
  }

  if (policy.onlyAllowDefaultServer) {
    const defaultHost = normalizeHost(policy.defaultHost);
    const defaultPort = normalizePort(policy.defaultPort);
    if (!defaultHost || !defaultPort) {
      return {
        allowed: false,
        reason: 'Server target policy is misconfigured',
      };
    }

    if (host !== defaultHost || port !== defaultPort) {
      return {
        allowed: false,
        reason: `This proxy only allows connections to ${policy.defaultHost}:${policy.defaultPort}`,
      };
    }

    return { allowed: true, host, port };
  }

  const allowedTargets = parseAllowedTargets(policy.allowedTargets);
  if (allowedTargets.size > 0 && !allowedTargets.has(targetKey(host, port))) {
    return {
      allowed: false,
      reason: 'Target is not in ALLOWED_TARGETS',
    };
  }

  return { allowed: true, host, port };
};
