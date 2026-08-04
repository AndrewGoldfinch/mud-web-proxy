# MWP-134 Legacy Required-TLS Fail-Closed Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reject legacy clients before any upstream dial when
`MUD_TLS_MODE=required`, with a process regression that proves the exact
fail-open existed and is closed.

**Architecture:** Add one early policy guard to the live legacy connect entry
point and leave both upstream transport implementations unchanged. Extend the
plaintext E2E mock with a cumulative accepted-connection counter, then use a
dedicated required-mode proxy to prove that legacy is rejected before dialing
while typed sessions still reach their own TLS transport.

**Tech Stack:** TypeScript, Bun 1.3.14, Bun test runner, Node-compatible
`net.Server`, native Bun `WebSocket`, Git, GitHub CLI.

## Global Constraints

- Implement only MWP-134. MWP-135 owns legacy TLS support and the shared
  transport connector.
- The required-mode guard must be the first operation inside
  `srv.openLegacyConnection()`, before the duplicate guard, authorization,
  capacity reservation, DNS resolution, or `srv.initT()`.
- Use this exact client-facing reason:
  `Legacy connections are unavailable when MUD_TLS_MODE=required.`
- `MUD_TLS_MODE=plain` and `MUD_TLS_MODE=prefer` legacy behavior must remain
  unchanged; `prefer` still opens plaintext without a TLS attempt in this PR.
- Do not modify `srv.initT()`, `Session`, `SessionIntegration`, target policy,
  capacity accounting, configuration, or operator documentation.
- Do not remove or repair the production-dead `srv.newSocket()` helper.
- The red run is valid only when the first failed assertion shows the mock's
  cumulative accepted-connection count increased on current code. A target
  rejection, timeout, or unrelated error is not proof of the defect.
- The repository-level verification command is only
  `bun run preflight:full`; do not hand-copy its evolving CI gate list.
- Release wording must say this closes the legacy fail-open in `required`
  mode. It must not claim that legacy TLS or `prefer` TLS-first behavior is
  implemented.

---

## File map

- `tests/e2e/mock-mud.ts`: own and expose the cumulative number of TCP
  connections accepted by a mock server instance.
- `tests/e2e/legacy-protocol.test.ts`: reproduce the legacy required-mode
  plaintext dial, verify the rejection contract, and prove typed requests do
  not enter the legacy guard.
- `wsproxy.ts`: add the single early required-mode legacy rejection.
- `docs/superpowers/specs/2026-08-04-mwp-134-legacy-required-fail-closed-design.md`:
  approved design; read-only during implementation.

---

### Task 1: Reproduce and close the required-mode legacy fail-open

**Files:**

- Modify: `tests/e2e/mock-mud.ts:93-104,208,749-765`
- Modify: `tests/e2e/legacy-protocol.test.ts:15-59,280`
- Modify: `wsproxy.ts:2306-2321`
- Test: `tests/e2e/legacy-protocol.test.ts`

**Interfaces:**

- Produces:
  `MockMUDServer.getAcceptedConnectionCount(): number`
- Consumes:
  `startTestProxy(port, { TN_HOST, TN_PORT, MUD_TLS_MODE })`
- Consumes:
  `srv.rejectLegacy(socket, reason): void`
- Does not change any production interface.

- [ ] **Step 1: Add cumulative accepted-connection observation to the mock**

Add the field beside `receivedCommands` in `MockMUDServer`:

```typescript
private acceptedConnectionCount = 0;
```

Make the first statement of `handleConnection()` increment it, before the
client identifier is created or the socket is inserted into `clients`:

```typescript
private handleConnection(socket: net.Socket): void {
  this.acceptedConnectionCount += 1;
  const clientId = `${socket.remoteAddress}:${socket.remotePort}`;
```

Add this public accessor beside `getClientCount()`:

```typescript
public getAcceptedConnectionCount(): number {
  return this.acceptedConnectionCount;
}
```

Do not decrement or reset the field in disconnect handling or `stop()`.
`getClientCount()` must continue returning `this.clients.size`.

- [ ] **Step 2: Add exact required-mode test constants and JSON parsing**

Add dedicated ports and the approved message near the existing constants in
`tests/e2e/legacy-protocol.test.ts`:

```typescript
const REQUIRED_PROXY_PORT = 6325;
const REQUIRED_MUD_PORT = 6326;
const LEGACY_REQUIRED_REJECTION =
  'Legacy connections are unavailable when MUD_TLS_MODE=required.';
```

