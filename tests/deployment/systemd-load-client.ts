import { z } from 'zod';

/** The proxy frames this client reacts to, by the fields it reacts on. */
const loadFrameSchema = z.looseObject({
  type: z.string().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  payload: z.string().optional(),
});

import { readFileSync } from 'fs';
import WebSocket, { type RawData } from 'ws';
import {
  spansSustainedInterval,
  type SustainedActivity,
} from './systemd-load-activity';

const sessionCount = Number(process.env.SESSION_COUNT ?? '50');
const sustainMs = Number(process.env.SUSTAIN_MS ?? '60000');
const wsUrl = process.env.PROXY_WS_URL ?? 'wss://localhost';
const mudHost = process.env.MUD_HOST ?? 'mwp-mud.test';
const mudPort = Number(process.env.MUD_PORT ?? '6300');

const fail = (message: string): never => {
  throw new Error(`systemd-load-client: ${message}`);
};

if (!Number.isInteger(sessionCount) || sessionCount < 1) {
  fail('SESSION_COUNT must be a positive integer');
}
if (!Number.isFinite(sustainMs) || sustainMs < 0) {
  fail('SUSTAIN_MS must be a non-negative number');
}
if (!Number.isInteger(mudPort) || mudPort < 1 || mudPort > 65_535) {
  fail('MUD_PORT must be a valid port');
}

const caPath = process.env.CADDY_CA_PATH?.trim();
if (!caPath) fail('missing CADDY_CA_PATH');
const ca = readFileSync(caPath);

const withTimeout = async <T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`systemd-load-client: timeout: ${label}`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const delay = async (milliseconds: number): Promise<void> =>
  await new Promise((resolve) => setTimeout(resolve, milliseconds));

interface LoadSession {
  socket: WebSocket;
  ready: Promise<void>;
  closed: Promise<void>;
  startTraffic: () => void;
  finishTraffic: () => void;
}

