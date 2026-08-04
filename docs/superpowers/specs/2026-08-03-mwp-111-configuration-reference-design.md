# MWP-111 Configuration Reference Design

## Goal

Finish the public v4 configuration contract without inventing a migration
story for an unreleased predecessor. Every active runtime setting must be
documented with enough precision for a first-time operator to configure the
proxy safely, and both supported operator environment templates must stay in
sync with that contract through CI.

## Context

MWP-111 was written before the Phase 1 and Phase 2 work landed. Several of its
deliverables already exist on `main`:

- `docs/configuration.md` lists all 58 uppercase configuration names found in
  `src/runtime-config.ts`, grouped by concern.
- `scripts/check-config-docs.ts` fails CI when a name read by the runtime is
  absent from the reference.
- `tests/check-config-docs.test.ts` covers the supported source-access forms.
- `.github/workflows/test.yml` and `scripts/preflight.sh` run the drift check.
- `README.md` links the configuration reference.

The remaining defects are narrower:

- the reference tables do not consistently state type and requirement
  conditions as explicit fields;
- `.env.example` omits active settings and mixes operator configuration with
  E2E-only variables;
- `.env.compose.example` documents only a subset of the settings that Compose
  forwards;
- CI verifies source-to-reference presence but not source-to-template parity;
- the checker sees retired variable names in validation messages and cannot
  distinguish them from active settings.

The repository has a `v3.1.0` tag, but v4 is the first public release of this
project. That tag is development history, not a supported operator contract.
A v3-to-v4 migration guide would misrepresent the release history and is not
part of this design.

## Scope

### In scope

1. Complete the structure and content of `docs/configuration.md`.
2. Make `.env.example` an exhaustive, runtime-only operator template.
3. Make `.env.compose.example` an exhaustive Compose operator template while
   retaining its Compose-only `MWP_*` settings.
4. Extend the existing drift checker to enforce active-variable presence in
   both templates.
5. Add focused tests for the new checker behavior.
6. Correct MWP-111 in Linear so its title, description, and acceptance criteria
   describe the first-public-release configuration work and contain no
   migration requirement.

### Out of scope

- A v3-to-v4 migration guide, renamed-variable migration table, or worked v3
  conversion.
- PM2 migration instructions. PM2 is not a supported public deployment path.
- Runtime parsing, defaults, validation, or security-policy changes.
- Changes to `.env.aardwolf.example`, `.env.achaea.example`,
  `.env.discworld.example`, `.env.ire.example`, `.env.raw.example`, or
  `.env.rom.example`. Those are E2E fixtures, not operator templates.
- Generating documentation from a new metadata schema or refactoring
  `src/runtime-config.ts` around documentation concerns.

## Source of truth and variable taxonomy

`src/runtime-config.ts` remains the authoritative list of names read at
startup. The checker will preserve its textual source extraction because it
already covers direct access, bracket access, optional chaining,
destructuring, helper calls, and required-variable arrays.

The extracted names have two categories:

1. **Active variables** are settings an operator may set in v4. They must
   appear in the reference and in both operator templates.
2. **Retired variables** are read only so startup can reject obsolete internal
   names with a useful error. They must appear in the reference's removed
   variables section, but they must not appear as assignments in either v4
   template.

`scripts/check-config-docs.ts` will define and export the retired set once. The
active set is `varsInSource(source)` minus that retired set. This is the
minimum explicit metadata needed to distinguish a live interface from a
fail-fast compatibility guard; it does not create a second configuration
schema.

The retired set is:

- `ONLY_ALLOW_DEFAULT_SERVER`
- `DISABLE_TLS`
- `ALLOW_INSECURE_PRODUCTION_NO_TLS`
- `TRUST_PROXY`
- `ALLOW_MTLS_FALLBACK`
- `MTLS_CLIENT_CA_PATH`

The two inert historical App Attest bypass names are not read by the runtime,
so they do not enter either set.

## Configuration reference contract

The existing concern-based sections remain. Each active-variable table will
use these columns:

| Column        | Meaning                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------- |
| Variable      | Exact environment variable name.                                                                         |
| Type          | Boolean, integer, enum values, string, path, or comma-separated list.                                    |
| Default       | Exact runtime default, including disabled or unset states.                                               |
| Required when | The condition that makes the variable mandatory, or `Never`.                                             |
| Description   | Operational effect, including the immediate security consequence when misconfiguration changes exposure. |

