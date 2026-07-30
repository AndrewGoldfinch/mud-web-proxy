/**
 * Keep every supported Bun runtime declaration synchronized with
 * `.bun-version`, the repository's canonical pin.
 */

import { readdir, readFile } from 'fs/promises';
import path from 'path';

interface PackageManifest {
  engines?: {
    bun?: unknown;
  };
}

interface SetupBunStep {
  line: number;
  input?: string;
}

const ENV_REFERENCE = '${{ env.BUN_VERSION }}';
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;

const yamlScalar = (value: string): string => {
  const withoutComment = value.replace(/\s+#.*$/, '').trim();
  if (
    (withoutComment.startsWith("'") && withoutComment.endsWith("'")) ||
    (withoutComment.startsWith('"') && withoutComment.endsWith('"'))
  ) {
    return withoutComment.slice(1, -1);
  }
  return withoutComment;
};

const collectSetupBunSteps = (workflow: string): SetupBunStep[] => {
  const lines = workflow.split('\n');
  const steps: SetupBunStep[] = [];

  for (let actionIndex = 0; actionIndex < lines.length; actionIndex += 1) {
    const actionMatch = lines[actionIndex].match(
      /^(\s*)(-\s*)?uses:\s*['"]?oven-sh\/setup-bun@[^'"\s#]+['"]?(?:\s+#.*)?\s*$/,
    );
    if (!actionMatch) {
      continue;
    }

    let stepStart = actionIndex;
    let stepIndent = actionMatch[1].length;

    if (!actionMatch[2]) {
      for (let index = actionIndex - 1; index >= 0; index -= 1) {
        const stepMatch = lines[index].match(/^(\s*)-\s+\S/);
        if (stepMatch && stepMatch[1].length < stepIndent) {
          stepStart = index;
          stepIndent = stepMatch[1].length;
          break;
        }
      }
    }

    let stepEnd = lines.length;
    for (let index = stepStart + 1; index < lines.length; index += 1) {
      const line = lines[index];
      if (line.trim() === '' || line.trimStart().startsWith('#')) {
        continue;
      }

      const indent = line.match(/^\s*/)?.[0].length ?? 0;
      if (
        indent < stepIndent ||
        (indent === stepIndent && /^\s*-\s+\S/.test(line))
      ) {
        stepEnd = index;
        break;
      }
    }

    let input: string | undefined;
    for (let index = stepStart + 1; index < stepEnd; index += 1) {
      const inputMatch = lines[index].match(/^\s*bun-version:\s*(.+)$/);
      if (inputMatch) {
        input = yamlScalar(inputMatch[1]);
        break;
      }
    }

    steps.push({ line: actionIndex + 1, input });
  }

  return steps;
};

export const collectBunVersionErrors = async (
  repoRoot: string,
  runtimeVersion: string,
): Promise<{ version: string; errors: string[] }> => {
  const version = (
    await readFile(path.join(repoRoot, '.bun-version'), 'utf8')
  ).trim();
  const errors: string[] = [];

  if (!EXACT_VERSION.test(version)) {
    errors.push(
      `.bun-version must contain an exact x.y.z version; found ${version || '(empty)'}`,
    );
  }

  const manifest = JSON.parse(
    await readFile(path.join(repoRoot, 'package.json'), 'utf8'),
  ) as PackageManifest;
  const packageVersion = manifest.engines?.bun;
  if (packageVersion !== version) {
    errors.push(
      `package.json engines.bun must equal ${version}; found ${String(packageVersion)}`,
    );
  }

  const workflowsDir = path.join(repoRoot, '.github', 'workflows');
  const workflowFiles = (await readdir(workflowsDir))
    .filter((file) => /\.ya?ml$/.test(file))
    .sort();
  let setupActions = 0;

  for (const file of workflowFiles) {
    const relativeFile = path.join('.github', 'workflows', file);
    const workflow = await readFile(path.join(workflowsDir, file), 'utf8');
    const envVersions = [
      ...workflow.matchAll(/^\s*BUN_VERSION:\s*(.+)$/gm),
    ].map((match) => yamlScalar(match[1]));
    const setupSteps = collectSetupBunSteps(workflow);

    for (const envVersion of envVersions) {
      if (envVersion !== version) {
        errors.push(
          `${relativeFile} BUN_VERSION must equal ${version}; found ${envVersion}`,
        );
      }
    }

    for (const step of setupSteps) {
      setupActions += 1;
      if (step.input === undefined) {
        errors.push(
          `${relativeFile} setup-bun step at line ${step.line} must declare bun-version`,
        );
        continue;
      }

      const input = step.input;
      if (input === ENV_REFERENCE) {
        if (envVersions.length === 0) {
          errors.push(
            `${relativeFile} uses ${ENV_REFERENCE} without declaring BUN_VERSION`,
          );
        }
      } else if (input !== version) {
        errors.push(
          `${relativeFile} bun-version must equal ${version}; found ${input}`,
        );
      }
    }
  }

  if (setupActions === 0) {
    errors.push('no oven-sh/setup-bun action exists in .github/workflows');
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