Add a small parser after `decodeLegacy()` for the typed-path assertion:

```typescript
const parseJsonFrames = (frames: string[]): Array<Record<string, unknown>> =>
  frames.flatMap((frame) => {
    try {
      return [JSON.parse(frame) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
```

- [ ] **Step 3: Write the process-level legacy regression before the fix**

Insert a new describe block after the existing plain legacy suite and before
the shared-secret suite. It must construct its own mock/proxy pair because
`startMockMUDTest()` cannot pass the required environment overrides:

```typescript
describe('legacy connect under required MUD TLS', () => {
  let mock: ReturnType<typeof createIREMUD>;
  let proxy: Awaited<ReturnType<typeof startTestProxy>>;
  let mudPort: number;

  beforeAll(async () => {
    mock = createIREMUD();
    (mock as unknown as { config: { port: number } }).config.port =
      REQUIRED_MUD_PORT;
    mudPort = portOf(mock);
    await mock.start();
    proxy = await startTestProxy(REQUIRED_PROXY_PORT, {
      TN_HOST: 'localhost',
      TN_PORT: mudPort.toString(),
      MUD_TLS_MODE: 'required',
    });
  });

  afterAll(async () => {
    await proxy.stop();
    await mock.stop();
  });

  test('10. required mode rejects legacy before dialing upstream', async () => {
    const before = mock.getAcceptedConnectionCount();
    const ws = await openRaw(proxy.url);
    const frames = collect(ws);
    let closed = false;
    ws.onclose = () => {
      closed = true;
    };

    ws.send(JSON.stringify({ connect: 1, host: 'localhost', port: mudPort }));
    await settle();

    // Keep this first: the red run is valid only when this reports 1 vs 0.
    expect(mock.getAcceptedConnectionCount()).toBe(before);
    expect(decodeLegacy(frames)).toContain(LEGACY_REQUIRED_REJECTION);
    expect(closed).toBe(true);
  });
```

The target in the frame must exactly match `TN_HOST` and `TN_PORT`. The proxy
launcher forces `TARGET_MODE=fixed`; using its default `aardmud.org:4000`
would make target policy reject before the code under test.

- [ ] **Step 4: Add the typed-path discriminator before production code**

Add this second case inside the same describe block:

```typescript
test('11. required mode still routes typed connects through TLS', async () => {
  const before = mock.getAcceptedConnectionCount();
  const ws = await openRaw(proxy.url);
  const frames = collect(ws);

  ws.send(
    JSON.stringify({
      type: 'connect',
      host: 'localhost',
      port: mudPort,
      deviceToken: 'required-typed-path',
    }),
  );

  const deadline = Date.now() + 5000;
  let errorFrame: Record<string, unknown> | undefined;
  while (Date.now() < deadline && !errorFrame) {
    errorFrame = parseJsonFrames(frames).find(
      (frame) => frame.type === 'error' && frame.code === 'connection_failed',
    );
    if (!errorFrame) await settle(100);
  }

  expect(errorFrame).toMatchObject({
    type: 'error',
    code: 'connection_failed',
  });
  expect(decodeLegacy(frames)).not.toContain(LEGACY_REQUIRED_REJECTION);
  expect(mock.getAcceptedConnectionCount()).toBeGreaterThan(before);
  ws.close();
  await settle();
}, 10000);
```

Do not assert the TLS library's diagnostic text. The stable contract is the
typed `connection_failed` code; the plaintext mock intentionally cannot
produce a successful required-mode typed connection.

- [ ] **Step 5: Run only the legacy regression and verify the red reason**

Run:

```bash
bun test tests/e2e/legacy-protocol.test.ts \
  -t '10. required mode rejects legacy before dialing upstream'
```

Expected: FAIL at
`expect(mock.getAcceptedConnectionCount()).toBe(before)`, with the received
count exactly one greater than `before`. Stop and fix the test setup if it
fails on target policy, timeout, missing text, socket state, or any other
reason.

- [ ] **Step 6: Add the minimal fail-closed production guard**

At the beginning of `srv.openLegacyConnection()`, before the existing
`s.ts || sessionIntegration.hasSession(s)` condition, add only:

```typescript
if (runtimeConfig.mudTlsMode === 'required') {
  srv.rejectLegacy(
    s,
    'Legacy connections are unavailable when MUD_TLS_MODE=required.',
  );
  return;
}
```

