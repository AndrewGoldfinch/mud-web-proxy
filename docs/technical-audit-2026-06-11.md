# Technical Audit — mud-web-proxy

**Date:** 2026-06-11
**Scope:** Full repository at commit `341aa30` (branch `claude/repo-technical-audit-xadcsf`)
**Method:** Full read of `wsproxy.ts` and all `src/` modules; sampled read of all 22 unit-test files, e2e harness, CI workflows, docs, and env/config files; verified locally with `bun install`, `bun run typecheck`, `bun run lint`, `bun run test`. No code was modified.

---

## Executive Summary

**Overall health: C+.** The new `src/` session layer is genuinely good — clean module boundaries, strict TypeScript that compiles clean, a green 477-test suite with real behavioral assertions, no committed secrets, and security-conscious defaults. What drags the grade down is everything around it: the 2,587-line `wsproxy.ts` entry point is a second, older implementation of the same telnet logic with **zero test coverage**, real bugs (telnet sockets are never closed on the legacy path), and an embedded 400-line HTML page; the CI test step references a script that does not exist, so the test gate has never been able to pass; and the project ships three contradictory license statements.

**Top 3 risks:**

1. CI's test step (`bun run test:unit`) can never pass, so nothing actually gates merges — the safety net is decorative (`.github/workflows/test.yml:18`).
2. `wsproxy.ts` is untested and carries correctness bugs: leaked telnet connections on client disconnect, negotiation parsing that misses sequences split across TCP chunks, and client-IP resolution that blindly trusts spoofable headers used for per-IP limits.
3. License is legally ambiguous (MIT vs GPL-3.0 vs a LICENSE file naming a different project), which blocks safe redistribution of an open-source project.

**Top 3 opportunities:**

1. ~15 minutes of CI fixes turns the existing 477-test suite into a real merge gate.
2. The well-tested `src/telnet-parser.ts` + `src/session.ts` path already does what the legacy `srv` path does, but correctly — consolidating onto it deletes ~1,500 lines of the riskiest code in the repo.
3. A short "bounded resources" hardening pass (caps on buffers, maps, and per-session client sets) removes most memory-growth exposure cheaply.

---

## Phase 1 — Repo Map

**Purpose.** WebSocket↔Telnet proxy for MUD game servers. Originally (v1, 2014) a thin browser-client bridge; v3.0 has evolved into the backend for an iOS client ("MUDBasher"): persistent sessions that survive client disconnects, replay buffers, Apple App Attest device authentication, and APNS push notifications.

**Stack.** TypeScript (ES2022, strict), Bun runtime + package manager, `ws`, `iconv-lite`, `cbor-x`. Built with esbuild to `dist/`, deployed via PM2 (`ecosystem.config.cjs`) by a GitHub Actions SSH workflow. Tests use `bun:test`.

**Architecture sketch.** Two parallel data paths coexist:

```
                         ┌─ legacy path (no `type` JSON): srv.parse → srv.forward →
WebSocket client ─ ws ───┤    srv.initT (net socket) → srv.sendClient (inline IAC scans) → client
  upgrade gate           │
  (origin, App Attest)   └─ session path ({type: connect|resume|input|...}):
                              SessionIntegration → SessionManager → Session
                              → TelnetParser (state machine) + CircularBuffer
                              → NotificationManager / BackgroundPushScheduler (APNS)
```

**Key directories/files:**

| Path                                                                                                                             | One-liner                                                                                                                |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `wsproxy.ts` (2,587 ln)                                                                                                          | Entry point: HTTP endpoints, WS upgrade auth, embedded diagnostic HTML page, _and_ the legacy `srv` proxy implementation |
| `src/session-integration.ts` (684 ln)                                                                                            | Bridge between WS messages and the session layer; the modern protocol's front door                                       |
| `src/session.ts`, `src/session-manager.ts`                                                                                       | Persistent telnet session + lifecycle/limits management                                                                  |
| `src/telnet-parser.ts` (447 ln)                                                                                                  | Proper state-machine telnet parser (handles chunk boundaries)                                                            |
| `src/app-attest.ts` (1,018 ln)                                                                                                   | Apple App Attest attestation/assertion verification                                                                      |
| `src/notification-manager.ts`, `src/background-push-scheduler.ts`                                                                | APNS over raw HTTP/2; push scheduling with backoff                                                                       |
| `src/circular-buffer.ts`, `src/trigger-matcher.ts`, `src/target-policy.ts`, `src/runtime-config.ts`, `src/protocol-constants.ts` | Supporting utilities (all small and focused)                                                                             |
| `tests/` (22 unit files, 477 tests) + `tests/e2e/`                                                                               | Unit suite over `src/`; e2e harness incl. a mock MUD server and per-MUD configs                                          |
| `docs/`                                                                                                                          | PRD, integration guides, and an honest self-audit (`open-source-readiness.md`)                                           |

