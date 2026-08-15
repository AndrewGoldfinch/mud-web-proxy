/**
 * Fail when a configuration variable exists in src/runtime-config.ts but is
 * not documented in docs/configuration.md, or when either operator template
 * drifts from the active runtime configuration.
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
const TEMPLATES = [
  path.join(repoRoot, '.env.example'),
  path.join(repoRoot, '.env.compose.example'),
];
const COMPOSE_ONLY_ENV_VARS: ReadonlySet<string> = new Set([
  'MWP_ACME_EMAIL',
  'MWP_DOMAIN',
  'MWP_IMAGE',
]);

// Commented assignments are part of these templates: they advertise optional
// defaults to operators and therefore count for parity. Consequently, prose
// examples must not start a comment line in dotenv assignment form.
const TEMPLATE_ASSIGNMENT = /^\s*(?:#\s*)?([A-Z][A-Z0-9_]{2,})\s*=.*$/gm;

/**
 * Every variable the runtime reads, however it reads it.
 *
 * This is textual, not a parse, so it recognises access forms rather than
 * understanding them. The forms below are the ones the code actually uses,
 * plus the two that review flagged as silently missed. A form nobody has
 * written yet — rebinding `env` to another name and reading through that —
 * would still escape, and would do so quietly, which is this check's one
 * genuine weakness. Adding such a read means teaching this function about it.
 */
