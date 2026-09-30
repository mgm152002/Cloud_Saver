import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageWithResourcesCommand,
  GetCostForecastCommand,
  type DateInterval,
  type ResultByTime,
} from "@aws-sdk/client-cost-explorer";
import {
  calculateServiceIncreases,
  detectCostAnomalies,
  type CostAnomalyCandidate,
  type DailyCostPoint,
  type ServiceIncrease,
} from "@/app/lib/cost-anomaly";

export type AwsTemporaryCredentials = {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
};

export type CostExplorerClientLike = {
  send(command: unknown): Promise<unknown>;
};

export type CostDateWindows = {
  history: DateInterval;
  resourceHistory: DateInterval;
  forecast: DateInterval;
  monthStart: string;
  latestCompletedDate: string;
};

export type CostForecast = {
  monthStart: string;
  monthEnd: string;
  monthToDate: number;
  predictedRemaining: number;
  forecastedMonthEnd: number;
  lowerBound: number | null;
  upperBound: number | null;
  currency: string;
};

export type CostAnomalyWithAttribution = CostAnomalyCandidate & {
  likelyResourceId: string | null;
  resourceIncreaseAmount: number | null;
  attributionStatus: "not_applicable" | "resolved" | "no_resource_increase" | "resource_data_unavailable";
};

export type CollectedCostInsights = {
  dailyCosts: DailyCostPoint[];
  forecast: CostForecast | null;
  anomalies: CostAnomalyWithAttribution[];
  serviceIncreases: ServiceIncrease[];
  status: "available" | "partial" | "unavailable";
  message: string | null;
  collectedAt: string;
};

type CostAndUsageResponseShape = {
  ResultsByTime?: ResultByTime[];
  NextPageToken?: string;
};

type ForecastResponseShape = {
  Total?: { Amount?: string; Unit?: string };
  ForecastResultsByTime?: {
    MeanValue?: string;
    PredictionIntervalLowerBound?: string;
    PredictionIntervalUpperBound?: string;
  }[];
};

function isoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function shiftUtcDate(date: Date, days: number) {
  const shifted = new Date(date);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function startOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfNextUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

function roundMoney(value: number) {
  return Number(value.toFixed(2));
}

function numberValue(value: string | undefined) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : "UnknownError";
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown Cost Explorer error";
}

export function buildCostDateWindows(now: Date): CostDateWindows {
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const latestCompletedDate = shiftUtcDate(todayUtc, -1);

  return {
    history: { Start: isoDate(shiftUtcDate(todayUtc, -30)), End: isoDate(todayUtc) },
    resourceHistory: { Start: isoDate(shiftUtcDate(todayUtc, -8)), End: isoDate(todayUtc) },
    forecast: { Start: isoDate(todayUtc), End: isoDate(startOfNextUtcMonth(todayUtc)) },
    monthStart: isoDate(startOfUtcMonth(todayUtc)),
    latestCompletedDate: isoDate(latestCompletedDate),
  };
}