**Surprises found during mapping:**

- CLAUDE.md and AGENTS.md both describe a "single-file application" — that stopped being true when `src/` (≈5,100 lines) was added.
- `docs/open-source-readiness.md` (dated 2026-05-11) already self-reports several findings of this audit (CI drift, license conflict, diagnostics exposure) — known issues, not yet fixed.
- Tests never import `wsproxy.ts`; several test files contain _re-implementations_ of `srv` methods and test the copy.

---

## Phase 2 — Audit Report

Severity legend: **[C]ritical / [H]igh / [M]edium / [L]ow**. Each finding marked **(fact)** — directly verified in code/runs — or **(judgment)**.

### 2.1 Architecture & design

**A1 [H] — Two competing implementations of the proxy's core job.** (fact + judgment)
`wsproxy.ts:2088-2347` (`srv.sendClient`) contains an inline telnet negotiation engine: ten separate `for` loops re-scanning every inbound buffer for IAC patterns. `src/telnet-parser.ts:44-176` is a second, modern state-machine implementation of the same concern, used only by the session path. Consequence: every protocol fix must be made twice, and only one of the two is tested. The legacy scanner also compares `data[i+1]`/`data[i+2]` past buffer ends and cannot recognize an IAC sequence split across two TCP chunks (fact: there is no carry-over state between `sendClient` calls), so negotiation can silently fail depending on packet boundaries — exactly the bug class the new parser fixes (`telnet-parser.ts:150-175`).

**A2 [H] — `wsproxy.ts` is a god file.** (fact)
One file holds: logging framework (`wsproxy.ts:84-124, 2357-2489`), a ~400-line embedded HTML+JS diagnostic dashboard as a template literal (`wsproxy.ts:462-865`), HTTP routing with four hand-rolled body-reading endpoints (`wsproxy.ts:1126-1571`), WS upgrade auth (`wsproxy.ts:1592-1767`), and the legacy proxy engine (`wsproxy.ts:1849-2556`). Consequence: the file is effectively unreviewable and untestable as a unit; this is where the bugs below live.

**A3 [M] — ~280 lines of copy-pasted endpoint code.** (fact)
`/debug/apns/test` (`wsproxy.ts:1166-1298`) and `/debug/apns/alert-test` (`wsproxy.ts:1299-1445`) are near-identical: same secret check, same body-size guard, same session/token resolution. The body-reading + size-limit pattern is duplicated a third time at `/attest/register` (`wsproxy.ts:1455-1472`).

**A4 [L] — Dead code: `srv.newSocket`.** (fact)
`wsproxy.ts:2514-2537` is never called from production code (grep confirms only tests reference it — and those tests re-implement it). It also attaches `net.Socket` events (`'data'`, `'end'`) to a WebSocket, which would never fire. Similarly, `srv.die()` tries to notify clients via `sock.write(...)` (`wsproxy.ts:2498-2505`), a method that doesn't exist on `ws` sockets — the guard makes it silently do nothing.

**Healthy:** the `src/` dependency graph is a clean DAG with no circular imports; module responsibilities (buffer, parser, policy, config) are well-factored.

### 2.2 Code quality & correctness

**Q1 [H] — Telnet sockets are never closed on the legacy path.** (fact)
`srv.closeSocket` (`wsproxy.ts:2051-2086`) logs "closing telnet socket" then calls `s.terminate()` — which is the _WebSocket_ close (`wsproxy.ts:1811`). No call to `s.ts.end()`/`s.ts.destroy()` exists anywhere in `wsproxy.ts` (grep-verified). Consequence: when a non-session browser client disconnects, the proxy's TCP connection to the MUD stays open until the MUD times it out; under reconnect churn this accumulates ghost connections (and ghost characters in-game). The session path does this correctly (`src/session.ts:429-457`).

