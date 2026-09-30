# Real Cost Data and Cost Anomaly Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace account-level heuristic totals with AWS Cost Explorer history and forecasts, then surface deterministic service/resource cost anomalies in the existing account dashboard.

**Architecture:** A focused Cost Explorer collector converts AWS responses into a provider-neutral snapshot. Pure anomaly functions evaluate the snapshot, a persistence module upserts normalized history/forecast/anomaly rows, and the existing scan coordinates collection without making inventory success depend on billing access. The existing account API and dashboard expose the stored insights.

**Tech Stack:** TypeScript, AWS SDK v3 Cost Explorer client, Trigger.dev, Drizzle ORM/PostgreSQL, Next.js 16 App Router, React 19, Node test runner through `tsx`.

**Spec:** `docs/superpowers/specs/2026-09-29-real-cost-anomaly-detection-design.md`

## Global Constraints

- Use `UnblendedCost` and UTC billing dates.
- An anomaly requires at least a 50% increase and USD 5 absolute increase; a zero baseline emits new-spend only at USD 5 or more.
- Baselines use the preceding seven completed days.
- Inventory scans remain successful when billing APIs fail.
- Do not use AI to decide anomalies.
- Do not require live AWS or database access in automated tests.
- Preserve existing API fields and dashboard functionality.

## Review Focus

- A partially paginated Cost Explorer response must aggregate every page without double-counting; Task 2 tests pagination parsing.
- Missing or non-USD forecast data must not be presented as a valid USD forecast; Task 2 tests unavailable forecast behavior.
- Sparse history with fewer than seven prior days must not emit an anomaly; Task 1 tests insufficient history.
- A zero-cost baseline followed by USD 5 or more must emit a new-spend anomaly without dividing by zero; Task 1 tests zero baselines.
- A later collection failure must preserve earlier cost history while exposing a stale/partial status; Task 3 tests persistence/status semantics through pure shaping helpers.

---

### Task 1: Pure Cost Models and Transparent Anomaly Rules

**Files:**
- Create: `src/app/lib/cost-anomaly.ts`
- Create: `tests/cost-anomaly.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `DailyCostPoint`, `CostAnomalyCandidate`, `ServiceIncrease`, `detectCostAnomalies(points, latestDate?)`, and `calculateServiceIncreases(points, latestDate?)`.
- Consumes: no AWS or database dependencies.

- [ ] **Step 1: Add the Node/tsx test command and failing anomaly tests**

Add `test: "tsx --test tests/**/*.test.ts"`. Test normal threshold, below-dollar threshold, below-percent threshold, zero baseline, insufficient history, severity levels, account/service isolation, and sorted service increases.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- tests/cost-anomaly.test.ts`
Expected: FAIL because `cost-anomaly.ts` does not exist.

- [ ] **Step 3: Implement the pure anomaly module**

Implement:

```ts
export function detectCostAnomalies(points: DailyCostPoint[], latestDate?: string): CostAnomalyCandidate[];
export function calculateServiceIncreases(points: DailyCostPoint[], latestDate?: string): ServiceIncrease[];
```

Use exactly seven preceding completed dates, round persisted/displayed monetary values to cents, and never divide by zero.

- [ ] **Step 4: Run tests and verify pass**

Run: `npm test -- tests/cost-anomaly.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add package.json tests/cost-anomaly.test.ts src/app/lib/cost-anomaly.ts
git commit -m "feat: add transparent cost anomaly rules"
```

### Task 2: AWS Cost Explorer Collector

**Files:**
- Create: `src/app/lib/aws-cost-explorer.ts`
- Create: `tests/aws-cost-explorer.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `cloud_formation/get_access.yaml`

**Interfaces:**
- Consumes: temporary STS credentials and `DailyCostPoint` from Task 1.
- Produces: `collectCostInsights(credentials, now?) -> Promise<CollectedCostInsights>` containing daily account/service points, forecast, anomalies, service increases, attribution metadata, and collection status.

- [ ] **Step 1: Add the Cost Explorer SDK dependency and failing collector tests**

Test UTC date windows, totals/service parsing, pagination, forecast composition, AccessDenied mapping, empty data, and resource attribution unavailable fallback using an injected `CostExplorerClientLike` sender.

- [ ] **Step 2: Run the focused tests and verify failure**

Run: `npm test -- tests/aws-cost-explorer.test.ts`
Expected: FAIL because collector exports are missing.

- [ ] **Step 3: Implement collector and parsers**

Implement:

```ts
export function buildCostDateWindows(now: Date): CostDateWindows;
export async function collectCostInsights(
  credentials: AwsTemporaryCredentials,
  options?: { now?: Date; client?: CostExplorerClientLike },
): Promise<CollectedCostInsights>;
```

Use `GetCostAndUsageCommand`, `GetCostForecastCommand`, and `GetCostAndUsageWithResourcesCommand`; follow next-page tokens. Resource attribution failure changes only attribution status, not the service anomaly.

- [ ] **Step 4: Add least-required IAM reads**

Add `ce:GetCostForecast` and `ce:GetCostAndUsageWithResources` beside the existing `ce:GetCostAndUsage` permission.

- [ ] **Step 5: Run focused tests and lint**

Run: `npm test -- tests/aws-cost-explorer.test.ts && npm run lint`
Expected: PASS with only the two documented baseline lint warnings.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json cloud_formation/get_access.yaml tests/aws-cost-explorer.test.ts src/app/lib/aws-cost-explorer.ts
git commit -m "feat: collect real AWS Cost Explorer data"
```

### Task 3: Cost Persistence and Scan Integration

