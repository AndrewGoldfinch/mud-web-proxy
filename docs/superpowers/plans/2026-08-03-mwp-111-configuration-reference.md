# MWP-111 Configuration Reference Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish an exhaustive first-public-release v4 configuration reference and keep both operator environment templates synchronized with the active runtime settings through CI.

**Architecture:** Keep `src/runtime-config.ts` as the sole configuration authority. Extend the existing textual drift checker with a six-name retired-variable taxonomy and dotenv-template extraction, then complete the two operator templates and the human reference without changing runtime behavior.

**Tech Stack:** Bun 1.3.14, TypeScript 6, Bun test, Markdown, dotenv templates, Linear.

## Global Constraints

- v4 is the first public release; do not create v3 migration documentation or imply a supported v3 operator contract.
- Do not modify `src/runtime-config.ts`, runtime defaults, validation, security policy, or application behavior.
- `.env.example` and `.env.compose.example` are the only operator templates governed by parity checks.
- Do not modify `.env.aardwolf.example`, `.env.achaea.example`, `.env.discworld.example`, `.env.ire.example`, `.env.raw.example`, or `.env.rom.example`.
- Every active runtime setting must occur exactly once in each operator template as an active or commented assignment.
- Retired settings may be documented in prose but must not occur as assignments in either operator template.
- Compose-only `MWP_DOMAIN`, `MWP_ACME_EMAIL`, and `MWP_IMAGE` remain valid extras in `.env.compose.example`.
- Match the repository's 79-column Prettier formatting and existing TypeScript style.
- Use test-driven development for every checker behavior: failing test, observed expected failure, minimal implementation, passing test.

---

## File map

- `scripts/check-config-docs.ts`: extract source, reference, and template names; classify retired variables; run the aggregate CI contract.
- `tests/check-config-docs.test.ts`: focused behavior tests for extraction, classification, sorting, and repository-template parity.
- `.env.example`: exhaustive deployment-neutral v4 runtime template.
- `.env.compose.example`: exhaustive v4 runtime template plus Compose-only settings and topology overrides.
- `docs/configuration.md`: complete human reference with explicit type, default, and requirement columns.
- `docs/superpowers/specs/2026-08-03-mwp-111-configuration-reference-design.md`: approved design; read-only during implementation.
- `docs/superpowers/plans/2026-08-03-mwp-111-configuration-reference.md`: this execution plan.

---

### Task 1: Correct and start MWP-111 in Linear

**Files:** None.

**Interfaces:**

- Consumes: approved no-migration design and the existing issue `MWP-111`.
- Produces: a truthful In Progress issue whose acceptance criteria match the implementation below.

- [ ] **Step 1: Fetch MWP-111 and verify its current state**

Use the Linear issue lookup for `MWP-111`. Confirm the issue still requests a
v3-to-v4 migration guide and is in Backlog before mutating it.

- [ ] **Step 2: Replace the stale title and description**

Set the title to:

```text
Complete the v4 configuration reference and enforce operator-template parity
```

Replace the description with this exact scope:

```markdown
Source: docs/open-source-plan.md — Phase 3, documentation bullet 2

## Context

v4 is this project's first public release. The repository contains an internal
v3.1.0 development tag, but no public v3 operator contract exists, so a
v3-to-v4 migration guide would be misleading and is explicitly out of scope.

The configuration reference and source-to-reference CI check already exist.
The remaining work is to make each reference entry explicit about type,
default, requirement conditions, and security implications; make the two
operator templates exhaustive; and make CI prevent those templates from
drifting.

## Implementation

1. Complete `docs/configuration.md` for every active variable read by
   `src/runtime-config.ts`.
2. Give every active entry explicit Type, Default, Required when, and
   Description fields.
3. Make `.env.example` and `.env.compose.example` exhaustive for active v4
   settings. Leave the per-MUD E2E fixtures unchanged.
4. Distinguish active variables from names read only to reject retired internal
   settings.
5. Extend `scripts/check-config-docs.ts` and its tests so CI fails when an active
   variable is missing from the reference or either operator template, or when
   a retired variable appears as a template assignment.

## Acceptance criteria

- [ ] Every active runtime variable is documented with type, exact default,
      requirement conditions, and security implications.
- [ ] `.env.example` contains every active runtime variable exactly once and no
      E2E-only variables.
- [ ] `.env.compose.example` contains every active runtime variable exactly
      once, retains its three Compose-only `MWP_*` settings, and documents the
      values imposed by `compose.yaml`.
- [ ] CI fails when either operator template omits an active variable.
- [ ] CI fails when either operator template assigns a retired variable.
- [ ] Per-MUD E2E fixtures and runtime behavior are unchanged.

## Verification

    bun test tests/check-config-docs.test.ts
    bun run check:config-docs
    bun run format
    bun run typecheck
    bun run lint
    bun run test:unit
    bun run build
```