**Q2 [M] — Client→MUD data is force-transcoded to latin1.** (fact + judgment)
`s.ts.send` runs every payload through `iconv.encode(data as string, 'latin1')` (`wsproxy.ts:1991`), and `srv.forward` first does `d.toString()` (UTF-8) (`wsproxy.ts:2554`). Consequence: non-latin1 input (CJK, emoji, even smart quotes) is mangled before reaching the MUD, despite the proxy advertising UTF-8 support in negotiation (`wsproxy.ts:2300-2321`). The `as string` cast on a possible Buffer also hides a type error.

**Q3 [M] — MCCP handling mutates the buffer mid-iteration.** (fact)
In `sendClient`, on finding `IAC SB MCCP2` the code does `data = data.slice(i + 5)` and continues the same loop with stale indices (`wsproxy.ts:2117-2129`), assuming a fixed 5-byte sequence and that nothing precedes/follows in awkward positions. (judgment) This works for the common case and corrupts the stream for edge cases.

**Q4 [M] — Version constant duplicated.** (fact)
`PACKAGE_VERSION = '3.0.0'` hardcoded at `wsproxy.ts:185` alongside `package.json:3` — they will drift.

**Q5 [L] — `parse()` double-parses every JSON message.** (fact)
`srv.parse` JSON-parses each `{`-prefixed message (`wsproxy.ts:1849-1870`) and `SessionIntegration.parseNewMessage` parses it again (`src/session-integration.ts:178`). Minor CPU waste; also `JSON.parse` failures are silently treated as "raw MUD input", which is intended but undocumented behavior.

**Q6 [M] — App Attest authData parsing lacks bounds checks.** (fact, from module review)
`src/app-attest.ts:64-70` and `:92-97` read fixed offsets (32/33/37/53/55) and `credIdStart + credIdLen` from attacker-supplied buffers without verifying buffer length first; short/truncated buffers yield silent zero-reads or truncated `subarray` results rather than a clean rejection.

### 2.3 Security

