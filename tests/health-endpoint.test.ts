import { describe, test, expect, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import path from 'path';
import pkg from '../package.json';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('/health endpoint', () => {
  let proxyProcess: ReturnType<typeof spawn> | null = null;
  const healthUrl = 'http://localhost:6217/health';

  afterAll(() => {
    if (proxyProcess) {
      proxyProcess.kill('SIGTERM');
      proxyProcess = null;
    }
  });

  test(
    'returns exactly { status, version } keys with no-store cache control',
    { timeout: 15000 },
    async () => {
      proxyProcess = spawn('bun', [path.join(__dirname, '..', 'wsproxy.ts')], {
        env: {
          ...process.env,
          WS_PORT: '6217',
          TN_HOST: 'localhost',
          TN_PORT: '7002',
          TARGET_MODE: 'fixed',
          INBOUND_TLS_MODE: 'off',
          ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
          BIND_HOST: '127.0.0.1',
          MUD_TLS_MODE: 'plain',
          REQUIRE_APP_AUTH: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Wait for server to be ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timeout waiting for proxy')),
          8000,
        );
        proxyProcess!.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          if (text.includes('server listening') || text.includes('port 6217')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        proxyProcess!.stderr?.on('data', () => {
          // ignore stderr
        });
      });

      const response = await fetch(healthUrl);

      expect(response.status).toBe(200);
      expect(response.headers.get('cache-control')).toBe('no-store');

      const body = await response.json();
      const keys = Object.keys(body).sort();
      expect(keys).toEqual(['status', 'version']);
      expect(body.status).toBe('healthy');
      expect(typeof body.version).toBe('string');
      expect(body.version).toBe(pkg.version);

      proxyProcess!.kill('SIGTERM');
      proxyProcess = null;
    },
  );

  test(
    'returns 503 with draining status after SIGTERM',
    { timeout: 15000 },
    async () => {
      proxyProcess = spawn('bun', [path.join(__dirname, '..', 'wsproxy.ts')], {
        env: {
          ...process.env,
          WS_PORT: '6218',
          TN_HOST: 'localhost',
          TN_PORT: '7003',
          TARGET_MODE: 'fixed',
          INBOUND_TLS_MODE: 'off',
          ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
          BIND_HOST: '127.0.0.1',
          MUD_TLS_MODE: 'plain',
          REQUIRE_APP_AUTH: 'false',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Wait for server to be ready
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('timeout waiting for proxy')),
          8000,
        );
        proxyProcess!.stdout?.on('data', (data: Buffer) => {
          const text = data.toString();
          if (text.includes('server listening') || text.includes('port 6218')) {
            clearTimeout(timeout);
            resolve();
          }
        });
        proxyProcess!.stderr?.on('data', () => {});
      });

      // Send SIGTERM to start draining
      proxyProcess!.kill('SIGTERM');

      // Give it a moment to set srv.open = false
      await new Promise((resolve) => setTimeout(resolve, 200));

      const response = await fetch('http://localhost:6218/health');

      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('no-store');

      const body = await response.json();
      const keys = Object.keys(body).sort();
      expect(keys).toEqual(['status', 'version']);
      expect(body.status).toBe('draining');
      expect(typeof body.version).toBe('string');

      proxyProcess = null;
    },
  );
});
