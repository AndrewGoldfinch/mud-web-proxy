/**
 * Fail when a configuration variable exists in src/runtime-config.ts but is
 * not documented in docs/configuration.md.
 *
 * Configuration is the proxy's entire operator interface, and it is read in
 * exactly one place. A variable that ships undocumented is one an operator
 * can only discover by reading the source, which for a security-relevant
 * setting — a target policy, an auth mode, a trusted-proxy list — means the
 * default silently becomes the policy. This check is cheap enough to run on
 * every pull request, and drift is only ever a few minutes old when it fires.
 *
 * Direction is deliberate: source is the authority, docs must catch up. A
 * documented variable that no longer exists is stale rather than dangerous,
 * so it is reported but does not fail the build.
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const SOURCE = path.join(repoRoot, 'src', 'runtime-config.ts');
const DOCS = path.join(repoRoot, 'docs', 'configuration.md');

/**
 * Fully-uppercase string literals in runtime-config.ts that are not
 * environment variables. Empty today; the escape hatch exists so that adding
 * an unrelated constant does not force a documentation entry for it.
 */
const NOT_ENV_VARS = new Set<string>([]);

/** Every variable the runtime reads, however it reads it. */
const varsInSource = (source: string): Set<string> => {
  const names = new Set<string>();

  // Direct property access: env.WS_PORT
  for (const [, name] of source.matchAll(/env\.([A-Z][A-Z0-9_]{2,})\b/g)) {
    names.add(name);
  }

  // Every other read routes the name through a string literal, whether as
  // env['X'], readBooleanEnv(env, 'X', …), a local closure, or a list of
  // required names. Matching the literal rather than each call shape means a
  // new helper does not silently escape the check.
  for (const [, name] of source.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)) {
    names.add(name);
  }

  for (const ignored of NOT_ENV_VARS) names.delete(ignored);
  return names;
};

/** Every variable named in the reference, which cites them in backticks. */
const varsInDocs = (docs: string): Set<string> => {
  const names = new Set<string>();
  for (const [, name] of docs.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)) {
    names.add(name);
  }
  return names;
};

const read = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    console.error(
      `check-config-docs: cannot read ${path.relative(repoRoot, file)}: ${(err as Error).message}`,
    );
    process.exit(1);
  }
};

const source = varsInSource(read(SOURCE));
const documented = varsInDocs(read(DOCS));

const undocumented = [...source].filter((n) => !documented.has(n)).sort();
const stale = [...documented].filter((n) => !source.has(n)).sort();

if (stale.length > 0) {
  console.warn(
    `check-config-docs: documented but not read by src/runtime-config.ts (stale, not fatal):\n` +
      stale.map((n) => `  ${n}`).join('\n'),
  );
}

if (undocumented.length > 0) {
  console.error(
    `check-config-docs: ${undocumented.length} variable(s) read by src/runtime-config.ts ` +
      `but missing from docs/configuration.md:\n` +
      undocumented.map((n) => `  ${n}`).join('\n') +
      `\n\nDocument each in docs/configuration.md, or add it to NOT_ENV_VARS in ` +
      `scripts/check-config-docs.ts if it is not a configuration variable.`,
  );
  process.exit(1);
}

console.log(
  `check-config-docs: ${source.size} configuration variables, all documented.`,
);