- [ ] **Step 3: Move the issue to In Progress and assign it to the authenticated maintainer**

Set `state` to `In Progress` and `assignee` to `me`. Do not mark the issue Done
until its implementation PR merges.

---

### Task 2: Add active and retired variable classification

**Files:**

- Modify: `tests/check-config-docs.test.ts:1-61`
- Modify: `scripts/check-config-docs.ts:28-72`

**Interfaces:**

- Consumes: `varsInSource(source: string): Set<string>`.
- Produces:
  - `RETIRED_ENV_VARS: ReadonlySet<string>`
  - `activeVarsInSource(source: string): Set<string>`
  - `varsInTemplate(template: string): Set<string>`
  - `duplicateVarsInTemplate(template: string): string[]`
  - `missingVars(required: ReadonlySet<string>, present: ReadonlySet<string>): string[]`
  - `retiredVarsInTemplate(template: string): string[]`

- [ ] **Step 1: Write classification and template-extraction tests**

Extend the import and add these tests beneath the existing `varsInSource`
suite. Each expectation is a hand-written literal; none derives its answer
through the helper under test.

```typescript
import {
  activeVarsInSource,
  duplicateVarsInTemplate,
  missingVars,
  retiredVarsInTemplate,
  varsInSource,
  varsInTemplate,
} from '../scripts/check-config-docs';

describe('activeVarsInSource', () => {
  test('keeps live settings and excludes names read only to reject retirement', () => {
    const names = activeVarsInSource(`
      const port = env.WS_PORT;
      if (env.ONLY_ALLOW_DEFAULT_SERVER !== undefined) fail();
      if (env.DISABLE_TLS !== undefined) fail();
    `);

    expect([...names].sort()).toEqual(['WS_PORT']);
  });
});

describe('varsInTemplate', () => {
  test('finds active and commented dotenv assignments', () => {
    const names = varsInTemplate(`
      WS_PORT=6200
      # MAX_SESSIONS_GLOBAL=100
      #TLS_CERT_PATH=/run/secrets/cert.pem
    `);

    expect([...names].sort()).toEqual([
      'MAX_SESSIONS_GLOBAL',
      'TLS_CERT_PATH',
      'WS_PORT',
    ]);
  });

  test('ignores prose, lowercase names, exports, and malformed lines', () => {
    const names = varsInTemplate(`
      # Use TARGET_MODE=fixed for one target.
      lowercase=value
      export WS_PORT=6200
      NOT AN ASSIGNMENT
    `);

    expect(names.size).toBe(0);
  });
});

describe('template parity helpers', () => {
  test('sorts missing variables for deterministic diagnostics', () => {
    expect(
      missingVars(new Set(['WS_PORT', 'BIND_HOST']), new Set(['WS_PORT'])),
    ).toEqual(['BIND_HOST']);
  });

  test('detects a retired assignment but ignores a prose mention', () => {
    const retired = retiredVarsInTemplate(`
      # DISABLE_TLS was removed.
      # ONLY_ALLOW_DEFAULT_SERVER=true
    `);

    expect(retired).toEqual(['ONLY_ALLOW_DEFAULT_SERVER']);
  });

  test('detects and sorts repeated assignment names', () => {
    const duplicates = duplicateVarsInTemplate(`
      WS_PORT=6200
      # BIND_HOST=127.0.0.1
      # WS_PORT=6300
      BIND_HOST=0.0.0.0
    `);

    expect(duplicates).toEqual(['BIND_HOST', 'WS_PORT']);
  });
});
```

The production mutations these tests catch are: returning all extracted names
as active, failing to recognize commented examples, accepting prose as an
assignment, returning nondeterministic diagnostics, accepting repeated
assignments, and scanning arbitrary prose for retired names.

- [ ] **Step 2: Run the focused suite and observe the expected RED failure**

Run:

```bash
bun test tests/check-config-docs.test.ts
```

Expected: import errors for `activeVarsInSource`, `duplicateVarsInTemplate`,
`missingVars`, `retiredVarsInTemplate`, and `varsInTemplate`. The existing nine
tests must still pass.

- [ ] **Step 3: Implement the minimal pure helpers**

