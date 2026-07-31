import { encode } from 'cbor-x';
import { readFileSync } from 'fs';
import WebSocket, { type RawData } from 'ws';

interface AcceptanceEnvironment {
  PROXY_HTTP_URL: string;
  PROXY_WS_URL: string;
  CADDY_CA_PATH: string;
  MUD_HOST: string;
  MUD_PORT: string;
}

const required = (name: keyof AcceptanceEnvironment): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`systemd-acceptance-client: missing ${name}`);
  }
  return value;
};

const fail = (message: string): never => {
  throw new Error(`systemd-acceptance-client: ${message}`);
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`systemd-acceptance-client: timeout: ${label}`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const httpBase = required('PROXY_HTTP_URL');
const wsUrl = required('PROXY_WS_URL');
const mudHost = required('MUD_HOST');
const mudPort = Number(required('MUD_PORT'));
if (!Number.isInteger(mudPort) || mudPort < 1 || mudPort > 65_535) {
  fail('invalid MUD_PORT');
}

const ca = readFileSync(required('CADDY_CA_PATH'));

const exerciseCaLoader = async (): Promise<void> => {
  const challengeResponse = await fetch(`${httpBase}/attest/challenge`);
  if (!challengeResponse.ok) {
    fail(`challenge returned ${challengeResponse.status}`);
  }
  const challenge = (await challengeResponse.json()) as { nonce?: string };
  if (!challenge.nonce) fail('challenge omitted nonce');

  const invalidAttestation = Buffer.from(
    encode({
      fmt: 'apple-appattest',
      attStmt: {
        x5c: [Buffer.from([0]), Buffer.from([0])],
      },
      authData: Buffer.alloc(55),
    }),
  ).toString('base64');

  const registerResponse = await fetch(`${httpBase}/attest/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      keyId: 'systemd-test-key',
      attestation: invalidAttestation,
      nonce: challenge.nonce,
    }),
  });
  const responseBody = await registerResponse.text();
  if (registerResponse.status !== 400) {
    fail(`invalid certificate chain returned ${registerResponse.status}`);
  }
  if (responseBody.includes('Apple root CA not found')) {
    fail(`App Attest CA loader failed: ${responseBody}`);
  }
  if (!/(certificate|asn1|pem|header|wrong tag)/i.test(responseBody)) {
    fail(`request did not reach certificate parsing: ${responseBody}`);
  }
  console.log('systemd-acceptance-client: ca-loaded');
};

const exerciseSession = async (): Promise<void> => {
  const socket = new WebSocket(wsUrl, {
    ca,
    rejectUnauthorized: true,
    headers: {
      'X-Forwarded-For': '198.51.100.77',
      'X-Real-IP': '203.0.113.88',
    },
  });
  let ready = false;
  let readySettled = false;
  let closeSettled = false;
  let phase: 'opening' | 'login' | 'ready' = 'opening';
  let loginTimer: ReturnType<typeof setInterval> | undefined;

  const clearLoginTimer = (): void => {
    if (loginTimer) {
      clearInterval(loginTimer);
      loginTimer = undefined;
    }
  };

  const sessionReady = new Promise<void>((resolve, reject) => {
    socket.on('open', () => {
      socket.send(
        JSON.stringify({
          type: 'connect',
          host: mudHost,
          port: mudPort,
        }),
      );
    });

    socket.on('error', (error: Error) => {
      reject(
        new Error(`systemd-acceptance-client: WebSocket error: ${error}`),
      );
    });

    socket.on('message', (data: RawData) => {
      const message = JSON.parse(data.toString()) as {
        type?: string;
        code?: string;
        message?: string;
        payload?: string;
      };
      if (message.type === 'error') {
        reject(
          new Error(
            `systemd-acceptance-client: proxy error ${message.code}: ${message.message}`,
          ),
        );
        return;
      }
      if (message.type === 'session' && phase === 'opening') {
        phase = 'login';
        loginTimer = setInterval(() => {
          socket.send(
            JSON.stringify({
              type: 'input',
              text: 'systemd-acceptance-login\r\n',
            }),
          );
        }, 250);
        return;
      }
      if (message.type !== 'data' || !message.payload) return;

      const text = Buffer.from(message.payload, 'base64').toString('utf8');
      const plainText = text.replace(/\x1b\[[0-9;]*m/g, '');
      if (
        phase === 'login' &&
        plainText.includes('Welcome to the Mock MUD!')
      ) {
        if (readySettled) {
          reject(
            new Error('systemd-acceptance-client: duplicate ready resolution'),
          );
          return;
        }
        clearLoginTimer();
        phase = 'ready';
        ready = true;
        readySettled = true;
        console.log('systemd-acceptance-client: spoof-probe-ready');
        resolve();
      }
    });
  });

  const proxyClosed = new Promise<void>((resolve, reject) => {
    socket.on('close', (code: number, reasonBuffer: Buffer) => {
      clearLoginTimer();
      if (closeSettled) {
        reject(
          new Error('systemd-acceptance-client: duplicate close resolution'),
        );
        return;
      }
      closeSettled = true;
      const reason = reasonBuffer.toString();
      if (!ready) {
        reject(
          new Error(
            `systemd-acceptance-client: socket closed before session was ready (${code})`,
          ),
        );
        return;
      }
      if (code !== 1001 || reason !== 'Server restarting') {
        reject(
          new Error(
            `systemd-acceptance-client: unexpected close ${code}: ${reason}`,
          ),
        );
        return;
      }
      console.log('systemd-acceptance-client: graceful-close-observed');
      resolve();
    });
  });
  void proxyClosed.catch(() => {});

  await withTimeout(sessionReady, 20_000, 'real session');
  await withTimeout(proxyClosed, 120_000, 'graceful proxy close');
};

await withTimeout(exerciseCaLoader(), 20_000, 'App Attest CA loader');
await exerciseSession();
