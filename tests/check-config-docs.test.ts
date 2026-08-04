import { describe, expect, test } from 'bun:test';
import {
  activeVarsInSource,
  duplicateVarsInTemplate,
  missingVars,
  RETIRED_ENV_VARS,
  retiredVarsInTemplate,
  varsInSource,
  varsInTemplate,
} from '../scripts/check-config-docs';

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

describe('activeVarsInSource', () => {
  test('classifies exactly the retired settings', () => {
    expect([...RETIRED_ENV_VARS].sort()).toEqual([
      'ALLOW_INSECURE_PRODUCTION_NO_TLS',
      'ALLOW_MTLS_FALLBACK',
      'DISABLE_TLS',
      'MTLS_CLIENT_CA_PATH',
      'ONLY_ALLOW_DEFAULT_SERVER',
      'TRUST_PROXY',
    ]);
  });

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
