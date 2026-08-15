/**
 * The /attest/* routes exist only when App Attest is configured (MWP-95).
 *
 * They used to be registered unconditionally. An operator running the proxy
 * for a browser client — who will never own an Apple developer team — still
 * served an unauthenticated nonce-minting endpoint and an attestation
 * verifier reachable from the internet. That is attack surface with no
 * corresponding feature.
 *
 * When disabled the routes must 404 rather than 403: a 403 confirms the
 * feature exists and is merely switched off, which is exactly the fact a
 * scanner is looking for.
 *
 * These are process-level on purpose. Route registration is a property of
 * the assembled server, and a unit test of the config object would pass
 * whether or not wsproxy consulted it.
 */

import { z } from 'zod';

/** The challenge endpoint's success body. */
const challengeBodySchema = z.looseObject({
  nonce: z.string(),
  expires: z.number().optional(),
});

/** The shape every rejection from these routes takes. */
const errorBodySchema = z.looseObject({ error: z.string() });
import { describe, test, expect, afterEach } from 'bun:test';
import { spawn, type ChildProcess } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(__dirname, '..', 'wsproxy.ts');

interface Proxy {
  port: number;
  output: string;
  stop: () => void;
}

let running: ChildProcess | null = null;

afterEach(() => {
  if (running) {
    running.kill('SIGKILL');
    running = null;
  }
});

const startProxy = async (
  port: number,
  env: Record<string, string>,
): Promise<Proxy> => {
  const child = spawn('bun', [PROXY], {
    env: {
      ...process.env,
      WS_PORT: String(port),
      TN_HOST: 'localhost',
      TN_PORT: '7002',
      TARGET_MODE: 'fixed',
      INBOUND_TLS_MODE: 'off',
      ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
      BIND_HOST: '127.0.0.1',
      MUD_TLS_MODE: 'plain',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  running = child;

  let output = '';
  const collect = (data: Buffer) => {
    output += data.toString();
  };
  child.stdout?.on('data', collect);
  child.stderr?.on('data', collect);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timeout waiting for proxy. Output:\n${output}`)),
      10_000,
    );
    const check = () => {
      if (output.includes('server listening')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited with ${code}. Output:\n${output}`));
    });
  });

  return {
    port,
    get output() {
      return output;
    },
    stop: () => {
      child.kill('SIGKILL');
      running = null;
    },
  };
};

const configured = {
  APPATTEST_BUNDLE_ID: 'com.example.app',
  APPATTEST_TEAM_ID: 'AAABBBCCC1',
};

describe('App Attest disabled', () => {
  test(
    'the challenge and register routes are not registered',
    { timeout: 20_000 },
    async () => {
      const proxy = await startProxy(6231, {});

      const challenge = await fetch(
        `http://127.0.0.1:${proxy.port}/attest/challenge`,
      );
      expect(challenge.status).toBe(404);

      const register = await fetch(
        `http://127.0.0.1:${proxy.port}/attest/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyId: 'k', attestation: 'a', nonce: 'n' }),
        },
      );
      expect(register.status).toBe(404);

      // 404, not 403 — the response must not distinguish "feature off" from
      // "no such endpoint".
      expect(challenge.status).not.toBe(403);
      expect(register.status).not.toBe(403);

      proxy.stop();
    },
  );

  test(
    'a disabled route is indistinguishable from a nonexistent one',
    { timeout: 20_000 },
    async () => {
      const proxy = await startProxy(6232, {});

      const attest = await fetch(
        `http://127.0.0.1:${proxy.port}/attest/challenge`,
      );
      const nonsense = await fetch(
        `http://127.0.0.1:${proxy.port}/no/such/path`,
      );

      expect(attest.status).toBe(nonsense.status);
      expect(await attest.json()).toEqual(await nonsense.json());

      proxy.stop();
    },
  );

  test(
    'startup says so explicitly rather than staying silent',
    { timeout: 20_000 },
    async () => {
      const proxy = await startProxy(6233, {});
      expect(proxy.output).toMatch(/App Attest DISABLED/);
      expect(proxy.output).toMatch(/APNS DISABLED/);
      proxy.stop();
    },
  );
});

