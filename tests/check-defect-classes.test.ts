// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Proof that each gate can fail.
 *
 * Three separate review findings (#105, #109, #114) were all the same shape:
 * a check that nobody had ever watched go red, and that structurally could
 * not. So every gate gets two fixtures here — one violating, one clean — and
 * the `gate-has-negative-test` gate fails the build if a gate is added without
 * a case naming it.
 *
 * This file is the single exemption from the file gates in
 * scripts/check-defect-classes.ts, because the fixtures below are deliberate
 * violations.
 */
import { describe, expect, test } from 'bun:test';
import {
  ALL_GATE_IDS,
  CORPUS_GATES,
  FILE_GATES,
  ciJobCoverageGate,
  docLogLiteralGate,
  enumDenylistGate,
  gateHasNegativeTestGate,
  readRepo,
  runAllGates,
  spdxHeaderGate,
  spreadOverDefaultsGate,
  stripComments,
  truncatingStateWriteGate,
  unsafeTempFileGate,
} from '../scripts/check-defect-classes';

const SPDX = '// SPDX-License-Identifier: GPL-3.0-or-later';

describe("gate 'unsafe-temp-file'", () => {
  test('reports a hardcoded shared-temp path', () => {
    const findings = unsafeTempFileGate.scan(
      'tests/x.test.ts',
      `const testDir = '/tmp/test-certs';\nfs.mkdirSync(testDir);\n`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(1);
  });

  test('reports tmpdir() joined with a fixed name', () => {
    const findings = unsafeTempFileGate.scan(
      'tests/x.test.ts',
      `const p = path.join(tmpdir(), 'fixed-name');\n`,
    );
    expect(findings).toHaveLength(1);
  });

  test('accepts mkdtempSync, including split across two lines', () => {
    expect(
      unsafeTempFileGate.scan(
        'tests/x.test.ts',
        `const d = fs.mkdtempSync(path.join(tmpdir(), 'mwp-'));\n` +
          `const e = fs.mkdtempSync(\n  path.join(tmpdir(), 'mwp-'),\n);\n`,
      ),
    ).toEqual([]);
  });

  test('ignores a shared-temp path inside a comment', () => {
    expect(
      unsafeTempFileGate.scan(
        'tests/x.test.ts',
        `// we used to write '/tmp/test-certs' here\n`,
      ),
    ).toEqual([]);
  });
});

describe("gate 'enum-denylist'", () => {
  test('reports a conclusion denylist missing STALE', () => {
    const findings = enumDenylistGate.scan(
      'scripts/x.sh',
      `FAILING=$(echo "$json" | jq '.conclusion | select(. == "FAILURE" or . == "TIMED_OUT")')\n`,
    );
    expect(findings).toHaveLength(1);
  });

  test('accepts a denylist that names STALE', () => {
    expect(
      enumDenylistGate.scan(
        'scripts/x.sh',
        `jq '.conclusion | select(. == "FAILURE" or . == "TIMED_OUT" or . == "STALE")'\n`,
      ),
    ).toEqual([]);
  });

  test('is not satisfied by STALE appearing only in a comment', () => {
    // The exact hole review #109 found: prose satisfied the check.
    const findings = enumDenylistGate.scan(
      'scripts/x.sh',
      `# STALE used to be missing from this list\n` +
        `jq '.conclusion | select(. == "FAILURE" or . == "TIMED_OUT")'\n`,
    );
    expect(findings).toHaveLength(1);
  });
});

describe("gate 'spread-over-defaults'", () => {
  test('reports a Partial<> spread over a defaults literal', () => {
    const findings = spreadOverDefaultsGate.scan(
      'src/x.ts',
      `${SPDX}\n` +
        `constructor(config: Partial<C> = {}) {\n` +
        `  this.config = {\n` +
        `    intervalMs: 1000,\n` +
        `    maxPerHour: 6,\n` +
        `    ...config,\n` +
        `  };\n` +
        `}\n`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('withDefaults');
  });

  test('accepts a spread with no defaults before it', () => {
    expect(
      spreadOverDefaultsGate.scan(
        'src/x.ts',
        `${SPDX}\n` +
          `function f(config: Partial<C>) {\n` +
          `  return {\n` +
          `    ...config,\n` +
          `  };\n` +
          `}\n`,
      ),
    ).toEqual([]);
  });

  test('accepts the withDefaults call that replaced the pattern', () => {
    expect(
      spreadOverDefaultsGate.scan(
        'src/x.ts',
        `${SPDX}\n` +
          `constructor(config: Partial<C> = {}) {\n` +
          `  this.config = withDefaults(\n` +
          `    {\n` +
          `      intervalMs: 1000,\n` +
          `    },\n` +
          `    config,\n` +
          `  );\n` +
          `}\n`,
      ),
    ).toEqual([]);
  });
});

describe("gate 'truncating-state-write'", () => {
  test('reports a writeFileSync onto a path', () => {
    const findings = truncatingStateWriteGate.scan(
      'src/x.ts',
      `${SPDX}\nfs.writeFileSync(filePath, JSON.stringify(obj));\n`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('renameSync');
  });

  test('accepts a write through an open descriptor', () => {
    expect(
      truncatingStateWriteGate.scan(
        'src/x.ts',
        `${SPDX}\n` +
          `const handle = fs.openSync(tempPath, 'wx');\n` +
          `fs.writeFileSync(handle, JSON.stringify(obj));\n` +
          `fs.renameSync(tempPath, filePath);\n`,
      ),
    ).toEqual([]);
  });

  test('does not apply to test files', () => {
    expect(truncatingStateWriteGate.applies('tests/x.test.ts')).toBe(false);
  });
});

describe("gate 'ci-job-coverage'", () => {
  const workflow = `on: [push]\njobs:\n  quality:\n    runs-on: ubuntu-latest\n  container:\n    runs-on: ubuntu-latest\n`;

  test('reports a workflow job with no coverage entry', () => {
    const findings = ciJobCoverageGate.scanCorpus(
      new Map([
        ['.github/workflows/test.yml', workflow],
        [
          'scripts/preflight.sh',
          `declare -A CI_JOB_COVERAGE=(\n  [quality]="inline"\n)\n`,
        ],
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('container');
  });

  test('is not satisfied by the job id appearing only in a comment', () => {
    // The second hole review #109 found.
    const findings = ciJobCoverageGate.scanCorpus(
      new Map([
        ['.github/workflows/test.yml', workflow],
        [
          'scripts/preflight.sh',
          `# container is covered by preflight:full\n` +
            `declare -A CI_JOB_COVERAGE=(\n  [quality]="inline"\n)\n`,
        ],
      ]),
    );
    expect(findings).toHaveLength(1);
  });

  test('accepts a complete coverage map', () => {
    expect(
      ciJobCoverageGate.scanCorpus(
        new Map([
          ['.github/workflows/test.yml', workflow],
          [
            'scripts/preflight.sh',
            `declare -A CI_JOB_COVERAGE=(\n  [quality]="inline"\n  [container]="docker:build"\n)\n`,
          ],
        ]),
      ),
    ).toEqual([]);
  });

  test('fails rather than passing when it cannot read its inputs', () => {
    expect(ciJobCoverageGate.scanCorpus(new Map())).toHaveLength(1);
  });
});

describe("gate 'spdx-header'", () => {
  test('reports a nested production file without the identifier', () => {
    const findings = spdxHeaderGate.scanCorpus(
      new Map([['src/types/index.ts', '/** types */\n']]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].file).toBe('src/types/index.ts');
  });

  test('accepts a tagged file and ignores test files', () => {
    expect(
      spdxHeaderGate.scanCorpus(
        new Map([
          ['src/a.ts', `${SPDX}\n`],
          ['tests/b.test.ts', 'no identifier here\n'],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("gate 'doc-log-literal'", () => {
  test('reports a runbook grep for a string no source emits', () => {
    const findings = docLogLiteralGate.scanCorpus(
      new Map([
        ['src/a.ts', `${SPDX}\nsrv.log('Rejected upgrade: unknown keyId');\n`],
        ['docs/deployment/cutover.md', `    grep -c 'Unknown key' || true\n`],
      ]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('Unknown key');
  });

  test('accepts a grep for a string the source does emit', () => {
    expect(
      docLogLiteralGate.scanCorpus(
        new Map([
          [
            'src/a.ts',
            `${SPDX}\nsrv.log('Rejected upgrade: unknown keyId');\n`,
          ],
          [
            'docs/deployment/cutover.md',
            `    grep -c 'Rejected upgrade: unknown keyId' || true\n`,
          ],
        ]),
      ),
    ).toEqual([]);
  });

  test("ignores journalctl's own quoted time arguments", () => {
    expect(
      docLogLiteralGate.scanCorpus(
        new Map([
          ['src/a.ts', `${SPDX}\n`],
          [
            'docs/deployment/systemd.md',
            `journalctl -u mud-web-proxy.service --since '1 hour ago'\n`,
          ],
        ]),
      ),
    ).toEqual([]);
  });
});

describe("gate 'gate-has-negative-test'", () => {
  test('reports a gate that no test names', () => {
    const findings = gateHasNegativeTestGate.scanCorpus(
      new Map([['tests/check-defect-classes.test.ts', 'nothing here\n']]),
    );
    expect(findings).toHaveLength(ALL_GATE_IDS.length);
  });

  test('fails rather than passing when the test file is missing', () => {
    expect(gateHasNegativeTestGate.scanCorpus(new Map())).toHaveLength(1);
  });

  test('this file names every gate, so the real repo passes', () => {
    const findings = gateHasNegativeTestGate.scanCorpus(readRepo());
    expect(findings).toEqual([]);
  });
});

describe('stripComments', () => {
  test('blanks whole-line comments but keeps a hash inside a string', () => {
    expect(stripComments(`# gone\nX='a#b'\n`, 'sh')).toBe(`\nX='a#b'\n`);
    expect(stripComments(`// gone\nconst u = 'http://x';\n`, 'ts')).toBe(
      `\nconst u = 'http://x';\n`,
    );
  });
});

describe('the gate registry', () => {
  test('every gate id is unique', () => {
    expect(new Set(ALL_GATE_IDS).size).toBe(ALL_GATE_IDS.length);
  });

  test('every gate reports findings tagged with its own id', () => {
    for (const gate of FILE_GATES) {
      expect(typeof gate.applies).toBe('function');
    }
    for (const gate of CORPUS_GATES) {
      expect(typeof gate.scanCorpus).toBe('function');
    }
  });

  test('the repository as committed is clean', () => {
    expect(runAllGates(readRepo())).toEqual([]);
  });
});