const createSession = (
  index: number,
  reportFatal: (error: Error) => void,
): LoadSession => {
  const socket = new WebSocket(wsUrl, {
    ca,
    rejectUnauthorized: true,
  });
  let phase:
    | 'opening'
    | 'login'
    | 'ready'
    | 'sustaining'
    | 'awaiting-shutdown'
    | 'closed' = 'opening';
  let readySettled = false;
  let closeSettled = false;
  const activity: SustainedActivity = { startedAt: 0 };
  let loginTimer: ReturnType<typeof setInterval> | undefined;
  let trafficTimer: ReturnType<typeof setInterval> | undefined;
  let rejectReady: (error: Error) => void = () => {};
  let rejectClosed: (error: Error) => void = () => {};

  const clearIntervals = (): void => {
    if (loginTimer) {
      clearInterval(loginTimer);
      loginTimer = undefined;
    }
    if (trafficTimer) {
      clearInterval(trafficTimer);
      trafficTimer = undefined;
    }
  };

  const rejectUnsettled = (error: Error): void => {
    reportFatal(error);
    if (!readySettled) {
      readySettled = true;
      rejectReady(error);
    }
    if (!closeSettled) {
      closeSettled = true;
      rejectClosed(error);
    }
  };

  const ready = new Promise<void>((resolve, reject) => {
    rejectReady = reject;
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
      rejectUnsettled(
        new Error(`systemd-load-client: session ${index} error: ${error}`),
      );
    });

    socket.on('message', (data: RawData) => {
      const message = loadFrameSchema.parse(JSON.parse(data.toString()));
      if (message.type === 'error') {
        rejectUnsettled(
          new Error(
            `systemd-load-client: session ${index} proxy error ${message.code}: ${message.message}`,
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
              text: `systemd-load-${index}\r\n`,
            }),
          );
        }, 250);
        return;
      }
      if (message.type !== 'data' || !message.payload) return;

      const text = Buffer.from(message.payload, 'base64').toString('utf8');
      // eslint-disable-next-line no-control-regex -- matching ANSI on purpose
      const plainText = text.replace(/\x1b\[[0-9;]*m/g, '');
      if (phase === 'sustaining' && plainText.includes(`look ${index}`)) {
        const now = performance.now();
        activity.firstInboundAt ??= now;
        activity.lastInboundAt = now;
      }
      if (plainText.includes('Welcome to the Mock MUD!')) {
        if (readySettled) {
          rejectUnsettled(
            new Error(
              `systemd-load-client: session ${index} duplicate ready resolution`,
            ),
          );
          return;
        }
        if (phase !== 'login') {
          rejectUnsettled(
            new Error(
              `systemd-load-client: session ${index} welcome before login`,
            ),
          );
          return;
        }
        if (loginTimer) {
          clearInterval(loginTimer);
          loginTimer = undefined;
        }
        phase = 'ready';
        readySettled = true;
        resolve();
      }
    });
  });

  const closed = new Promise<void>((resolve, reject) => {
    rejectClosed = reject;
    socket.on('close', (code: number, reasonBuffer: Buffer) => {
      clearIntervals();
      if (closeSettled) {
        const error = new Error(
          `systemd-load-client: session ${index} duplicate close resolution`,
        );
        reportFatal(error);
        reject(error);
        return;
      }
      closeSettled = true;
      const reason = reasonBuffer.toString();
      if (!readySettled || phase !== 'awaiting-shutdown') {
        const error = new Error(
          `systemd-load-client: session ${index} closed during ${phase} (${code})`,
        );
        if (!readySettled) {
          readySettled = true;
          rejectReady(error);
        }
        reject(error);
        return;
      }
      if (code !== 1001 || reason !== 'Server restarting') {
        reject(
          new Error(
            `systemd-load-client: session ${index} unexpected close ${code}: ${reason}`,
          ),
        );
        return;
      }
      phase = 'closed';
      resolve();
    });
  });

  return {
    socket,
    ready,
    closed,
    startTraffic: () => {
      if (phase !== 'ready' || trafficTimer) {
        rejectUnsettled(
          new Error(
            `systemd-load-client: session ${index} invalid sustained phase`,
          ),
        );
        return;
      }
      phase = 'sustaining';
      activity.startedAt = performance.now();
      const sendTraffic = (): void => {
        const now = performance.now();
        activity.firstOutboundAt ??= now;
        activity.lastOutboundAt = now;
        socket.send(
          JSON.stringify({
            type: 'input',
            text: `look ${index}\r\n`,
          }),
        );
      };
      sendTraffic();
      trafficTimer = setInterval(() => {
        sendTraffic();
      }, 1000);
    },
    finishTraffic: () => {
      if (trafficTimer) {
        clearInterval(trafficTimer);
        trafficTimer = undefined;
      }
      if (
        phase !== 'sustaining' ||
        !spansSustainedInterval(activity, performance.now(), sustainMs)
      ) {
        throw new Error(
          `systemd-load-client: session ${index} did not sustain bidirectional traffic`,
        );
      }
      phase = 'awaiting-shutdown';
    },
  };
};

let rejectFatal: (error: Error) => void = () => {};
const fatal = new Promise<never>((_resolve, reject) => {
  rejectFatal = reject;
});
void fatal.catch(() => {});

const sessions = Array.from({ length: sessionCount }, (_unused, index) =>
  createSession(index, rejectFatal),
);
const allClosed = Promise.all(sessions.map((session) => session.closed));
void allClosed.catch(() => {});

await withTimeout(
  Promise.race([Promise.all(sessions.map((session) => session.ready)), fatal]),
  20_000,
  'all sessions ready',
);
console.log(`systemd-load-client: ${sessionCount} sessions ready`);

for (const session of sessions) session.startTraffic();
await withTimeout(
  Promise.race([
    delay(sustainMs),
    allClosed.then(() => fail('all sessions closed during sustained phase')),
    fatal,
  ]),
  sustainMs + 20_000,
  'sustained traffic',
);
for (const session of sessions) session.finishTraffic();
console.log('systemd-load-client: sustained');

await withTimeout(
  Promise.race([allClosed, fatal]),
  20_000,
  'all sessions graceful close',
);
console.log('systemd-load-client: graceful-close-observed');