Replace the empty `NOT_ENV_VARS` escape hatch with the explicit retired set and
add these helpers immediately after `varsInSource`:

```typescript
export const RETIRED_ENV_VARS: ReadonlySet<string> = new Set([
  'ALLOW_INSECURE_PRODUCTION_NO_TLS',
  'ALLOW_MTLS_FALLBACK',
  'DISABLE_TLS',
  'MTLS_CLIENT_CA_PATH',
  'ONLY_ALLOW_DEFAULT_SERVER',
  'TRUST_PROXY',
]);

export const activeVarsInSource = (source: string): Set<string> => {
  const names = varsInSource(source);
  for (const retired of RETIRED_ENV_VARS) names.delete(retired);
  return names;
};

export const varsInTemplate = (template: string): Set<string> => {
  const names = new Set<string>();
  for (const [, name] of template.matchAll(
    /^\s*(?:#\s*)?([A-Z][A-Z0-9_]{2,})\s*=.*$/gm,
  )) {
    names.add(name);
  }
  return names;
};

export const duplicateVarsInTemplate = (template: string): string[] => {
  const counts = new Map<string, number>();
  for (const [, name] of template.matchAll(
    /^\s*(?:#\s*)?([A-Z][A-Z0-9_]{2,})\s*=.*$/gm,
  )) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
};

export const missingVars = (
  required: ReadonlySet<string>,
  present: ReadonlySet<string>,
): string[] => [...required].filter((name) => !present.has(name)).sort();

export const retiredVarsInTemplate = (template: string): string[] =>
  [...varsInTemplate(template)]
    .filter((name) => RETIRED_ENV_VARS.has(name))
    .sort();
```

Keep `varsInSource` responsible only for recognizing source access forms. Do
not make it hide retired variables because the reference must still document
their rejection behavior. Delete the old `for (const ignored of NOT_ENV_VARS)`
loop together with `NOT_ENV_VARS`; otherwise the removed escape hatch remains
an undefined reference.

- [ ] **Step 4: Run the focused suite and observe GREEN**

Run:

```bash
bun test tests/check-config-docs.test.ts
```

Expected: 15 tests pass, 0 fail.

- [ ] **Step 5: Run typecheck and commit the independently useful helpers**

```bash
bun run typecheck
git add scripts/check-config-docs.ts tests/check-config-docs.test.ts
git diff --cached --check
git commit -m "test: classify active configuration settings"
```

---

### Task 3: Enforce parity and complete both operator templates

**Files:**

- Modify: `scripts/check-config-docs.ts:21-134`
- Modify: `tests/check-config-docs.test.ts:1-end`
- Modify: `.env.example:1-180`
- Modify: `.env.compose.example:1-71`

**Interfaces:**

- Consumes: all Task 2 helper functions and `src/runtime-config.ts`.
- Produces: one `bun run check:config-docs` contract covering the reference,
  `.env.example`, and `.env.compose.example` in a single run.

- [ ] **Step 1: Add repository-template contract tests before changing templates**

Import `readFileSync` and resolve paths relative to the test file. Add a suite
that loads the real source and both real templates:

```typescript
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const runtimeSource = readFileSync(
  path.join(repoRoot, 'src', 'runtime-config.ts'),
  'utf8',
);

describe('operator template parity', () => {
  const active = activeVarsInSource(runtimeSource);
  const templates = ['.env.example', '.env.compose.example'];

  for (const template of templates) {
    test(`${template} contains every active setting`, () => {
      const contents = readFileSync(path.join(repoRoot, template), 'utf8');
      expect(missingVars(active, varsInTemplate(contents))).toEqual([]);
    });

    test(`${template} assigns no retired setting`, () => {
      const contents = readFileSync(path.join(repoRoot, template), 'utf8');
      expect(retiredVarsInTemplate(contents)).toEqual([]);
    });

    test(`${template} assigns each active setting once`, () => {
      const contents = readFileSync(path.join(repoRoot, template), 'utf8');
      expect(
        duplicateVarsInTemplate(contents).filter((name) => active.has(name)),
      ).toEqual([]);
    });
  }
});
```

The missing-variable tests protect the actual distributed templates, not a
mock. The retired tests catch uncommented and commented assignment examples;
ordinary explanatory prose remains legal.

- [ ] **Step 2: Run the focused suite and observe repository-level RED**

Run:

```bash
bun test tests/check-config-docs.test.ts
```

Expected: both `contains every active setting` tests fail with literal missing
name arrays. The retired-assignment and duplicate-active-assignment tests pass
against the current templates.

- [ ] **Step 3: Extend the script's main path to aggregate template failures**

