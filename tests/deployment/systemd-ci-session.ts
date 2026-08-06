/**
 * One session through the systemd-managed service to the mock MUD.
 *
 * Deliberately small. `run-systemd-acceptance.sh` drives fifty sessions and a
 * sustained load window because it is proving a production host; this only has
 * to answer "does a session work at all", which is what breaks when the
 * release layout or unit is wrong.
 */
const wsPort = Number(process.argv[2] ?? 6200);
const mudPort = Number(process.argv[3] ?? 6455);

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ws = new WebSocket(`ws://127.0.0.1:${wsPort}/`);
const frames: string[] = [];

await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('open timeout')), 10_000);
  ws.onopen = () => {
    clearTimeout(timer);
    resolve();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    reject(new Error('socket error'));
  };
});

ws.onmessage = (ev) => frames.push(String(ev.data));
ws.send(JSON.stringify({ type: 'connect', host: '127.0.0.1', port: mudPort }));
await wait(3000);

const typed = frames.flatMap((f) => {
  try {
    return [JSON.parse(f) as Record<string, unknown>];
  } catch {
    return [];
  }
});

const session = typed.find((m) => m.type === 'session');
if (!session) {
  console.error(
    `systemd-ci-session: no session envelope. Frames: ${JSON.stringify(typed).slice(0, 400)}`,
  );
  process.exit(1);
}

ws.send(JSON.stringify({ type: 'input', text: 'tester\r\n' }));
await wait(3000);

const data = typed
  .concat(
    frames.flatMap((f) => {
      try {
        return [JSON.parse(f) as Record<string, unknown>];
      } catch {
        return [];
      }
    }),
  )
  .filter((m) => m.type === 'data');

if (data.length === 0) {
  console.error('systemd-ci-session: session established but no MUD output');
  process.exit(1);
}

console.log(
  `systemd-ci-session: session ok, ${data.length} data frame(s) from the MUD`,
);
ws.close();
process.exit(0);
