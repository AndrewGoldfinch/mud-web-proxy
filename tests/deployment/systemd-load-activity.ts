export interface SustainedActivity {
  startedAt: number;
  firstOutboundAt?: number;
  lastOutboundAt?: number;
  firstInboundAt?: number;
  lastInboundAt?: number;
}

export const spansSustainedInterval = (
  activity: SustainedActivity,
  finishedAt: number,
  sustainMs: number,
): boolean => {
  const {
    startedAt,
    firstOutboundAt,
    lastOutboundAt,
    firstInboundAt,
    lastInboundAt,
  } = activity;
  if (
    firstOutboundAt === undefined ||
    lastOutboundAt === undefined ||
    firstInboundAt === undefined ||
    lastInboundAt === undefined ||
    finishedAt - startedAt < sustainMs
  ) {
    return false;
  }

  const edgeWindowMs = Math.min(3_000, sustainMs / 4);
  return (
    firstOutboundAt >= startedAt &&
    firstOutboundAt <= startedAt + edgeWindowMs &&
    firstInboundAt >= firstOutboundAt &&
    firstInboundAt <= startedAt + edgeWindowMs &&
    lastOutboundAt >= finishedAt - edgeWindowMs &&
    lastOutboundAt <= finishedAt &&
    lastInboundAt >= finishedAt - edgeWindowMs &&
    lastInboundAt <= finishedAt
  );
};
