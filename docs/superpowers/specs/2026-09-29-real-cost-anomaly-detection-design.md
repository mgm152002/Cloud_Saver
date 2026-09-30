# Real Cost Data and Cost Anomaly Detection Design

## Objective

Replace account-level fixed price estimates with AWS Cost Explorer data and add explainable cost anomaly detection. The account dashboard must show daily spend, month-to-date spend, forecasted month-end spend, service-level increases, and the resource most likely responsible for a spike when AWS provides resource-level billing data.

## Scope

- Collect 30 completed days of `UnblendedCost` totals and service breakdowns through Cost Explorer.
- Fetch the remaining-month cost forecast and combine it with month-to-date actual spend.
- Detect account and service anomalies with deterministic CloudSaver rules.
- Attempt resource attribution for anomalous services when resource-level Cost Explorer data is enabled.
- Persist cost history, the latest forecast, and anomalies.
- Return cost insights from the existing cloud-account API and display them in the existing account dashboard.
- Keep inventory scans usable when Cost Explorer is unavailable.

Out of scope: AWS Cost Anomaly Detection monitors, hourly analysis, scheduled scans, organization-wide consolidated billing views, CUR ingestion, and AI-generated anomaly decisions.

## Data Flow

1. `aws-initial-scan` assumes the customer role as it does today.
2. A focused Cost Explorer module uses the temporary credentials in `us-east-1`.
3. `GetCostAndUsage` retrieves daily account totals and service costs.
4. `GetCostForecast` retrieves the remaining-month forecast.
5. CloudSaver compares the latest completed day with the previous seven completed days.
6. For anomalous services, CloudSaver attempts resource attribution using resource-level Cost Explorer data.
7. Cost records, forecast data, and anomaly results are upserted transactionally after collection.
8. The account API returns `costInsights`; the dashboard renders real billing information separately from resource inventory.

## Transparent Anomaly Rule

For the latest completed UTC billing day:

- Baseline: arithmetic mean of the preceding seven completed days for the same dimension.
- Anomaly: actual cost is at least 50% above baseline and the absolute increase is at least USD 5.
- A zero baseline does not produce a percentage anomaly; a new-spend anomaly is emitted only when actual cost is at least USD 5.
- Severity: `high` at USD 50 or more absolute increase, `medium` at USD 20 or more, otherwise `low`.
- Account and service dimensions use the same rule.
- Stored explanations include actual cost, baseline, dollar delta, percentage delta when defined, and the threshold that fired.

Resource attribution is evidence attached to a service anomaly, not a separate anomaly decision. CloudSaver stores the resource with the largest positive cost increase between the latest day and the preceding-day baseline when AWS returns resource data. When resource data is disabled or unsupported, the anomaly remains valid at service level and records an attribution status explaining the limitation.

## Persistence

### `cost_daily_records`

- organization ID and cloud account ID
- cost date
- dimension type: `account` or `service`
- dimension value: account identifier or AWS service name
- amount, currency, and AWS estimated flag
- unique key on account, date, dimension type, and dimension value

### `cost_forecasts`

- one latest row per cloud account
- month start/end
- month-to-date actual cost
- predicted remaining cost
- forecasted month-end cost
- lower and upper forecast bounds when returned
- currency, collection status/error, and synchronization timestamp

### `cost_anomalies`

- organization/account and anomaly date
- account or service dimension and optional service name
- actual, baseline, dollar delta, and percentage delta
- severity and deterministic explanation
- optional resource ID and resource delta
- resource attribution status
- lifecycle status, initially `open`
- unique key preventing duplicate anomaly rows for the same account/date/dimension

The existing `resource_cost_history` table remains unchanged because its rows are tied to inventory records that are deleted and recreated during scans; it is not suitable for durable account billing history.

## API Contract

The existing account detail endpoint adds:

```ts
costInsights: {
  dailySpend: Array<{ date: string; amount: number; estimated: boolean }>;
  forecast: {
    monthToDate: number;
    predictedRemaining: number;
    forecastedMonthEnd: number;
    lowerBound: number | null;
    upperBound: number | null;
    currency: string;
  } | null;
  serviceIncreases: Array<{
    service: string;
    latestCost: number;
    baselineCost: number;
    increaseAmount: number;
    increasePercent: number | null;
  }>;
  anomalies: Array<{
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
  }>;
  status: "available" | "partial" | "unavailable";
  message: string | null;
  lastSyncedAt: string | null;
}
```

Existing response fields remain for compatibility. `totals.estimatedMonthlyCost` becomes the Cost Explorer month-end forecast when available, then month-to-date actual cost if forecast is unavailable. It falls back to the existing estimate only when no successful Cost Explorer collection has ever occurred, and the response exposes that fallback through `costInsights.status` and `message`.

## Dashboard

The overview adds:

- Month-to-date spend and forecasted month-end summary cards.
- A 30-day daily-spend area chart.
- A service increase table/chart ordered by absolute increase.
- An anomaly section with severity, service, actual versus baseline, and likely resource.
- A clear partial/unavailable notice with the required AWS setup when forecast or resource attribution is unavailable.

The inventory and recommendations sections remain intact. Resource costs are not replaced with guessed Cost Explorer attribution when AWS omits a resource ID.

## IAM and Dependencies

- Add `@aws-sdk/client-cost-explorer`.
- Keep `ce:GetCostAndUsage`.
- Add `ce:GetCostForecast` and `ce:GetCostAndUsageWithResources` to the onboarding role.
- Do not add AWS Cost Anomaly Detection permissions.

## Failure Handling

- `AccessDeniedException`: retain inventory scan success and return a permission-specific cost status.
- Cost Explorer disabled or no billing data: store an unavailable/partial forecast state without inventing zero spend.
- Forecast unavailable early in the month: show month-to-date actual spend and a forecast-unavailable message.
- Resource-level data disabled: preserve service anomaly and mark attribution `resource_data_unavailable`.
- Pagination is followed for all Cost Explorer responses that expose a next-page token.
- Existing stored cost insights remain readable if a later refresh fails; the latest error and timestamp identify staleness.

## Verification

- Unit tests for date windows, parsing, pagination aggregation, forecast composition, anomaly thresholds, zero baselines, severity, and resource attribution fallback.
- Mocked collector tests for successful, partial, access-denied, paginated, and resource-data-disabled responses.
- API tests for the new `costInsights` response and compatibility fallback.
- UI lint/type/build checks and focused rendering assertions where supported by the existing test setup.
- No live AWS billing calls are required for automated tests.
