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
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');

interface Finding {
  gate: string;
  file: string;
  line: number;
  message: string;
}

const findings: Finding[] = [];

/** Files git would track: skip build output, deps, and gitignored worktrees. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'coverage',
  '.claude',
  'release',
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

const allFiles = walk(ROOT);
const tsFiles = allFiles.filter((f) => f.endsWith('.ts'));
const rel = (f: string) => path.relative(ROOT, f);

// ---------------------------------------------------------------------------
// Gate 1 — symlink-unsafe temporary files
//
// Origin: CodeQL js/insecure-temporary-file on tests/app-attest-keys.test.ts
// (PR #104) and again on the same pattern in PR #107's test.
//
// A predictable path under the shared temp dir can be pre-created as a
// symlink by another local user, redirecting the write. mkdtempSync creates a
// 0700 directory with an unguessable suffix, so the whole subtree is private.
// ---------------------------------------------------------------------------
for (const file of tsFiles) {
  const lines = readFileSync(file, 'utf-8').split('\n');
  lines.forEach((line, i) => {
    if (!/\btmpdir\(\)/.test(line)) return;
    // Safe when this join is the argument to mkdtemp — which is often written
    // across two lines, so look at the previous line too.
    const context = `${lines[i - 1] ?? ''}\n${line}`;
    if (/mkdtemp/.test(context)) return;
    findings.push({
      gate: 'unsafe-temp-file',
      file: rel(file),
      line: i + 1,
      message:
        'tmpdir() joined with a predictable name. Use fs.mkdtempSync(path.join(tmpdir(), "prefix-")) and put files inside it.',
    });
  });
}

// ---------------------------------------------------------------------------
// Gate 2 — enumerating failure states instead of allowlisting success
//
// Origin: reviewer P2 on scripts/ci-status.sh (PR #107). The script listed
// the CheckConclusionState values it considered failures and omitted STALE
// and STARTUP_FAILURE, so those runs reported "All checks passed", exit 0.
//
// The general defect is denylisting an open-ended enum owned by someone else.
// This gate only knows about GitHub check conclusions, which is the concrete
// case that bit us; it deliberately does not try to detect the pattern in
// general, because that produces false positives on every legitimate switch.
// ---------------------------------------------------------------------------
const GH_FAILURE_STATES = ['TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'];
for (const file of allFiles.filter(
  (f) => f.endsWith('.sh') || f.endsWith('.ts'),
)) {
  const text = readFileSync(file, 'utf-8');
  // Only look at files that clearly reason about GitHub check conclusions.
  if (!/conclusion/i.test(text) || !/FAILURE/.test(text)) continue;
  const mentions = GH_FAILURE_STATES.filter((s) => text.includes(s));
  // A file that names some failure states but not STARTUP_FAILURE/STALE is
  // denylisting an enum it does not own.
  if (mentions.length > 0 && !text.includes('STALE')) {
    const line =
      text
        .split('\n')
        .findIndex((l) => /conclusion/i.test(l) && /FAILURE/.test(l)) + 1;
    findings.push({
      gate: 'enum-denylist',
      file: rel(file),
      line: Math.max(line, 1),
      message:
        'Enumerates GitHub check-conclusion failures without STALE. Allowlist success values (SUCCESS/NEUTRAL/SKIPPED) instead of listing failures.',
    });
  }
}

// ---------------------------------------------------------------------------
// Gate 3 — preflight must cover every CI job, or say which it does not
//
// Origin: reviewer P2 on CLAUDE.md (PR #107). The docs claimed `--full`
// covered "the other two CI jobs" when the workflow has four besides
// `quality`, so preflight:full could pass while CI failed.
//
// Every job in test.yml must be either invoked by preflight.sh or named in
// its explicit SKIPPED list. Adding a CI job now fails this gate until
// preflight is updated — which is the point.
// ---------------------------------------------------------------------------
const workflowPath = path.join(ROOT, '.github/workflows/test.yml');
const preflightPath = path.join(ROOT, 'scripts/preflight.sh');
try {
  const workflow = readFileSync(workflowPath, 'utf-8');
  const preflight = readFileSync(preflightPath, 'utf-8');
  // Job ids are the two-space-indented keys under `jobs:`.
  const jobsSection = workflow.slice(workflow.indexOf('\njobs:'));
  const jobs = [...jobsSection.matchAll(/^ {2}([a-z][a-z0-9_-]*):$/gm)].map(
    (m) => m[1],
  );
  for (const job of jobs) {
    if (!preflight.includes(job)) {
      findings.push({
        gate: 'ci-job-coverage',
        file: 'scripts/preflight.sh',
        line: 1,
        message: `CI job "${job}" is neither run nor listed as skipped by preflight.sh. Add it, or add it to SKIPPED with the reason.`,
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
} catch (err) {
  findings.push({
    gate: 'ci-job-coverage',
    file: '.github/workflows/test.yml',
    line: 1,
    message: `Could not read workflow or preflight: ${(err as Error).message}`,
  });
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
if (findings.length === 0) {
  console.log('check:defect-classes — all gates clean');
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
