// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Repo-wide gates for defect classes that reviewers or CodeQL caught after
 * the fact. Each gate exists because a real defect shipped, and each is
 * written to fail on the whole class rather than the one instance found.
 *
 *   bun run check:defect-classes
 *
 * Adding a gate here is cheaper than re-reviewing for the same mistake, but
 * only if it stays free of false positives — a noisy gate gets bypassed and
 * then it protects nothing. Every rule below is deliberately narrow, and the
 * allowlists are explicit rather than heuristic.
 *
 * Every gate is a pure function over (path, text) and is exported, because a
 * gate nobody has ever seen fail is indistinguishable from a gate that cannot
 * fail. `tests/check-defect-classes.test.ts` feeds each one a violating
 * fixture and asserts it reports; the `gate-has-negative-test` gate below
 * fails the build if any gate lacks that proof.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { NEGATIVE_FIXTURES } from './gate-fixtures';

const ROOT = path.resolve(import.meta.dirname, '..');

export interface Finding {
  gate: string;
  file: string;
  line: number;
  message: string;
}

/** Files git would track: skip build output, deps, and gitignored worktrees. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.worktrees',
  'dist',
  'coverage',
  '.claude',
  'release',
]);

/**
 * The files exempt from every file gate: they hold deliberate violations as
 * fixtures. Exempting them by name is safer than teaching each gate to
 * recognise a fixture, which would be a hole any real defect could hide in.
 */
