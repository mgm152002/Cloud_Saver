import { sql } from "drizzle-orm";
import type { CollectedCostInsights } from "@/app/lib/aws-cost-explorer";
import { costAnomalies, costDailyRecords, costForecasts } from "@/db/auth-schema";
import { db } from "@/db/db";

export type CostInsightIdentifiers = {
  organizationId: string;
  cloudAccountId: string;
};

function money(value: number | null) {
  return value === null ? null : value.toFixed(2);
}

export function mapDailyCostRows(
  identifiers: CostInsightIdentifiers,
  insights: CollectedCostInsights,
) {
  const collectedAt = new Date(insights.collectedAt);
  const rows = new Map<string, {
    organizationId: string;
    cloudAccountId: string;
    costDate: string;
    dimensionType: string;
    dimensionValue: string;
    amount: string;
    currency: string;
    estimated: boolean;
    collectedAt: Date;
  }>();

  for (const point of insights.dailyCosts) {
    const key = `${point.date}\u0000${point.dimensionType}\u0000${point.dimensionValue}`;
    rows.set(key, {
      ...identifiers,
      costDate: point.date,
      dimensionType: point.dimensionType,
      dimensionValue: point.dimensionValue,
      amount: money(point.amount)!,
      currency: point.currency,
      estimated: point.estimated,
      collectedAt,
    });
  }

  return [...rows.values()];
}

export function mapForecastRow(
  identifiers: CostInsightIdentifiers,
  insights: CollectedCostInsights,
) {
  const forecast = insights.forecast;
  return {
    ...identifiers,
    monthStart: forecast?.monthStart ?? null,
    monthEnd: forecast?.monthEnd ?? null,
    monthToDate: forecast ? money(forecast.monthToDate) : null,
    predictedRemaining: forecast ? money(forecast.predictedRemaining) : null,
    forecastedMonthEnd: forecast ? money(forecast.forecastedMonthEnd) : null,
    lowerBound: forecast ? money(forecast.lowerBound) : null,
    upperBound: forecast ? money(forecast.upperBound) : null,
    currency: forecast?.currency ?? null,
    status: insights.status,
    errorMessage: insights.message,
    lastSyncedAt: new Date(insights.collectedAt),
  };
}

export function mapAnomalyRows(
  identifiers: CostInsightIdentifiers,
  insights: CollectedCostInsights,
) {
  const updatedAt = new Date(insights.collectedAt);
  const rows = new Map<string, {
    organizationId: string;
    cloudAccountId: string;
    anomalyDate: string;
    dimensionType: string;
    dimensionValue: string;
    service: string | null;
    actualCost: string;
    baselineCost: string;
    increaseAmount: string;
    increasePercent: string | null;
    severity: string;
    explanation: string;
    likelyResourceId: string | null;
    resourceIncreaseAmount: string | null;
    attributionStatus: string;
    status: string;
    updatedAt: Date;
  }>();

  for (const anomaly of insights.anomalies) {
    const key = `${anomaly.date}\u0000${anomaly.dimensionType}\u0000${anomaly.dimensionValue}`;
    rows.set(key, {
      ...identifiers,
      anomalyDate: anomaly.date,
      dimensionType: anomaly.dimensionType,
      dimensionValue: anomaly.dimensionValue,
      service: anomaly.service,
      actualCost: money(anomaly.actualCost)!,
      baselineCost: money(anomaly.baselineCost)!,
      increaseAmount: money(anomaly.increaseAmount)!,
      increasePercent: money(anomaly.increasePercent),
      severity: anomaly.severity,
      explanation: anomaly.explanation,
      likelyResourceId: anomaly.likelyResourceId,
      resourceIncreaseAmount: money(anomaly.resourceIncreaseAmount),
      attributionStatus: anomaly.attributionStatus,
      status: "open",
      updatedAt,
    });
  }

  return [...rows.values()];
}

export function buildCostPersistencePlan(
  identifiers: CostInsightIdentifiers,
  insights: CollectedCostInsights,
) {
  return {
    dailyRows: mapDailyCostRows(identifiers, insights),
    forecastRow: mapForecastRow(identifiers, insights),
    anomalyRows: mapAnomalyRows(identifiers, insights),
    deleteExistingHistory: false as const,
  };
}

export async function persistCostInsights(
  database: typeof db,
  identifiers: CostInsightIdentifiers,
  insights: CollectedCostInsights,
) {
  const plan = buildCostPersistencePlan(identifiers, insights);

  if (plan.dailyRows.length > 0) {
    await database
      .insert(costDailyRecords)
      .values(plan.dailyRows)
      .onConflictDoUpdate({
        target: [
          costDailyRecords.cloudAccountId,
          costDailyRecords.costDate,
          costDailyRecords.dimensionType,
          costDailyRecords.dimensionValue,
        ],
        set: {
          amount: sql`excluded.amount`,
          currency: sql`excluded.currency`,
          estimated: sql`excluded.estimated`,
          collectedAt: sql`excluded.collected_at`,
        },
      });
  }

  const forecastUpdate = insights.forecast
    ? {
        monthStart: sql`excluded.month_start`,
        monthEnd: sql`excluded.month_end`,
        monthToDate: sql`excluded.month_to_date`,
        predictedRemaining: sql`excluded.predicted_remaining`,
        forecastedMonthEnd: sql`excluded.forecasted_month_end`,
        lowerBound: sql`excluded.lower_bound`,
        upperBound: sql`excluded.upper_bound`,
        currency: sql`excluded.currency`,
        status: sql`excluded.status`,
        errorMessage: sql`excluded.error_message`,
        lastSyncedAt: sql`excluded.last_synced_at`,
      }
    : {
        status: sql`excluded.status`,
        errorMessage: sql`excluded.error_message`,
        lastSyncedAt: sql`excluded.last_synced_at`,
      };

  await database
    .insert(costForecasts)
    .values(plan.forecastRow)
    .onConflictDoUpdate({
      target: costForecasts.cloudAccountId,
      set: forecastUpdate,
    });

  if (plan.anomalyRows.length > 0) {
    await database
      .insert(costAnomalies)
      .values(plan.anomalyRows)
      .onConflictDoUpdate({
        target: [
          costAnomalies.cloudAccountId,
          costAnomalies.anomalyDate,
          costAnomalies.dimensionType,
          costAnomalies.dimensionValue,
        ],
        set: {
          service: sql`excluded.service`,
          actualCost: sql`excluded.actual_cost`,
          baselineCost: sql`excluded.baseline_cost`,
          increaseAmount: sql`excluded.increase_amount`,
          increasePercent: sql`excluded.increase_percent`,
          severity: sql`excluded.severity`,
          explanation: sql`excluded.explanation`,
          likelyResourceId: sql`excluded.likely_resource_id`,
          resourceIncreaseAmount: sql`excluded.resource_increase_amount`,
          attributionStatus: sql`excluded.attribution_status`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }

  return plan;
}