Update the file header to say the command enforces both
`docs/configuration.md` coverage and operator-template parity; it must no longer
claim documentation presence is its only responsibility.

Add template paths beside `SOURCE` and `DOCS`:

```typescript
const TEMPLATES = [
  path.join(repoRoot, '.env.example'),
  path.join(repoRoot, '.env.compose.example'),
];
```

In the `import.meta.main` block, preserve the existing source-to-reference
comparison, calculate `active`, and aggregate errors without exiting inside
the first branch:

```typescript
const sourceText = read(SOURCE);
const source = varsInSource(sourceText);
const active = activeVarsInSource(sourceText);
const documented = varsInDocs(read(DOCS));
let failed = false;

const undocumented = missingVars(source, documented);
const stale = [...documented].filter((name) => !source.has(name)).sort();

// Preserve the stale warning. For undocumented names, print the existing
// reference-specific diagnostic and set failed = true.

for (const templatePath of TEMPLATES) {
  const template = read(templatePath);
  const relative = path.relative(repoRoot, templatePath);
  const missing = missingVars(active, varsInTemplate(template));
  const retired = retiredVarsInTemplate(template);
  const duplicates = duplicateVarsInTemplate(template).filter((name) =>
    active.has(name),
  );

  if (missing.length > 0) {
    console.error(
      `check-config-docs: ${relative} is missing ${missing.length} active ` +
        `configuration variable(s):\n` +
        missing.map((name) => `  ${name}`).join('\n'),
    );
    failed = true;
  }

  if (retired.length > 0) {
    console.error(
      `check-config-docs: ${relative} assigns ${retired.length} retired ` +
        `configuration variable(s):\n` +
        retired.map((name) => `  ${name}`).join('\n'),
    );
    failed = true;
  }

  if (duplicates.length > 0) {
    console.error(
      `check-config-docs: ${relative} assigns ${duplicates.length} active ` +
        `configuration variable(s) more than once:\n` +
        duplicates.map((name) => `  ${name}`).join('\n'),
    );
    failed = true;
  }
}

if (failed) process.exit(1);

console.log(
  `check-config-docs: ${source.size} documented variables; ` +
    `${active.size} active variables present in both operator templates.`,
);
```

Do not reject Compose-only extras. Do not use a regular expression that counts
prose mentions as assignments.

- [ ] **Step 4: Run the CLI and observe the expected RED diagnostics**

Run:

```bash
bun run check:config-docs
```

Expected: exit 1 with separate sorted missing-variable lists for
`.env.example` and `.env.compose.example`. The reference itself remains clean.

- [ ] **Step 5: Rewrite `.env.example` as the exhaustive runtime-only template**

Use the same section order as `docs/configuration.md`. Include each of these 52
active assignments exactly once; commented examples count and must retain the
leading assignment shape `# NAME=value`:

```text
BIND_HOST=127.0.0.1
WS_PORT=6200
INBOUND_TLS_MODE=required
# TLS_CERT_PATH=./cert.pem
# TLS_KEY_PATH=./privkey.pem
# ALLOW_INSECURE_INBOUND_NO_TLS=false
TN_HOST=muds.maldorne.org
TN_PORT=5010
TARGET_MODE=fixed
# ALLOWED_TARGETS=aardmud.org:4000,achaea.com:23
# ARBITRARY_ALLOWED_PORTS=23,4000-4100
MUD_TLS_MODE=prefer
AUTH_MODE=none
# PROXY_SHARED_SECRET=
# AUTH_ALLOW_QUERY_SECRET=false
# REQUIRE_APP_AUTH=false
# ALLOWED_ORIGINS=https://app.example.com
# ALLOW_MISSING_ORIGIN=false
# TRUSTED_PROXY_CIDRS=127.0.0.1
SESSION_TIMEOUT_HOURS=24
MAX_SESSIONS_PER_DEVICE=5
MAX_SESSIONS_PER_IP=10
# MAX_SESSIONS_GLOBAL=100
RESUME_GRACE_MINUTES=45
MAX_MESSAGES_PER_SECOND=60
MAX_MESSAGES_PER_SECOND_PER_IP=240
SHUTDOWN_GRACE_MS=3000
SHUTDOWN_DEADLINE_MS=15000
MAX_SUBNEGOTIATION_BYTES=65536
OUTPUT_BUFFER_BYTES=51200
WS_HEARTBEAT_ENABLED=true
WS_HEARTBEAT_INTERVAL_MS=30000
WS_HEARTBEAT_TIMEOUT_MS=90000
ENABLE_DIAGNOSTICS=false
# ADMIN_TOKEN=
LOG_LEVEL=info
# NO_COLOR=1
# APPATTEST_BUNDLE_ID=com.example.yourapp
# APPATTEST_TEAM_ID=AAABBBCCC1
# ATTESTED_KEYS_PATH=./config/attested-keys.json
# APNS_KEY_PATH=./AuthKey.p8
# APNS_KEY_ID=
# APNS_TEAM_ID=
# APNS_TOPIC=com.example.yourapp
APNS_ENVIRONMENT=sandbox
# APNS_TEST_SECRET=
# SILENT_PUSH_INTERVAL_MS=1200000
# ACTIVITY_PUSH_INTERVAL_MS=120000
# ACTIVITY_PUSH_ACK_TIMEOUT_MS=15000
# ACTIVITY_PUSH_FALLBACK_COOLDOWN_MS=60000
# ACTIVITY_PUSH_FALLBACK_MAX_PER_HOUR=6
# ACTIVITY_PUSH_MAX_SNIPPET_LENGTH=100
```