const FIXTURE_FILES = new Set([
  'tests/check-defect-classes.test.ts',
  'scripts/gate-fixtures.ts',
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/**
 * Blank out comment lines so a gate tests executable code, not prose.
 *
 * Both of the original gates matched raw file text. That made them unfailable
 * on their own targets: `ci-status.sh` mentions the STALE conclusion in a
 * comment explaining the bug, which satisfied the test no matter what the jq
 * expression did (review on #109).
 *
 * Block comments are tracked line-wise, and only a line that *begins* with
 * `/*` opens one. A regex that paired `/*` with the next `*\/` anywhere in the
 * text was catastrophically wrong on real source: wsproxy.ts line 1191 has the
 * string `'/attest/* routes are not registered'`, whose `/*` opened a phantom
 * comment that ran to the next real `*\/` 1,094 lines later and deleted 40 KB
 * of live code, including the very log call a gate was checking for.
 *
 * Line-wise is also the safe direction: the worst case is a trailing block
 * comment on a code line surviving, which can only make a gate miss something,
 * never make it delete code it should have judged.
 */
export function stripComments(text: string, kind: 'sh' | 'ts'): string {
  const lineComment = kind === 'ts' ? /^\s*\/\// : /^\s*#/;
  let inBlock = false;

  return text
    .split('\n')
    .map((line) => {
      if (kind === 'ts' && inBlock) {
        if (line.includes('*/')) inBlock = false;
        return '';
      }
      // Only a line that opens with `/*` starts a block. Anything later on the
      // line may be inside a string literal.
      if (kind === 'ts' && /^\s*\/\*/.test(line)) {
        if (!line.includes('*/')) inBlock = true;
        return '';
      }
      return lineComment.test(line) ? '' : line;
    })
    .join('\n');
}

/** A gate that judges one file at a time. */
export interface FileGate {
  id: string;
  applies: (relPath: string) => boolean;
  scan: (relPath: string, text: string) => Finding[];
}

/** A gate that needs the whole repo at once. */
export interface CorpusGate {
  id: string;
  scanCorpus: (files: Map<string, string>) => Finding[];
}

const isTs = (f: string) => f.endsWith('.ts');
const isShOrTs = (f: string) => f.endsWith('.sh') || f.endsWith('.ts');
/** Production source: the proxy entrypoint and the modules it imports. */
const isProductionTs = (f: string) =>
  f === 'wsproxy.ts' || (f.startsWith('src/') && f.endsWith('.ts'));

// ---------------------------------------------------------------------------
// Gate — symlink-unsafe temporary files
//
// Origin: CodeQL js/insecure-temporary-file, first on tests/app-attest-keys.ts
// (PR #104), then fifteen more alerts across tests/utilities.test.ts that the
// original gate could not see: it only knew the `tmpdir()` call, and those
// sites wrote the shared temp directory as a bare string literal instead.
//
// A predictable path under the shared temp dir can be pre-created as a symlink
// by another local user, redirecting the write. mkdtempSync creates a 0700
// directory with an unguessable suffix, so the whole subtree is private.
// ---------------------------------------------------------------------------
const TEMP_DIR_LITERAL = /['"`](\/tmp|\/var\/tmp)\//;

export const unsafeTempFileGate: FileGate = {
  id: 'unsafe-temp-file',
  applies: isTs,
  scan(relPath, text) {
    const findings: Finding[] = [];
    const lines = stripComments(text, 'ts').split('\n');

    lines.forEach((line, i) => {
      // Safe when the join is the argument to mkdtemp — often written across
      // two lines, so look at the previous line too.
      const context = `${lines[i - 1] ?? ''}\n${line}`;
      if (/mkdtemp/.test(context)) return;

      if (/\btmpdir\(\)/.test(line)) {
        findings.push({
          gate: 'unsafe-temp-file',
          file: relPath,
          line: i + 1,
          message:
            'tmpdir() joined with a predictable name. Use fs.mkdtempSync(path.join(tmpdir(), "prefix-")) and put files inside it.',
        });
        return;
      }

      if (TEMP_DIR_LITERAL.test(line)) {
        findings.push({
          gate: 'unsafe-temp-file',
          file: relPath,
          line: i + 1,
          message:
            'Hardcoded path under the shared temp directory. Another local user can pre-create that name as a symlink. Use fs.mkdtempSync(path.join(os.tmpdir(), "prefix-")).',
        });
      }
    });

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Gate — enumerating failure states instead of allowlisting success
//
// Origin: reviewer P2 on scripts/ci-status.sh (PR #107). The script listed the
// CheckConclusionState values it considered failures and omitted STALE and
// STARTUP_FAILURE, so those runs reported "All checks passed", exit 0.
//
// The general defect is denylisting an open-ended enum owned by someone else.
// This gate only knows about GitHub check conclusions, which is the concrete
// case that bit us; it deliberately does not try to detect the pattern in
// general, because that produces false positives on every legitimate switch.
// ---------------------------------------------------------------------------
const GH_FAILURE_STATES = ['TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];

export const enumDenylistGate: FileGate = {
  id: 'enum-denylist',
  applies: isShOrTs,
  scan(relPath, text) {
    const stripped = stripComments(
      text,
      relPath.endsWith('.ts') ? 'ts' : 'sh',
    );
    // Only look at files that clearly reason about GitHub check conclusions.
    if (!/conclusion/i.test(stripped) || !/FAILURE/.test(stripped)) return [];

    const mentions = GH_FAILURE_STATES.filter((s) => stripped.includes(s));
    if (mentions.length === 0 || stripped.includes('STALE')) return [];

    // Point at the first line naming a failure state — the tokens rarely sit
    // on one line, so requiring both here reported line 1 and helped nobody.
    const line =
      stripped
        .split('\n')
        .findIndex((l) => GH_FAILURE_STATES.some((st) => l.includes(st))) + 1;

    return [
      {
        gate: 'enum-denylist',
        file: relPath,
        line: Math.max(line, 1),
        message:
          'Enumerates GitHub check-conclusion failures without STALE. Allowlist success values (SUCCESS/NEUTRAL/SKIPPED) instead of listing failures.',
      },
    ];
  },
};

// ---------------------------------------------------------------------------
// Gate — undefined overrides silently clobbering defaults
//
// Origin: MWP-63 fixed this once for background push. It came back in
// BackgroundPushScheduler, and review caught it again on PR #114.
//
// `{ ...defaults, ...overrides }` reads as "apply defaults", but a key that is
// present and undefined overwrites the default with undefined. runtime-config
// builds its optional blocks with helpers returning `number | undefined`, so
// every key is present and most are undefined on a default install. Nothing
// throws: the undefined reaches arithmetic, `now - last >= undefined` is false
// forever, and the feature stops running with every log line still green.
//
// Scoped to production source. Test helpers spread over defaults deliberately,
// and flagging them would make this gate noise.
// ---------------------------------------------------------------------------
export const spreadOverDefaultsGate: FileGate = {
  id: 'spread-over-defaults',
  applies: isProductionTs,
  scan(relPath, text) {
    const findings: Finding[] = [];
    // Only meaningful when the spread source is declared Partial<> — that is
    // what makes "present but undefined" reachable for the caller.
    if (!/Partial</.test(text)) return findings;

    const lines = stripComments(text, 'ts').split('\n');

    lines.forEach((line, i) => {
      const spread = line.match(/^\s*\.\.\.([A-Za-z_$][\w$]*),\s*$/);
      if (!spread) return;

      // Walk back to the opening of this object literal. If any property was
      // assigned before the spread, those are defaults being clobbered.
      let assignedBefore = false;
      for (let j = i - 1; j >= 0 && j >= i - 40; j--) {
        const prev = lines[j] ?? '';
        if (/=\s*\{\s*$/.test(prev)) break;
        if (/^\s*[A-Za-z_$][\w$]*\s*:\s*.+,\s*$/.test(prev)) {
          assignedBefore = true;
        }
      }
      if (!assignedBefore) return;

      findings.push({
        gate: 'spread-over-defaults',
        file: relPath,
        line: i + 1,
        message: `Spreading "${spread[1]}" over a defaults literal: a key that is present and undefined overwrites the default with undefined. Use withDefaults(defaults, ${spread[1]}) from src/with-defaults.ts, which skips undefined and preserves an explicit 0.`,
      });
    });

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Gate — truncating writes to persistent state
//
// Origin: MWP-95. `writeFileSync` on the live path truncates it first, so a
// crash, a full disk, or a container stop mid-write leaves a truncated file —
// and loadAttestedKeys treats unparseable JSON as "start fresh", silently
// deregistering every device.
//
// saveAttestedKeys is the exemplar: stage inside a mkdtemp sibling, fsync, and
// rename. Writing through an open descriptor is how that is spelled, so a
// write whose first argument is a path is the thing to catch. There are zero
// such writes in production source today.
// ---------------------------------------------------------------------------
export const truncatingStateWriteGate: FileGate = {
  id: 'truncating-state-write',
  applies: isProductionTs,
  scan(relPath, text) {
    const findings: Finding[] = [];
    const lines = stripComments(text, 'ts').split('\n');

    lines.forEach((line, i) => {
      const call = line.match(/\bwriteFileSync\s*\(\s*([A-Za-z_$][\w$.]*)/);
      if (!call) return;
      // A descriptor from openSync is the safe, staged form.
      if (/^(handle|fd|fileHandle)$/.test(call[1])) return;

      findings.push({
        gate: 'truncating-state-write',
        file: relPath,
        line: i + 1,
        message: `writeFileSync(${call[1]}, …) truncates the live file before writing it. A crash mid-write leaves a partial file that the loader treats as absent. Stage into a mkdtemp sibling, fsync the descriptor, then renameSync over the target — see saveAttestedKeys in src/app-attest.ts.`,
      });
    });

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Gate — preflight must cover every CI job, or say which it does not
//
// Origin: reviewer P2 on CLAUDE.md (PR #107). The docs claimed `--full`
// covered "the other two CI jobs" when the workflow has four besides
// `quality`, so preflight:full could pass while CI failed.
//
// Every job in test.yml must be either invoked by preflight.sh or named in its
// explicit coverage map. Adding a CI job now fails this gate until preflight
// is updated — which is the point.
// ---------------------------------------------------------------------------
export const ciJobCoverageGate: CorpusGate = {
  id: 'ci-job-coverage',
  scanCorpus(files) {
    const findings: Finding[] = [];
    const workflow = files.get('.github/workflows/test.yml');
    const preflight = files.get('scripts/preflight.sh');

    if (workflow === undefined || preflight === undefined) {
      return [
        {
          gate: 'ci-job-coverage',
          file: '.github/workflows/test.yml',
          line: 1,
          message:
            'Could not read the workflow or preflight.sh — this gate cannot verify coverage, so it fails rather than passing silently.',
        },
      ];
    }

    // Job ids are the two-space-indented keys under `jobs:`.
    const jobsSection = workflow.slice(workflow.indexOf('\njobs:'));
    const jobs = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map(
      (m) => m[1],
    );

    // Parse the CI_JOB_COVERAGE map from EXECUTABLE lines only. Matching
    // arbitrary substrings let a job id in a comment stand in as proof of
    // coverage, so deleting the run_gate call kept the gate green (review
    // #109).
    const declared = new Map<string, string>();
    for (const line of stripComments(preflight, 'sh').split('\n')) {
      const m = line.match(/^\s*\[([a-z0-9_-]+)\]="([^"]*)"/);
      if (m) declared.set(m[1], m[2]);
    }

    for (const job of jobs) {
      const spec = declared.get(job);
      if (spec === undefined) {
        findings.push({
          gate: 'ci-job-coverage',
          file: 'scripts/preflight.sh',
          line: 1,
          message: `CI job "${job}" has no entry in preflight.sh's CI_JOB_COVERAGE map. Add [${job}]="cmd:…" or [${job}]="skip:reason".`,
        });
      } else if (!/^(inline|cmd:.+|docker:.+|root:.+|skip:.+)$/.test(spec)) {
        findings.push({
          gate: 'ci-job-coverage',
          file: 'scripts/preflight.sh',
          line: 1,
          message: `CI job "${job}" has an unrecognised coverage spec "${spec}". Use inline, cmd:<command>, docker:<command>, root:<command>, or skip:<reason>.`,
        });
      }
    }

    for (const job of declared.keys()) {
      if (!jobs.includes(job)) {
        findings.push({
          gate: 'ci-job-coverage',
          file: 'scripts/preflight.sh',
          line: 1,
          message: `preflight.sh declares coverage for "${job}", which is not a job in test.yml. Stale entry — remove it.`,
        });
      }
    }

    if (jobs.length === 0) {
      findings.push({
        gate: 'ci-job-coverage',
        file: '.github/workflows/test.yml',
        line: 1,
        message:
          'Parsed zero jobs from the workflow — this gate cannot verify coverage, so it fails rather than passing silently.',
      });
    }

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Gate — SPDX identifier on every production source file
//
// Origin: reviewer P2 on PR #110. The bulk addition covered 19 of the 20 files
// under src/, missing src/types/index.ts because the scan was not recursive.
// The PR merged with its own acceptance criterion — "every source file has the
// identifier" — unmet, and it stayed unmet on main until this sweep.
//
// The general defect is a bulk edit that reports success against the set it
// happened to enumerate rather than the set it claimed.
// ---------------------------------------------------------------------------
/**
 * The tag on a line of its own, optionally behind a comment marker.
 *
 * Searching the whole file for the bare phrase accepted a file that only
 * mentions it in prose (review on #116). Requiring line 1 exactly would be
 * wrong in the other direction: wsproxy.ts carries the tag at line 12, inside
 * the provenance block that predates it, which is a legitimate placement.
 */
const SPDX_TAG = /^\s*(?:\/\/|\/\*|\*|#)?\s*SPDX-License-Identifier:\s*\S+/;
/** Header region — the leading comment block, generously bounded. */
const SPDX_HEADER_LINES = 30;

export const spdxHeaderGate: CorpusGate = {
  id: 'spdx-header',
  scanCorpus(files) {
    const findings: Finding[] = [];
    for (const [relPath, text] of files) {
      if (!isProductionTs(relPath)) continue;
      const header = text.split('\n', SPDX_HEADER_LINES);
      if (header.some((line) => SPDX_TAG.test(line))) continue;
      findings.push({
        gate: 'spdx-header',
        file: relPath,
        line: 1,
        message:
          'Production source without an SPDX-License-Identifier tag in its header. Add "// SPDX-License-Identifier: GPL-3.0-or-later" on a line of its own. A mention in prose does not count.',
      });
    }
    return findings;
  },
};

// ---------------------------------------------------------------------------
// Gate — runbooks telling operators to grep for strings the code never emits
//
// Origin: reviewer P2 on PR #105. The cutover runbook had operators count
// occurrences of "Unknown key" in the journal as acceptance evidence. wsproxy
// logs "Rejected upgrade: unknown App Attest keyId"; "Unknown key" was only
// ever the HTTP response reason. The count was structurally always zero, so
// the evidence was not merely wrong — it was reassuring.
//
// Any quoted multi-word pattern a deployment runbook greps for must exist in
// the source that is supposed to emit it.
// ---------------------------------------------------------------------------
export const docLogLiteralGate: CorpusGate = {
  id: 'doc-log-literal',
  scanCorpus(files) {
    const findings: Finding[] = [];
    // Comment-stripped, because a log message quoted in a comment is not the
    // application emitting it. Building this from raw text reproduced the very
    // failure described above — prose standing in as proof (review on #116).
    const sources = [...files]
      .filter(([f]) => isProductionTs(f))
      .map(([, text]) => stripComments(text, 'ts'))
      .join('\n');

    for (const [relPath, text] of files) {
      if (!relPath.startsWith('docs/deployment/')) continue;

      text.split('\n').forEach((line, i) => {
        // grep only. journalctl's own quoted arguments (--since '1 hour ago')
        // are time expressions, not claims about what the proxy logs.
        for (const [, literal] of line.matchAll(/\bgrep\b[^|#]*?'([^']+)'/g)) {
          // Multi-word only: a bare identifier is as likely to be a filename
          // or a flag value as a log message.
          if (!literal.includes(' ')) continue;
          if (sources.includes(literal)) continue;
          findings.push({
            gate: 'doc-log-literal',
            file: relPath,
            line: i + 1,
            message: `Runbook greps for "${literal}", which appears in no production source file. The count is structurally always zero, so the evidence reads as reassuring while proving nothing. Quote the string the code actually emits.`,
          });
        }
      });
    }

    return findings;
  },
};

// ---------------------------------------------------------------------------
// Gate — every gate must have a test proving it can fail
//
// Origin: the recurring shape behind three separate review findings. On #109 a
// gate matched explanatory prose rather than executable code, so it was green
// no matter what the code did. On #105 an acceptance check passed in both the
// "state transferred" and "state lost" scenarios. On #114 a test asserted a
// constant against a hand-copied literal of itself.
//
// The one thing all three have in common is that nobody ever watched them go
// red. This gate cannot judge semantics, but it can require that each gate
// above is named by a test that feeds it a violation.
// ---------------------------------------------------------------------------
/**
 * Findings for every gate id with no fixture in the registry.
 *
 * Exported and parameterised so the meta-gate's own negative case — a registry
 * with a gap — is reachable from a test. The gate itself always runs against
 * the real registry, which is complete.
 */
export function missingFixtureFindings(
  covered: ReadonlySet<string>,
  ids: string[] = ALL_GATE_IDS,
): Finding[] {
  return ids
    .filter((id) => id !== 'gate-has-negative-test')
    .filter((id) => !covered.has(id))
    .map((id) => ({
      gate: 'gate-has-negative-test',
      file: 'scripts/gate-fixtures.ts',
      line: 1,
      message: `Gate "${id}" has no fixture in NEGATIVE_FIXTURES. Add a violating input so the gate is known to be able to fail; tests/check-defect-classes.test.ts runs every gate against its fixture.`,
    }));
}

export const gateHasNegativeTestGate: CorpusGate = {
  id: 'gate-has-negative-test',
  // Structural: Object keys against the gate registry, not a text search.
  // The first version grepped the test file for the gate id, which an import
  // or a comment satisfied — an unfailable check guarding against unfailable
  // checks (review on #116).
  scanCorpus: () =>
    missingFixtureFindings(new Set(Object.keys(NEGATIVE_FIXTURES))),
};

export const FILE_GATES: FileGate[] = [
  unsafeTempFileGate,
  enumDenylistGate,
  spreadOverDefaultsGate,
  truncatingStateWriteGate,
];

export const CORPUS_GATES: CorpusGate[] = [
  ciJobCoverageGate,
  spdxHeaderGate,
  docLogLiteralGate,
  gateHasNegativeTestGate,
];

export const ALL_GATE_IDS = [
  ...FILE_GATES.map((g) => g.id),
  ...CORPUS_GATES.map((g) => g.id),
];

export function runAllGates(files: Map<string, string>): Finding[] {
  const findings: Finding[] = [];

  for (const [relPath, text] of files) {
    if (FIXTURE_FILES.has(relPath)) continue;
    for (const gate of FILE_GATES) {
      if (gate.applies(relPath)) findings.push(...gate.scan(relPath, text));
    }
  }

  for (const gate of CORPUS_GATES) findings.push(...gate.scanCorpus(files));

  return findings;
}

/** Read every tracked file into memory, keyed by repo-relative path. */
export function readRepo(root: string = ROOT): Map<string, string> {
  const files = new Map<string, string>();
  for (const full of walk(root)) {
    try {
      files.set(path.relative(root, full), readFileSync(full, 'utf-8'));
    } catch {
      // Unreadable (a broken symlink, a socket) — nothing to judge.
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (import.meta.main) {
  const files = readRepo();
  const findings = runAllGates(files);

  if (findings.length === 0) {
    console.log(
      `check:defect-classes — all ${ALL_GATE_IDS.length} gates clean across ${files.size} files`,
    );
    process.exit(0);
  }

  const byGate = new Map<string, Finding[]>();
  for (const f of findings) {
    const list = byGate.get(f.gate) ?? [];
    list.push(f);
    byGate.set(f.gate, list);
  }
  for (const [gate, items] of byGate) {
    console.error(`\n✗ ${gate} (${items.length})`);
    for (const f of items) {
      console.error(`  ${f.file}:${f.line}`);
      console.error(`    ${f.message}`);
    }
  }
  console.error(
    `\n${findings.length} finding(s) across ${byGate.size} gate(s).`,
  );
  process.exit(1);
}