Do not add a second check in `initT()` and do not alter typed dispatch.

- [ ] **Step 7: Run the focused green checks**

Run the previously red test:

```bash
bun test tests/e2e/legacy-protocol.test.ts \
  -t '10. required mode rejects legacy before dialing upstream'
```

Expected: PASS; the accepted-connection count remains unchanged, the exact
legacy rejection is present, and the WebSocket is closed.

Run the typed discriminator:

```bash
bun test tests/e2e/legacy-protocol.test.ts \
  -t '11. required mode still routes typed connects through TLS'
```

Expected: PASS with a typed `connection_failed` error and an increased mock
accepted-connection count.

Run the complete process-level protocol file:

```bash
bun test tests/e2e/legacy-protocol.test.ts
```

Expected: every test passes. Existing plain-mode legacy framing, teardown,
authorization, and shared-secret behavior remain unchanged.

- [ ] **Step 8: Run the one authoritative repository preflight**

Run:

```bash
bun run preflight:full
```

Expected: all runnable local CI gates pass. A Docker skip is acceptable only
when the script reports that no Docker daemon is available; `secret-scan` is
the documented GitHub-only job. Any reported failure must be fixed before
commit.

- [ ] **Step 9: Review the surgical diff and commit**

Run:

```bash
git diff --check
git diff --stat
git diff -- tests/e2e/mock-mud.ts tests/e2e/legacy-protocol.test.ts wsproxy.ts
git status --short
```

Confirm that production changes consist only of the early guard and that no
tracked file outside the three planned implementation files changed.

Commit:

```bash
git add tests/e2e/mock-mud.ts tests/e2e/legacy-protocol.test.ts wsproxy.ts
git commit -m 'fix: fail closed for legacy required TLS (MWP-134)'
```

---

### Task 2: Publish the narrowly scoped fix PR and verify CI

**Files:**

- No file changes expected.

**Interfaces:**

- Consumes branch: `fix/mwp-134-legacy-required-fail-closed`
- Produces: one GitHub pull request targeting `main`
- Leaves MWP-134 `In Progress` until merge.

- [ ] **Step 1: Verify the committed branch before publishing**

Run:

```bash
git status --short --branch
git log --oneline --decorate origin/main..HEAD
git diff --check origin/main...HEAD
```

Expected: clean worktree; the two design commits plus one implementation
commit; no whitespace errors.

- [ ] **Step 2: Push the branch**

Run:

```bash
git push -u origin fix/mwp-134-legacy-required-fail-closed
```

- [ ] **Step 3: Create the PR with exact security scope**

Use title:

```text
fix: fail closed for legacy required TLS (MWP-134)
```

Use this body:

```markdown
## What it does

Closes the legacy connection fail-open when `MUD_TLS_MODE=required`.
Legacy clients are now rejected before target authorization or any upstream
dial instead of silently sending MUD traffic over plaintext.

Adds process-level coverage proving:

- the client receives the exact legacy-framed rejection;
- the WebSocket closes;
- the plaintext mock MUD accepts zero upstream connections;
- typed required-mode connects still reach their existing TLS transport and
  report `connection_failed`.

## Scope

This does **not** add TLS support to legacy connections. Until MWP-135 lands:

- `prefer` continues to send legacy traffic over plaintext without a TLS
  attempt;
- `plain` remains unchanged;
- `required` rejects legacy clients even when the target MUD supports TLS.

Release note: Fail closed for legacy connections when
`MUD_TLS_MODE=required`; legacy TLS support and `prefer`-mode TLS-first
behavior remain tracked separately.

## Verification

- Red proof: before the guard, the cumulative mock connection assertion failed
  with one accepted plaintext connection.
- `bun test tests/e2e/legacy-protocol.test.ts`
- `bun run preflight:full`

Closes MWP-134.
Follow-up: MWP-135.
```

- [ ] **Step 4: Verify GitHub CI and report the handoff**

Run:

```bash
bun run ci:status
```

The command infers the PR from the current branch. Expected: exit 0 with all
GitHub checks green. If a job fails, inspect the printed logs, reproduce and
fix the failure on this branch, rerun `bun run preflight:full`, push the fix,
and poll CI again.

Add the PR URL and verified red/green evidence to MWP-134. Do not mark the
issue complete before merge. Report separately that MWP-112 remains blocked
by MWP-135 after this PR.
