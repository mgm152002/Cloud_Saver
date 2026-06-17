import { getS3MetricState } from "@/app/lib/s3-metrics";

type CostResource = {
  resourceType: string;
  status?: string;
  utilization?: number;
  metadata?: Record<string, unknown>;
};

const HOURS_PER_MONTH = 730;

const ec2HourlyByFamily: Record<string, number> = {
  t2: 0.0416,
  t3: 0.0416,
  t4g: 0.0336,
  m5: 0.096,
  m6i: 0.096,
  m7i: 0.1008,
  c5: 0.085,
  c6i: 0.085,
  r5: 0.126,
  r6i: 0.126,
};

const rdsHourlyByFamily: Record<string, number> = {
  "db.t3": 0.068,
  "db.t4g": 0.058,
  "db.m5": 0.171,
  "db.m6i": 0.178,
  "db.r5": 0.24,
  "db.r6i": 0.25,
};

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function hourlyRate(instanceType: string | undefined, rates: Record<string, number>, fallback: number) {
  if (!instanceType) return fallback;
  const exactFamily = instanceType.split(".").slice(0, 2).join(".");
  const family = instanceType.split(".")[0];
  return rates[exactFamily] ?? rates[family] ?? fallback;
}

function cloudWatchMetrics(resource: CostResource) {
  return resource.metadata?.cloudWatchMetrics as
    | {
        enabled?: boolean;
        cpu?: { datapoints?: number; average?: number; maximum?: number };
        databaseConnections?: { datapoints?: number; average?: number; maximum?: number };
        idleTime?: { datapoints?: number; sum?: number };
        readOps?: { datapoints?: number; sum?: number };
        writeOps?: { datapoints?: number; sum?: number };
        requestCount?: { datapoints?: number; sum?: number };
        invocations?: { datapoints?: number; sum?: number };
      }
    | undefined;
}

export function estimateMonthlyCost(resource: CostResource) {
  if (resource.resourceType === "ec2-instance") {
    if (resource.status === "stopped" || resource.status === "terminated") return 0;
    const instanceType = stringValue(resource.metadata?.instanceType);
    return hourlyRate(instanceType, ec2HourlyByFamily, 0.05) * HOURS_PER_MONTH;
  }

  if (resource.resourceType === "ec2-volume") {
    const size = numberValue(resource.metadata?.size);
    const volumeType = stringValue(resource.metadata?.volumeType);
    const gbMonthRate = volumeType === "io1" || volumeType === "io2" ? 0.125 : 0.08;
    return size * gbMonthRate;
  }

  if (resource.resourceType === "rds-instance") {
    const instanceClass = stringValue(resource.metadata?.instanceClass);
    const compute = hourlyRate(instanceClass, rdsHourlyByFamily, 0.09) * HOURS_PER_MONTH;
    const storage = numberValue(resource.metadata?.allocatedStorage) * 0.115;
    const multiAzMultiplier = resource.metadata?.multiAZ === true ? 2 : 1;
    return (compute + storage) * multiAzMultiplier;
  }

  if (resource.resourceType === "load-balancer") {
    return 0.0225 * HOURS_PER_MONTH;
  }

  if (resource.resourceType === "lambda-function") {
    const codeSizeMb = numberValue(resource.metadata?.codeSize) / 1024 / 1024;
    return codeSizeMb > 250 ? 3 : 0.5;
  }

  if (resource.resourceType === "s3-bucket") {
    return 1;
  }

  return 0;
}

export function estimateResourceSavings(resource: CostResource, monthlyCost: number) {
  if (monthlyCost <= 0) return 0;

  if (resource.resourceType === "s3-bucket") {
    const activity = getS3MetricState(resource.metadata);
    return activity.requestMetricsAvailable === true && activity.hasRecentRequests === false ? monthlyCost : 0;
  }

  if (resource.resourceType === "ec2-volume" && numberValue(resource.metadata?.attachments) === 0) {
    return monthlyCost;
  }

  if (resource.resourceType === "ec2-volume") {
    const metrics = cloudWatchMetrics(resource);
    const totalOps = numberValue(metrics?.readOps?.sum) + numberValue(metrics?.writeOps?.sum);
    return metrics?.enabled === true && totalOps === 0 ? monthlyCost * 0.8 : 0;
  }

  if (resource.resourceType === "ec2-instance" && numberValue(resource.utilization) > 0 && numberValue(resource.utilization) < 8) {
    const metrics = cloudWatchMetrics(resource);
    const legacyCpu = resource.metadata?.cpu as { datapoints?: number; maximum?: number } | undefined;
    const hasMetrics = (metrics?.enabled === true && Boolean(metrics.cpu?.datapoints)) || Boolean(legacyCpu?.datapoints);
    if (!hasMetrics || numberValue(metrics?.cpu?.maximum ?? legacyCpu?.maximum, 100) >= 25) {
      return 0;
    }
    return monthlyCost * 0.45;
  }

  if (resource.resourceType === "rds-instance") {
    const metrics = cloudWatchMetrics(resource);
    const lowCpu = numberValue(metrics?.cpu?.average, 100) < 10 && numberValue(metrics?.cpu?.maximum, 100) < 35;
    const lowConnections = numberValue(metrics?.databaseConnections?.average, 100) < 1;
    return metrics?.enabled === true && lowCpu && lowConnections ? monthlyCost * 0.25 : 0;
  }

  if (resource.resourceType === "load-balancer" && resource.status !== "active") {
    return monthlyCost * 0.8;
  }

  if (resource.resourceType === "load-balancer") {
    const metrics = cloudWatchMetrics(resource);
    return metrics?.enabled === true && numberValue(metrics.requestCount?.sum) === 0 ? monthlyCost * 0.8 : 0;
  }

  if (resource.resourceType === "lambda-function") {
    const metrics = cloudWatchMetrics(resource);
    return metrics?.enabled === true && numberValue(metrics.invocations?.sum) === 0 ? monthlyCost : 0;
  }

  return monthlyCost * 0.08;
}

export function formatMoney(value: number) {
  return Number(value.toFixed(2));
}