Remove these six E2E-only assignments entirely:

```text
DEBUG
TEST_TIMEOUT_MS
TEST_PROXY_PORT
TEST_MOCK_PORT
USE_MOCK_MUD
SKIP_E2E_TESTS
```

Keep security explanations for non-loopback plaintext, arbitrary targets,
query-string secrets, trusted proxies, App Attest's review status, and APNS
data flow. Do not add any retired name in assignment form.

- [ ] **Step 6: Rewrite `.env.compose.example` as the exhaustive Compose template**

Retain these Compose-only assignments:

```text
MWP_DOMAIN=
MWP_ACME_EMAIL=
# MWP_IMAGE=ghcr.io/andrewgoldfinch/mud-web-proxy@sha256:...
```

Add all 52 runtime assignments from Step 5 exactly once. For the three values
hard-coded by `compose.yaml`, include commented assignments and state that the
service-level `environment` block wins over `.env`:

```text
# BIND_HOST=0.0.0.0
# INBOUND_TLS_MODE=off
# ALLOW_INSECURE_INBOUND_NO_TLS=true
```

Keep `TN_HOST=` blank because Compose deliberately requires the operator to
choose a target. Keep secrets blank and optional features commented. Do not
claim that changing one of the three imposed topology values in `.env` changes
the container.

- [ ] **Step 7: Run focused tests and the real checker to observe GREEN**

Run:

```bash
bun test tests/check-config-docs.test.ts
bun run check:config-docs
```

Expected:

```text
21 pass
0 fail
check-config-docs: 58 documented variables; 52 active variables present in both operator templates.
```

- [ ] **Step 8: Verify specialized E2E fixtures are untouched**

Run:

```bash
git diff --exit-code origin/main -- \
  .env.aardwolf.example \
  .env.achaea.example \
  .env.discworld.example \
  .env.ire.example \
  .env.raw.example \
  .env.rom.example
```

Expected: exit 0 with no output.

- [ ] **Step 9: Format, validate, and commit the parity contract**

```bash
bunx prettier --write \
  scripts/check-config-docs.ts \
  tests/check-config-docs.test.ts \
  .env.example \
  .env.compose.example
bun test tests/check-config-docs.test.ts
bun run check:config-docs
bun run typecheck
bun run lint
git add scripts/check-config-docs.ts tests/check-config-docs.test.ts \
  .env.example .env.compose.example
git diff --cached --check
git commit -m "docs: enforce operator configuration parity"
```

---

### Task 4: Complete the configuration reference structure and content

**Files:**

- Modify: `docs/configuration.md:1-362`

**Interfaces:**

- Consumes: the 52-name active set enforced by Task 3 and the exact defaults
  and constraints in `src/runtime-config.ts`.
- Produces: the public human-readable configuration contract consumed from
  `README.md` and both deployment guides.

- [ ] **Step 1: Convert every active-variable table to the five-column contract**

Every active row must use:

```markdown
| Variable | Type | Default | Required when | Description |
```

Use this exact type/default/requirement matrix; retain and sharpen the existing
security rationale in each row and the prose below it:

