import assert from "node:assert/strict";
import test from "node:test";

import { buildCostDashboardViewModel } from "../src/app/lib/cost-dashboard";
import type { CostInsightsResponse } from "../src/app/lib/cost-insights-response";

function insights(overrides: Partial<CostInsightsResponse> = {}): CostInsightsResponse {
  return {
    dailySpend: [],
    forecast: null,
    serviceIncreases: [],
    anomalies: [],
    status: "unavailable",
    message: "Billing data unavailable",
    lastSyncedAt: null,
    ...overrides,
  };
}

test("uses Cost Explorer forecast values for dashboard totals", () => {
  const view = buildCostDashboardViewModel({
    costInsights: insights({
      status: "available",
      forecast: {
        monthStart: "2026-09-01",
        monthEnd: "2026-10-01",
        monthToDate: 42.25,
        predictedRemaining: 57.75,
        forecastedMonthEnd: 100,
        lowerBound: 95,
        upperBound: 105,
        currency: "USD",
      },
    }),
    estimatedMonthlyCost: 100,
    monthlyCostSource: "cost-explorer-forecast",
  });

  assert.equal(view.monthToDateSpend, 42.25);
  assert.equal(view.forecastedMonthEnd, 100);
  assert.equal(view.projectedMonthlyCost, 100);
  assert.equal(view.isHeuristicFallback, false);
});

test("sums daily spend when a forecast is not available", () => {
  const view = buildCostDashboardViewModel({
    costInsights: insights({
      status: "partial",
      dailySpend: [
        { date: "2026-09-27", amount: 4.5, estimated: false },
        { date: "2026-09-28", amount: 5.25, estimated: true },
      ],
    }),
    estimatedMonthlyCost: 9.75,
    monthlyCostSource: "cost-explorer-month-to-date",
  });

  assert.equal(view.monthToDateSpend, 9.75);
  assert.equal(view.forecastedMonthEnd, null);
  assert.equal(view.dailySpendMaximum, 5.25);
});

test("keeps unavailable billing data explicit while allowing legacy limits", () => {
  const view = buildCostDashboardViewModel({
    costInsights: insights(),
    estimatedMonthlyCost: 18,
    monthlyCostSource: "heuristic-fallback",
  });

  assert.equal(view.monthToDateSpend, null);
  assert.equal(view.forecastedMonthEnd, null);
  assert.equal(view.projectedMonthlyCost, 18);
  assert.equal(view.isHeuristicFallback, true);
  assert.equal(view.dailySpendMaximum, 1);
});
