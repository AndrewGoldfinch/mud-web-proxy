import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { collectBunVersionErrors } from '../scripts/check-bun-version';

const CHECKER = path.resolve(
  import.meta.dir,
  '..',
  'scripts',
  'check-bun-version.ts',
);
const fixtures: string[] = [];

interface FixtureOptions {
  canonicalContent?: string;
  packageContent?: string;
  packageVersion?: string;
}

const makeFixture = async (
  version: string,
  options: FixtureOptions = {},
): Promise<string> => {
  const root = await mkdtemp(path.join(tmpdir(), 'mwp-bun-version-'));
  fixtures.push(root);

  await writeFile(
    path.join(root, '.bun-version'),
    options.canonicalContent ?? `${version}\n`,
  );
  await writeFile(
    path.join(root, 'package.json'),
    options.packageContent ??
      JSON.stringify({
        engines: { bun: options.packageVersion ?? version },
      }),
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

test('accepts exact package and runtime mirrors', async () => {
  const root = await makeFixture('1.2.3');

  expect(await collectBunVersionErrors(root, '1.2.3')).toEqual({
    version: '1.2.3',
    errors: [],
  });
});

test('collects independent package and runtime mismatches', async () => {
  const root = await makeFixture('1.2.3', {
    packageVersion: '1.2.2',
  });

  expect(await collectBunVersionErrors(root, '1.2.1')).toEqual({
    version: '1.2.3',
    errors: [
      'package.json engines.bun must equal 1.2.3; found 1.2.2',
      'running Bun must equal 1.2.3; found 1.2.1',
    ],
  });
});

test('a missing canonical file returns one source error', async () => {
  const root = await makeFixture('1.2.3');
  await rm(path.join(root, '.bun-version'));

  const result = await collectBunVersionErrors(root, '9.9.9');

  expect(result.version).toBe('');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('.bun-version could not be read');
});

test('an unreadable canonical path returns one source error', async () => {
  const root = await makeFixture('1.2.3');
  await rm(path.join(root, '.bun-version'));
  await mkdir(path.join(root, '.bun-version'));

  const result = await collectBunVersionErrors(root, '9.9.9');

  expect(result.version).toBe('');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('.bun-version could not be read');
});

test.each([
  ['', '(empty)'],
  ['1.2', '1.2'],
])(
  'invalid canonical content %p returns one error',
  async (canonicalContent, displayed) => {
    const root = await makeFixture('ignored', { canonicalContent });

    const result = await collectBunVersionErrors(root, '9.9.9');

    expect(result.errors).toEqual([
      `.bun-version must contain an exact x.y.z version; found ${displayed}`,
    ]);
  },
);

test('a missing package manifest returns one source error', async () => {
  const root = await makeFixture('1.2.3');
  await rm(path.join(root, 'package.json'));

  const result = await collectBunVersionErrors(root, '9.9.9');

  expect(result.version).toBe('1.2.3');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toContain('package.json could not be read');
});

test('invalid package JSON returns one source error', async () => {
  const root = await makeFixture('1.2.3', {
    packageContent: '{not-json',
  });

  const result = await collectBunVersionErrors(root, '9.9.9');

  expect(result.version).toBe('1.2.3');
  expect(result.errors).toEqual(['package.json must contain valid JSON']);
});

test('CLI exits zero when every resolved source agrees', async () => {
  const root = await makeFixture(Bun.version);
  const result = await runCheck(root);

  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(
    `check-bun-version: all sources pin Bun ${Bun.version}.`,
  );
  expect(result.stderr).toBe('');
});

test('CLI exits one when a resolved source disagrees', async () => {
  const root = await makeFixture(Bun.version, {
    packageVersion: '9.9.9',
  });
  const result = await runCheck(root);

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe('');
  expect(result.stderr).toContain(
    `package.json engines.bun must equal ${Bun.version}; found 9.9.9`,
  );
});
