import { encode } from 'cbor-x';

const httpBase = process.env.PROXY_HTTP_URL ?? 'http://mwp-test-proxy:6200';
const wsUrl = process.env.PROXY_WS_URL ?? 'ws://mwp-test-proxy:6200';

const fail = (message: string): never => {
  throw new Error(`container-acceptance: ${message}`);
};

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`container-acceptance: timeout: ${label}`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

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
      keyId: 'container-test-key',
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
  console.log('container-acceptance: ca-loaded');
};

const exerciseSession = async (): Promise<void> => {
  const socket = new WebSocket(wsUrl);
  let ready = false;
  let phase: 'opening' | 'login' | 'ready' = 'opening';
  let loginTimer: ReturnType<typeof setInterval> | undefined;

  const sessionReady = new Promise<void>((resolve, reject) => {
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          type: 'connect',
          host: 'mwp-test-mud',
          port: 6300,
        }),
      );
    };

    socket.onerror = () => {
      reject(new Error('container-acceptance: WebSocket error'));
    };

    socket.onmessage = (event: MessageEvent) => {
      const message = JSON.parse(event.data.toString()) as {
        type?: string;
        code?: string;
        message?: string;
        payload?: string;
      };
      if (message.type === 'error') {
        reject(
          new Error(
            `container-acceptance: proxy error ${message.code}: ${message.message}`,
          ),
        );
        return;
      }
      if (message.type === 'session' && phase === 'opening') {
        phase = 'login';
        loginTimer = setInterval(() => {
          socket.send(
            JSON.stringify({ type: 'input', text: 'container-login\r\n' }),
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
        if (loginTimer) clearInterval(loginTimer);
        phase = 'ready';
        ready = true;
        console.log('container-acceptance: session-ready');
        resolve();
      }
    };
  });

  const proxyClosed = new Promise<void>((resolve, reject) => {
    socket.onclose = (event: CloseEvent) => {
      if (loginTimer) clearInterval(loginTimer);
      if (!ready) {
        reject(
          new Error(
            `container-acceptance: socket closed before session was ready (${event.code})`,
          ),
        );
        return;
      }
      if (event.reason !== 'Server restarting') {
        reject(
          new Error(
            `container-acceptance: unexpected close ${event.code}: ${event.reason}`,
          ),
        );
        return;
      }
      console.log('container-acceptance: proxy-closed');
      resolve();
    };
  });

  await withTimeout(sessionReady, 10_000, 'real session');
  await withTimeout(proxyClosed, 15_000, 'graceful proxy close');
};

await exerciseCaLoader();
await exerciseSession();
