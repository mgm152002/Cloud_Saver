import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateServiceIncreases,
  detectCostAnomalies,
  type DailyCostPoint,
} from "../src/app/lib/cost-anomaly";

const priorDates = [
  "2026-09-01",
  "2026-09-02",
  "2026-09-03",
  "2026-09-04",
  "2026-09-05",
  "2026-09-06",
  "2026-09-07",
];
const latestDate = "2026-09-08";

function series(
  baseline: number,
  latest: number,
  dimensionType: "account" | "service" = "service",
  dimensionValue = "Amazon Elastic Compute Cloud - Compute",
): DailyCostPoint[] {
  return [
    ...priorDates.map((date) => ({ date, amount: baseline, dimensionType, dimensionValue, currency: "USD", estimated: false })),
    { date: latestDate, amount: latest, dimensionType, dimensionValue, currency: "USD", estimated: false },
  ];
}

test("detects a cost increase that exceeds both percentage and dollar thresholds", () => {
  const [anomaly] = detectCostAnomalies(series(10, 16), latestDate);

  assert.deepEqual(anomaly, {
    date: latestDate,
    dimensionType: "service",
    dimensionValue: "Amazon Elastic Compute Cloud - Compute",
    service: "Amazon Elastic Compute Cloud - Compute",
    actualCost: 16,
    baselineCost: 10,
    increaseAmount: 6,
    increasePercent: 60,
    severity: "low",
    explanation: "Amazon Elastic Compute Cloud - Compute cost was $16.00, $6.00 (60%) above its 7-day baseline of $10.00.",
  });
});

test("does not flag a large percentage increase below the five dollar threshold", () => {
  assert.deepEqual(detectCostAnomalies(series(2, 3.5), latestDate), []);
});

test("does not flag a dollar increase below the fifty percent threshold", () => {
  assert.deepEqual(detectCostAnomalies(series(20, 28), latestDate), []);
});

test("flags new spend from a zero baseline without dividing by zero", () => {
  const [anomaly] = detectCostAnomalies(series(0, 5), latestDate);

  assert.equal(anomaly.increasePercent, null);
  assert.equal(anomaly.explanation, "Amazon Elastic Compute Cloud - Compute recorded $5.00 of new spend after a $0.00 7-day baseline.");
});

test("requires all seven preceding completed days", () => {
  assert.deepEqual(detectCostAnomalies(series(10, 20).slice(1), latestDate), []);
});

test("assigns medium and high severity by absolute dollar impact", () => {
  assert.equal(detectCostAnomalies(series(10, 35), latestDate)[0].severity, "medium");
  assert.equal(detectCostAnomalies(series(10, 70), latestDate)[0].severity, "high");
});

test("evaluates account and service dimensions independently", () => {
  const points = [
    ...series(100, 100, "account", "123456789012"),
    ...series(10, 16, "service", "Amazon Elastic Compute Cloud - Compute"),
    ...series(20, 20, "service", "Amazon Simple Storage Service"),
  ];

  const anomalies = detectCostAnomalies(points, latestDate);

  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].dimensionValue, "Amazon Elastic Compute Cloud - Compute");
});

test("sorts positive service increases by absolute dollar increase", () => {
  const points = [
    ...series(10, 16, "service", "EC2"),
    ...series(20, 32, "service", "RDS"),
    ...series(15, 12, "service", "S3"),
  ];

  assert.deepEqual(calculateServiceIncreases(points, latestDate), [
    { service: "RDS", latestCost: 32, baselineCost: 20, increaseAmount: 12, increasePercent: 60 },
    { service: "EC2", latestCost: 16, baselineCost: 10, increaseAmount: 6, increasePercent: 60 },
  ]);
});
