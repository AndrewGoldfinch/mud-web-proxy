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
export async function startTestProxy(
  port: number = 6299,
): Promise<ProxyLauncher> {
  return new Promise((resolve, reject) => {
    const proxyPath = path.join(__dirname, '..', '..', 'wsproxy.ts');

    console.log(`[E2E] Starting test proxy on port ${port}...`);

    // Spawn proxy process with test port
    const proxyProcess = spawn('bun', [proxyPath], {
      env: {
        ...process.env,
        WS_PORT: port.toString(),
        TN_HOST: 'aardmud.org',
        TN_PORT: '4000',
        ONLY_ALLOW_DEFAULT_SERVER: 'false',
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
              url: `wss://localhost:${port}`,
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

    // Send SIGTERM
    process.kill('SIGTERM');

    // Force kill after 2 seconds
    setTimeout(() => {
      if (!process.killed) {
        process.kill('SIGKILL');
      }
      resolve();
    }, 2000);

    process.on('exit', () => {
      resolve();
    });
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