async function fetchDailyCosts(client: CostExplorerClientLike, window: DateInterval, accountIdentifier: string) {
  const serviceByDate = new Map<string, { amount: number; currency: string; estimated: boolean }>();
  const observedDates = new Map<string, boolean>();
  const serviceCurrencies = new Map<string, string>();
  let nextPageToken: string | undefined;

  do {
    const response = (await client.send(
      new GetCostAndUsageCommand({
        TimePeriod: window,
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        GroupBy: [{ Type: "DIMENSION", Key: "SERVICE" }],
        NextPageToken: nextPageToken,
      }),
    )) as CostAndUsageResponseShape;

    for (const result of response.ResultsByTime ?? []) {
      const date = result.TimePeriod?.Start;
      if (!date) continue;
      observedDates.set(date, Boolean(observedDates.get(date) || result.Estimated));
      for (const group of result.Groups ?? []) {
        const service = group.Keys?.[0];
        const metric = group.Metrics?.UnblendedCost;
        if (!service || !metric?.Unit) continue;
        serviceCurrencies.set(service, metric.Unit);
        const key = `${date}\u0000${service}`;
        const previous = serviceByDate.get(key);
        serviceByDate.set(key, {
          amount: roundMoney((previous?.amount ?? 0) + numberValue(metric.Amount)),
          currency: metric.Unit,
          estimated: Boolean(previous?.estimated || result.Estimated),
        });
      }
    }
    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  for (const [date, estimated] of observedDates) {
    for (const [service, currency] of serviceCurrencies) {
      const key = `${date}\u0000${service}`;
      if (!serviceByDate.has(key)) {
        serviceByDate.set(key, { amount: 0, currency, estimated });
      }
    }
  }

  const servicePoints = [...serviceByDate.entries()].map(([key, value]) => {
    const [date, service] = key.split("\u0000");
    return {
      date,
      amount: value.amount,
      dimensionType: "service" as const,
      dimensionValue: service,
      currency: value.currency,
      estimated: value.estimated,
    };
  });

  const accountByDate = new Map<string, DailyCostPoint>();
  for (const point of servicePoints) {
    const previous = accountByDate.get(point.date);
    accountByDate.set(point.date, {
      date: point.date,
      amount: roundMoney((previous?.amount ?? 0) + point.amount),
      dimensionType: "account",
      dimensionValue: accountIdentifier,
      currency: point.currency,
      estimated: Boolean(previous?.estimated || point.estimated),
    });
  }

  return [...accountByDate.values(), ...servicePoints].sort((left, right) =>
    left.date.localeCompare(right.date) || left.dimensionType.localeCompare(right.dimensionType) || left.dimensionValue.localeCompare(right.dimensionValue),
  );
}

async function fetchForecast(
  client: CostExplorerClientLike,
  windows: CostDateWindows,
  dailyCosts: DailyCostPoint[],
): Promise<CostForecast> {
  const response = (await client.send(
    new GetCostForecastCommand({
      TimePeriod: windows.forecast,
      Granularity: "DAILY",
      Metric: "UNBLENDED_COST",
      PredictionIntervalLevel: 80,
    }),
  )) as ForecastResponseShape;
  const dailyCurrency = dailyCosts.find((point) => point.dimensionType === "account")?.currency ?? "USD";
  const forecastCurrency = response.Total?.Unit;
  if (!forecastCurrency || forecastCurrency !== dailyCurrency) {
    throw Object.assign(new Error("Cost forecast currency does not match daily cost currency."), { name: "CurrencyMismatchError" });
  }

  const monthToDate = roundMoney(
    dailyCosts
      .filter((point) => point.dimensionType === "account" && point.date >= windows.monthStart)
      .reduce((total, point) => total + point.amount, 0),
  );
  const predictedRemaining = roundMoney(numberValue(response.Total?.Amount));
  const lowerRemaining = roundMoney(
    (response.ForecastResultsByTime ?? []).reduce((total, point) => total + numberValue(point.PredictionIntervalLowerBound), 0),
  );
  const upperRemaining = roundMoney(
    (response.ForecastResultsByTime ?? []).reduce((total, point) => total + numberValue(point.PredictionIntervalUpperBound), 0),
  );

  return {
    monthStart: windows.monthStart,
    monthEnd: windows.forecast.End!,
    monthToDate,
    predictedRemaining,
    forecastedMonthEnd: roundMoney(monthToDate + predictedRemaining),
    lowerBound: response.ForecastResultsByTime?.length ? roundMoney(monthToDate + lowerRemaining) : null,
    upperBound: response.ForecastResultsByTime?.length ? roundMoney(monthToDate + upperRemaining) : null,
    currency: forecastCurrency,
  };
}

async function fetchResourceAttribution(
  client: CostExplorerClientLike,
  window: DateInterval,
  latestDate: string,
  service: string,
) {
  const resourceByDate = new Map<string, number>();
  let nextPageToken: string | undefined;

  do {
    const response = (await client.send(
      new GetCostAndUsageWithResourcesCommand({
        TimePeriod: window,
        Granularity: "DAILY",
        Metrics: ["UnblendedCost"],
        Filter: { Dimensions: { Key: "SERVICE", Values: [service] } },
        GroupBy: [{ Type: "DIMENSION", Key: "RESOURCE_ID" }],
        NextPageToken: nextPageToken,
      }),
    )) as CostAndUsageResponseShape;

    for (const result of response.ResultsByTime ?? []) {
      const date = result.TimePeriod?.Start;
      if (!date) continue;
      for (const group of result.Groups ?? []) {
        const resourceId = group.Keys?.at(-1);
        if (!resourceId) continue;
        const key = `${date}\u0000${resourceId}`;
        resourceByDate.set(key, roundMoney((resourceByDate.get(key) ?? 0) + numberValue(group.Metrics?.UnblendedCost?.Amount)));
      }
    }
    nextPageToken = response.NextPageToken;
  } while (nextPageToken);

  const baselineDates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(`${latestDate}T00:00:00.000Z`);
    date.setUTCDate(date.getUTCDate() + index - 7);
    return isoDate(date);
  });
  const resourceIds = new Set([...resourceByDate.keys()].map((key) => key.split("\u0000")[1]));
  const candidates = [...resourceIds].map((resourceId) => {
    const latest = resourceByDate.get(`${latestDate}\u0000${resourceId}`) ?? 0;
    const baseline = baselineDates.reduce((total, date) => total + (resourceByDate.get(`${date}\u0000${resourceId}`) ?? 0), 0) / 7;
    return { resourceId, increaseAmount: roundMoney(latest - baseline) };
  });

  return candidates.filter((candidate) => candidate.increaseAmount > 0).sort((left, right) => right.increaseAmount - left.increaseAmount)[0] ?? null;
}

