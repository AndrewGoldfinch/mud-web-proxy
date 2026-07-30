/**
 * Keep every supported Bun runtime declaration synchronized with
 * `.bun-version`, the repository's canonical pin.
 */

import { readFile } from 'fs/promises';
import path from 'path';

interface PackageManifest {
  engines?: {
    bun?: unknown;
  };
}

const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

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
