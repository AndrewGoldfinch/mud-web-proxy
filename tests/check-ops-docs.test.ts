import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  errorRegions,
  failFastVars,
  missingEntries,
  troubleshootingSection,
} from '../scripts/check-ops-docs';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);

/**
 * The check is only worth having if it sees every way a variable reaches a
 * startup error. A missed shape does not make it noisy — it makes it report
 * success while an undocumented failure ships, which is worse than no check,
 * because it looks like coverage.
 */
describe('errorRegions', () => {
  test('captures a single-line errors.push', () => {
    const regions = errorRegions("errors.push('WS_PORT must be a number.');");
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('WS_PORT');
  });

  test('captures a multi-line concatenated push', () => {
    const regions = errorRegions(
      "errors.push(\n  'TARGET_MODE=arbitrary requires ' +\n  'ARBITRARY_ALLOWED_PORTS.',\n);",
    );
    expect(regions[0]).toContain('ARBITRARY_ALLOWED_PORTS');
  });

  test('does not stop at a parenthesis inside the message', () => {
    const regions = errorRegions(
      'errors.push(`MAX_SESSIONS_GLOBAL (${n}) must be positive. See BIND_HOST.`);',
    );
    expect(regions[0]).toContain('BIND_HOST');
  });

  test('captures a validate helper whose return value is pushed elsewhere', () => {
    const regions = errorRegions(
      'function validateTlsMaterial(a: string) {\n  if (!a) return `TLS_CERT_PATH missing`;\n  return null;\n}',
    );
    expect(regions.some((r) => r.includes('TLS_CERT_PATH'))).toBe(true);
  });

  test('a brace inside the helper body does not truncate it', () => {
    const regions = errorRegions(
      'function validateThing() {\n  const o = { a: 1 };\n  return `TLS_KEY_PATH bad`;\n}',
    );
    expect(regions.some((r) => r.includes('TLS_KEY_PATH'))).toBe(true);
  });
});

describe('failFastVars', () => {
  test('reports only names the module actually reads', () => {
    const source =
      "const a = env.WS_PORT;\nerrors.push('WS_PORT and NOT_A_REAL_VAR are bad.');";
    const vars = failFastVars(source);
    expect(vars).toContain('WS_PORT');
    expect(vars).not.toContain('NOT_A_REAL_VAR');
  });

  test('ignores a variable that is read but can never abort startup', () => {
    const source = 'const a = env.LOG_LEVEL;\nconst b = env.WS_PORT;';
    expect(failFastVars(source)).toEqual([]);
  });
});

describe('troubleshootingSection', () => {
  test('is empty when the section is absent', () => {
    expect(troubleshootingSection('# Operations\n\n## Logs\n')).toBe('');
  });

  test('excludes content before the section', () => {
    const section = troubleshootingSection(
      '## Logs\n\nBIND_HOST appears here.\n\n## Troubleshooting\n\nWS_PORT here.\n',
    );
    expect(section).toContain('WS_PORT');
    expect(section).not.toContain('BIND_HOST');
  });
});

describe('missingEntries', () => {
  test('a variable mentioned only outside the section still counts as missing', () => {
    const source = "const a = env.WS_PORT;\nerrors.push('WS_PORT is bad.');";
    const docs =
      '# Operations\n\nWS_PORT is mentioned.\n\n## Troubleshooting\n\nNothing.\n';
    expect(missingEntries(source, docs)).toEqual(['WS_PORT']);
  });

  test('passes when the section documents it', () => {
    const source = "const a = env.WS_PORT;\nerrors.push('WS_PORT is bad.');";
    const docs =
      '## Troubleshooting\n\n| `WS_PORT must be a number` | Set it. |\n';
    expect(missingEntries(source, docs)).toEqual([]);
  });
});

describe('the live repository', () => {
  test('every variable that can abort startup is documented', () => {
    const source = readFileSync(
      path.join(repoRoot, 'src', 'runtime-config.ts'),
      'utf8',
    );
    const docs = readFileSync(
      path.join(repoRoot, 'docs', 'operations.md'),
      'utf8',
    );
    expect(missingEntries(source, docs)).toEqual([]);
  });

  test('the set is not vacuously empty', () => {
    // A bug that returned no variables would make the check above pass while
    // documenting nothing. Pin a lower bound instead.
    const source = readFileSync(
      path.join(repoRoot, 'src', 'runtime-config.ts'),
      'utf8',
    );
    expect(failFastVars(source).length).toBeGreaterThan(20);
  });
});