describe('App Attest enabled', () => {
  test('the challenge route issues a nonce', { timeout: 20_000 }, async () => {
    const proxy = await startProxy(6234, configured);

    const response = await fetch(
      `http://127.0.0.1:${proxy.port}/attest/challenge`,
    );
    expect(response.status).toBe(200);

    const body = challengeBodySchema.parse(await response.json());
    expect(body.nonce).toEqual(expect.any(String));
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
    expect(body.expires).toBeGreaterThan(Date.now());

    proxy.stop();
  });

  test('successive challenges are distinct', { timeout: 20_000 }, async () => {
    const proxy = await startProxy(6235, configured);
    const base = `http://127.0.0.1:${proxy.port}/attest/challenge`;

    const first = challengeBodySchema.parse(await (await fetch(base)).json());
    const second = challengeBodySchema.parse(await (await fetch(base)).json());

    expect(first.nonce).not.toBe(second.nonce);

    proxy.stop();
  });

  test(
    'the register route exists and validates its input',
    { timeout: 20_000 },
    async () => {
      const proxy = await startProxy(6236, configured);

      // A 400 rather than a 404 is the point: the route is registered, and
      // it rejected the body on its merits.
      const response = await fetch(
        `http://127.0.0.1:${proxy.port}/attest/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ keyId: 'only-a-key-id' }),
        },
      );
      expect(response.status).toBe(400);
      expect(errorBodySchema.parse(await response.json())).toMatchObject({
        error: expect.stringContaining('Missing'),
      });

      proxy.stop();
    },
  );

  test(
    'challenge issuance is rate-limited per source',
    { timeout: 30_000 },
    async () => {
      const proxy = await startProxy(6237, configured);
      const url = `http://127.0.0.1:${proxy.port}/attest/challenge`;

      // The limit is 30/minute. Requests are serialized so the limiter sees a
      // deterministic order rather than a burst racing itself.
      const statuses: number[] = [];
      for (let i = 0; i < 35; i++) {
        statuses.push((await fetch(url)).status);
      }

      expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
      expect(statuses.slice(30).every((s) => s === 429)).toBe(true);

      proxy.stop();
    },
  );

  test(
    'the rate-limit response tells the client when to retry',
    { timeout: 30_000 },
    async () => {
      const proxy = await startProxy(6238, configured);
      const url = `http://127.0.0.1:${proxy.port}/attest/challenge`;

      let limited: Response | null = null;
      for (let i = 0; i < 35; i++) {
        const response = await fetch(url);
        if (response.status === 429) {
          limited = response;
          break;
        }
      }

      expect(limited).not.toBeNull();
      expect(limited!.headers.get('retry-after')).toBe('60');

      proxy.stop();
    },
  );

  test(
    'startup announces the feature and its experimental status',
    { timeout: 20_000 },
    async () => {
      const proxy = await startProxy(6239, configured);
      expect(proxy.output).toMatch(/App Attest ENABLED \(EXPERIMENTAL\)/);
      // The review gap is stated where an operator will actually see it.
      expect(proxy.output).toMatch(/independent cryptographic review/);
      proxy.stop();
    },
  );
});

describe('startup refuses incoherent App Attest configuration', () => {
  const failsToStart = async (
    port: number,
    env: Record<string, string>,
  ): Promise<string> => {
    const child = spawn('bun', [PROXY], {
      env: {
        ...process.env,
        WS_PORT: String(port),
        TN_HOST: 'localhost',
        TN_PORT: '7002',
        TARGET_MODE: 'fixed',
        INBOUND_TLS_MODE: 'off',
        ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
        BIND_HOST: '127.0.0.1',
        MUD_TLS_MODE: 'plain',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    running = child;

    let output = '';
    child.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (output += d.toString()));

    const code = await new Promise<number | null>((resolve) => {
      child.on('exit', resolve);
      setTimeout(() => resolve(null), 10_000);
    });
    running = null;

    expect(code).not.toBe(0);
    expect(code).not.toBeNull();
    return output;
  };

  test(
    'REQUIRE_APP_AUTH without App Attest aborts instead of rejecting everyone',
    { timeout: 20_000 },
    async () => {
      const output = await failsToStart(6240, { REQUIRE_APP_AUTH: 'true' });
      expect(output).toMatch(/REQUIRE_APP_AUTH=true requires App Attest/);
    },
  );

  test(
    'a half-configured App Attest aborts',
    { timeout: 20_000 },
    async () => {
      const output = await failsToStart(6241, {
        APPATTEST_BUNDLE_ID: 'com.example.app',
      });
      expect(output).toMatch(/App Attest is partially configured/);
    },
  );

  test('the retired mTLS fallback aborts', { timeout: 20_000 }, async () => {
    const output = await failsToStart(6242, { ALLOW_MTLS_FALLBACK: 'true' });
    expect(output).toMatch(/ALLOW_MTLS_FALLBACK has been removed/);
  });
});

describe('the removed bypass variables reach nothing at runtime', () => {
  test(
    'a proxy carrying them starts and behaves identically',
    { timeout: 20_000 },
    async () => {
      // Setting them must not enable anything, and must not prevent startup:
      // ignoring a retired bypass fails toward the safe side.
      const proxy = await startProxy(6243, {
        ...configured,
        APPATTEST_ALLOW_ASSERTION_BYPASS: 'true',
        APPATTEST_DIAG_CROSSKEY: 'true',
      });

      expect(proxy.output).toMatch(/App Attest ENABLED/);
      // No log line acknowledges a bypass, because nothing reads one.
      expect(proxy.output).not.toMatch(/bypass enabled/i);

      const response = await fetch(
        `http://127.0.0.1:${proxy.port}/attest/challenge`,
      );
      expect(response.status).toBe(200);

      proxy.stop();
    },
  );
});