export const varsInSource = (source: string): Set<string> => {
  const names = new Set<string>();

  // Direct property access, optional chaining included: env.WS_PORT, env?.WS_PORT
  for (const [, name] of source.matchAll(/env\??\.([A-Z][A-Z0-9_]{2,})\b/g)) {
    names.add(name);
  }

  // Destructuring: const { WS_PORT, TN_HOST: host } = env. Neither the
  // property-access nor the string-literal pattern sees these, so without
  // this the check would report success while the variable went undocumented.
  for (const [, group] of source.matchAll(/\{([^{}]*)\}\s*=\s*env\b/g)) {
    for (const [, name] of group.matchAll(/\b([A-Z][A-Z0-9_]{2,})\b/g)) {
      names.add(name);
    }
  }

  // Every other read routes the name through a string literal, whether as
  // env['X'], readBooleanEnv(env, 'X', …), a local closure, or a list of
  // required names. Matching the literal rather than each call shape means a
  // new helper does not silently escape the check.
  for (const [, name] of source.matchAll(/['"]([A-Z][A-Z0-9_]{2,})['"]/g)) {
    names.add(name);
  }

  return names;
};

export const RETIRED_ENV_VARS: ReadonlySet<string> = new Set([
  'ALLOW_INSECURE_PRODUCTION_NO_TLS',
  'ALLOW_MTLS_FALLBACK',
  'DISABLE_TLS',
  'MTLS_CLIENT_CA_PATH',
  'ONLY_ALLOW_DEFAULT_SERVER',
  'TRUST_PROXY',
]);

export const rejectedRetiredVarsInSource = (source: string): Set<string> => {
  const names = new Set<string>();
  for (const [, name] of source.matchAll(
    /if\s*\(\s*env\.([A-Z][A-Z0-9_]{2,})\s*!==\s*undefined\s*\)\s*\{\s*errors\.push\(/g,
  )) {
    names.add(name);
  }
  return names;
};

export const activeVarsInSource = (source: string): Set<string> => {
  const names = varsInSource(source);
  for (const retired of RETIRED_ENV_VARS) names.delete(retired);
  return names;
};

export const varsInTemplate = (template: string): Set<string> => {
  const names = new Set<string>();
  for (const [, name] of template.matchAll(TEMPLATE_ASSIGNMENT)) {
    names.add(name);
  }
  return names;
};

export const duplicateVarsInTemplate = (template: string): string[] => {
  const counts = new Map<string, number>();
  for (const [, name] of template.matchAll(TEMPLATE_ASSIGNMENT)) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([name]) => name)
    .sort();
};

export const missingVars = (
  required: ReadonlySet<string>,
  present: ReadonlySet<string>,
): string[] => [...required].filter((name) => !present.has(name)).sort();

export const unexpectedVars = (
  present: ReadonlySet<string>,
  allowed: ReadonlySet<string>,
): string[] => [...present].filter((name) => !allowed.has(name)).sort();

export const retiredVarsInTemplate = (template: string): string[] =>
  [...varsInTemplate(template)]
    .filter((name) => RETIRED_ENV_VARS.has(name))
    .sort();

/**
 * Every variable named in the reference's tables.
 *
 * Only the first column of a table row counts, not any backticked uppercase
 * token anywhere in the prose. Matching prose reported `IAC`, `SIGINT` and
 * `SIGTERM` as stale configuration variables — noise that teaches a reader to
 * skim this check's output, which is worse than the drift it exists to catch.
 *
 * It also sets a clearer bar: a variable mentioned only in a paragraph is not
 * documented. It belongs in a table with its default.
 */
const varsInDocs = (docs: string): Set<string> => {
  const names = new Set<string>();
  for (const [, name] of docs.matchAll(/^\|\s*`([A-Z][A-Z0-9_]{2,})`/gm)) {
    names.add(name);
  }
  return names;
};

const read = (file: string): string => {
  try {
    return readFileSync(file, 'utf8');
  } catch (err) {
    console.error(
      `check-config-docs: cannot read ${path.relative(repoRoot, file)}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    process.exit(1);
  }
};

// Guarded so the extraction above can be imported and tested without running
// the check or calling process.exit.
if (import.meta.main) {
  const sourceText = read(SOURCE);
  const source = varsInSource(sourceText);
  const active = activeVarsInSource(sourceText);
  const documented = varsInDocs(read(DOCS));
  let failed = false;

  const undocumented = missingVars(source, documented);
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
        `\n\nDocument each reported variable in docs/configuration.md.`,
    );
    failed = true;
  }

  for (const templatePath of TEMPLATES) {
    const template = read(templatePath);
    const relative = path.relative(repoRoot, templatePath);
    const missing = missingVars(active, varsInTemplate(template));
    const retired = retiredVarsInTemplate(template);
    const duplicates = duplicateVarsInTemplate(template).filter((name) =>
      active.has(name),
    );
    const allowed = new Set([...active, ...RETIRED_ENV_VARS]);
    if (path.basename(templatePath) === '.env.compose.example') {
      for (const name of COMPOSE_ONLY_ENV_VARS) allowed.add(name);
    }
    const unexpected = unexpectedVars(varsInTemplate(template), allowed);

    if (missing.length > 0) {
      console.error(
        `check-config-docs: ${relative} is missing ${missing.length} active ` +
          `configuration variable(s):\n` +
          missing.map((name) => `  ${name}`).join('\n'),
      );
      failed = true;
    }

    if (retired.length > 0) {
      console.error(
        `check-config-docs: ${relative} assigns ${retired.length} retired ` +
          `configuration variable(s):\n` +
          retired.map((name) => `  ${name}`).join('\n'),
      );
      failed = true;
    }

    if (duplicates.length > 0) {
      console.error(
        `check-config-docs: ${relative} assigns ${duplicates.length} active ` +
          `configuration variable(s) more than once:\n` +
          duplicates.map((name) => `  ${name}`).join('\n'),
      );
      failed = true;
    }

    if (unexpected.length > 0) {
      console.error(
        `check-config-docs: ${relative} assigns ${unexpected.length} ` +
          `unexpected configuration variable(s):\n` +
          unexpected.map((name) => `  ${name}`).join('\n'),
      );
      failed = true;
    }
  }

  if (failed) process.exit(1);

  console.log(
    `check-config-docs: ${source.size} documented variables; ` +
      `${active.size} active variables present in both operator templates.`,
  );
}
