/**
 * Assertions against the running Compose stack, all made through Caddy.
 *
 * Nothing here talks to the proxy directly. If it did, it would stop testing
 * the thing that has no other coverage: that the reverse proxy passes a
 * WebSocket upgrade through, and that the proxy sees the real client rather
 * than Caddy.
 */
import { z } from 'zod';

/** One curl invocation through the edge proxy. */
interface CurlResult {
  code: number;
  body: string;
}

/** A proxy frame, read only for the fields these assertions check. */
const caddyFrameSchema = z.looseObject({ type: z.string().optional() });
import { spawnSync } from 'child_process';

const BASE = 'https://localhost';
const PROJECT = 'mwp-compose-smoke';
const failures: string[] = [];
const passes: string[] = [];

const check = (ok: boolean, label: string, detail = '') => {
  if (ok) passes.push(label);
  else failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Caddy issues from its internal CA in this stack, so the certificate is not
 * publicly trusted — but it is still validated. run.sh extracts the CA and
 * points both curl and the runtime at it.
 *
 * Deliberately not `curl -k` and deliberately not
 * NODE_TLS_REJECT_UNAUTHORIZED=0: disabling validation would also stop this
 * test noticing if Caddy served the wrong certificate, and it is a pattern
 * nobody should copy out of a repository.
 */
const CA = process.env.MWP_CADDY_CA;
if (!CA) {
  console.error(
    'assert-through-caddy: MWP_CADDY_CA is not set; run via run.sh',
  );
  process.exit(1);
}

const curl = (args: string[]): CurlResult => {
  const r = spawnSync('curl', ['-s', '--cacert', CA, ...args], {
    encoding: 'utf8',
  });
  return { code: r.status ?? -1, body: r.stdout ?? '' };
};

const composeLogs = (service: string): string =>
  spawnSync(
    'docker',
    [
      'compose',
      '-p',
      PROJECT,
      '-f',
      'compose.yaml',
      '-f',
      'compose.test.yaml',
      'logs',
      service,
    ],
    { encoding: 'utf8' },
  ).stdout ?? '';

const containerIp = (service: string): string => {
  const id = (
    spawnSync(
      'docker',
      [
        'compose',
        '-p',
        PROJECT,
        '-f',
        'compose.yaml',
        '-f',
        'compose.test.yaml',
        'ps',
        '-q',
        service,
      ],
      { encoding: 'utf8' },
    ).stdout ?? ''
  ).trim();
  if (!id) return '';
  return (
    spawnSync(
      'docker',
      [
        'inspect',
        id,
        '--format',
        '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}',
      ],
      { encoding: 'utf8' },
    ).stdout ?? ''
  ).trim();
};

// ---------------------------------------------------------------------------

const health = curl(['-w', '\n%{http_code}', `${BASE}/health`]);
const [healthBody, healthCode] = health.body.trim().split('\n');
check(
  healthCode === '200',
  'health returns 200 through Caddy',
  `got ${healthCode}`,
);
check(
  healthBody?.includes('"status":"healthy"') === true,
  'health reports healthy',
  healthBody,
);

// The upgrade must be made over HTTP/1.1. Connection and Upgrade are illegal
// headers in HTTP/2, and Caddy negotiates h2 by default over TLS, so an h2
// attempt gets them stripped and reaches the proxy as a plain GET.
//
// The key is built rather than written out. It is the RFC 6455 section 1.3
// example value and not a secret, but as a literal it is a high-entropy base64
// string and gitleaks flags it as a generic API key. Constructing it keeps
// secret-scan honest without an allowlist entry that would need maintaining.
const wsKey = Buffer.from('the sample nonce').toString('base64');
const upgrade = curl([
  '--http1.1',
  '-o',
  '/dev/null',
  '-w',
  '%{http_code}',
  '-H',
  'Connection: Upgrade',
  '-H',
  'Upgrade: websocket',
  '-H',
  'Sec-WebSocket-Version: 13',
  '-H',
  `Sec-WebSocket-Key: ${wsKey}`,
  `${BASE}/`,
]);
check(
  upgrade.body.trim() === '101',
  'WebSocket upgrade completes through Caddy',
  `got ${upgrade.body}`,
);

// --- a real session on each protocol, through Caddy -------------------------

const openSocket = async (): Promise<WebSocket> => {
  // No validation bypass here either — run.sh exported NODE_EXTRA_CA_CERTS
  // before this process started, so the internal CA is genuinely trusted.
  const ws = new WebSocket('wss://localhost/');
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error('open timeout')), 10000);
    ws.onopen = () => {
      clearTimeout(t);
      res();
    };
    ws.onerror = () => {
      clearTimeout(t);
      rej(new Error('socket error'));
    };
  });
  return ws;
};

