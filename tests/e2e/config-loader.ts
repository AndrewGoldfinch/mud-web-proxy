/**
 * E2E Test Configuration Loader
 * Loads MUD server credentials from config files (gitignored)
 */

import fs from 'fs';
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
 * Load E2E config for a specific MUD
 * Returns null if config file doesn't exist or is disabled
 */
export function loadE2EConfig(mudName: string): ConfigLoadResult {
  const configPath = path.join(
    __dirname,
    '..',
    '..',
    'config',
    'e2e',
    `${mudName}.json`,
  );

  // Check if config file exists
  if (!fs.existsSync(configPath)) {
    return {
      config: null,
      skip: true,
      reason: `Config file not found: config/e2e/${mudName}.json`,
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    const config: E2EConfig = JSON.parse(content);

    // Check if enabled
    if (!config.enabled) {
      return {
        config: null,
        skip: true,
        reason: `E2E tests disabled in config (enabled: false)`,
      };
    }

    // Validate required fields
    if (!config.host || !config.port) {
      return {
        config: null,
        skip: true,
        reason: `Missing required fields (host/port) in config`,
      };
    }

    // Set default timeout
    if (!config.testTimeoutMs) {
      config.testTimeoutMs = 30000;
    }

    return {
      config,
      skip: false,
    };
  } catch (err) {
    return {
      config: null,
      skip: true,
      reason: `Failed to parse config: ${err}`,
    };
  }
}

/**
 * Check if E2E tests should run globally
 */
export function shouldRunE2ETests(): boolean {
  // Check for explicit environment variable
  if (
    process.env.SKIP_E2E_TESTS === '1' ||
    process.env.SKIP_E2E_TESTS === 'true'
  ) {
    return false;
  }

  // Check if any config files exist
  const configDir = path.join(__dirname, '..', '..', 'config', 'e2e');
  if (!fs.existsSync(configDir)) {
    return false;
  }

  return true;
}

/**
 * Get list of available E2E configs
 */
export function listAvailableConfigs(): string[] {
  const configDir = path.join(__dirname, '..', '..', 'config', 'e2e');

  if (!fs.existsSync(configDir)) {
    return [];
  }

  return fs
    .readdirSync(configDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace('.json', ''));
}
