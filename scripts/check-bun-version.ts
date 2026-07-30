/**
 * Keep every supported Bun runtime declaration synchronized with
 * `.bun-version`, the repository's canonical pin.
 */

import { readFile, readdir } from 'fs/promises';
import path from 'path';

interface PackageManifest {
  engines?: {
    bun?: unknown;
  };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const countOccurrences = (source: string, needle: string): number =>
  source.split(needle).length - 1;

export const collectWorkflowVersionErrors = (
  workflowText: string,
): string[] => {
  const errors: string[] = [];
  const explicitInputs = countOccurrences(workflowText, 'bun-version:');
  const setupActions = countOccurrences(workflowText, 'oven-sh/setup-bun');
  const canonicalInputs = countOccurrences(
    workflowText,
    'bun-version-file: .bun-version',
  );

  if (explicitInputs > 0) {
    errors.push(
      'workflow files must not declare bun-version; use bun-version-file: .bun-version',
    );
  }
  if (setupActions !== canonicalInputs) {
    errors.push(
      `every setup-bun action must declare bun-version-file: .bun-version; found ${setupActions} action${setupActions === 1 ? '' : 's'} and ${canonicalInputs} canonical input${canonicalInputs === 1 ? '' : 's'}`,
    );
  }

  return errors;
};

const readWorkflowText = async (repoRoot: string): Promise<string> => {
  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  let files: string[];
  try {
    files = (await readdir(workflowsDir))
      .filter((file) => /\.ya?ml$/.test(file))
      .sort();
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return '';
    }
    throw err;
  }

  return (
    await Promise.all(
      files.map((file) => readFile(path.join(workflowsDir, file), 'utf8')),
    )
  ).join('\n');
};

export const collectBunVersionErrors = async (
  repoRoot: string,
  runtimeVersion: string,
): Promise<{ version: string; errors: string[] }> => {
  let version: string;
  try {
    version = (
      await readFile(path.join(repoRoot, '.bun-version'), 'utf8')
    ).trim();
  } catch (err: unknown) {
    return {
      version: '',
      errors: [`.bun-version could not be read: ${(err as Error).message}`],
    };
  }

  if (!EXACT_VERSION.test(version)) {
    return {
      version,
      errors: [
        `.bun-version must contain an exact x.y.z version; found ${
          version || '(empty)'
        }`,
      ],
    };
  }

  let packageSource: string;
  try {
    packageSource = await readFile(
      path.join(repoRoot, 'package.json'),
      'utf8',
    );
  } catch (err: unknown) {
    return {
      version,
      errors: [`package.json could not be read: ${(err as Error).message}`],
    };
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(packageSource);
  } catch {
    return {
      version,
      errors: ['package.json must contain valid JSON'],
    };
  }

  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    return {
      version,
      errors: ['package.json must contain valid JSON'],
    };
  }

  const errors: string[] = [];
  const packageVersion = (manifest as PackageManifest).engines?.bun;
  if (packageVersion !== version) {
    errors.push(
      `package.json engines.bun must equal ${version}; found ${String(packageVersion)}`,
    );
  }

  try {
    errors.push(
      ...collectWorkflowVersionErrors(await readWorkflowText(repoRoot)),
    );
  } catch (err: unknown) {
    errors.push(
      `.github/workflows could not be read: ${(err as Error).message}`,
    );
  }

  if (runtimeVersion !== version) {
    errors.push(`running Bun must equal ${version}; found ${runtimeVersion}`);
  }

  return { version, errors };
};

if (import.meta.main) {
  collectBunVersionErrors(process.cwd(), process.versions.bun ?? 'unknown')
    .then(({ version, errors }) => {
      if (errors.length > 0) {
        for (const error of errors) {
          console.error(`check-bun-version: ${error}`);
        }
        process.exit(1);
      }
      console.log(`check-bun-version: all sources pin Bun ${version}.`);
    })
    .catch((err: unknown) => {
      console.error(`check-bun-version: ${(err as Error).message}`);
      process.exit(1);
    });
}
