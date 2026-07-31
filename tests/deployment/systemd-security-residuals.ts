interface SecurityResidual {
  assessment: string;
  reason: string;
}

interface SecurityBaseline {
  residuals: SecurityResidual[];
}

interface ResidualComparison {
  status: 'match' | 'mismatch';
  baselineIdentifiers: string[];
  liveIdentifiers: string[];
  missing: string[];
  extra: string[];
  baselineDuplicates: string[];
  liveDuplicates: string[];
}

const sortedDuplicates = (identifiers: string[]): string[] => {
  const counts = new Map<string, number>();
  for (const identifier of identifiers) {
    counts.set(identifier, (counts.get(identifier) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([identifier]) => identifier)
    .sort();
};

const sortedUnique = (identifiers: string[]): string[] =>
  [...new Set(identifiers)].sort();

const parseLiveIdentifiers = (report: string): string[] => {
  const identifiers: string[] = [];
  for (const line of report.split(/\r?\n/)) {
    if (!line.startsWith('✗')) continue;
    const match = /^✗\s+(\S+)\s{2,}/u.exec(line);
    if (!match) {
      throw new Error('unparseable failed systemd assessment');
    }
    identifiers.push(match[1]);
  }
  return identifiers;
};

const parseBaselineIdentifiers = (value: unknown): string[] => {
  if (!value || typeof value !== 'object') {
    throw new Error('security baseline is not an object');
  }
  const residuals = (value as Partial<SecurityBaseline>).residuals;
  if (!Array.isArray(residuals) || residuals.length === 0) {
    throw new Error('security baseline has no residuals');
  }
  return residuals.map((residual) => {
    if (
      !residual ||
      typeof residual.assessment !== 'string' ||
      residual.assessment.trim() !== residual.assessment ||
      residual.assessment === '' ||
      typeof residual.reason !== 'string' ||
      residual.reason.trim() === ''
    ) {
      throw new Error('security baseline has an invalid residual');
    }
    return residual.assessment;
  });
};

export const compareSecurityResiduals = (
  report: string,
  baseline: unknown,
): ResidualComparison => {
  const baselineRaw = parseBaselineIdentifiers(baseline);
  const liveRaw = parseLiveIdentifiers(report);
  const baselineIdentifiers = sortedUnique(baselineRaw);
  const liveIdentifiers = sortedUnique(liveRaw);
  const baselineSet = new Set(baselineIdentifiers);
  const liveSet = new Set(liveIdentifiers);
  const missing = baselineIdentifiers.filter(
    (identifier) => !liveSet.has(identifier),
  );
  const extra = liveIdentifiers.filter(
    (identifier) => !baselineSet.has(identifier),
  );
  const baselineDuplicates = sortedDuplicates(baselineRaw);
  const liveDuplicates = sortedDuplicates(liveRaw);
  const status =
    missing.length === 0 &&
    extra.length === 0 &&
    baselineDuplicates.length === 0 &&
    liveDuplicates.length === 0
      ? 'match'
      : 'mismatch';

  return {
    status,
    baselineIdentifiers,
    liveIdentifiers,
    missing,
    extra,
    baselineDuplicates,
    liveDuplicates,
  };
};

const main = async (): Promise<void> => {
  const [, , reportPath, baselinePath, outputPath] = Bun.argv;
  if (!reportPath || !baselinePath || !outputPath) {
    throw new Error(
      'usage: systemd-security-residuals REPORT BASELINE OUTPUT',
    );
  }
  try {
    const report = await Bun.file(reportPath).text();
    const baseline = await Bun.file(baselinePath).json();
    const comparison = compareSecurityResiduals(report, baseline);
    await Bun.write(outputPath, `${JSON.stringify(comparison, null, 2)}\n`);
    if (comparison.status !== 'match') process.exitCode = 1;
  } catch (error) {
    const invalid = {
      status: 'invalid',
      error: error instanceof Error ? error.message : String(error),
    };
    await Bun.write(outputPath, `${JSON.stringify(invalid, null, 2)}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) {
  await main();
}
