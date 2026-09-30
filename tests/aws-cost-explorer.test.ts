import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCostDateWindows,
  collectCostInsights,
  type CostExplorerClientLike,
} from "../src/app/lib/aws-cost-explorer";

const baselineDates = [
  "2026-09-21",
  "2026-09-22",
  "2026-09-23",
  "2026-09-24",
  "2026-09-25",
  "2026-09-26",
  "2026-09-27",
];
const latestDate = "2026-09-28";

function costResult(date: string, ec2: number, s3 = 5) {
  return {
    TimePeriod: { Start: date, End: nextDate(date) },
    Estimated: false,
    Total: {},
    Groups: [
      { Keys: ["Amazon Elastic Compute Cloud - Compute"], Metrics: { UnblendedCost: { Amount: String(ec2), Unit: "USD" } } },
      { Keys: ["Amazon Simple Storage Service"], Metrics: { UnblendedCost: { Amount: String(s3), Unit: "USD" } } },
    ],
  };
}

function nextDate(date: string) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + 1);
  return value.toISOString().slice(0, 10);
}

function dailyResponse() {
  return {
    ResultsByTime: [
      ...baselineDates.map((date) => costResult(date, 10)),
      costResult(latestDate, 16),
    ],
  };
}

function resourceResponse() {
  return {
    ResultsByTime: [
      ...baselineDates.map((date) => ({
        TimePeriod: { Start: date, End: nextDate(date) },
        Estimated: false,
        Total: {},
        Groups: [{ Keys: ["i-spike"], Metrics: { UnblendedCost: { Amount: "10", Unit: "USD" } } }],
      })),
      {
        TimePeriod: { Start: latestDate, End: nextDate(latestDate) },
        Estimated: false,
        Total: {},
        Groups: [{ Keys: ["i-spike"], Metrics: { UnblendedCost: { Amount: "16", Unit: "USD" } } }],
      },
    ],
  };
}

function fakeClient(
  handler: (commandName: string, input: Record<string, unknown>) => unknown | Promise<unknown>,
): CostExplorerClientLike {
  return {
    send(command) {
      const value = command as { constructor: { name: string }; input: Record<string, unknown> };
      return Promise.resolve(handler(value.constructor.name, value.input));
    },
  };
}

const credentials = {
  accessKeyId: "temporary-access-key",
  secretAccessKey: "temporary-secret",
  sessionToken: "temporary-token",
};

test("builds UTC history and remaining-month forecast windows", () => {
  assert.deepEqual(buildCostDateWindows(new Date("2026-09-29T18:00:00-07:00")), {
    history: { Start: "2026-08-31", End: "2026-09-30" },
    resourceHistory: { Start: "2026-09-22", End: "2026-09-30" },
    forecast: { Start: "2026-09-30", End: "2026-10-01" },
    monthStart: "2026-09-01",
    latestCompletedDate: "2026-09-29",
  });
});

test("collects daily totals, service costs, forecast and likely resource", async () => {
  const client = fakeClient((commandName) => {
    if (commandName === "GetCostAndUsageCommand") return dailyResponse();
    if (commandName === "GetCostForecastCommand") {
      return {
        Total: { Amount: "20", Unit: "USD" },
        ForecastResultsByTime: [{ MeanValue: "20", PredictionIntervalLowerBound: "18", PredictionIntervalUpperBound: "24" }],
      };
    }
    if (commandName === "GetCostAndUsageWithResourcesCommand") return resourceResponse();
    throw new Error(`Unexpected command ${commandName}`);
  });

  const result = await collectCostInsights(credentials, {
    now: new Date("2026-09-29T12:00:00.000Z"),
    client,
  });

  assert.equal(result.status, "available");
  assert.equal(result.dailyCosts.filter((point) => point.dimensionType === "account").length, 8);
  assert.equal(result.dailyCosts.find((point) => point.date === latestDate && point.dimensionType === "account")?.amount, 21);
  assert.deepEqual(result.forecast, {
    monthStart: "2026-09-01",
    monthEnd: "2026-10-01",
    monthToDate: 126,
    predictedRemaining: 20,
    forecastedMonthEnd: 146,
    lowerBound: 144,
    upperBound: 150,
    currency: "USD",
  });
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].service, "Amazon Elastic Compute Cloud - Compute");
  assert.equal(result.anomalies[0].likelyResourceId, "i-spike");
  assert.equal(result.anomalies[0].resourceIncreaseAmount, 6);
  assert.equal(result.anomalies[0].attributionStatus, "resolved");
});

test("aggregates paginated service groups without double counting", async () => {
  const client = fakeClient((commandName, input) => {
    if (commandName === "GetCostAndUsageCommand") {
      if (!input.NextPageToken) {
        return {
          ResultsByTime: [{
            TimePeriod: { Start: latestDate, End: nextDate(latestDate) },
            Estimated: false,
            Total: {},
            Groups: [{ Keys: ["EC2"], Metrics: { UnblendedCost: { Amount: "7", Unit: "USD" } } }],
          }],
          NextPageToken: "page-2",
        };
      }
      return {
        ResultsByTime: [{
          TimePeriod: { Start: latestDate, End: nextDate(latestDate) },
          Estimated: false,
          Total: {},
          Groups: [{ Keys: ["S3"], Metrics: { UnblendedCost: { Amount: "3", Unit: "USD" } } }],
        }],
      };
    }
    if (commandName === "GetCostForecastCommand") throw Object.assign(new Error("Forecast unavailable"), { name: "DataUnavailableException" });
    throw new Error(`Unexpected command ${commandName}`);
  });

  const result = await collectCostInsights(credentials, {
    now: new Date("2026-09-29T12:00:00.000Z"),
    client,
  });

  assert.equal(result.dailyCosts.find((point) => point.dimensionType === "account")?.amount, 10);
  assert.equal(result.dailyCosts.filter((point) => point.dimensionType === "service").length, 2);
  assert.equal(result.status, "partial");
  assert.equal(result.forecast, null);
});

