import { calculateServiceIncreases, type DailyCostPoint } from "@/app/lib/cost-anomaly";

type DailyRecordInput = {
  costDate: string;
  dimensionType: string;
  dimensionValue: string;
  amount: string | number;
  currency: string;
  estimated: boolean;
};

type ForecastInput = {
  monthStart: string | null;
  monthEnd: string | null;
  monthToDate: string | number | null;
  predictedRemaining: string | number | null;
  forecastedMonthEnd: string | number | null;
  lowerBound: string | number | null;
  upperBound: string | number | null;
  currency: string | null;
  status: string;
  errorMessage: string | null;
  lastSyncedAt: Date | string;
};

type AnomalyInput = {
  anomalyDate: string;
  service: string | null;
  actualCost: string | number;
  baselineCost: string | number;
  increaseAmount: string | number;
  increasePercent: string | number | null;
  severity: string;
  likelyResourceId: string | null;
  attributionStatus: string;
  explanation: string;
};

export type CostInsightsResponse = {
  dailySpend: { date: string; amount: number; estimated: boolean }[];
  forecast: {
    monthStart: string;
    monthEnd: string;
    monthToDate: number;
    predictedRemaining: number;
    forecastedMonthEnd: number;
    lowerBound: number | null;
    upperBound: number | null;
    currency: string;
  } | null;
  serviceIncreases: {
    service: string;
    latestCost: number;
    baselineCost: number;
    increaseAmount: number;
    increasePercent: number | null;
  }[];
  anomalies: {
    date: string;
    service: string | null;
    actualCost: number;
    baselineCost: number;
    increaseAmount: number;
    increasePercent: number | null;
    severity: "low" | "medium" | "high";
    likelyResourceId: string | null;
    attributionStatus: string;
    explanation: string;
  }[];
  status: "available" | "partial" | "unavailable";
  message: string | null;
  lastSyncedAt: string | null;
};

function numeric(value: string | number | null | undefined) {
  if (value === null || typeof value === "undefined") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildForecast(forecast: ForecastInput | null) {
  if (!forecast?.monthStart || !forecast.monthEnd || !forecast.currency) return null;
  const monthToDate = numeric(forecast.monthToDate);
  const predictedRemaining = numeric(forecast.predictedRemaining);
  const forecastedMonthEnd = numeric(forecast.forecastedMonthEnd);
  if (monthToDate === null || predictedRemaining === null || forecastedMonthEnd === null) return null;

  return {
    monthStart: forecast.monthStart,
    monthEnd: forecast.monthEnd,
    monthToDate,
    predictedRemaining,
    forecastedMonthEnd,
    lowerBound: numeric(forecast.lowerBound),
    upperBound: numeric(forecast.upperBound),
    currency: forecast.currency,
  };
}

function normalizeSeverity(value: string): "low" | "medium" | "high" {
  if (value === "high" || value === "medium") return value;
  return "low";
}

export function buildCostInsightsResponse(input: {
  dailyRecords: DailyRecordInput[];
  forecast: ForecastInput | null;
  anomalies: AnomalyInput[];
  legacyEstimatedMonthlyCost: number;
}) {
  const points: DailyCostPoint[] = input.dailyRecords.flatMap((record) => {
    const amount = numeric(record.amount);
    if (amount === null || (record.dimensionType !== "account" && record.dimensionType !== "service")) return [];
    return [{
      date: record.costDate,
      amount,
      dimensionType: record.dimensionType,
      dimensionValue: record.dimensionValue,
      currency: record.currency,
      estimated: record.estimated,
    }];
  });
  const accountPoints = points
    .filter((point) => point.dimensionType === "account")
    .sort((left, right) => left.date.localeCompare(right.date));
  const dailySpend = accountPoints.map((point) => ({
    date: point.date,
    amount: point.amount,
    estimated: point.estimated,
  }));
  const resolvedForecast = buildForecast(input.forecast);
  const latestMonth = accountPoints.at(-1)?.date.slice(0, 7);
  const monthToDate = accountPoints
    .filter((point) => latestMonth && point.date.startsWith(latestMonth))
    .reduce((total, point) => total + point.amount, 0);
  const hasRealCostData = accountPoints.length > 0;
  const hasReadableCostData = hasRealCostData || Boolean(resolvedForecast);
  const status: CostInsightsResponse["status"] = !hasReadableCostData
    ? "unavailable"
    : input.forecast?.status === "available"
      ? "available"
      : "partial";
  const estimatedMonthlyCost = resolvedForecast?.forecastedMonthEnd
    ?? (hasRealCostData ? Number(monthToDate.toFixed(2)) : input.legacyEstimatedMonthlyCost);
  const monthlyCostSource = resolvedForecast
    ? "cost-explorer-forecast"
    : hasRealCostData
      ? "cost-explorer-month-to-date"
      : "heuristic-fallback";

  const costInsights: CostInsightsResponse = {
    dailySpend,
    forecast: resolvedForecast,
    serviceIncreases: calculateServiceIncreases(points),
    anomalies: input.anomalies.map((anomaly) => ({
      date: anomaly.anomalyDate,
      service: anomaly.service,
      actualCost: numeric(anomaly.actualCost) ?? 0,
      baselineCost: numeric(anomaly.baselineCost) ?? 0,
      increaseAmount: numeric(anomaly.increaseAmount) ?? 0,
      increasePercent: numeric(anomaly.increasePercent),
      severity: normalizeSeverity(anomaly.severity),
      likelyResourceId: anomaly.likelyResourceId,
      attributionStatus: anomaly.attributionStatus,
      explanation: anomaly.explanation,
    })),
    status,
    message: input.forecast?.errorMessage
      ?? (!hasReadableCostData ? "No Cost Explorer data is available yet. Run a scan after granting billing permissions." : null),
    lastSyncedAt: input.forecast?.lastSyncedAt
      ? new Date(input.forecast.lastSyncedAt).toISOString()
      : null,
  };

  return { costInsights, estimatedMonthlyCost, monthlyCostSource };
}
