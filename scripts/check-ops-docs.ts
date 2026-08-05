/**
 * Fail when a configuration variable can abort startup but has no
 * troubleshooting entry in docs/operations.md.
 *
 * A fail-fast startup error is the first thing an operator sees when a deploy
 * goes wrong, and the only thing they have to work from. "Every startup error
 * has a remedy" is a claim about a set, and sets drift: the next validation
 * added to runtime-config.ts is one nobody remembers to document, and the gap
 * is invisible until someone hits it in production at 2am.
 *
 * This check found its own first defect. When it was written,
 * SHUTDOWN_DEADLINE_MS/SHUTDOWN_GRACE_MS could abort startup and appeared
 * nowhere in the operations guide, despite a manual pass that believed it had
 * covered everything.
 *
 * Direction is deliberate, matching check-config-docs: source is the
 * authority and docs must catch up. A documented variable that can no longer
 * fail is stale rather than dangerous, so it is not reported.
 *
 * Keying on the variable name rather than the message text is also
 * deliberate. Message wording changes often and harmlessly; the variable is
 * what an operator greps for when they read it off a failed unit.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { varsInSource } from './check-config-docs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SOURCE = path.join(repoRoot, 'src', 'runtime-config.ts');
const DOCS = path.join(repoRoot, 'docs', 'operations.md');
const SECTION = '## Troubleshooting';

/** Text between a balanced pair of delimiters, starting just after `from`. */
const balanced = (
  source: string,
  from: number,
  open: string,
  close: string,
) => {
  let depth = 1;
  let i = from;
  while (i < source.length && depth > 0) {
    if (source[i] === open) depth++;
    else if (source[i] === close) depth--;
    i++;
  }
  return source.slice(from, i - 1);
};

/**
 * The regions of runtime-config.ts that can produce a startup error.
 *
 * Two shapes, because there are two: the `errors.push(...)` calls themselves,
 * and the `validate*` helpers whose returned string is pushed by a caller.
 * Scanning the whole file instead would be simpler and wrong — an apostrophe
 * in a comment is enough to derail a naive literal scan, and the failure mode
 * is a check that reports success while a variable ships undocumented.
 */
export const errorRegions = (source: string): string[] => {
  const regions: string[] = [];

  // Only `lastIndex` matters, so the match object is deliberately not bound.
  const push = /errors\.push\(/g;
  while (push.exec(source) !== null) {
    regions.push(balanced(source, push.lastIndex, '(', ')'));
  }

  const helper = /function\s+validate[A-Z]\w*\s*\(/g;
  while (helper.exec(source) !== null) {
    const brace = source.indexOf('{', helper.lastIndex);
    if (brace !== -1) regions.push(balanced(source, brace + 1, '{', '}'));
  }

  return regions;
};

/** Configuration variables that can appear in a startup error. */
export const failFastVars = (source: string): string[] => {
  const known = new Set(varsInSource(source));
  const found = new Set<string>();
  for (const region of errorRegions(source)) {
    for (const token of region.match(/\b[A-Z][A-Z0-9_]{3,}\b/g) ?? []) {
      if (known.has(token)) found.add(token);
    }
  }
  return [...found].sort();
};

/** The troubleshooting section, or the empty string when it is absent. */
export const troubleshootingSection = (docs: string): string => {
  const start = docs.indexOf(SECTION);
  if (start === -1) return '';
  return docs.slice(start);
};

export const missingEntries = (source: string, docs: string): string[] => {
  const section = troubleshootingSection(docs);
  return failFastVars(source).filter((name) => !section.includes(name));
};

if (import.meta.main) {
  const source = readFileSync(SOURCE, 'utf8');
  const docs = readFileSync(DOCS, 'utf8');

  if (troubleshootingSection(docs) === '') {
    console.error(
      `check-ops-docs: docs/operations.md has no "${SECTION}" section, so no ` +
        `startup error is documented at all.`,
    );
    process.exit(1);
  }

  const missing = missingEntries(source, docs);
  if (missing.length > 0) {
    console.error(
      `check-ops-docs: ${missing.length} configuration variable(s) can abort ` +
        `startup but have no troubleshooting entry in docs/operations.md:\n` +
        missing.map((name) => `  ${name}`).join('\n') +
        `\n\nAdd a row under "${SECTION}" giving the message an operator will ` +
        `see and what to do about it.`,
    );
    process.exit(1);
  }

  const total = failFastVars(source).length;
  console.log(
    `check-ops-docs: ${total} variables can abort startup; all are documented ` +
      `in docs/operations.md.`,
  );
}