test("maps Cost Explorer access denial to an unavailable result", async () => {
  const client = fakeClient(() => {
    throw Object.assign(new Error("not authorized"), { name: "AccessDeniedException" });
  });

  const result = await collectCostInsights(credentials, { now: new Date("2026-09-29T12:00:00.000Z"), client });

  assert.equal(result.status, "unavailable");
  assert.match(result.message ?? "", /Cost Explorer permissions/i);
  assert.deepEqual(result.dailyCosts, []);
});

test("treats an empty Cost Explorer response as unavailable rather than zero spend", async () => {
  const client = fakeClient((commandName) => {
    if (commandName === "GetCostAndUsageCommand") return { ResultsByTime: [] };
    throw new Error(`Unexpected command ${commandName}`);
  });

  const result = await collectCostInsights(credentials, { now: new Date("2026-09-29T12:00:00.000Z"), client });

  assert.equal(result.status, "unavailable");
  assert.match(result.message ?? "", /no billing data/i);
  assert.equal(result.forecast, null);
});

test("keeps a service anomaly when resource-level data is unavailable", async () => {
  const client = fakeClient((commandName) => {
    if (commandName === "GetCostAndUsageCommand") return dailyResponse();
    if (commandName === "GetCostForecastCommand") return { Total: { Amount: "20", Unit: "USD" } };
    if (commandName === "GetCostAndUsageWithResourcesCommand") {
      throw Object.assign(new Error("Resource-level data is disabled"), { name: "DataUnavailableException" });
    }
    throw new Error(`Unexpected command ${commandName}`);
  });

  const result = await collectCostInsights(credentials, { now: new Date("2026-09-29T12:00:00.000Z"), client });

  assert.equal(result.status, "partial");
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0].likelyResourceId, null);
  assert.equal(result.anomalies[0].attributionStatus, "resource_data_unavailable");
});

test("rejects a forecast whose currency differs from daily cost data", async () => {
  const client = fakeClient((commandName) => {
    if (commandName === "GetCostAndUsageCommand") return dailyResponse();
    if (commandName === "GetCostForecastCommand") return { Total: { Amount: "20", Unit: "EUR" } };
    if (commandName === "GetCostAndUsageWithResourcesCommand") return resourceResponse();
    throw new Error(`Unexpected command ${commandName}`);
  });

  const result = await collectCostInsights(credentials, { now: new Date("2026-09-29T12:00:00.000Z"), client });

  assert.equal(result.forecast, null);
  assert.equal(result.status, "partial");
  assert.match(result.message ?? "", /currency/i);
});

test("does not present non-USD daily costs as dollar amounts", async () => {
  const client = fakeClient((commandName) => {
    if (commandName === "GetCostAndUsageCommand") {
      return {
        ResultsByTime: dailyResponse().ResultsByTime.map((result) => ({
          ...result,
          Groups: result.Groups.map((group) => ({
            ...group,
            Metrics: { UnblendedCost: { ...group.Metrics.UnblendedCost, Unit: "EUR" } },
          })),
        })),
      };
    }
    throw new Error(`Unexpected command ${commandName}`);
  });

  const result = await collectCostInsights(credentials, { now: new Date("2026-09-29T12:00:00.000Z"), client });

  assert.equal(result.status, "unavailable");
  assert.deepEqual(result.dailyCosts, []);
  assert.equal(result.forecast, null);
  assert.match(result.message ?? "", /USD/i);
});

test("treats an omitted service group as zero when complete daily history exists", async () => {
  const client = fakeClient((commandName) => {
    if (commandName === "GetCostAndUsageCommand") {
      return {
        ResultsByTime: [
          ...baselineDates.map((date) => ({
            TimePeriod: { Start: date, End: nextDate(date) },
            Estimated: false,
            Groups: [{ Keys: ["S3"], Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } } }],
          })),
          {
            TimePeriod: { Start: latestDate, End: nextDate(latestDate) },
            Estimated: false,
            Groups: [
              { Keys: ["S3"], Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } } },
              { Keys: ["Lambda"], Metrics: { UnblendedCost: { Amount: "5", Unit: "USD" } } },
            ],
          },
        ],
      };
    }
    if (commandName === "GetCostForecastCommand") return { Total: { Amount: "1", Unit: "USD" } };
    if (commandName === "GetCostAndUsageWithResourcesCommand") return { ResultsByTime: [] };
    throw new Error(`Unexpected command ${commandName}`);
  });

  const result = await collectCostInsights(credentials, { now: new Date("2026-09-29T12:00:00.000Z"), client });
  const lambdaAnomaly = result.anomalies.find((anomaly) => anomaly.service === "Lambda");

  assert.ok(lambdaAnomaly);
  assert.equal(lambdaAnomaly.baselineCost, 0);
  assert.equal(lambdaAnomaly.actualCost, 5);
  assert.equal(lambdaAnomaly.increasePercent, null);
});
