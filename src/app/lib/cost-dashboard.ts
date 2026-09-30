import type { CostInsightsResponse } from "@/app/lib/cost-insights-response";

export function buildCostDashboardViewModel(input: {
  costInsights: CostInsightsResponse;
  estimatedMonthlyCost: number;
  monthlyCostSource: string;
}) {
  const dailyTotal = input.costInsights.dailySpend.reduce((total, point) => total + point.amount, 0);
  const monthToDateSpend = input.costInsights.forecast?.monthToDate
    ?? (input.costInsights.dailySpend.length > 0 ? Number(dailyTotal.toFixed(2)) : null);

  return {
    monthToDateSpend,
    forecastedMonthEnd: input.costInsights.forecast?.forecastedMonthEnd ?? null,
    projectedMonthlyCost: input.estimatedMonthlyCost,
    isHeuristicFallback: input.monthlyCostSource === "heuristic-fallback",
    dailySpendMaximum: Math.max(...input.costInsights.dailySpend.map((point) => point.amount), 1),
  };
}