**Files:**
- Modify: `src/db/auth-schema.ts`
- Create: `drizzle/0007_real_cost_insights.sql`
- Create: `src/app/lib/cost-insights-store.ts`
- Create: `tests/cost-insights-store.test.ts`
- Modify: `trigger/aws-initial-scan.ts`

**Interfaces:**
- Consumes: `CollectedCostInsights` from Task 2.
- Produces: `persistCostInsights(db, identifiers, insights)`, durable cost tables, and scan metadata cost status.

- [ ] **Step 1: Write failing pure store-shaping tests**

Test daily-row mapping, forecast row mapping, anomaly row mapping, duplicate keys, and failure-status updates that do not delete existing history.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/cost-insights-store.test.ts`
Expected: FAIL because store exports are missing.

- [ ] **Step 3: Add Drizzle schema and SQL migration**

Add `costDailyRecords`, `costForecasts`, and `costAnomalies` with the unique keys defined by the spec, account/organization foreign keys, decimal amounts, status fields, and timestamps.

- [ ] **Step 4: Implement persistence mapping and upserts**

Keep pure `map*Rows` functions testable without a database. Upsert successful collection rows; on collection failure update forecast status/error only and retain daily/anomaly history.

- [ ] **Step 5: Integrate collection into the existing scan**

Call `collectCostInsights` after role assumption. Catch billing errors separately, persist partial/unavailable status, include cost status in scan/job metadata, and use forecast/month-to-date totals for scan summary when present.

- [ ] **Step 6: Run focused and full tests**

Run: `npm test && npm run lint`
Expected: all tests PASS; lint has no new warnings.

- [ ] **Step 7: Commit**

```bash
git add src/db/auth-schema.ts drizzle/0007_real_cost_insights.sql src/app/lib/cost-insights-store.ts tests/cost-insights-store.test.ts trigger/aws-initial-scan.ts
git commit -m "feat: persist cost insights during AWS scans"
```

### Task 4: Account Cost Insights API

**Files:**
- Create: `src/app/lib/cost-insights-response.ts`
- Create: `tests/cost-insights-response.test.ts`
- Modify: `src/app/api/org/[orgId]/cloud-accounts/[accountId]/route.ts`

**Interfaces:**
- Consumes: stored cost rows/forecast/anomalies from Task 3.
- Produces: `buildCostInsightsResponse(input) -> CostInsightsResponse` and the `costInsights` account API field.

- [ ] **Step 1: Write failing response-shaping tests**

Test available, partial, unavailable, stale-error-preserving-history, forecast-total preference, month-to-date fallback, and legacy estimate fallback.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/cost-insights-response.test.ts`
Expected: FAIL because response builder is missing.

- [ ] **Step 3: Implement response builder and queries**

Query the account's last 30 days, latest forecast, recent service anomalies, and service increases. Return the exact spec contract and keep existing response fields.

- [ ] **Step 4: Run focused/full tests and type-aware build**

Run: `npm test && npm run lint && npx tsc --noEmit`
Expected: PASS with no new errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/lib/cost-insights-response.ts tests/cost-insights-response.test.ts src/app/api/org/[orgId]/cloud-accounts/[accountId]/route.ts
git commit -m "feat: expose account cost insights API"
```

### Task 5: Dashboard Cost Experience

**Files:**
- Modify: `src/app/org/[orgId]/cloud-accounts/[accountId]/page.tsx`
- Modify: `src/components/ui/chart.tsx` only if the existing chart API cannot display dated points.
- Modify: `README.md`

**Interfaces:**
- Consumes: `costInsights` from Task 4.
- Produces: month-to-date/forecast cards, daily spend chart, service increase view, anomaly cards, and unavailable/partial guidance.

- [ ] **Step 1: Add client-side types and safe empty-state calculations**

Parse the new response without assuming forecast or resource attribution exists. Use legacy totals only when status is unavailable and no real data exists.

- [ ] **Step 2: Replace account overview heuristic totals**

Display actual month-to-date and forecast month-end cards, a daily spend area chart, service increases ordered by dollar increase, and anomaly cards with likely-resource/fallback copy.

- [ ] **Step 3: Document IAM and Cost Explorer resource-data setup**

Document the new permissions, real-cost behavior, 30-day window, transparent thresholds, and the optional AWS resource-level data setting.

- [ ] **Step 4: Run complete verification**

Run: `npm test && npm run lint && npx tsc --noEmit && npm run build`
Expected: tests/lint/types PASS and production build completes; if the known baseline build hang recurs, capture it separately and do not call the build verified.

- [ ] **Step 5: Inspect changes and commit**

Run: `git diff --check && git status --short && git diff --stat origin/main...HEAD`

```bash
git add src/app/org/[orgId]/cloud-accounts/[accountId]/page.tsx src/components/ui/chart.tsx README.md
git commit -m "feat: show real spend and cost anomalies"
```

### Task 6: Final Regression and Delivery Review

**Files:**
- Review all feature files and migrations.

**Interfaces:**
- Consumes: Tasks 1-5.
- Produces: verified, reviewable feature branch.

- [ ] **Step 1: Run full verification from a clean state**

Run: `npm test && npm run lint && npx tsc --noEmit && npm run build`
Expected: all configured checks pass, with only explicitly reported pre-existing warnings.

- [ ] **Step 2: Review security and data correctness**

Confirm no credentials or billing responses are logged, IAM changes are read-only, monetary units are not mixed, resource attribution is labeled as optional evidence, and inventory scans survive Cost Explorer errors.

- [ ] **Step 3: Inspect final diff**

Run: `git diff --check && git status --short && git log --oneline origin/main..HEAD`
Expected: only feature/spec/plan changes are present and no secrets, generated build files, or temporary fixtures are tracked.

- [ ] **Step 4: Commit any final documentation-only corrections**

Use a focused commit only if verification required changes; otherwise leave history unchanged.