Context: the proxy defaults are sensible — `ONLY_ALLOW_DEFAULT_SERVER=true`, diagnostics 404 unless a token is configured and matched timing-safely (`src/runtime-config.ts:133-157`), single-use nonces (`src/app-attest.ts:34`), body-size limits on POST endpoints, no secrets committed (all `.env.*` files in the repo are credential-free templates; `config/apple-app-attest-root-ca.pem` is Apple's public root CA).

**S1 [H] — Client IP from spoofable headers feeds security controls.** (fact)
`getClientIP` (`wsproxy.ts:195-205`) unconditionally trusts `X-Real-IP`/`X-Forwarded-For` with no trusted-proxy allowlist. That value is used for the per-IP session cap (`maxPerIP: 10`, `wsproxy.ts:136`) and is _sent to the MUD_ as the player's IP via GMCP `client_ip`, MSDP `CLIENT_IP`, and NEW-ENV `IPADDRESS` (`wsproxy.ts:2179, 2195, 2249`). Consequence: any client connecting directly to the exposed port (the deploy listens publicly; PM2/no fronting proxy is implied by `ecosystem.config.cjs`) can bypass IP limits and spoof arbitrary IPs to the MUD's ban/ident systems.

**S2 [M] — TLS→plaintext downgrade decided by error-string matching.** (fact)
`src/session.ts:88-99` tries TLS to the MUD and falls back to plain TCP if the error message _looks_ SSL-ish. (judgment) An active attacker can force the downgrade; given most MUDs are plaintext telnet anyway this is Medium, but the fallback should at least be policy-controlled per target.

**S3 [M] — Unbounded attacker-influenceable memory.** (fact, cluster)

- `subnegBuffer` in the parser accumulates a subnegotiation with no size cap (`src/telnet-parser.ts:66`) — a hostile/compromised MUD can hold IAC SB open and stream megabytes.
- `attestedKeys` grows per registration with no eviction (`src/app-attest.ts:953`); `/attest/challenge` and `/attest/register` have no rate limiting (`wsproxy.ts:1157-1165`).
- A session's `clients` Set has no cap (`src/session.ts:39`), so one device looping reconnects bloats broadcast fan-out.

**S4 [L] — Non-constant-time secret comparison on APNS debug endpoints.** (fact)
`provided !== apnsTestSecret` (`wsproxy.ts:1180, 1314`) vs. the timing-safe comparison used for the diagnostic token. Low impact (high-entropy secret, noisy channel) but inconsistent.

**S5 [L] — IPv6 targets mis-parsed in allowlist.** (fact)
`parseAllowedTargets` splits host:port on `lastIndexOf(':')` (`src/target-policy.ts:41`), which breaks for `[::1]:4000`-style entries; invalid entries are dropped silently with no startup warning.

### 2.4 Testing

**T1 [C] — The CI test gate cannot pass.** (fact)
`.github/workflows/test.yml:18` runs `bun run test:unit`; `package.json:13-28` defines no such script (`test`, `test:e2e`, `test:mock` exist). Every PR's test job fails regardless of code quality, which trains everyone to ignore CI. (`docs/open-source-readiness.md` flagged this a month ago.)

**T2 [H] — The entry point has zero test coverage, and some tests test a copy of it.** (fact)
No test imports `wsproxy.ts` (it doesn't even appear in the coverage report). Worse, `tests/socket-management.test.ts:124` and `tests/security.test.ts:131` define their _own_ `newSocket`/`srv` mock implementations and assert against those — they verify the test's copy, not the production code. Consequence: bugs Q1–Q3 above live precisely in the untested file, and the negotiation tests (`telnet-negotiation-part1/2.test.ts`) give false confidence.

**T3 [M] — Coverage holes in core modules.** (fact, from local run)
Overall 63.96% lines / 64.94% funcs. `src/telnet-parser.ts` **1.18%** lines (no dedicated test file for the state machine that all session traffic flows through); `src/notification-manager.ts` **8.69%**; `src/session-integration.ts` 54%. No coverage threshold is enforced anywhere.

**Healthy:** the 477 tests that exist are real behavioral tests (e.g., `tests/circular-buffer.test.ts:34-47` asserts sequence monotonicity; `tests/open-source-regressions.test.ts:72-94` asserts target-policy rejections), use mocks instead of real networks, and the e2e harness with a mock MUD (`tests/e2e/mock-mud.ts`, `USE_MOCK_MUD=auto`) is a strong foundation.

### 2.5 Performance

**P1 [M] — Legacy negotiation rescans every buffer up to 10×.** (fact)
Until all flags settle (or the 12 s timeout at `wsproxy.ts:2009-2021` force-sets them), each inbound chunk is scanned by up to ten sequential loops (`wsproxy.ts:2105-2321`). (judgment) Tolerable at MUD bandwidths; it's a smell, not a bottleneck.

**P2 [L] — `srv.log` does session lookups and env reads per log line.** (fact)
`getLogLevel()` re-reads `process.env` and `findByWebSocket` runs per call (`wsproxy.ts:2363, 2380`). At INFO verbosity with per-byte protocol logging, this adds avoidable overhead.

Otherwise healthy: zlib deflate is async with a closed-socket guard (`wsproxy.ts:2337-2346`), the circular buffer is O(1) (`src/circular-buffer.ts:92-95`).

### 2.6 Dependencies

Healthy in one sentence each: only 3 runtime deps (`ws`, `iconv-lite`, `cbor-x`), all actively maintained, all within one minor of latest (`bun outdated` verified; no known-CVE versions spotted); `bun.lock` is committed. **[L]** `@types/uglify-js` and `uglify-js` remain in devDependencies (`package.json:43,57`) with no references in the codebase — leftovers. (fact)

### 2.7 DevEx & operations

**D1 [M] — Deploy workflow is hardcoded and unvalidated.** (fact)
`.github/workflows/deploy.yml:14,19` hardcodes the production hostname and deploy path; deploy is `git pull` + `pm2 startOrRestart` with no post-deploy health check (a `/health` endpoint exists and is unused here) and no rollback. Acceptable for a single-operator hobby service (judgment), but one bad push silently takes the service down.

**D2 [L] — No `uncaughtException`/`unhandledRejection` handlers.** (fact)
Signals are handled (`wsproxy.ts:2561-2577`) but a stray throw in a callback kills the process; PM2 restart masks it at the cost of dropping all live sessions.

Local DevEx is otherwise good: `bun install && bun run typecheck && bun run lint && bun run test` all pass cleanly in a fresh clone (verified), and scripts are well-organized.

### 2.8 Documentation & licensing

**L1 [H] — Three-way license contradiction.** (fact)
`wsproxy.ts:11` says "License: MIT"; `package.json:34` says `gpl-3.0` (also not a valid SPDX identifier — should be `GPL-3.0-only`/`-or-later`); `LICENSE.md:1` is GPL-3 text titled for a _different project_ ("mud-web-client"). For a public fork of GPL-licensed work this is a real legal problem, not pedantry.

**L2 [M] — CLAUDE.md/AGENTS.md describe a codebase that no longer exists.** (fact)
Both claim "Single-file TypeScript application (`wsproxy.ts`)" (CLAUDE.md project-overview; AGENTS.md:51) and neither mentions `src/` (≈5,100 lines), sessions, App Attest, or APNS. These files steer AI-assisted development — inaccuracy here actively causes wrong changes.

**L3 [M] — README configuration section is stale.** (fact)
README.md:66 says "In `wsproxy.ts` you can change the following options" and shows an editable config object; actual configuration is env-driven through `src/runtime-config.ts`, and the env-var table (README.md:85-90) covers 4 of the ~25 supported variables (APNS__, APPATTEST__, ALLOWED_ORIGINS, ALLOWED_TARGETS, REQUIRE_APP_AUTH, etc., are documented only in `.env.example`).

**Strength:** `docs/` is unusually rich for a project this size — PRD, iOS integration guide, session protocol guide, mock-MUD guide, and a candid self-audit. The bones of great docs exist; they need reconciliation, not creation.

### 2.9 Strengths (what to preserve)

1. **The `src/` session layer design** — clean DAG, single-responsibility modules, a correct chunk-boundary-aware telnet parser, O(1) replay buffer.
2. **Test culture for new code** — 477 green behavioral tests, mock infrastructure, e2e harness with mock MUD and real-MUD configs.
3. **Security posture by default** — locked-down target policy, timing-safe diagnostic auth, single-use nonces, request body caps, password-mode log redaction (`wsproxy.ts:2542-2552`), secret-free repo.
4. **Strict tooling** — strict tsconfig (clean), ESLint+Prettier (clean), modern Bun workflow.
5. **Self-awareness** — `docs/open-source-readiness.md` shows the team already knows where the bodies are buried.

---

## Phase 3 — Improvement Strategy

### Theme 1: One proxy, not two (explains A1, A2, Q1–Q3, T2, P1)

Most correctness risk comes from the untested legacy `srv` path duplicating what `src/` already does well. **Target state:** all traffic — including plain browser clients — flows through `SessionIntegration`/`Session`/`TelnetParser`; `wsproxy.ts` shrinks to bootstrap, HTTP routing, and upgrade auth (< ~600 lines). **Principle:** delete the worse of two implementations rather than fixing it twice.

### Theme 2: Make the safety net real (explains T1–T3, D1)

A good test suite exists but nothing enforces it. **Target state:** CI green and required on PRs; coverage thresholds enforced; at least one boot-the-real-binary smoke test so `wsproxy.ts` regressions are caught; deploy verifies `/health` after restart. **Principle:** an unenforced check is a suggestion.

### Theme 3: Explicit trust boundaries and bounded resources (explains S1–S3, Q6)

The proxy sits between three untrusted parties (browser/app, network middleboxes, the MUD) and currently extends implicit trust to each in places. **Target state:** proxy headers honored only when `TRUST_PROXY` is configured; every attacker-growable structure (subneg buffer, key store, client sets, challenge endpoints) has a cap or rate limit; binary parsers validate lengths before reads. **Principle:** every input gets a budget.

### Theme 4: Tell the truth in metadata (explains L1–L3, Q4, D1)

License, docs, and agent-instruction files contradict the code. **Target state:** one license everywhere; CLAUDE.md/AGENTS.md/README describe the modular reality; version read from package.json. **Principle:** docs that lie are worse than no docs — especially the ones LLM tooling reads.

### Explicitly NOT recommending

- **Rewriting the legacy negotiation engine in place** — migration to the existing parser (Theme 1) makes that work disposable.
- **Framework adoption (Express/Fastify), metrics/tracing stacks, containerization** — single-operator hobby-scale service; PM2 + `/health` + good logs are proportionate.
- **Hardening the APNS HTTP/2 response handling beyond basics or "authenticating" APNS responses** — TLS to Apple is sufficient; effort outweighs risk.
- **Chasing 90%+ coverage on `app-attest.ts`'s exhaustive verifier** — it's defensive by design and well-logged; bounds-check fixes (Q6) suffice.

### Definition of done (measurable)

- CI: required PR check, green, running typecheck + lint + the real test script; coverage gate ≥ 70% lines overall and ≥ 80% for `src/telnet-parser.ts` and `src/session*.ts`.
- `wsproxy.ts` < 600 lines; zero duplicated telnet negotiation logic; `grep -c "newSocket" wsproxy.ts` → 0.
- Zero High findings from this report open; license identical in all three locations.
- Soak check: open/close 100 legacy connections against the mock MUD → 0 lingering telnet sockets (`lsof` or mock-server connection count).

---

## Phase 4 — Task Plan

### Milestone 0 — Safety net

| #   | Task                                                                                                                                                                                                                                                                                                                                        | Files                                             | Acceptance criteria                                             | Effort | Risk            | Deps |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------- | ------ | --------------- | ---- |
| 0.1 | **Fix CI test script.** Change `test:unit` to `test` (or add the alias).                                                                                                                                                                                                                                                                    | `.github/workflows/test.yml:18` or `package.json` | CI test job passes on a no-op PR                                | **S**  | None            | —    |
| 0.2 | **Enforce coverage + make CI required.** Add `--coverage-threshold` (bun supports thresholds via config) at current levels (~63%) so it can only ratchet up; mark workflow as required branch check.                                                                                                                                        | `package.json`, repo settings, `test.yml`         | PR with coverage drop fails CI                                  | **S**  | None            | 0.1  |
| 0.3 | **Boot-smoke e2e in CI.** Run the existing mock-MUD e2e (`tests/e2e/mock-mud.test.ts` via `proxy-launcher.ts`, `DISABLE_TLS=1`) in the workflow so `wsproxy.ts` is actually executed pre-merge.                                                                                                                                             | `test.yml`, `tests/e2e/*`                         | CI fails if the proxy can't boot and round-trip data            | **M**  | Low (test-only) | 0.1  |
| 0.4 | **Legacy-path regression tests.** Add tests that import the real `wsproxy.ts` exports (`writeTelnet`, types) and an e2e covering legacy (non-session) connect/disconnect, asserting the mock MUD sees its socket closed. This pins behavior before refactoring and will initially _fail_ on the Q1 leak — written as the spec for task 1.1. | `tests/e2e/`, new test file                       | Test exists, runs in CI, documents current vs intended behavior | **M**  | Low             | 0.3  |

### Milestone 1 — Critical & correctness fixes

| #   | Task                                                                                                                                                                                                 | Files                                                                                       | Acceptance criteria                                                                 | Effort | Risk                                                                                | Deps           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- | -------------- |
| 1.1 | **Close telnet sockets in `closeSocket`.** Destroy `s.ts` (and null it) on the legacy path; keep the double-close guards.                                                                            | `wsproxy.ts:2051-2086`                                                                      | Task 0.4's leak test passes; soak check shows 0 lingering sockets                   | **S**  | Low                                                                                 | 0.4            |
| 1.2 | **Resolve the license.** Owner decides (GPL-3.0 is almost certainly required given fork lineage from maldorne/mud-web-proxy). Fix header, SPDX id, and LICENSE.md title to match.                    | `wsproxy.ts:11`, `package.json:34`, `LICENSE.md`                                            | One license, three consistent files                                                 | **S**  | None                                                                                | Owner decision |
| 1.3 | **Trusted-proxy gating for client IP.** Add `TRUST_PROXY` env (off by default, or CIDR list); `getClientIP` uses headers only when the socket peer is trusted. Document in `.env.example`.           | `wsproxy.ts:195-205`, `src/runtime-config.ts`, `.env.example`                               | With flag off, spoofed `X-Forwarded-For` is ignored in limits/logs/GMCP; test added | **M**  | Medium (could mis-log real deploys behind nginx — coordinate with owner's topology) | —              |
| 1.4 | **Bounds-check App Attest buffer parsing.** Validate minimum lengths before offset reads in `parseAttestationAuthData`/`parseAssertionAuthData`; reject cleanly.                                     | `src/app-attest.ts:64-97`                                                                   | Fuzz-ish unit tests with truncated buffers → clean errors, no silent acceptance     | **S**  | Low                                                                                 | —              |
| 1.5 | **Resource caps.** Max subnegotiation size (e.g., 256 KB) in the parser; cap `clients` per session; basic rate limit on `/attest/challenge` + `/attest/register`; size cap on `attestedKeys` writes. | `src/telnet-parser.ts:66`, `src/session.ts:39`, `wsproxy.ts:1157,1455`, `src/app-attest.ts` | Unit tests for each cap; oversize input → logged rejection, no growth               | **M**  | Low                                                                                 | —              |

### Milestone 2 — High-leverage improvements

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                          | Files                                                        | Acceptance criteria                                                                                   | Effort | Risk                                                                                                                                                 | Deps                 |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 2.1 | **Extract the diagnostic dashboard.** Move HTML/JS to `static/diagnostic.html` read at startup (or build-embedded); `wsproxy.ts` just serves it.                                                                                                                                                                                                                                                                                              | `wsproxy.ts:462-865` → new file                              | Behavior identical; wsproxy.ts ~400 lines lighter                                                     | **M**  | Low                                                                                                                                                  | 0.3                  |
| 2.2 | **Deduplicate APNS debug endpoints + body reader.** One `readJsonBody(req, maxSize)` helper; one parameterized push-test handler.                                                                                                                                                                                                                                                                                                             | `wsproxy.ts:1166-1471`                                       | Both endpoints behave identically to before; ~200 lines removed                                       | **S**  | Low                                                                                                                                                  | 0.3                  |
| 2.3 | **Route legacy clients through the session layer.** Treat a legacy connection as an anonymous, non-resumable session: `SessionIntegration` gains a "transient" mode; delete `srv.sendClient`/`initT`/`forward`/`newSocket` and the inline negotiation. This is the keystone task — break it down (XL): (a) transient session mode, (b) base64/compression output parity for web clients, (c) cutover behind env flag, (d) delete legacy code. | `wsproxy.ts`, `src/session-integration.ts`, `src/session.ts` | Mock-MUD e2e passes for legacy clients; negotiation handled by `TelnetParser`; wsproxy.ts < 600 lines | **XL** | **High** — protocol parity (zlib deflate + base64 framing, TTYPE/GMCP portal strings) must match what mud-web-client expects; gate behind flag + e2e | 0.3, 0.4, 2.1, 2.2   |
| 2.4 | **Direct tests for `telnet-parser.ts`.** Unit tests for every negotiation branch and chunk-boundary splits (split IAC across chunks, subneg across chunks, MCCP start mid-buffer).                                                                                                                                                                                                                                                            | new `tests/telnet-parser.test.ts`                            | Parser ≥ 80% line coverage                                                                            | **M**  | None                                                                                                                                                 | —                    |
| 2.5 | **Rewrite CLAUDE.md/AGENTS.md/README architecture+config sections** to describe the modular layout, both protocols, and the full env-var table (generate from `.env.example`).                                                                                                                                                                                                                                                                | `CLAUDE.md`, `AGENTS.md`, `README.md:60-96`                  | No claim contradicts the code; env table complete                                                     | **S**  | None                                                                                                                                                 | best after 2.3 lands |

### Milestone 3 — Quality & polish

| #   | Task                                                                                                                                 | Files                                            | Acceptance                              | Effort | Risk                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | --------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| 3.1 | Remove dead code: `newSocket`, fix `die()` to use `sock.send` (or drop the notify)                                                   | `wsproxy.ts:2491-2537`                           | Lint/typecheck pass; behavior unchanged | **S**  | Low                                                                                            |
| 3.2 | Read version from package.json instead of `PACKAGE_VERSION`                                                                          | `wsproxy.ts:185`                                 | `/health` reports package.json version  | **S**  | Low                                                                                            |
| 3.3 | IPv6-safe `parseAllowedTargets` + warn on dropped invalid entries                                                                    | `src/target-policy.ts:37-50`                     | Unit tests for `[::1]:4000`             | **S**  | Low                                                                                            |
| 3.4 | Parameterize deploy host via repo vars; add post-deploy `/health` curl with failure exit                                             | `.github/workflows/deploy.yml`                   | Bad deploy turns the workflow red       | **S**  | Low                                                                                            |
| 3.5 | Constant-time compare for APNS test secret; add `uncaughtException`/`unhandledRejection` last-resort handlers (log + die gracefully) | `wsproxy.ts:1180,1314,2561`                      | Code review + unit test                 | **S**  | Low                                                                                            |
| 3.6 | Notification-manager tests (mock HTTP/2), incl. response-body size cap and request-error handler gaps found in review                | `src/notification-manager.ts:390-483`, new tests | ≥ 60% coverage on the module            | **L**  | Low                                                                                            |
| 3.7 | Drop unused `uglify-js`/`@types/uglify-js`; routine dep bumps                                                                        | `package.json`                                   | Install + CI green                      | **S**  | Low                                                                                            |
| 3.8 | Make TLS→TCP fallback for MUD connections opt-in per target                                                                          | `src/session.ts:88-99`, `src/runtime-config.ts`  | Flag documented; test for both modes    | **S**  | Medium (could break MUDs relying on silent fallback — default to current behavior, log loudly) |

### Quick wins (do immediately, ~1 day total)

- **0.1** CI script fix — unbreaks the merge gate (15 min).
- **1.1** Close telnet sockets — one-line-class fix for the worst correctness bug.
- **1.2** License reconciliation — needs only an owner decision.
- **2.2** APNS endpoint dedupe — −200 lines of risk surface.
- **2.5** CLAUDE.md/AGENTS.md truth pass — immediately improves every future AI-assisted change.
- **3.1, 3.2, 3.7** — trivial deletions.

### Implementation sketches (top 3)

**0.1 + 0.2 — CI repair.**
Change `test.yml:18` to `bun run test`. Add coverage thresholds via `bunfig.toml` (`[test] coverageThreshold = 0.63` or per-metric map) so the existing run enforces them; mark the workflow required in branch protection. Gotcha: `bun test` discovers `tests/e2e/*.test.ts` too if invoked bare — keep the existing `tests/*.test.ts` glob from package.json so CI doesn't try to dial real MUDs.

**1.1 — Telnet socket close.**
In `closeSocket`'s legacy branch, replace the mislabeled `s.terminate()` at `wsproxy.ts:2072` with `s.ts.destroy(); s.ts = undefined;` before terminating the WS. Gotchas: the telnet `'close'` handler re-enters `closeSocket` after 500 ms (`wsproxy.ts:2034-2039`) — nulling `s.ts` first keeps re-entry idempotent; `die()` iterates sockets and must remain safe for already-cleaned entries.

**1.3 — Trusted proxy.**
Add `trustProxy: boolean | string[]` to `getRuntimeConfig` (`src/runtime-config.ts`), parsed from `TRUST_PROXY` (`true`, or comma CIDR/IP list). In `getClientIP` (`wsproxy.ts:195`), check `req.socket.remoteAddress` against the trust list before honoring headers; otherwise return the socket address. Apply the same rule to `requestPeer` (`wsproxy.ts:1086-1092`) for log consistency. Gotcha: the production deploy's topology is unknown (Open Question 3) — default `TRUST_PROXY` unset = headers ignored, and call this out in release notes since it changes logged IPs for anyone currently behind nginx.

---

## Open Questions (need a human)

1. **License intent:** Given the fork lineage from GPL-3.0 `maldorne/mud-web-proxy`, is there any basis for the MIT header (`wsproxy.ts:11`), or do we standardize on GPL-3.0-or-later everywhere? (Blocks task 1.2.)
2. **Is the legacy browser-client path still a supported product?** If mud-web-client compatibility can be dropped (iOS app only), Milestone 2.3 becomes _deletion_ instead of _migration_ — dramatically cheaper. The zlib-deflate-to-browser feature (`srv.compress`, `wsproxy.ts:915`) only matters here.
3. **Deployment topology:** Is the proxy fronted by nginx/Cloudflare, or directly exposed? Determines the right `TRUST_PROXY` default (task 1.3) and how urgent S1 is.
4. **Scale targets:** Expected concurrent sessions/devices? Current caps (10/IP, 5/device) and in-memory key storage are fine for tens of users, not thousands — if growth is planned, `attested-keys.json` persistence should move to SQLite (not currently recommended).
5. **`/diagnostic` exposure:** Is a `DIAGNOSTIC_TOKEN` set in production? If not, confirm the endpoint 404s as designed; if yes, consider whether session IDs belong on that page at all (they're usable with the APNS debug panel).
