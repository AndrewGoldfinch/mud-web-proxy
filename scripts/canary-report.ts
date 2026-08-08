/**
 * Turn seven days of canary samples into a verdict.
 *
 * MWP-123 step 6: "Growth in any of the first three over the week is a
 * blocker, not a curiosity", and "'It seemed fine' is not the bar." So this
 * fits a trend and judges it, rather than printing a maximum and leaving the
 * reader to squint.
 *
 * Usage:
 *   bun scripts/canary-report.ts /var/lib/mud-web-proxy-canary/samples.csv
 *
 * Exits 0 if the canary passes, 1 if it fails, 2 if the evidence is too thin
 * to judge — which is not the same as passing and must not be reported as it.
 */

import { existsSync, readFileSync } from 'fs';

interface Sample {
  unix: number;
  pid: number;
  rssKib: number | null;
  fds: number | null;
  threads: number | null;
  nrestarts: number | null;
  memMaxBytes: number | null;
  nofileLimit: number | null;
}

const num = (v: string): number | null => {
  if (v === undefined || v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function parse(csv: string): Sample[] {
  const lines = csv.trim().split('\n');
  if (lines.length < 2) return [];
  return lines.slice(1).flatMap((line) => {
    const f = line.split(',');
    if (f.length < 10) return [];
    const unix = num(f[1]);
    if (unix === null) return [];
    return [
      {
        unix,
        pid: num(f[2]) ?? 0,
        rssKib: num(f[3]),
        fds: num(f[4]),
        threads: num(f[5]),
        nrestarts: num(f[6]),
        memMaxBytes: num(f[8]),
        nofileLimit: num(f[9]),
      },
    ];
  });
}

/**
 * Least-squares slope in units per day.
 *
 * A slope rather than last-minus-first: a single spike at either end would
 * dominate a difference, and a week of samples has spikes. Restarts are
 * excluded by the caller, because a restart resets the counter and would
 * otherwise read as a steep negative trend that cancels real growth.
 */
function slopePerDay(points: Array<[number, number]>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((a, [x]) => a + x, 0) / n;
  const meanY = points.reduce((a, [, y]) => a + y, 0) / n;
  let num_ = 0;
  let den = 0;
  for (const [x, y] of points) {
    num_ += (x - meanX) * (y - meanY);
    den += (x - meanX) ** 2;
  }
  if (den === 0) return null;
  return (num_ / den) * 86400;
}

const fmt = (n: number, digits = 1): string =>
  Number.isFinite(n) ? n.toFixed(digits) : 'n/a';

const path = process.argv[2] ?? '/var/lib/mud-web-proxy-canary/samples.csv';
if (!existsSync(path)) {
  console.error(`canary-report: no samples at ${path}`);
  process.exit(2);
}

const samples = parse(readFileSync(path, 'utf8'));
if (samples.length === 0) {
  console.error('canary-report: no parsable samples');
  process.exit(2);
}

const first = samples[0];
const last = samples[samples.length - 1];
const spanDays = (last.unix - first.unix) / 86400;

// Restarts split the series: RSS and FD counts are per-process, so comparing
// across a restart measures the restart, not a leak. Judge the longest
// unbroken run instead of stitching them together.
const runs: Sample[][] = [];
let current: Sample[] = [];
for (const s of samples) {
  if (current.length > 0 && s.pid !== current[current.length - 1].pid) {
    runs.push(current);
    current = [];
  }
  current.push(s);
}
if (current.length > 0) runs.push(current);
const longest = runs.reduce((a, b) => (b.length > a.length ? b : a), runs[0]);
const longestDays =
  (longest[longest.length - 1].unix - longest[0].unix) / 86400;

const rssPoints = longest
  .filter((s) => s.rssKib !== null)
  .map((s) => [s.unix, s.rssKib as number] as [number, number]);
const fdPoints = longest
  .filter((s) => s.fds !== null)
  .map((s) => [s.unix, s.fds as number] as [number, number]);

const rssSlope = slopePerDay(rssPoints);
const fdSlope = slopePerDay(fdPoints);

const memMax = last.memMaxBytes;
const nofile = last.nofileLimit;
const restarts =
  last.nrestarts !== null && first.nrestarts !== null
    ? last.nrestarts - first.nrestarts
    : null;

const rssValues = rssPoints.map(([, y]) => y);
const fdValues = fdPoints.map(([, y]) => y);
const peak = (xs: number[]): number => (xs.length ? Math.max(...xs) : NaN);

console.log('canary report');
console.log(
  `  samples          ${samples.length} over ${fmt(spanDays, 2)} days`,
);
console.log(
  `  process runs     ${runs.length} (longest ${fmt(longestDays, 2)} days)`,
);
console.log(`  restarts         ${restarts ?? 'n/a'}`);
if (memMax !== null) {
  console.log(
    `  rss peak         ${fmt(peak(rssValues) / 1024)} MiB of ${fmt(memMax / 1048576)} MiB limit`,
  );
}
console.log(
  `  rss trend        ${rssSlope === null ? 'n/a' : `${fmt(rssSlope / 1024)} MiB/day`}`,
);
if (nofile !== null) {
  console.log(
    `  fd peak          ${fmt(peak(fdValues), 0)} of ${nofile} limit`,
  );
}
console.log(
  `  fd trend         ${fdSlope === null ? 'n/a' : `${fmt(fdSlope, 2)} per day`}`,
);

// --- verdict --------------------------------------------------------------
//
// Thresholds are stated rather than tuned until the data passes. Both are
// expressed against the limits the unit actually enforces, so they mean
// something concrete: at these rates the service would not reach its ceiling
// within a year of uptime.
const RSS_SLOPE_LIMIT_KIB_PER_DAY =
  memMax !== null ? memMax / 1024 / 365 : 1024;
const FD_SLOPE_LIMIT_PER_DAY = nofile !== null ? nofile / 365 : 3;

const problems: string[] = [];
const notes: string[] = [];

if (longestDays < 7) {
  notes.push(
    `longest unbroken run is ${fmt(longestDays, 2)} days, short of the seven the gate asks for`,
  );
}
if (rssSlope === null) problems.push('no usable RSS series');
else if (rssSlope > RSS_SLOPE_LIMIT_KIB_PER_DAY) {
  problems.push(
    `RSS grew ${fmt(rssSlope / 1024)} MiB/day, over the ${fmt(RSS_SLOPE_LIMIT_KIB_PER_DAY / 1024)} MiB/day bar`,
  );
}
if (fdSlope === null) problems.push('no usable FD series');
else if (fdSlope > FD_SLOPE_LIMIT_PER_DAY) {
  problems.push(
    `file descriptors grew ${fmt(fdSlope, 2)}/day, over the ${fmt(FD_SLOPE_LIMIT_PER_DAY, 2)}/day bar`,
  );
}
if (restarts !== null && restarts > 0) {
  problems.push(`${restarts} restart(s) during the window`);
}

console.log('');
for (const n of notes) console.log(`  note: ${n}`);

if (problems.length > 0) {
  console.log('  VERDICT: FAIL');
  for (const p of problems) console.log(`    - ${p}`);
  process.exit(1);
}

if (longestDays < 7) {
  // Explicitly not a pass. The gate is seven days; anything less is an
  // unfinished measurement, and reporting it as green is how a canary
  // becomes a formality.
  console.log('  VERDICT: INCOMPLETE — not enough elapsed time to conclude');
  process.exit(2);
}

console.log('  VERDICT: PASS');
process.exit(0);