Long rationale stays in prose below the table instead of being compressed
into unreadable cells. Conditional groups such as APNS and App Attest must name
their all-or-nothing requirements in both the table and the explanatory prose.

The removed-variable table remains separate and uses `Variable` and
`Replacement or disposition` columns. Removed variables have no v4 type or
default because they are rejected, not configured.

No default or accepted value will be inferred from existing prose. Each value
will be checked against `src/runtime-config.ts` and its configuration tests.

## Operator template contract

Both templates must contain every active setting exactly once as either an
active assignment or a commented assignment example. Optional and dangerous
settings should normally remain commented; exhaustiveness does not mean
enabling features by default.

### `.env.example`

This becomes the runtime-only, deployment-neutral template:

- include all active settings, grouped in the same order as the reference;
- use the exact runtime default where a safe copyable value exists;
- leave secrets, conditional paths, and optional feature values empty or
  commented;
- remove the E2E-only `DEBUG`, `TEST_TIMEOUT_MS`, `TEST_PROXY_PORT`,
  `TEST_MOCK_PORT`, `USE_MOCK_MUD`, and `SKIP_E2E_TESTS` entries;
- retain warnings about target policy, query-string secrets, trusted proxy
  boundaries, plaintext listeners, and Apple data flows.

### `.env.compose.example`

This remains directly copyable to the Compose stack:

- retain Compose-only `MWP_DOMAIN`, `MWP_ACME_EMAIL`, and `MWP_IMAGE`;
- retain the required blank values that Compose validates before startup;
- add every active runtime setting, normally commented when the Compose stack
  already supplies the safe topology default;
- state which values are imposed by `compose.yaml` and why changing them in
  the environment has no effect;
- contain no retired-variable assignment.

Duplicating the runtime list between two operator templates is deliberate.
Each template must work by itself; dotenv files have no include mechanism, and
requiring an operator to merge two examples would make the example incomplete.
CI carries the maintenance cost of that duplication.

## Drift checker design

The checker remains one script and one CI command. It gains small pure helpers
rather than a generator or configuration framework:

- `activeVarsInSource(source: string): Set<string>` returns extracted names
  minus the exported retired set.
- `varsInTemplate(template: string): Set<string>` recognizes exact dotenv
  assignment lines, including commented examples such as
  `# MAX_SESSIONS_GLOBAL=100`. Prose mentions do not count.
- `missingVars(required, present): string[]` returns sorted missing names for
  deterministic diagnostics.
- the main check compares all extracted names with the reference, then active
  names with each operator template;
- the main check separately rejects retired names that occur as template
  assignments.

Template-specific names are allowed. `.env.compose.example` legitimately
contains `MWP_*` values consumed by Compose rather than the proxy, so an
unrecognized-name failure would be incorrect. The contract is complete
coverage of active runtime variables and absence of retired assignments, not
identity between every token in the files.

Failure output names the affected file and prints one sorted variable per
line. A single run may report every reference and template defect before
exiting, so an operator does not fix drift one variable at a time.

## Test strategy

Changes to checker behavior follow test-driven development.

Focused unit tests will prove that:

1. active extraction excludes every retired variable while preserving active
   variables;
2. template extraction recognizes active and commented assignments;
3. template extraction ignores prose, commented explanations, lowercase
   names, and malformed lines;
4. missing-variable output is sorted and contains the expected names;
5. a retired assignment is detectable even when the retired name is also
   mentioned harmlessly in prose.

The feature-level checks are:

- `bun test tests/check-config-docs.test.ts`
- `bun run check:config-docs`
- `bun run format`
- `bun run typecheck`
- `bun run lint`
- `bun run test:unit`
- `bun run build`

A mutation check will temporarily remove one active assignment from each
template copy and confirm the checker fails naming that file and variable.
The tracked templates will then be restored before the final clean run.

## Delivery and success criteria

The implementation is complete when:

- every active runtime variable is documented with type, exact default,
  requirement conditions, and security-relevant operational meaning;
- both operator templates contain every active setting and no retired setting
  assignment;
- specialized E2E fixtures are unchanged;
- CI catches a new active runtime variable that is missing from the reference
  or either operator template;
- the existing quality and test suites pass;
- MWP-111 no longer requests or evaluates migration documentation.

No application runtime file should change. Every changed line must trace to
the public v4 configuration contract or its verification.
