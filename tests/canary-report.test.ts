/**
 * The canary report reaches the right verdict (MWP-123 step 6).
 *
 * The gate this serves says growth over the week is a blocker rather than a
 * curiosity, and that "it seemed fine" is not the bar. A reporting script is
 * the wrong place for optimism, so these pin the three outcomes that matter
 * and — more importantly — pin that an unfinished measurement is **not** a
 * pass. `INCOMPLETE` exiting 2 rather than 0 is the whole reason the script
 * has three exit codes instead of two.
 *
 * Series are generated rather than fixtured so the trend is exact: a leak of
 * a known slope must be caught, and flat noise of a known amplitude must not
 * be mistaken for one.
 */

import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const SCRIPT = join(import.meta.dir, '..', 'scripts', 'canary-report.ts');
const dir = mkdtempSync(join(tmpdir(), 'canary-'));

const MEM_MAX = 536870912; // 512 MiB, as the shipped unit enforces
const NOFILE = 1024;

/** A deterministic series: `days` long, with the given per-day growth. */
function series(opts: {
  days: number;
  rssGrowthKibPerDay?: number;
  fdGrowthPerDay?: number;
  restartHalfway?: boolean;
}): string {
  const { days, rssGrowthKibPerDay = 0, fdGrowthPerDay = 0 } = opts;
  const start = 1_780_000_000;
  const n = Math.round(days * 288); // one sample every 5 minutes
  const rows = [
    'iso8601,unix,pid,rss_kib,fds,threads,nrestarts,active_sockets,mem_max_bytes,nofile_limit',
  ];
  // Fixed pseudo-noise, so a run cannot pass or fail by luck.
  let seed = 12345;
  const noise = (amp: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return ((seed / 2147483648) * 2 - 1) * amp;
  };
  for (let i = 0; i < n; i++) {
    const t = start + i * 300;
    const d = (t - start) / 86400;
    const rss = Math.round(90_000 + rssGrowthKibPerDay * d + noise(800));
    const fds = Math.round(60 + fdGrowthPerDay * d + noise(2));
    const pid = opts.restartHalfway && i >= n / 2 ? 4243 : 4242;
    const restarts = opts.restartHalfway && i >= n / 2 ? 1 : 0;
    rows.push(
      `x,${t},${pid},${rss},${fds},12,${restarts},3,${MEM_MAX},${NOFILE}`,
    );
  }
  return rows.join('\n') + '\n';
}

/** One invocation of the canary script under test. */
interface ScriptRun {
  code: number;
  out: string;
}

function run(csv: string): ScriptRun {
  const path = join(dir, `s-${Math.random().toString(36).slice(2)}.csv`);
  writeFileSync(path, csv);
  const p = Bun.spawnSync(['bun', SCRIPT, path]);
  return {
    code: p.exitCode ?? -1,
    out: p.stdout.toString() + p.stderr.toString(),
  };
}

describe('a healthy week passes', () => {
  test('flat usage over eight days exits 0', () => {
    const r = run(series({ days: 8 }));
    expect(r.out).toContain('VERDICT: PASS');
    expect(r.code).toBe(0);
  });
});

describe('growth is a blocker, not a curiosity', () => {
  test('a memory leak fails', () => {
    const r = run(series({ days: 8, rssGrowthKibPerDay: 40 * 1024 }));
    expect(r.out).toContain('VERDICT: FAIL');
    expect(r.out).toMatch(/RSS grew/);
    expect(r.code).toBe(1);
  });

  test('a file-descriptor leak fails', () => {
    const r = run(series({ days: 8, fdGrowthPerDay: 20 }));
    expect(r.out).toContain('VERDICT: FAIL');
    expect(r.out).toMatch(/file descriptors grew/);
    expect(r.code).toBe(1);
  });

  test('a restart during the window fails', () => {
    // A service that keeps dying looks flat, because each restart resets the
    // counters. Flatness earned that way is not health.
    const r = run(series({ days: 8, restartHalfway: true }));
    expect(r.out).toContain('VERDICT: FAIL');
    expect(r.out).toMatch(/restart/);
    expect(r.code).toBe(1);
  });
});

describe('an unfinished measurement is not a pass', () => {
  test('two days exits 2, not 0', () => {
    // The failure mode this exists to prevent: reading "no problems found"
    // off a window too short to have found them.
    const r = run(series({ days: 2 }));
    expect(r.out).toContain('VERDICT: INCOMPLETE');
    expect(r.code).toBe(2);
  });

  test('a missing file exits 2', () => {
    const p = Bun.spawnSync(['bun', SCRIPT, join(dir, 'absent.csv')]);
    expect(p.exitCode).toBe(2);
  });

  test('an empty file exits 2 rather than passing vacuously', () => {
    const r = run(
      'iso8601,unix,pid,rss_kib,fds,threads,nrestarts,active_sockets,mem_max_bytes,nofile_limit\n',
    );
    expect(r.code).toBe(2);
  });
});

describe('the bar is derived from the enforced limits', () => {
  test('noise alone does not trip the memory threshold', () => {
    // Guards the opposite failure: a threshold so tight that ordinary
    // variation fails the gate would get the gate switched off.
    const r = run(series({ days: 8, rssGrowthKibPerDay: 0 }));
    expect(r.out).not.toMatch(/RSS grew/);
  });

  test('the report states the limit it judged against', () => {
    const r = run(series({ days: 8 }));
    expect(r.out).toMatch(/512\.0 MiB limit/);
    expect(r.out).toMatch(/of 1024 limit/);
  });
});