function unavailableResult(now: Date, message: string): CollectedCostInsights {
  return {
    dailyCosts: [],
    forecast: null,
    anomalies: [],
    serviceIncreases: [],
    status: "unavailable",
    message,
    collectedAt: now.toISOString(),
  };
}

export async function collectCostInsights(
  credentials: AwsTemporaryCredentials,
  options: { now?: Date; client?: CostExplorerClientLike; accountIdentifier?: string } = {},
): Promise<CollectedCostInsights> {
  const now = options.now ?? new Date();
  const windows = buildCostDateWindows(now);
  const client = options.client ?? (new CostExplorerClient({ region: "us-east-1", credentials }) as CostExplorerClientLike);
  let dailyCosts: DailyCostPoint[];

  try {
    dailyCosts = await fetchDailyCosts(client, windows.history, options.accountIdentifier ?? "aws-account");
  } catch (error) {
    const message = errorName(error) === "AccessDeniedException"
      ? "AWS Cost Explorer permissions are missing. Re-deploy the CloudSaver access stack."
      : `AWS Cost Explorer is unavailable: ${errorMessage(error)}`;
    return unavailableResult(now, message);
  }

  if (!dailyCosts.some((point) => point.dimensionType === "account")) {
    return unavailableResult(now, "AWS Cost Explorer returned no billing data for the selected period.");
  }

  const currencies = new Set(dailyCosts.map((point) => point.currency));
  if (currencies.size !== 1 || !currencies.has("USD")) {
    return unavailableResult(now, "CloudSaver currently supports USD Cost Explorer data only.");
  }

  const messages: string[] = [];
  let forecast: CostForecast | null = null;
  try {
    forecast = await fetchForecast(client, windows, dailyCosts);
  } catch (error) {
    messages.push(errorName(error) === "CurrencyMismatchError" ? errorMessage(error) : `Cost forecast unavailable: ${errorMessage(error)}`);
  }

  const baseAnomalies = detectCostAnomalies(dailyCosts, windows.latestCompletedDate);
  const anomalies: CostAnomalyWithAttribution[] = [];
  for (const anomaly of baseAnomalies) {
    if (!anomaly.service) {
      anomalies.push({ ...anomaly, likelyResourceId: null, resourceIncreaseAmount: null, attributionStatus: "not_applicable" });
      continue;
    }

    try {
      const attribution = await fetchResourceAttribution(
        client,
        windows.resourceHistory,
        windows.latestCompletedDate,
        anomaly.service,
      );
      anomalies.push({
        ...anomaly,
        likelyResourceId: attribution?.resourceId ?? null,
        resourceIncreaseAmount: attribution?.increaseAmount ?? null,
        attributionStatus: attribution ? "resolved" : "no_resource_increase",
      });
    } catch (error) {
      anomalies.push({
        ...anomaly,
        likelyResourceId: null,
        resourceIncreaseAmount: null,
        attributionStatus: "resource_data_unavailable",
      });
      messages.push(`Resource-level cost data unavailable for ${anomaly.service}: ${errorMessage(error)}`);
    }
  }

  return {
    dailyCosts,
    forecast,
    anomalies,
    serviceIncreases: calculateServiceIncreases(dailyCosts, windows.latestCompletedDate),
    status: messages.length ? "partial" : "available",
    message: messages.length ? messages.join(" ") : null,
    collectedAt: now.toISOString(),
  };
}
