/**
 * E2E Test Configuration Loader
 * Loads MUD server credentials from .env files
 *
 * Bun automatically loads .env files in this order:
 * 1. .env.local (highest priority - secrets, gitignored)
 * 2. .env.{environment} (e.g., .env.test, .env.production)
 * 3. .env (defaults, can be committed)
 *
 * Per-MUD configs: .env.aardwolf, .env.achaea, etc.
 */

import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface E2EConfig {
  enabled: boolean;
  host: string;
  port: number;
  username?: string;
  password?: string;
  character?: string;
  expectations: {
    gmcp: boolean;
    mccp: boolean;
    mxp: boolean;
    msdp: boolean;
    utf8: boolean;
    ansi: boolean;
  };
  testTimeoutMs: number;
  loginPrompt?: string;
}

export interface ConfigLoadResult {
  config: E2EConfig | null;
  skip: boolean;
  reason?: string;
}

/**
 * Load E2E config for a specific MUD from environment variables
 * Variables are loaded from .env.{mud} and .env.{mud}.local files
 *
 * Example for Aardwolf:
 *   AARDWOLF_ENABLED=true
 *   AARDWOLF_HOST=aardmud.org
 *   AARDWOLF_PORT=4000
 *   AARDWOLF_USERNAME=your_name
 *   AARDWOLF_PASSWORD=your_pass
 *   AARDWOLF_EXPECT_GMCP=true
 *   ...
 */
export function loadE2EConfig(mudName: string): ConfigLoadResult {
  const prefix = mudName.toUpperCase().replace(/-/g, '_');

  // Check if enabled
  const enabled = getEnvBool(`${prefix}_ENABLED`, false);
  if (!enabled) {
    return {
      config: null,
      skip: true,
      reason: `E2E tests disabled (${prefix}_ENABLED not set or false). Create .env.${mudName}.local to enable.`,
    };
  }

  // Load required fields
  const host = process.env[`${prefix}_HOST`];
  const port = getEnvInt(`${prefix}_PORT`, 0);

  if (!host || port === 0) {
    return {
      config: null,
      skip: true,
      reason: `Missing required fields: ${prefix}_HOST and/or ${prefix}_PORT`,
    };
  }

  // Build config from environment
  const config: E2EConfig = {
    enabled: true,
    host,
    port,
    username: process.env[`${prefix}_USERNAME`] || undefined,
    password: process.env[`${prefix}_PASSWORD`] || undefined,
    character: process.env[`${prefix}_CHARACTER`] || undefined,
    expectations: {
      gmcp: getEnvBool(`${prefix}_EXPECT_GMCP`, true),
      mccp: getEnvBool(`${prefix}_EXPECT_MCCP`, true),
      mxp: getEnvBool(`${prefix}_EXPECT_MXP`, false),
      msdp: getEnvBool(`${prefix}_EXPECT_MSDP`, false),
      utf8: getEnvBool(`${prefix}_EXPECT_UTF8`, true),
      ansi: getEnvBool(`${prefix}_EXPECT_ANSI`, true),
    },
    testTimeoutMs: getEnvInt(`${prefix}_TIMEOUT_MS`, 30000),
    loginPrompt: process.env[`${prefix}_LOGIN_PROMPT`] || undefined,
  };

  return {
    config,
    skip: false,
  };
}

/**
 * Check if E2E tests should run globally
 */
export function shouldRunE2ETests(): boolean {
  // Check for explicit skip
  const skipE2E = process.env.SKIP_E2E_TESTS;
  if (skipE2E === '1' || skipE2E === 'true') {
    return false;
  }

  // In CI, check if we have any configs set up
  if (isCI()) {
    // In CI, check if at least one MUD is enabled
    const muds = ['aardwolf', 'achaea', 'discworld', 'ire', 'rom', 'raw'];
    return muds.some((mud) => {
      const prefix = mud.toUpperCase().replace(/-/g, '_');
      return (
        process.env[`${prefix}_ENABLED`] === 'true' ||
        process.env[`${prefix}_ENABLED`] === '1'
      );
    });
  }

  // In dev, always allow (will check per-MUD)
  return true;
}

/**
 * Check if running in CI environment
 */
export function isCI(): boolean {
  return (
    process.env.CI === 'true' ||
    process.env.GITHUB_ACTIONS === 'true' ||
    process.env.TRAVIS === 'true' ||
    process.env.CIRCLECI === 'true' ||
    process.env.JENKINS === 'true'
  );
}

/**
 * Get list of available E2E configs
 */
export function listAvailableConfigs(): string[] {
  const muds = ['aardwolf', 'achaea', 'discworld', 'ire', 'rom', 'raw'];

  return muds.filter((mud) => {
    const prefix = mud.toUpperCase().replace(/-/g, '_');
    const enabled = process.env[`${prefix}_ENABLED`];
    return enabled === 'true' || enabled === '1';
  });
}

/**
 * Load a specific environment variable
 */
export function getEnv(key: string): string | undefined {
  return process.env[key];
}

/**
 * Load a boolean environment variable
 */
export function getEnvBool(key: string, defaultValue: boolean): boolean {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  return value === 'true' || value === '1';
}

/**
 * Load an integer environment variable
 */
export function getEnvInt(key: string, defaultValue: number): number {
  const value = process.env[key];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Get all environment variables as a record
 * Useful for debugging
 */
export function getAllEnv(): Record<string, string | undefined> {
  return { ...process.env };
}

/**
 * Get MUD-specific environment variables
 */
export function getMudEnv(
  mudName: string,
): Record<string, string | undefined> {
  const prefix = mudName.toUpperCase().replace(/-/g, '_');
  const result: Record<string, string | undefined> = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith(prefix)) {
      result[key] = value;
    }
  }

  return result;
}