| Variables                             | Type                                             | Default                     | Required when                                                |
| ------------------------------------- | ------------------------------------------------ | --------------------------- | ------------------------------------------------------------ |
| `BIND_HOST`                           | string                                           | `127.0.0.1`                 | Never                                                        |
| `WS_PORT`                             | integer                                          | `6200`                      | Never                                                        |
| `INBOUND_TLS_MODE`                    | `required` or `off`                              | `required`                  | Never                                                        |
| `TLS_CERT_PATH`                       | path                                             | `./cert.pem`                | `INBOUND_TLS_MODE=required`                                  |
| `TLS_KEY_PATH`                        | path                                             | `./privkey.pem`             | `INBOUND_TLS_MODE=required`                                  |
| `ALLOW_INSECURE_INBOUND_NO_TLS`       | boolean                                          | `false`                     | Must be `true` for plaintext on a non-loopback bind          |
| `TN_HOST`                             | hostname                                         | `muds.maldorne.org`         | Never                                                        |
| `TN_PORT`                             | integer                                          | `5010`                      | Never                                                        |
| `TARGET_MODE`                         | `fixed`, `allowlist`, or `arbitrary`             | `fixed`                     | Never                                                        |
| `ALLOWED_TARGETS`                     | comma-separated `host:port` list                 | empty                       | `TARGET_MODE=allowlist`                                      |
| `ARBITRARY_ALLOWED_PORTS`             | comma-separated ports/ranges                     | empty                       | `TARGET_MODE=arbitrary`                                      |
| `MUD_TLS_MODE`                        | `plain`, `required`, or `prefer`                 | `prefer`                    | Never                                                        |
| `AUTH_MODE`                           | `none` or `shared-secret`                        | `none`                      | Never                                                        |
| `PROXY_SHARED_SECRET`                 | secret string                                    | empty                       | `AUTH_MODE=shared-secret`                                    |
| `AUTH_ALLOW_QUERY_SECRET`             | boolean                                          | `false`                     | Never                                                        |
| `REQUIRE_APP_AUTH`                    | boolean                                          | `false`                     | Never; `true` requires App Attest configuration              |
| `ALLOWED_ORIGINS`                     | comma-separated exact origins                    | empty                       | Never                                                        |
| `ALLOW_MISSING_ORIGIN`                | boolean                                          | `false`                     | Never                                                        |
| `TRUSTED_PROXY_CIDRS`                 | `true`, `false`, or comma-separated IP/CIDR list | `false`                     | Never                                                        |
| `SESSION_TIMEOUT_HOURS`               | positive integer                                 | `24`                        | Never                                                        |
| `MAX_SESSIONS_PER_DEVICE`             | positive integer                                 | `5`                         | Never                                                        |
| `MAX_SESSIONS_PER_IP`                 | positive integer                                 | `10`                        | Never                                                        |
| `MAX_SESSIONS_GLOBAL`                 | positive integer                                 | unset                       | Never                                                        |
| `RESUME_GRACE_MINUTES`                | positive integer                                 | `45`                        | Never                                                        |
| `MAX_MESSAGES_PER_SECOND`             | positive integer                                 | `60`                        | Never                                                        |
| `MAX_MESSAGES_PER_SECOND_PER_IP`      | positive integer                                 | `240`                       | Never                                                        |
| `SHUTDOWN_GRACE_MS`                   | positive integer                                 | `3000`                      | Never                                                        |
| `SHUTDOWN_DEADLINE_MS`                | positive integer                                 | `15000`                     | Never                                                        |
| `MAX_SUBNEGOTIATION_BYTES`            | positive integer                                 | `65536`                     | Never                                                        |
| `OUTPUT_BUFFER_BYTES`                 | positive integer                                 | `51200`                     | Never                                                        |
| `WS_HEARTBEAT_ENABLED`                | boolean                                          | `true`                      | Never                                                        |
| `WS_HEARTBEAT_INTERVAL_MS`            | positive integer                                 | `30000`                     | Never                                                        |
| `WS_HEARTBEAT_TIMEOUT_MS`             | positive integer                                 | `90000`                     | Never                                                        |
| `ENABLE_DIAGNOSTICS`                  | boolean                                          | `false`                     | Never                                                        |
| `ADMIN_TOKEN`                         | secret string                                    | empty                       | Required to access enabled diagnostics                       |
| `LOG_LEVEL`                           | `debug`, `info`, `warn`, or `error`              | `info`                      | Never                                                        |
| `NO_COLOR`                            | literal `1` or unset                             | unset                       | Never                                                        |
| `APPATTEST_BUNDLE_ID`                 | string                                           | empty                       | Set together with `APPATTEST_TEAM_ID` to enable App Attest   |
| `APPATTEST_TEAM_ID`                   | string                                           | empty                       | Set together with `APPATTEST_BUNDLE_ID` to enable App Attest |
| `ATTESTED_KEYS_PATH`                  | path                                             | `config/attested-keys.json` | Never                                                        |
| `APNS_KEY_PATH`                       | path                                             | empty                       | Set with all four APNS identity variables to enable push     |
| `APNS_KEY_ID`                         | string                                           | empty                       | Set with all four APNS identity variables to enable push     |
| `APNS_TEAM_ID`                        | string                                           | empty                       | Set with all four APNS identity variables to enable push     |
| `APNS_TOPIC`                          | string                                           | empty                       | Set with all four APNS identity variables to enable push     |
| `APNS_ENVIRONMENT`                    | `sandbox` or `production`                        | `sandbox`                   | Never                                                        |
| `APNS_TEST_SECRET`                    | secret string                                    | empty                       | Required to use the APNS test endpoint                       |
| `SILENT_PUSH_INTERVAL_MS`             | integer                                          | `1200000`                   | Never                                                        |
| `ACTIVITY_PUSH_INTERVAL_MS`           | integer                                          | `120000`                    | Never                                                        |
| `ACTIVITY_PUSH_ACK_TIMEOUT_MS`        | integer                                          | `15000`                     | Never                                                        |
| `ACTIVITY_PUSH_FALLBACK_COOLDOWN_MS`  | integer                                          | `60000`                     | Never                                                        |
| `ACTIVITY_PUSH_FALLBACK_MAX_PER_HOUR` | integer                                          | `6`                         | Never                                                        |
| `ACTIVITY_PUSH_MAX_SNIPPET_LENGTH`    | integer                                          | `100`                       | Never                                                        |

