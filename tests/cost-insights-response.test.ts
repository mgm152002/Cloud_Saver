import assert from "node:assert/strict";
import test from "node:test";
import { buildCostInsightsResponse } from "../src/app/lib/cost-insights-response";

const dates = [
  "2026-09-21",
  "2026-09-22",
  "2026-09-23",
  "2026-09-24",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
  "2026-09-28",
];

function dailyRecords() {
  return dates.flatMap((costDate, index) => [
    {
      costDate,
      dimensionType: "account",
      dimensionValue: "123456789012",
      amount: index === 7 ? "21.00" : "15.00",
      currency: "USD",
      estimated: false,
    },
    {
      costDate,
      dimensionType: "service",
      dimensionValue: "EC2",
      amount: index === 7 ? "16.00" : "10.00",
      currency: "USD",
      estimated: false,
    },
    {
      costDate,
      dimensionType: "service",
      dimensionValue: "S3",
      amount: "5.00",
      currency: "USD",
      estimated: false,
    },
  ]);
}

const forecast = {
  monthStart: "2026-09-01",
  monthEnd: "2026-10-01",
  monthToDate: "126.00",
  predictedRemaining: "20.00",
  forecastedMonthEnd: "146.00",
  lowerBound: "144.00",
  upperBound: "150.00",
  currency: "USD",
  status: "available",
  errorMessage: null,
  lastSyncedAt: new Date("2026-09-29T12:00:00.000Z"),
};

const anomaly = {
  anomalyDate: "2026-09-28",
  service: "EC2",
  actualCost: "16.00",
  baselineCost: "10.00",
  increaseAmount: "6.00",
  increasePercent: "60.00",
  severity: "low",
  likelyResourceId: "i-spike",
  attributionStatus: "resolved",
  explanation: "EC2 cost increased.",
};

test("returns available daily spend, forecast, service increases and anomalies", () => {
  const result = buildCostInsightsResponse({
    dailyRecords: dailyRecords(),
    forecast,
    anomalies: [anomaly],
    legacyEstimatedMonthlyCost: 999,
  });

  assert.equal(result.costInsights.status, "available");
  assert.equal(result.costInsights.dailySpend.length, 8);
  assert.equal(result.costInsights.dailySpend.at(-1)?.amount, 21);
  assert.equal(result.costInsights.forecast?.forecastedMonthEnd, 146);
  assert.deepEqual(result.costInsights.serviceIncreases, [{
    service: "EC2",
    latestCost: 16,
    baselineCost: 10,
    increaseAmount: 6,
    increasePercent: 60,
  }]);
  assert.equal(result.costInsights.anomalies[0].likelyResourceId, "i-spike");
  assert.equal(result.estimatedMonthlyCost, 146);
  assert.equal(result.monthlyCostSource, "cost-explorer-forecast");
});

test("uses month-to-date actual cost when a forecast is unavailable", () => {
  const result = buildCostInsightsResponse({
    dailyRecords: dailyRecords(),
    forecast: { ...forecast, monthStart: null, monthEnd: null, monthToDate: null, predictedRemaining: null, forecastedMonthEnd: null, lowerBound: null, upperBound: null, currency: null, status: "partial", errorMessage: "Forecast unavailable" },
    anomalies: [],
    legacyEstimatedMonthlyCost: 999,
  });

  assert.equal(result.costInsights.status, "partial");
  assert.equal(result.costInsights.forecast, null);
  assert.equal(result.estimatedMonthlyCost, 126);
  assert.equal(result.monthlyCostSource, "cost-explorer-month-to-date");
});

test("uses the legacy estimate only when no Cost Explorer history exists", () => {
  const result = buildCostInsightsResponse({
    dailyRecords: [],
    forecast: null,
    anomalies: [],
    legacyEstimatedMonthlyCost: 87.5,
  });

  assert.equal(result.costInsights.status, "unavailable");
  assert.equal(result.estimatedMonthlyCost, 87.5);
  assert.equal(result.monthlyCostSource, "heuristic-fallback");
  assert.match(result.costInsights.message ?? "", /no cost explorer data/i);
});

test("preserves stale forecast values while exposing the latest refresh error", () => {
  const result = buildCostInsightsResponse({
    dailyRecords: dailyRecords(),
    forecast: { ...forecast, status: "unavailable", errorMessage: "Access denied during refresh" },
    anomalies: [anomaly],
    legacyEstimatedMonthlyCost: 999,
  });

  assert.equal(result.costInsights.status, "partial");
  assert.equal(result.costInsights.forecast?.forecastedMonthEnd, 146);
  assert.equal(result.estimatedMonthlyCost, 146);
  assert.equal(result.costInsights.message, "Access denied during refresh");
});
