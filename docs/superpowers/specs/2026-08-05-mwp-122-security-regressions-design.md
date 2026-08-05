# MWP-122 Security Regression Suite Design

## Goal

Close the security regressions that are genuinely missing, and record what is
already covered so the gap is not re-litigated.

## The suite is mostly already there

MWP-122 enumerates ten areas. An audit of all ten against the current suite
found **seven already covered by tests that would fail if the protection were
removed**, one delivered by MWP-135 since the issue was written, and two with
real gaps.

| #   | Area                                             | Status                                                                                                                          |
| --- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Target modes                                     | Covered — `target-policy-modes`, `target-mode-guard`                                                                            |
| 2   | Reserved networks and DNS rebinding              | **Reserved: covered. Re-resolution: NOT pinned**                                                                                |
| 3   | Shared-secret auth on both protocols             | Covered per protocol; parity not asserted side by side                                                                          |
| 4   | Forwarding headers                               | Covered — `trusted-proxy*`, `ip-counting`                                                                                       |
| 5   | Connection limits, incl. leak after failed dials | Covered — `pending-dial-reservation` has "repeated failures do not leak capacity"; `global-session-cap` has the N-failures case |
| 6   | Caps                                             | Covered — `telnet-subneg-cap`, `circular-buffer-cap`, `message-rate-limit`                                                      |
| 7   | TLS no-downgrade                                 | **Delivered by MWP-135** — `mud-transport`, `legacy-protocol`                                                                   |
| 8   | Health exact key set, diagnostics auth           | Covered — `health-endpoint` asserts `toEqual(['status','version'])`                                                             |
| 9   | Redaction and shutdown                           | Function-level covered; no process-level sentinel test                                                                          |
| 10  | App Attest gating                                | Covered — `attest-route-gating`, `app-attest-*`                                                                                 |

Writing ten areas of new tests would mostly duplicate working coverage. The
value is in the gaps.

## Gap 1: DNS rebinding is not actually pinned

`connect-path-dns.test.ts:128` — "dials the validated address, not the
requested name" — stubs a resolver that returns **the same address every
time** and asserts the dial used it. It never counts resolver calls.

A regression that re-resolved immediately before dialling would return the same
constant and **the test would still pass**. The protection MWP-88 exists to
provide — resolve once, dial that answer — has no test that fails when it is
removed.

The issue asks for exactly this: "a stubbed resolver returning different
answers on successive calls, asserting the proxy connected to the validated
address and never re-resolved." The fix is a resolver that returns a different
address on each call plus a call-count assertion, so a second resolution both
changes the dialled address and trips the count.

## Gap 2: the comparison primitive is not pinned

Carried over from MWP-112's ledger. `src/wsproxy-utils.ts` uses
`timingSafeEqual`, but every assertion in `shared-secret-auth.test.ts` is about
correctness. **Replacing `timingSafeEqual` with `===` passes the entire
suite.**

A timing assertion is not stable in CI. Pinning the primitive — asserting the
comparison path calls it — is the achievable form and is what this closes.

## Gap 3: no Compose deployment contract test

Also carried over. `tests/deployment/systemd-contract.test.ts` asserts the
systemd topology keeps plaintext on loopback and overwrites both client-IP
headers. Compose has no equivalent, so a one-character edit to `compose.yaml`
or `Caddyfile` reintroduces header spoofing with nothing going red.

Caddy's default is to _append_ to a client-supplied `X-Forwarded-For`. Under
that default a client prepends a forged address and the proxy, trusting the
hop, believes it — silently disabling per-IP session limits, the per-address
message-rate budget, and pending-dial reservations.

## Deliberately not in this PR

- **Process-level sentinel-secret log capture** (area 9). `log-redaction.test.ts`
  covers the function against every input shape. A process-level test adds
  confidence that the function is actually on the path, which is real but
  smaller than the three above.
- **Side-by-side auth parity** (area 3). Both protocols are tested
  independently; a single test asserting identical rejection is a tidiness
  improvement rather than a missing protection.
- **App Attest cryptographic correctness.** Out of scope for a test suite;
  it needs external review, and two documents already state that.

These are recorded rather than silently dropped. They are the honest remainder
of MWP-122 and should stay open on the issue.

## Success criteria

- A resolver returning different answers per call proves the proxy resolves
  once and never re-resolves.
- Replacing `timingSafeEqual` with `===` fails the suite.
- A Compose contract test asserts the trusted CIDR and header replacement.
- Each new test demonstrably fails when its protection is removed.
- The remainder is recorded on the issue rather than implied complete.
