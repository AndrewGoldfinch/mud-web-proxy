import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const CHECKER = path.resolve(
  import.meta.dir,
  '..',
  'scripts',
  'check-bun-version.ts',
);
const fixtures: string[] = [];

interface FixtureOptions {
  packageVersion?: string;
  workflowVersion?: string;
}

const makeFixture = async (
  version: string,
  options: FixtureOptions = {},
): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'mwp-bun-version-'));
  fixtures.push(root);

  await mkdir(path.join(root, '.github', 'workflows'), { recursive: true });
  await writeFile(path.join(root, '.bun-version'), `${version}\n`);
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({
      engines: { bun: options.packageVersion ?? version },
    }),
  );
  await writeFile(
    path.join(root, '.github', 'workflows', 'test.yml'),
    [
      'env:',
      `  BUN_VERSION: '${options.workflowVersion ?? version}'`,
      'jobs:',
      '  quality:',
      '    steps:',
      '      - uses: oven-sh/setup-bun@pinned-sha',
      '        with:',
      '          bun-version: ${{ env.BUN_VERSION }}',
      '',
    ].join('\n'),
  );

  return root;
};

const runCheck = async (
  root: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
  const child = Bun.spawn([process.execPath, CHECKER], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true })),
  );
});

test('accepts an exact pin shared by metadata, workflows, and runtime', async () => {
  const root = await makeFixture(Bun.version);
  const result = await runCheck(root);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    `check-bun-version: all sources pin Bun ${Bun.version}.`,
  );
  expect(result.stderr).toBe('');
});

test('rejects every source that differs from the canonical file', async () => {
  const root = await makeFixture('9.9.9', {
    packageVersion: '>=9.9.9',
    workflowVersion: '9.9.8',
  });
  const result = await runCheck(root);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(
    'package.json engines.bun must equal 9.9.9; found >=9.9.9',
  );
  expect(result.stderr).toContain(
    '.github/workflows/test.yml BUN_VERSION must equal 9.9.9; found 9.9.8',
  );
  expect(result.stderr).toContain(
    `running Bun must equal 9.9.9; found ${Bun.version}`,
  );
});