For the background push rows, explain that these are scheduler defaults used
when the parsed runtime value is unset. Do not call an unset optional parse
result a different operator-visible default.

- [ ] **Step 2: Make every security consequence explicit**

Retain or add these concrete consequences in the matching row or immediately
following prose:

- non-loopback plaintext exposes credentials unless a trusted edge terminates
  TLS;
- `TARGET_MODE=arbitrary` without enforced authentication is an open relay and
  startup rejects it;
- `AUTH_ALLOW_QUERY_SECRET=true` can place a secret in URLs and access logs;
- wildcard origins are rejected and Origin checking is not authentication;
- trusting arbitrary forwarded headers permits identity spoofing and defeats
  per-IP limits;
- raising session, buffer, telnet, or rate limits increases per-client resource
  exposure;
- `MUD_TLS_MODE=prefer` is downgradeable by an active network attacker;
- `LOG_LEVEL=debug` exposes session content except password input protected by
  telnet ECHO state;
- App Attest is experimental and not independently reviewed;
- attested keys and APNS tokens are device-derived data;
- APNS alert snippets transit Apple's infrastructure.

Do not add general security boilerplate to every row. State the direct
consequence once where the relevant setting is introduced.

- [ ] **Step 3: Preserve retired-variable documentation without treating it as v4 configuration**

Rename the final table's second column to `Replacement or disposition` and
retain exactly these six rows:

```text
ONLY_ALLOW_DEFAULT_SERVER
DISABLE_TLS
ALLOW_INSECURE_PRODUCTION_NO_TLS
TRUST_PROXY
ALLOW_MTLS_FALLBACK
MTLS_CLIENT_CA_PATH
```

State above the table that assigning any of them aborts startup. Do not add
Type, Default, or Required columns to rejected names.

- [ ] **Step 4: Validate the reference against the source and format it**

Run:

```bash
bun run check:config-docs
bunx prettier --write docs/configuration.md
bunx prettier --check docs/configuration.md
git diff --check
```

Expected: 58 documented variables, 52 active variables present in both
templates, Prettier clean, and no whitespace errors.

- [ ] **Step 5: Commit the completed public reference**

```bash
git add docs/configuration.md
git diff --cached --check
git commit -m "docs: complete the v4 configuration reference"
```

---

### Task 5: Mutation checks, full verification, and Linear handoff

**Files:**

- Verify: `scripts/check-config-docs.ts`
- Verify: `tests/check-config-docs.test.ts`
- Verify: `.env.example`
- Verify: `.env.compose.example`
- Verify: `docs/configuration.md`
- Verify unchanged: `src/runtime-config.ts` and all specialized E2E fixtures.

**Interfaces:**

- Consumes: all previous task deliverables.
- Produces: reproducible evidence that the branch is review-ready and a Linear
  comment that preserves that evidence without prematurely closing the issue.

- [ ] **Step 1: Prove `.env.example` omission is caught using a disposable copy**

