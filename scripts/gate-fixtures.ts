// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * One violating input per gate, as data.
 *
 * This is the registry `gate-has-negative-test` checks, and it is checked
 * structurally — `Object.keys` against the gate registry — not by searching
 * this file's text. A textual check was the first thing review caught here
 * (#116): a gate id mentioned in an import or a comment satisfied it, so the
 * guarantee it claimed to provide was exactly the kind of unfailable check
 * this whole script exists to prevent.
 *
 * `tests/check-defect-classes.test.ts` runs every gate against its fixture and
 * asserts it reports. A gate added without an entry here fails that test on a
 * missing fixture, so the guarantee is executed rather than asserted.
 *
 * The fixtures are deliberate violations, so this file is exempt from the file
 * gates alongside the test file.
 */

/** Input for one gate: a single file for a FileGate, a corpus for a CorpusGate. */
export interface GateFixture {
  file?: { path: string; text: string };
  corpus?: Map<string, string>;
}

const SPDX = '// SPDX-License-Identifier: GPL-3.0-or-later';

/**
 * Keyed by gate id. `gate-has-negative-test` is absent by design: its own
 * negative case is a registry with a gap, which cannot be expressed as an
 * entry in a complete registry. It is covered directly in the test file by
 * calling `missingFixtureFindings(new Set())`.
 */
export const NEGATIVE_FIXTURES = {
  'unsafe-temp-file': {
    file: {
      path: 'tests/x.test.ts',
      text: `const testDir = '/tmp/test-certs';\nfs.mkdirSync(testDir);\n`,
    },
  },

  'enum-denylist': {
    file: {
      path: 'scripts/x.sh',
      // The comment naming STALE is the point: review #109 found that prose
      // alone satisfied this gate. It must still report.
      text:
        `# STALE used to be missing from this list\n` +
        `jq '.conclusion | select(. == "FAILURE" or . == "TIMED_OUT")'\n`,
    },
  },

  'spread-over-defaults': {
    file: {
      path: 'src/x.ts',
      text:
        `${SPDX}\n` +
        `constructor(config: Partial<C> = {}) {\n` +
        `  this.config = {\n` +
        `    intervalMs: 1000,\n` +
        `    maxPerHour: 6,\n` +
        `    ...config,\n` +
        `  };\n` +
        `}\n`,
    },
  },

  'truncating-state-write': {
    file: {
      path: 'src/x.ts',
      text: `${SPDX}\nfs.writeFileSync(filePath, JSON.stringify(obj));\n`,
    },
  },

  'ci-job-coverage': {
    corpus: new Map([
      [
        '.github/workflows/test.yml',
        `on: [push]\njobs:\n  quality:\n    runs-on: ubuntu-latest\n  container:\n    runs-on: ubuntu-latest\n`,
      ],
      [
        'scripts/preflight.sh',
        // Naming the job in a comment must not stand in for covering it.
        `# container is covered by preflight:full\n` +
          `declare -A CI_JOB_COVERAGE=(\n  [quality]="inline"\n)\n`,
      ],
    ]),
  },

  'spdx-header': {
    corpus: new Map([
      [
        'src/types/index.ts',
        // Mentions the tag in prose without ever carrying it. The gate used to
        // accept this (#116).
        `/**\n * Licensing: see SPDX-License-Identifier in the root files.\n */\nexport interface T {}\n`,
      ],
    ]),
  },

  'doc-log-literal': {
    corpus: new Map([
      [
        'src/a.ts',
        // The literal appears only in a comment. Treating that as proof the
        // application emits it was the hole review caught (#116).
        `${SPDX}\n// we log 'Unknown key' somewhere around here\nsrv.log('Rejected upgrade: unknown keyId');\n`,
      ],
      ['docs/deployment/cutover.md', `    grep -c 'Unknown key' || true\n`],
    ]),
  },
} satisfies Record<string, GateFixture>;