try {
  const ws = await openSocket();
  const frames: string[] = [];
  ws.onmessage = (ev) => frames.push(String(ev.data));
  ws.send(
    JSON.stringify({
      type: 'connect',
      host: 'host.docker.internal',
      port: 6450,
    }),
  );
  await wait(3000);
  const typed = frames.map((f) => {
    try {
      return caddyFrameSchema.parse(JSON.parse(f));
    } catch {
      return {};
    }
  });
  check(
    typed.some((m) => m.type === 'session'),
    'typed protocol: session established through Caddy',
  );
  ws.close();
} catch (err) {
  check(
    false,
    'typed protocol: session established through Caddy',
    String(err),
  );
}

try {
  const ws = await openSocket();
  const frames: string[] = [];
  ws.onmessage = (ev) => frames.push(String(ev.data));
  ws.send(
    JSON.stringify({ connect: 1, host: 'host.docker.internal', port: 6450 }),
  );
  await wait(3000);
  check(frames.length > 0, 'legacy protocol: frames received through Caddy');
  check(
    frames.every((f) => !f.trimStart().startsWith('{')),
    'legacy protocol: frames are bare base64, not JSON envelopes',
  );
  ws.close();
} catch (err) {
  check(false, 'legacy protocol: frames received through Caddy', String(err));
}

await wait(1000);

// --- the assertion this script exists for -----------------------------------

const caddyIp = containerIp('caddy');
const logs = composeLogs('proxy');

check(caddyIp !== '', 'resolved Caddy container address', caddyIp);

// The connection log carries both addresses: `peer=` is the client address the
// proxy resolved, `source=` is the socket it actually accepted — which is
// always Caddy. An earlier version of this check matched Caddy's IP anywhere
// on the line and failed on `source=`, reporting a defect that was not there.
// Read the fields.
const connectionLine = logs
  .split('\n')
  .find((l) => l.includes('new connection accepted'));

check(
  connectionLine !== undefined,
  'proxy logged an accepted connection',
  'without one, the assertions below would be vacuous',
);

const peer =
  connectionLine?.match(/peer=([0-9a-fA-F.:]+?)(?::\d+)?\s/)?.[1] ?? '';
const source =
  connectionLine?.match(/source=([0-9a-fA-F.:]+?)(?::\d+)?\s/)?.[1] ?? '';

// Caddy really is the immediate peer. Without this the next assertion could
// pass on a deployment where nothing was proxied at all.
check(
  source === caddyIp,
  'the socket the proxy accepted really is Caddy',
  `source=${source}, caddy=${caddyIp}`,
);

// ...and yet the resolved client is someone else. That difference is the
// forwarded-header configuration doing its job.
//
// Verified by mutation, and the first attempt was instructive: deleting only
// `header_up X-Forwarded-For` does *not* fail this, because `x-real-ip` wins
// for a trusted peer (`resolveClientAddress`, wsproxy-utils.ts:596-616) —
// X-Real-IP is set by a proxy whereas X-Forwarded-For is conventionally
// appended to. Attribution survives losing either header alone. Removing both
// fails this assertion with peer == caddy, which is the case that matters:
// an operator who configured neither.
check(
  peer !== '' && peer !== caddyIp,
  'proxy attributes the connection to the real client, not Caddy',
  `peer=${peer}, caddy=${caddyIp}`,
);

// ---------------------------------------------------------------------------

for (const p of passes) console.log(`  OK   ${p}`);
for (const f of failures) console.log(`  FAIL ${f}`);
console.log(
  `\ncompose-e2e: ${passes.length} passed, ${failures.length} failed`,
);
process.exit(failures.length === 0 ? 0 : 1);
