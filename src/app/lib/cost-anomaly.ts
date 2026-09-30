export type CostDimensionType = "account" | "service";

export type DailyCostPoint = {
  date: string;
  amount: number;
  dimensionType: CostDimensionType;
  dimensionValue: string;
  currency: string;
  estimated: boolean;
};

export type CostAnomalyCandidate = {
  date: string;
  dimensionType: CostDimensionType;
  dimensionValue: string;
  service: string | null;
  actualCost: number;
  baselineCost: number;
  increaseAmount: number;
  increasePercent: number | null;
  severity: "low" | "medium" | "high";
  explanation: string;
};

export type ServiceIncrease = {
  service: string;
  latestCost: number;
  baselineCost: number;
  increaseAmount: number;
  increasePercent: number | null;
};

const BASELINE_DAYS = 7;
const MINIMUM_PERCENT_INCREASE = 50;
const MINIMUM_DOLLAR_INCREASE = 5;

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function dateOffset(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function resolveLatestDate(points: DailyCostPoint[], latestDate?: string) {
  return latestDate ?? [...new Set(points.map((point) => point.date))].sort().at(-1);
}

function dimensionKey(point: Pick<DailyCostPoint, "dimensionType" | "dimensionValue">) {
  return `${point.dimensionType}:${point.dimensionValue}`;
}

function buildDimensionStats(points: DailyCostPoint[], latestDate?: string) {
  const resolvedLatestDate = resolveLatestDate(points, latestDate);
  if (!resolvedLatestDate) return [];

  const baselineDates = Array.from({ length: BASELINE_DAYS }, (_, index) =>
    dateOffset(resolvedLatestDate, index - BASELINE_DAYS),
  );
  const byDimension = new Map<string, DailyCostPoint[]>();

  for (const point of points) {
    const key = dimensionKey(point);
    byDimension.set(key, [...(byDimension.get(key) ?? []), point]);
  }

  return [...byDimension.values()].flatMap((dimensionPoints) => {
    const latest = dimensionPoints.find((point) => point.date === resolvedLatestDate);
    const baseline = baselineDates.map((date) => dimensionPoints.find((point) => point.date === date));
    if (!latest || baseline.some((point) => !point)) return [];

    const baselineCost = roundMoney(
      baseline.reduce((total, point) => total + (point?.amount ?? 0), 0) / BASELINE_DAYS,
    );
    const actualCost = roundMoney(latest.amount);
    const increaseAmount = roundMoney(actualCost - baselineCost);
    const increasePercent = baselineCost > 0
      ? roundMoney((increaseAmount / baselineCost) * 100)
      : null;

    return [{ latest, actualCost, baselineCost, increaseAmount, increasePercent }];
  });
}

function severityFor(increaseAmount: number): CostAnomalyCandidate["severity"] {
  if (increaseAmount >= 50) return "high";
  if (increaseAmount >= 20) return "medium";
  return "low";
}

export function detectCostAnomalies(points: DailyCostPoint[], latestDate?: string): CostAnomalyCandidate[] {
  return buildDimensionStats(points, latestDate).flatMap((stats) => {
    const isNewSpend = stats.baselineCost === 0 && stats.actualCost >= MINIMUM_DOLLAR_INCREASE;
    const exceedsBaseline =
      stats.increaseAmount >= MINIMUM_DOLLAR_INCREASE &&
      stats.increasePercent !== null &&
      stats.increasePercent >= MINIMUM_PERCENT_INCREASE;
    if (!isNewSpend && !exceedsBaseline) return [];

    const label = stats.latest.dimensionValue;
    const explanation = isNewSpend
      ? `${label} recorded $${stats.actualCost.toFixed(2)} of new spend after a $0.00 7-day baseline.`
      : `${label} cost was $${stats.actualCost.toFixed(2)}, $${stats.increaseAmount.toFixed(2)} (${stats.increasePercent}%) above its 7-day baseline of $${stats.baselineCost.toFixed(2)}.`;

    return [{
      date: stats.latest.date,
      dimensionType: stats.latest.dimensionType,
      dimensionValue: label,
      service: stats.latest.dimensionType === "service" ? label : null,
      actualCost: stats.actualCost,
      baselineCost: stats.baselineCost,
      increaseAmount: stats.increaseAmount,
      increasePercent: stats.increasePercent,
      severity: severityFor(stats.increaseAmount),
      explanation,
    }];
  });
}

export function calculateServiceIncreases(points: DailyCostPoint[], latestDate?: string): ServiceIncrease[] {
  return buildDimensionStats(
    points.filter((point) => point.dimensionType === "service"),
    latestDate,
  )
    .filter((stats) => stats.increaseAmount > 0)
    .map((stats) => ({
      service: stats.latest.dimensionValue,
      latestCost: stats.actualCost,
      baselineCost: stats.baselineCost,
      increaseAmount: stats.increaseAmount,
      increasePercent: stats.increasePercent,
    }))
    .sort((left, right) => right.increaseAmount - left.increaseAmount);
}
