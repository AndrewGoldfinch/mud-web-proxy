/**
 * Spawn the real proxy and capture everything it writes.
 *
 * The unit suites for redaction and auth exercise `redactLogMessage()` and
 * `authorizeSharedSecret()` directly. Both properties they check are
 * process-level: redaction holds only if every log path actually routes
 * through `srv.log()` with the configured secrets attached, and auth parity
 * holds only if enforcement sits where neither wire protocol can bypass it.
 * Neither can be observed by calling the helper — you have to run the binary
 * and read its output.
 *
 * Not merged into `tests/e2e/proxy-launcher.ts`: that one takes a fixed
 * allowlist of eight settings, forwards stderr to the console instead of
 * retaining it, and runs in the mock-e2e job. These tests need arbitrary
 * environment, a retained transcript, and the `quality` job.
 */

import { spawn, type ChildProcess } from 'child_process';
import net from 'net';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROXY = path.join(__dirname, '..', 'wsproxy.ts');

export interface RunningProxy {
  /** Everything written to stdout and stderr since launch. */
  output: () => string;
  stop: () => Promise<void>;
}

/**
 * Start the proxy on `port` and resolve once it reports it is listening.
 *
 * `env` is applied last and overrides the defaults, so a test can set any
 * variable — including one that makes startup fail, which is why a non-zero
 * exit rejects with the captured output rather than hanging until timeout.
 */
export async function startProxy(
  port: number,
  env: Record<string, string>,
): Promise<RunningProxy> {
  let transcript = '';

  const child: ChildProcess = spawn('bun', [PROXY], {
    env: {
      ...process.env,
      WS_PORT: String(port),
      BIND_HOST: '127.0.0.1',
      TARGET_MODE: 'fixed',
      INBOUND_TLS_MODE: 'off',
      ALLOW_INSECURE_INBOUND_NO_TLS: 'true',
      MUD_TLS_MODE: 'plain',
      REQUIRE_APP_AUTH: 'false',
      // The launcher's reason, and it applies here too: the production 3s
      // drain outlives the kill window and leaves the port held into the
      // next file.
      SHUTDOWN_GRACE_MS: '100',
      SHUTDOWN_DEADLINE_MS: '2000',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (d: Buffer) => {
    transcript += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    transcript += d.toString();
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`proxy did not start. Output:\n${transcript}`)),
      15000,
    );
    const check = (): void => {
      if (transcript.includes('server listening')) {
        clearTimeout(timer);
        resolve();
      }
    };
    child.stdout?.on('data', check);
    child.stderr?.on('data', check);
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`proxy exited with ${code}. Output:\n${transcript}`));
    });
  });

  // The listener is up, but the log line is emitted before the first tick of
  // request handling settles; connecting immediately is occasionally refused.
  await new Promise((r) => setTimeout(r, 300));

  return {
    output: () => transcript,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(force);
          // Let the final flush of the exiting child land in the transcript,
          // otherwise the shutdown log lines are missing from what we assert
          // over — and shutdown is one of the paths that logs.
          setTimeout(resolve, 150);
        };
        child.once('exit', finish);
        child.kill('SIGTERM');
        const force = setTimeout(() => {
          if (!settled) {
            child.kill('SIGKILL');
            setTimeout(finish, 250);
          }
        }, 3000);
      }),
  };
}

export interface MockMud {
  /** How many TCP connections the MUD has accepted. */
  connections: () => number;
  /** Every byte the MUD received, as a string. */
  received: () => string;
  stop: () => Promise<void>;
}

/**
 * A deliberately minimal TCP MUD.
 *
 * `tests/e2e/mock-mud.ts` is a far richer server — telnet negotiation, GMCP,
 * login prompts. That richness is a liability here: these tests assert on a
 * log transcript, and every extra thing the MUD says is more text to rule
 * out. This one greets and echoes, which is all that is needed to prove a
 * session carried player input.
 */
export async function startMockMud(port: number): Promise<MockMud> {
  let connections = 0;
  let received = '';

  const server = net.createServer((socket) => {
    connections += 1;
    socket.write('Welcome to the test MUD.\r\n');
    socket.on('data', (d: Buffer) => {
      received += d.toString('utf8');
      socket.write('ack\r\n');
    });
    socket.on('error', () => {
      // A test closing its WebSocket mid-write resets this end; not a failure.
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    connections: () => connections,
    received: () => received,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}
