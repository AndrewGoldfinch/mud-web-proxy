/**
 * E2E Proxy Launcher
 * Automatically starts the proxy server for testing
 */

import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface ProxyLauncher {
  process: ChildProcess;
  url: string;
  stop: () => Promise<void>;
}

/**
 * Start proxy server for E2E testing
 */
export interface ProxyConfig {
  TN_HOST?: string;
  TN_PORT?: string;
  MUD_TLS_MODE?: string;
  AUTH_MODE?: string;
  PROXY_SHARED_SECRET?: string;
}

export async function startTestProxy(
  port: number = 6299,
  extraEnv?: ProxyConfig,
): Promise<ProxyLauncher> {
  return new Promise((resolve, reject) => {
    const proxyPath = path.join(__dirname, '..', '..', 'wsproxy.ts');

    console.log(`[E2E] Starting test proxy on port ${port}...`);

    // Spawn proxy process with test port (non-TLS mode)
    const proxyProcess = spawn('bun', [proxyPath], {
      env: {
        ...process.env,
        WS_PORT: port.toString(),
        TN_HOST: extraEnv?.TN_HOST || 'aardmud.org',
        TN_PORT: extraEnv?.TN_PORT || '4000',
        TARGET_MODE: 'fixed',
        INBOUND_TLS_MODE: 'off',
        ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
        BIND_HOST: '127.0.0.1',
        MUD_TLS_MODE: extraEnv?.MUD_TLS_MODE || 'plain',
        REQUIRE_APP_AUTH: 'false',
        // Production defaults to a 3s drain grace, which outlives the
        // launcher's kill window and left the listener holding its port
        // into the next suite ("Is port NNNN in use?").
        SHUTDOWN_GRACE_MS: '100',
        SHUTDOWN_DEADLINE_MS: '2000',
        AUTH_MODE: extraEnv?.AUTH_MODE || 'none',
        ...(extraEnv?.PROXY_SHARED_SECRET
          ? { PROXY_SHARED_SECRET: extraEnv.PROXY_SHARED_SECRET }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let output = '';

    // Wait for proxy to start
    proxyProcess.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;

      // Check if proxy started
      if (text.includes('server listening') || text.includes('port ' + port)) {
        if (!started) {
          started = true;
          console.log(`[E2E] Proxy started on port ${port}`);

          // Give it a moment to fully initialize
          setTimeout(() => {
            resolve({
              process: proxyProcess,
              url: `ws://localhost:${port}`,
              stop: () => stopProxy(proxyProcess),
            });
          }, 500);
        }
      }
    });

    proxyProcess.stderr?.on('data', (data: Buffer) => {
      const text = data.toString();
      output += text;
      console.log(`[E2E Proxy stderr] ${text.trim()}`);
    });

    // Timeout after 10 seconds
    setTimeout(() => {
      if (!started) {
        proxyProcess.kill();
        reject(
          new Error(
            `Proxy failed to start within 10 seconds. Output: ${output}`,
          ),
        );
      }
    }, 10000);

    proxyProcess.on('error', (err) => {
      reject(new Error(`Failed to start proxy: ${err.message}`));
    });

    proxyProcess.on('exit', (code) => {
      if (!started && code !== 0) {
        reject(new Error(`Proxy exited with code ${code}. Output: ${output}`));
      }
    });
  });
}

/**
 * Stop proxy server
 */
async function stopProxy(process: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    console.log('[E2E] Stopping test proxy...');

    if (process.exitCode !== null || process.signalCode !== null) {
      resolve();
      return;
    }

    // Resolve only once the child has actually exited. Resolving on a timer
    // returned while the listener still held its port, so the next suite's
    // proxy failed to bind and every test in it failed at startup.
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKill);
      resolve();
    };

    process.once('exit', finish);

    process.kill('SIGTERM');

    // If the graceful path stalls, escalate and wait for the kill to land
    // rather than assuming it did.
    const forceKill = setTimeout(() => {
      if (!settled) {
        process.kill('SIGKILL');
        setTimeout(finish, 250);
      }
    }, 3000);
  });
}

/**
 * Wait for proxy to be ready
 */
export async function waitForProxy(
  url: string,
  timeoutMs: number = 5000,
): Promise<boolean> {
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      // Try to connect to health endpoint
      const response = await fetch(
        `http://localhost:${url.split(':')[2]}/health`,
      );
      if (response.ok) {
        return true;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return false;
}