Do not edit the tracked template. Copy the repository to a temporary directory,
remove the `WS_PORT` assignment there, and run the real checker there:

```bash
MUTATION_DIR=$(mktemp -d)
mkdir "$MUTATION_DIR/repo"
git archive HEAD | tar -x -C "$MUTATION_DIR/repo"
printf '%s\n' "$MUTATION_DIR/repo/.env.example"
```

Use `apply_patch` against the printed absolute path to remove the exact
`WS_PORT=6200` line from the disposable copy. Then run:

```bash
cd "$MUTATION_DIR/repo"
bun run check:config-docs
```

Expected: exit 1, naming `.env.example` and `WS_PORT`. Return to the worktree
with `cd -` after capturing the result. Leave the temporary directory for the
operating system's temporary-file cleanup; do not run a recursive deletion.

- [ ] **Step 2: Prove `.env.compose.example` omission is caught using a second disposable copy**

```bash
MUTATION_DIR_2=$(mktemp -d)
mkdir "$MUTATION_DIR_2/repo"
git archive HEAD | tar -x -C "$MUTATION_DIR_2/repo"
printf '%s\n' "$MUTATION_DIR_2/repo/.env.compose.example"
```

Use `apply_patch` against the printed absolute path to remove the exact
`# MAX_SESSIONS_GLOBAL=100` line from the disposable copy. Then run:

```bash
cd "$MUTATION_DIR_2/repo"
bun run check:config-docs
```

Expected: exit 1, naming `.env.compose.example` and
`MAX_SESSIONS_GLOBAL`. Return to the worktree with `cd -`.

- [ ] **Step 3: Prove retired assignments are rejected**

```bash
MUTATION_DIR_3=$(mktemp -d)
mkdir "$MUTATION_DIR_3/repo"
git archive HEAD | tar -x -C "$MUTATION_DIR_3/repo"
printf '%s\n' "$MUTATION_DIR_3/repo/.env.example"
```

Use `apply_patch` against the printed absolute path to append the exact line
`# ONLY_ALLOW_DEFAULT_SERVER=true` to the disposable copy. Then run:

```bash
cd "$MUTATION_DIR_3/repo"
bun run check:config-docs
```

Expected: exit 1, naming `.env.example` and
`ONLY_ALLOW_DEFAULT_SERVER` as retired. Return to the worktree with `cd -`.

- [ ] **Step 4: Run the exact quality chain on the clean worktree**

```bash
bun run check:bun-version
bun install --frozen-lockfile
bun run format
bun run check:config-docs
bun run check:defect-classes
bun run typecheck
bun run lint
bun run test:unit
bun run build
```

Expected: every command exits 0; the unit summary remains at least 1,135 tests
with 0 failures, plus the new focused tests.

- [ ] **Step 5: Verify scope and worktree cleanliness**

```bash
git diff --exit-code origin/main -- src/runtime-config.ts
git diff --exit-code origin/main -- \
  .env.aardwolf.example \
  .env.achaea.example \
  .env.discworld.example \
  .env.ire.example \
  .env.raw.example \
  .env.rom.example
git diff --check origin/main...HEAD
git status --short --branch
git log --oneline origin/main..HEAD
```

Expected: no runtime or specialized-fixture diff, no whitespace errors, a clean
worktree, and only MWP-111 design/plan/implementation commits above
`origin/main`.

- [ ] **Step 6: Add the implementation evidence to Linear without closing the issue**

Comment on MWP-111 with:

```markdown
MWP-111 implementation is ready for review.

- Completed the first-public-release v4 configuration reference; no migration
  guide was created because v4 is the first public release.
- Documented all 52 active settings and all 6 fail-fast retired names.
- Made `.env.example` and `.env.compose.example` exhaustive.
- Extended CI to enforce source/reference/template parity and reject retired
  assignments.
- Left runtime behavior and all per-MUD E2E fixtures unchanged.

Verification: formatting, config drift, defect classes, typecheck, lint, unit
tests, and build all pass. Mutation checks prove each template omission and a
retired assignment fail with file-specific diagnostics.

The issue remains In Progress until the implementation PR merges.
```

Do not move MWP-111 to Done. The merge integration or a post-merge closeout
step owns completion.

---

## Execution handoff

The branch already contains the approved design and this plan in the isolated
worktree:

```text
/home/andy/mud-web-proxy/.worktrees/mwp-111-configuration-reference
```

Execute tasks in order. Task 2 establishes the tested parsing interfaces;
Task 3 consumes them for real-template parity; Task 4 completes the human
contract; Task 5 supplies mutation and full-suite evidence.
