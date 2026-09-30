import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostPersistencePlan,
  mapAnomalyRows,
  mapDailyCostRows,
  mapForecastRow,
} from "../src/app/lib/cost-insights-store";
import type { CollectedCostInsights } from "../src/app/lib/aws-cost-explorer";

const identifiers = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  cloudAccountId: "22222222-2222-4222-8222-222222222222",
};

function insights(overrides: Partial<CollectedCostInsights> = {}): CollectedCostInsights {
  return {
    dailyCosts: [{
      date: "2026-09-28",
      amount: 21,
      dimensionType: "account",
      dimensionValue: "123456789012",
      currency: "USD",
      estimated: false,
    }],
    forecast: {
      monthStart: "2026-09-01",
      monthEnd: "2026-10-01",
      monthToDate: 126,
      predictedRemaining: 20,
      forecastedMonthEnd: 146,
      lowerBound: 144,
      upperBound: 150,
      currency: "USD",
    },
    anomalies: [{
      date: "2026-09-28",
      dimensionType: "service",
      dimensionValue: "EC2",
      service: "EC2",
      actualCost: 16,
      baselineCost: 10,
      increaseAmount: 6,
      increasePercent: 60,
      severity: "low",
      explanation: "EC2 cost increased.",
      likelyResourceId: "i-spike",
      resourceIncreaseAmount: 6,
      attributionStatus: "resolved",
    }],
    serviceIncreases: [],
    status: "available",
    message: null,
    collectedAt: "2026-09-29T12:00:00.000Z",
    ...overrides,
  };
}

test("maps daily cost points to durable account-scoped rows", () => {
  assert.deepEqual(mapDailyCostRows(identifiers, insights()), [{
    organizationId: identifiers.organizationId,
    cloudAccountId: identifiers.cloudAccountId,
    costDate: "2026-09-28",
    dimensionType: "account",
    dimensionValue: "123456789012",
    amount: "21.00",
    currency: "USD",
    estimated: false,
    collectedAt: new Date("2026-09-29T12:00:00.000Z"),
  }]);
});

test("deduplicates daily rows by account date and dimension key", () => {
  const duplicate = insights({
    dailyCosts: [
      ...insights().dailyCosts,
      { ...insights().dailyCosts[0], amount: 22 },
    ],
  });

  const rows = mapDailyCostRows(identifiers, duplicate);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].amount, "22.00");
});

test("maps forecast amounts and synchronization status", () => {
  assert.deepEqual(mapForecastRow(identifiers, insights()), {
    organizationId: identifiers.organizationId,
    cloudAccountId: identifiers.cloudAccountId,
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
  });
});

test("maps anomaly evidence without losing resource attribution", () => {
  assert.deepEqual(mapAnomalyRows(identifiers, insights()), [{
    organizationId: identifiers.organizationId,
    cloudAccountId: identifiers.cloudAccountId,
    anomalyDate: "2026-09-28",
    dimensionType: "service",
    dimensionValue: "EC2",
    service: "EC2",
    actualCost: "16.00",
    baselineCost: "10.00",
    increaseAmount: "6.00",
    increasePercent: "60.00",
    severity: "low",
    explanation: "EC2 cost increased.",
    likelyResourceId: "i-spike",
    resourceIncreaseAmount: "6.00",
    attributionStatus: "resolved",
    status: "open",
    updatedAt: new Date("2026-09-29T12:00:00.000Z"),
  }]);
});

test("an unavailable refresh preserves history and writes only forecast status", () => {
  const unavailable = insights({
    dailyCosts: [],
    forecast: null,
    anomalies: [],
    status: "unavailable",
    message: "AWS Cost Explorer permissions are missing.",
  });

  const plan = buildCostPersistencePlan(identifiers, unavailable);

  assert.deepEqual(plan.dailyRows, []);
  assert.deepEqual(plan.anomalyRows, []);
  assert.equal(plan.forecastRow.status, "unavailable");
  assert.equal(plan.forecastRow.errorMessage, "AWS Cost Explorer permissions are missing.");
  assert.equal(plan.deleteExistingHistory, false);
});
