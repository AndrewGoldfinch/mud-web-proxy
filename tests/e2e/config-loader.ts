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
 * Each file contains unprefixed variables like ENABLED=true, HOST=..., etc.
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
 * Variables in each file are unprefixed (e.g., ENABLED=true, HOST=...)
 *
 * Example for Aardwolf in .env.aardwolf:
 *   ENABLED=true
 *   HOST=aardmud.org
 *   PORT=4000
 *   USERNAME=your_name
 *   PASSWORD=your_pass
 *   EXPECT_GMCP=true
 *   ...
 */
export function loadE2EConfig(mudName: string): ConfigLoadResult {
  // Env vars loaded via bun --env-file in package.json scripts
  const enabled = getEnvBool('ENABLED', false);
  if (!enabled) {
    return {
      config: null,
      skip: true,
      reason: `E2E tests disabled (ENABLED not set or false). Create .env.${mudName}.local to enable.`,
    };
  }

  // Load required fields
  const host = process.env['HOST'];
  const port = getEnvInt('PORT', 0);

  if (!host || port === 0) {
    return {
      config: null,
      skip: true,
      reason: `Missing required fields: HOST and/or PORT`,
    };
  }

  // Build config from environment (no prefix needed)
  const config: E2EConfig = {
    enabled: true,
    host,
    port,
    username: process.env['USERNAME'] || undefined,
    password: process.env['PASSWORD'] || undefined,
    character: process.env['CHARACTER'] || undefined,
    expectations: {
      gmcp: getEnvBool('EXPECT_GMCP', true),
      mccp: getEnvBool('EXPECT_MCCP', true),
      mxp: getEnvBool('EXPECT_MXP', false),
      msdp: getEnvBool('EXPECT_MSDP', false),
      utf8: getEnvBool('EXPECT_UTF8', true),
      ansi: getEnvBool('EXPECT_ANSI', true),
    },
    testTimeoutMs: getEnvInt('TIMEOUT_MS', 30000),
    loginPrompt: process.env['LOGIN_PROMPT'] || undefined,
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

  // In dev, always allow (will check per-MUD when loading specific configs)
  // In CI, tests should use the mock server instead
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
 * Note: This now checks each MUD's specific .env file
 */
export function listAvailableConfigs(): string[] {
  const muds = ['aardwolf', 'achaea', 'discworld', 'ire', 'rom', 'raw'];

  return muds.filter((mud) => {
    // In a real implementation, we would load each .env.{mud} file
    // and check if ENABLED=true. For now, just return empty or
    // check if there's a way to know which are configured.
    // This is a simplified version - in practice, you'd need to
    // actually load each .env file to check.
    const enabled = process.env['ENABLED'];
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
 * Get MUD-specific environment variables from current loaded env
 * Returns variables relevant to the current MUD context
 */
export function getMudEnv(
  _mudName: string,
): Record<string, string | undefined> {
  // Since each MUD has its own .env file, we just return all env vars
  // that are relevant to MUD configuration (not system vars)
  const mudVars: Record<string, string | undefined> = {};
  const relevantKeys = [
    'ENABLED',
    'HOST',
    'PORT',
    'USERNAME',
    'PASSWORD',
    'CHARACTER',
    'EXPECT_GMCP',
    'EXPECT_MCCP',
    'EXPECT_MXP',
    'EXPECT_MSDP',
    'EXPECT_UTF8',
    'EXPECT_ANSI',
    'TIMEOUT_MS',
    'LOGIN_PROMPT',
  ];

  for (const key of relevantKeys) {
    if (key in process.env) {
      mudVars[key] = process.env[key];
    }
  }

  return mudVars;
}
