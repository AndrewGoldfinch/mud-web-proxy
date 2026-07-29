import { describe, expect, test } from 'bun:test';
import { varsInSource } from '../scripts/check-config-docs';

/**
 * The drift check is only worth having if it sees every way the runtime reads
 * a variable. A missed access form does not make it noisy — it makes it report
 * success while an undocumented variable ships, which is worse than no check
 * at all, because it looks like coverage.
 *
 * Destructuring and optional chaining were both missed by the first version
 * and were caught in review rather than by CI. They have tests now.
 */
describe('varsInSource', () => {
  test('finds direct property access', () => {
    expect(varsInSource('const a = env.WS_PORT;')).toContain('WS_PORT');
  });

  test('finds bracket access', () => {
    expect(varsInSource("const a = env['TN_HOST'];")).toContain('TN_HOST');
  });

  test('finds names passed to helpers as string literals', () => {
    expect(
      varsInSource("readBooleanEnv(env, 'ENABLE_DIAGNOSTICS', false)"),
    ).toContain('ENABLE_DIAGNOSTICS');
  });

  test('finds optional chaining', () => {
    expect(varsInSource('const a = env?.OPTIONAL_FLAG;')).toContain(
      'OPTIONAL_FLAG',
    );
  });

  test('finds destructuring', () => {
    expect(varsInSource('const { NEW_FLAG } = env;')).toContain('NEW_FLAG');
  });

  test('finds every name in a multi-variable destructure', () => {
    const names = varsInSource('const { FIRST_FLAG, SECOND_FLAG } = env;');
    expect(names).toContain('FIRST_FLAG');
    expect(names).toContain('SECOND_FLAG');
  });

  test('finds the source name in a renaming destructure', () => {
    // The property is what the operator sets; the local alias is irrelevant.
    expect(varsInSource('const { RENAMED_FLAG: local } = env;')).toContain(
      'RENAMED_FLAG',
    );
  });

  test('ignores lowercase and short identifiers', () => {
    const names = varsInSource('const { a, bc } = env; const d = env.ok;');
    expect(names.size).toBe(0);
  });

  test('does not treat an unrelated destructure as an env read', () => {
    expect(varsInSource('const { SOME_CONST } = constants;')).not.toContain(
      'SOME_CONST',
    );
  });
});
