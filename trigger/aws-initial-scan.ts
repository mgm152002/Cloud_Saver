import { task } from "@trigger.dev/sdk/v3";
import {
  DescribeInstancesCommand,
  type DescribeInstancesCommandOutput,
  type Instance,
  DescribeRegionsCommand,
  DescribeVolumesCommand,
  type DescribeVolumesCommandOutput,
  type Volume,
  EC2Client,
} from "@aws-sdk/client-ec2";
import { GetMetricStatisticsCommand, CloudWatchClient } from "@aws-sdk/client-cloudwatch";
import { DescribeDBInstancesCommand, type DBInstance, type DescribeDBInstancesCommandOutput, RDSClient } from "@aws-sdk/client-rds";
import { ListBucketsCommand, type Bucket, type ListBucketsCommandOutput, S3Client } from "@aws-sdk/client-s3";
import { DescribeLoadBalancersCommand, type DescribeLoadBalancersCommandOutput, type LoadBalancer, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { LambdaClient, ListFunctionsCommand, type FunctionConfiguration, type ListFunctionsCommandOutput } from "@aws-sdk/client-lambda";
import { generateText, stepCountIs, tool } from "ai";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { validateAssumeRole } from "@/app/lib/aws-onboarding";
import { createOpenRouterModel } from "@/app/lib/ai";
import { estimateMonthlyCost, estimateResourceSavings, formatMoney } from "@/app/lib/cost-estimation";
import { db } from "@/db/db";
import { aiRecommendations, cloudAccounts, cloudResources, scanJobs } from "@/db/auth-schema";

type AwsInitialScanPayload = {
  organizationId: string;
  cloudAccountId: string;
  roleArn: string;
  externalId: string;
  region?: string;
};

type AssumedCredentials = Awaited<ReturnType<typeof validateAssumeRole>>;

type ScannedResource = {
  resourceId: string;
  resourceName?: string;
  resourceType: string;
  region?: string;
  service: string;
  status?: string;
  utilization?: number;
  monthlyCost?: number;
  metadata?: Record<string, unknown>;
};

type AiRecommendation = {
  resourceId?: string;
  title: string;
  recommendation: string;
  estimatedSavings: number;
  severity: string;
  confidence: number;
};

type MetricSummary = {
  metricName: string;
  datapoints: number;
  average?: number;
  maximum?: number;
  sum?: number;
  latestTimestamp?: string;
};

function clientCredentials(credentials: AssumedCredentials) {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  };
}

async function getRegions(credentials: AssumedCredentials, fallbackRegion: string) {
  try {
    const ec2 = new EC2Client({ region: fallbackRegion, credentials: clientCredentials(credentials) });
    const response = await ec2.send(new DescribeRegionsCommand({}));
    const regions = response.Regions?.map((region) => region.RegionName).filter(Boolean) as string[] | undefined;
    return regions?.length ? regions : [fallbackRegion];
  } catch {
    return [fallbackRegion];
  }
}

async function countEc2Resources(region: string, credentials: AssumedCredentials) {
  const ec2 = new EC2Client({ region, credentials: clientCredentials(credentials) });
  const instances: Instance[] = [];
  const volumes: Volume[] = [];
  let nextToken: string | undefined;

  do {
    const response: DescribeInstancesCommandOutput = await ec2.send(new DescribeInstancesCommand({ MaxResults: 100, NextToken: nextToken }));
    for (const reservation of response.Reservations ?? []) {
      instances.push(...(reservation.Instances ?? []));
    }
    nextToken = response.NextToken;
  } while (nextToken);

  nextToken = undefined;
  do {
    const response: DescribeVolumesCommandOutput = await ec2.send(new DescribeVolumesCommand({ MaxResults: 100, NextToken: nextToken }));
    volumes.push(...(response.Volumes ?? []));
    nextToken = response.NextToken;
  } while (nextToken);

  return { instances, volumes };
}

async function countRdsInstances(region: string, credentials: AssumedCredentials) {
  const rds = new RDSClient({ region, credentials: clientCredentials(credentials) });
  const dbInstances: DBInstance[] = [];
  let marker: string | undefined;

  do {
    const response: DescribeDBInstancesCommandOutput = await rds.send(new DescribeDBInstancesCommand({ Marker: marker, MaxRecords: 100 }));
    dbInstances.push(...(response.DBInstances ?? []));
    marker = response.Marker;
  } while (marker);

  return dbInstances;
}

async function countLoadBalancers(region: string, credentials: AssumedCredentials) {
  const elb = new ElasticLoadBalancingV2Client({ region, credentials: clientCredentials(credentials) });
  const loadBalancers: LoadBalancer[] = [];
  let marker: string | undefined;

  do {
    const response: DescribeLoadBalancersCommandOutput = await elb.send(new DescribeLoadBalancersCommand({ Marker: marker, PageSize: 100 }));
    loadBalancers.push(...(response.LoadBalancers ?? []));
    marker = response.NextMarker;
  } while (marker);

  return loadBalancers;
}

async function countLambdaFunctions(region: string, credentials: AssumedCredentials) {
  const lambda = new LambdaClient({ region, credentials: clientCredentials(credentials) });
  const functions: FunctionConfiguration[] = [];
  let marker: string | undefined;

  do {
    const response: ListFunctionsCommandOutput = await lambda.send(new ListFunctionsCommand({ Marker: marker, MaxItems: 50 }));
    functions.push(...(response.Functions ?? []));
    marker = response.NextMarker;
  } while (marker);

  return functions;
}

async function countS3Buckets(credentials: AssumedCredentials) {
  const s3 = new S3Client({ region: "us-east-1", credentials: clientCredentials(credentials) });
  const response: ListBucketsCommandOutput = await s3.send(new ListBucketsCommand({}));
  return response.Buckets ?? [];
}

async function getS3BucketActivity(credentials: AssumedCredentials, bucketName: string) {
  const cloudwatch = new CloudWatchClient({ region: "us-east-1", credentials: clientCredentials(credentials) });
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 30 * 24 * 60 * 60 * 1000);

  const requestMetricNames = ["AllRequests", "GetRequests", "PutRequests", "DeleteRequests"];
  const requestResults = await Promise.all(
    requestMetricNames.map(async (metricName) => {
      const response = await cloudwatch.send(
        new GetMetricStatisticsCommand({
          Namespace: "AWS/S3",
          MetricName: metricName,
          Dimensions: [
            { Name: "BucketName", Value: bucketName },
            { Name: "FilterId", Value: "EntireBucket" },
          ],
          StartTime: startTime,
          EndTime: endTime,
          Period: 86400,
          Statistics: ["Sum"],
        }),
      );

      return {
        metricName,
        datapoints: response.Datapoints?.length ?? 0,
        requests: response.Datapoints?.reduce((total, point) => total + (point.Sum ?? 0), 0) ?? 0,
      };
    }),
  );

  const storageResponse = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/S3",
      MetricName: "BucketSizeBytes",
      Dimensions: [
        { Name: "BucketName", Value: bucketName },
        { Name: "StorageType", Value: "StandardStorage" },
      ],
      StartTime: startTime,
      EndTime: endTime,
      Period: 86400,
      Statistics: ["Average"],
    }),
  );

  const latestStorage = [...(storageResponse.Datapoints ?? [])]
    .sort((left, right) => (right.Timestamp?.getTime() ?? 0) - (left.Timestamp?.getTime() ?? 0))
    .at(0);
  const totalRequests = requestResults.reduce((total, metric) => total + metric.requests, 0);
  const requestMetricDatapoints = requestResults.reduce((total, metric) => total + metric.datapoints, 0);

  return {
    lookbackDays: 30,
    requestMetricsAvailable: requestMetricDatapoints > 0,
    hasRecentRequests: requestMetricDatapoints > 0 ? totalRequests > 0 : undefined,
    totalRequests,
    requestMetrics: requestResults,
    storageBytes: latestStorage?.Average ? Math.round(latestStorage.Average) : undefined,
    storageMetricTimestamp: latestStorage?.Timestamp?.toISOString(),
  };
}

async function getEc2MetricSummary(
  cloudwatch: CloudWatchClient,
  dimensions: { Name: string; Value: string }[],
  metricName: string,
  statistics: ("Average" | "Maximum" | "Sum")[],
  startTime: Date,
  endTime: Date,
): Promise<MetricSummary> {
  const response = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/EC2",
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: startTime,
      EndTime: endTime,
      Period: 86400,
      Statistics: statistics,
    }),
  );

  const datapoints = response.Datapoints ?? [];
  const averageValues = datapoints.map((point) => point.Average).filter((value): value is number => typeof value === "number");
  const maximumValues = datapoints.map((point) => point.Maximum).filter((value): value is number => typeof value === "number");
  const sumValues = datapoints.map((point) => point.Sum).filter((value): value is number => typeof value === "number");

  return {
    metricName,
    datapoints: datapoints.length,
    average: averageValues.length ? Number((averageValues.reduce((total, value) => total + value, 0) / averageValues.length).toFixed(2)) : undefined,
    maximum: maximumValues.length ? Number(Math.max(...maximumValues).toFixed(2)) : undefined,
    sum: sumValues.length ? Number(sumValues.reduce((total, value) => total + value, 0).toFixed(2)) : undefined,
    latestTimestamp: [...datapoints].sort((left, right) => (right.Timestamp?.getTime() ?? 0) - (left.Timestamp?.getTime() ?? 0)).at(0)?.Timestamp?.toISOString(),
  };
}

async function getEc2CloudWatchMetrics(region: string, credentials: AssumedCredentials, instanceId: string) {
  const cloudwatch = new CloudWatchClient({ region, credentials: clientCredentials(credentials) });
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [cpu, networkIn, networkOut, diskReadBytes, diskWriteBytes] = await Promise.all([
    getEc2MetricSummary(cloudwatch, [{ Name: "InstanceId", Value: instanceId }], "CPUUtilization", ["Average", "Maximum"], startTime, endTime),
    getEc2MetricSummary(cloudwatch, [{ Name: "InstanceId", Value: instanceId }], "NetworkIn", ["Sum"], startTime, endTime),
    getEc2MetricSummary(cloudwatch, [{ Name: "InstanceId", Value: instanceId }], "NetworkOut", ["Sum"], startTime, endTime),
    getEc2MetricSummary(cloudwatch, [{ Name: "InstanceId", Value: instanceId }], "DiskReadBytes", ["Sum"], startTime, endTime),
    getEc2MetricSummary(cloudwatch, [{ Name: "InstanceId", Value: instanceId }], "DiskWriteBytes", ["Sum"], startTime, endTime),
  ]);

  return {
    namespace: "AWS/EC2",
    lookbackDays: 14,
    enabled: cpu.datapoints > 0,
    cpu,
    networkIn,
    networkOut,
    diskReadBytes,
    diskWriteBytes,
  };
}

async function getAwsMetricSummary(
  cloudwatch: CloudWatchClient,
  namespace: string,
  dimensions: { Name: string; Value: string }[],
  metricName: string,
  statistics: ("Average" | "Maximum" | "Sum")[],
  startTime: Date,
  endTime: Date,
): Promise<MetricSummary> {
  const response = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: namespace,
      MetricName: metricName,
      Dimensions: dimensions,
      StartTime: startTime,
      EndTime: endTime,
      Period: 86400,
      Statistics: statistics,
    }),
  );

  const datapoints = response.Datapoints ?? [];
  const averageValues = datapoints.map((point) => point.Average).filter((value): value is number => typeof value === "number");
  const maximumValues = datapoints.map((point) => point.Maximum).filter((value): value is number => typeof value === "number");
  const sumValues = datapoints.map((point) => point.Sum).filter((value): value is number => typeof value === "number");

  return {
    metricName,
    datapoints: datapoints.length,
    average: averageValues.length ? Number((averageValues.reduce((total, value) => total + value, 0) / averageValues.length).toFixed(2)) : undefined,
    maximum: maximumValues.length ? Number(Math.max(...maximumValues).toFixed(2)) : undefined,
    sum: sumValues.length ? Number(sumValues.reduce((total, value) => total + value, 0).toFixed(2)) : undefined,
    latestTimestamp: [...datapoints].sort((left, right) => (right.Timestamp?.getTime() ?? 0) - (left.Timestamp?.getTime() ?? 0)).at(0)?.Timestamp?.toISOString(),
  };
}

function metricWindow(days = 14) {
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - days * 24 * 60 * 60 * 1000);
  return { startTime, endTime, days };
}

async function getEbsCloudWatchMetrics(region: string, credentials: AssumedCredentials, volumeId: string) {
  const cloudwatch = new CloudWatchClient({ region, credentials: clientCredentials(credentials) });
  const { startTime, endTime, days } = metricWindow(14);
  const dimensions = [{ Name: "VolumeId", Value: volumeId }];
  const [idleTime, readOps, writeOps, queueLength] = await Promise.all([
    getAwsMetricSummary(cloudwatch, "AWS/EBS", dimensions, "VolumeIdleTime", ["Sum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/EBS", dimensions, "VolumeReadOps", ["Sum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/EBS", dimensions, "VolumeWriteOps", ["Sum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/EBS", dimensions, "VolumeQueueLength", ["Average", "Maximum"], startTime, endTime),
  ]);

  return {
    namespace: "AWS/EBS",
    lookbackDays: days,
    enabled: idleTime.datapoints + readOps.datapoints + writeOps.datapoints > 0,
    idleTime,
    readOps,
    writeOps,
    queueLength,
  };
}

async function getRdsCloudWatchMetrics(region: string, credentials: AssumedCredentials, dbInstanceIdentifier: string) {
  const cloudwatch = new CloudWatchClient({ region, credentials: clientCredentials(credentials) });
  const { startTime, endTime, days } = metricWindow(14);
  const dimensions = [{ Name: "DBInstanceIdentifier", Value: dbInstanceIdentifier }];
  const [cpu, databaseConnections, freeStorageSpace, readIops, writeIops] = await Promise.all([
    getAwsMetricSummary(cloudwatch, "AWS/RDS", dimensions, "CPUUtilization", ["Average", "Maximum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/RDS", dimensions, "DatabaseConnections", ["Average", "Maximum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/RDS", dimensions, "FreeStorageSpace", ["Average"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/RDS", dimensions, "ReadIOPS", ["Average", "Maximum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/RDS", dimensions, "WriteIOPS", ["Average", "Maximum"], startTime, endTime),
  ]);

  return {
    namespace: "AWS/RDS",
    lookbackDays: days,
    enabled: cpu.datapoints + databaseConnections.datapoints > 0,
    cpu,
    databaseConnections,
    freeStorageSpace,
    readIops,
    writeIops,
  };
}

function loadBalancerDimension(loadBalancerArn?: string) {
  return loadBalancerArn?.split(":loadbalancer/")[1];
}

async function getLoadBalancerCloudWatchMetrics(region: string, credentials: AssumedCredentials, loadBalancerArn: string) {
  const loadBalancer = loadBalancerDimension(loadBalancerArn);
  if (!loadBalancer) return undefined;

  const cloudwatch = new CloudWatchClient({ region, credentials: clientCredentials(credentials) });
  const { startTime, endTime, days } = metricWindow(14);
  const dimensions = [{ Name: "LoadBalancer", Value: loadBalancer }];
  const [requestCount, activeConnectionCount, targetResponseTime, consumedLcus] = await Promise.all([
    getAwsMetricSummary(cloudwatch, "AWS/ApplicationELB", dimensions, "RequestCount", ["Sum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/ApplicationELB", dimensions, "ActiveConnectionCount", ["Sum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/ApplicationELB", dimensions, "TargetResponseTime", ["Average", "Maximum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/ApplicationELB", dimensions, "ConsumedLCUs", ["Sum"], startTime, endTime),
  ]);

  return {
    namespace: "AWS/ApplicationELB",
    lookbackDays: days,
    enabled: requestCount.datapoints + activeConnectionCount.datapoints > 0,
    requestCount,
    activeConnectionCount,
    targetResponseTime,
    consumedLcus,
  };
}

async function getLambdaCloudWatchMetrics(region: string, credentials: AssumedCredentials, functionName: string) {
  const cloudwatch = new CloudWatchClient({ region, credentials: clientCredentials(credentials) });
  const { startTime, endTime, days } = metricWindow(14);
  const dimensions = [{ Name: "FunctionName", Value: functionName }];
  const [invocations, errors, throttles, duration] = await Promise.all([
    getAwsMetricSummary(cloudwatch, "AWS/Lambda", dimensions, "Invocations", ["Sum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/Lambda", dimensions, "Errors", ["Sum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/Lambda", dimensions, "Throttles", ["Sum"], startTime, endTime),
    getAwsMetricSummary(cloudwatch, "AWS/Lambda", dimensions, "Duration", ["Average", "Maximum"], startTime, endTime),
  ]);

  return {
    namespace: "AWS/Lambda",
    lookbackDays: days,
    enabled: invocations.datapoints + errors.datapoints + duration.datapoints > 0,
    invocations,
    errors,
    throttles,
    duration,
  };
}

function getNameTag(tags?: { Key?: string; Value?: string }[]) {
  return tags?.find((tag) => tag.Key === "Name")?.Value;
}

function parseJsonObject(text: string) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

async function buildRecommendations(resources: ScannedResource[], counts: Record<string, number>) {
  const model = createOpenRouterModel();
  if (!model || resources.length === 0) return [];

  const promptResources = resources.slice(0, 80).map((resource) => ({
    id: resource.resourceId,
    name: resource.resourceName,
    type: resource.resourceType,
    service: resource.service,
    region: resource.region,
    status: resource.status,
    utilization: resource.utilization,
    monthlyCost: resource.monthlyCost,
    metadata: resource.metadata,
  }));

  const totalMonthlyCost = formatMoney(resources.reduce((total, resource) => total + (resource.monthlyCost ?? 0), 0));
  if (totalMonthlyCost <= 0) return [];

  const result = await generateText({
    model,
    stopWhen: stepCountIs(4),
    tools: {
      summarizeInventory: tool({
        description: "Get AWS inventory counts and estimated monthly cost totals from the scanner.",
        inputSchema: z.object({}),
        execute: async () => ({
          counts,
          totalMonthlyCost,
          topCostResources: [...resources]
            .sort((left, right) => (right.monthlyCost ?? 0) - (left.monthlyCost ?? 0))
            .slice(0, 12)
            .map((resource) => ({
              id: resource.resourceId,
              name: resource.resourceName,
              type: resource.resourceType,
              service: resource.service,
              region: resource.region,
              status: resource.status,
              utilization: resource.utilization,
              monthlyCost: resource.monthlyCost,
              metadata: resource.metadata,
            })),
        }),
      }),
      estimateSavings: tool({
        description: "Estimate conservative monthly savings for a scanned AWS resource by resource id.",
        inputSchema: z.object({
          resourceId: z.string(),
          action: z.string().describe("The proposed cost optimization action."),
        }),
        execute: async ({ resourceId }) => {
          const resource = resources.find((candidate) => candidate.resourceId === resourceId);
          if (!resource) return { resourceId, estimatedSavings: 0, reason: "Resource was not found in this scan." };
          return {
            resourceId,
            monthlyCost: resource.monthlyCost ?? 0,
            estimatedSavings: formatMoney(estimateResourceSavings(resource, resource.monthlyCost ?? 0)),
            s3Activity: resource.metadata?.s3Activity,
          };
        },
      }),
    },
    system:
      "You are a cloud cost optimization assistant. Use the provided tools before finalizing recommendations. Return only valid JSON with a recommendations array. Never invent exact AWS bills; ground savings in scanned monthlyCost, status, utilization, and metadata. For EC2, EBS, RDS, load balancers, and Lambda, require metadata.cloudWatchMetrics.enabled=true before recommending rightsizing, deletion, stopping, or scheduling. If required CloudWatch metrics are missing, recommend enabling or validating metrics instead of taking action. For S3 buckets, do not recommend deletion unless metadata.s3Activity.requestMetricsAvailable is true and metadata.s3Activity.hasRecentRequests is false.",
    prompt: JSON.stringify({
      instruction:
        "Create up to 6 AWS cost-saving recommendations. Include resourceId, title, recommendation, estimatedSavings monthly USD number, severity low/medium/high, confidence 0-100. Prefer idle unattached volumes, EC2 instances with CloudWatch CPU average under 8% and maximum under 25%, RDS instances with low CPU and near-zero connections, load balancers with zero RequestCount, and Lambda functions with zero Invocations. Use metadata.cloudWatchMetrics for EC2/EBS/RDS/ELB/Lambda and never recommend rightsizing/deleting/stopping these resources when metrics are missing. For S3, use CloudWatch AWS/S3 request metrics from metadata.s3Activity; if request metrics are unavailable, recommend enabling S3 request metrics or server access logging instead of deleting the bucket. Call summarizeInventory and estimateSavings for recommendations tied to specific resources.",
      counts,
      totalMonthlyCost,
      resources: promptResources,
    }),
  });

  const parsed = parseJsonObject(result.text) as { recommendations?: AiRecommendation[] };
  return (parsed.recommendations ?? [])
    .filter((recommendation) => {
      const text = `${recommendation.title} ${recommendation.recommendation}`.toLowerCase();
      const resource = resources.find(
        (candidate) =>
          candidate.resourceId === recommendation.resourceId ||
          text.includes(candidate.resourceId.toLowerCase()) ||
          (candidate.resourceName && text.includes(candidate.resourceName.toLowerCase())),
      );
      const isS3Delete = resource?.resourceType === "s3-bucket" && /\b(delete|remove|terminate)\b/.test(text);
      if (!isS3Delete) return true;

      const activity = resource?.metadata?.s3Activity as { requestMetricsAvailable?: boolean; hasRecentRequests?: boolean } | undefined;
      return activity?.requestMetricsAvailable === true && activity.hasRecentRequests === false;
    })
    .filter((recommendation) => {
      const text = `${recommendation.title} ${recommendation.recommendation}`.toLowerCase();
      const resource = resources.find(
        (candidate) =>
          candidate.resourceType === "ec2-instance" &&
          (candidate.resourceId === recommendation.resourceId ||
            text.includes(candidate.resourceId.toLowerCase()) ||
            Boolean(candidate.resourceName && text.includes(candidate.resourceName.toLowerCase()))),
      );
      const isEc2Optimization = Boolean(resource) && /\b(rightsize|resize|downsize|stop|terminate|delete|schedule|reserved|savings plan)\b/.test(text);
      if (!isEc2Optimization) return true;

      const metrics = resource?.metadata?.cloudWatchMetrics as { enabled?: boolean; cpu?: { datapoints?: number; average?: number; maximum?: number } } | undefined;
      return metrics?.enabled === true && Boolean(metrics.cpu?.datapoints) && Number(metrics.cpu?.average ?? 100) < 8 && Number(metrics.cpu?.maximum ?? 100) < 25;
    })
    .slice(0, 6);
}

export const awsInitialScan = task({
  id: "aws-initial-scan",
  run: async (payload: AwsInitialScanPayload) => {
    const startedAt = new Date();

    const [scanJob] = await db
      .insert(scanJobs)
      .values({
        organizationId: payload.organizationId,
        cloudAccountId: payload.cloudAccountId,
        status: "running",
        startedAt,
      })
      .returning();

    try {
      const credentials = await validateAssumeRole(payload.roleArn, payload.externalId);
      const fallbackRegion = payload.region ?? "ap-south-1";
      const regions = await getRegions(credentials, fallbackRegion);
      const resources: ScannedResource[] = [];
      const counts = {
        ec2Instances: 0,
        ec2Volumes: 0,
        rdsInstances: 0,
        loadBalancers: 0,
        lambdaFunctions: 0,
        s3Buckets: 0,
      };

      const regionErrors: Record<string, string[]> = {};
      const buckets = await countS3Buckets(credentials).catch(() => [] as Bucket[]);
      counts.s3Buckets = buckets.length;
      for (const bucket of buckets) {
        if (!bucket.Name) continue;
        const s3Activity = await getS3BucketActivity(credentials, bucket.Name).catch((error: unknown) => {
          regionErrors.s3 = [
            ...(regionErrors.s3 ?? []),
            `${bucket.Name}: ${error instanceof Error ? error.message : "CloudWatch S3 metrics failed"}`,
          ];
          return undefined;
        });
        resources.push({
          resourceId: bucket.Name,
          resourceName: bucket.Name,
          resourceType: "s3-bucket",
          service: "s3",
          region: "global",
          metadata: { creationDate: bucket.CreationDate?.toISOString(), s3Activity },
        });
      }

      for (const region of regions) {
        const errors: string[] = [];

        const ec2Counts = await countEc2Resources(region, credentials).catch((error: unknown) => {
          errors.push(`ec2: ${error instanceof Error ? error.message : "failed"}`);
          return { instances: [] as Instance[], volumes: [] as Volume[] };
        });
        counts.ec2Instances += ec2Counts.instances.length;
        counts.ec2Volumes += ec2Counts.volumes.length;

        for (const instance of ec2Counts.instances) {
          if (!instance.InstanceId) continue;
          const cloudWatchMetrics = await getEc2CloudWatchMetrics(region, credentials, instance.InstanceId).catch((error: unknown) => {
            errors.push(`cloudwatch/ec2/${instance.InstanceId}: ${error instanceof Error ? error.message : "metrics failed"}`);
            return undefined;
          });
          const cpu = cloudWatchMetrics?.cpu;
          resources.push({
            resourceId: instance.InstanceId,
            resourceName: getNameTag(instance.Tags),
            resourceType: "ec2-instance",
            region,
            service: "ec2",
            status: instance.State?.Name,
            utilization: cloudWatchMetrics?.enabled ? cpu?.average : undefined,
            metadata: {
              instanceType: instance.InstanceType,
              launchTime: instance.LaunchTime?.toISOString(),
              cloudWatchMetrics,
              cpu,
            },
          });
        }

        for (const volume of ec2Counts.volumes) {
          if (!volume.VolumeId) continue;
          const cloudWatchMetrics = await getEbsCloudWatchMetrics(region, credentials, volume.VolumeId).catch((error: unknown) => {
            errors.push(`cloudwatch/ebs/${volume.VolumeId}: ${error instanceof Error ? error.message : "metrics failed"}`);
            return undefined;
          });
          resources.push({
            resourceId: volume.VolumeId,
            resourceType: "ec2-volume",
            region,
            service: "ec2",
            status: volume.State,
            metadata: {
              size: volume.Size,
              volumeType: volume.VolumeType,
              attachments: volume.Attachments?.length ?? 0,
              cloudWatchMetrics,
            },
          });
        }

        const rdsInstances = await countRdsInstances(region, credentials).catch((error: unknown) => {
          errors.push(`rds: ${error instanceof Error ? error.message : "failed"}`);
          return [] as DBInstance[];
        });
        counts.rdsInstances += rdsInstances.length;
        for (const dbInstance of rdsInstances) {
          if (!dbInstance.DBInstanceArn && !dbInstance.DBInstanceIdentifier) continue;
          const cloudWatchMetrics = dbInstance.DBInstanceIdentifier
            ? await getRdsCloudWatchMetrics(region, credentials, dbInstance.DBInstanceIdentifier).catch((error: unknown) => {
                errors.push(`cloudwatch/rds/${dbInstance.DBInstanceIdentifier}: ${error instanceof Error ? error.message : "metrics failed"}`);
                return undefined;
              })
            : undefined;
          resources.push({
            resourceId: dbInstance.DBInstanceArn ?? dbInstance.DBInstanceIdentifier!,
            resourceName: dbInstance.DBInstanceIdentifier,
            resourceType: "rds-instance",
            region,
            service: "rds",
            status: dbInstance.DBInstanceStatus,
            metadata: {
              instanceClass: dbInstance.DBInstanceClass,
              engine: dbInstance.Engine,
              allocatedStorage: dbInstance.AllocatedStorage,
              multiAZ: dbInstance.MultiAZ,
              cloudWatchMetrics,
            },
          });
        }

        const loadBalancers = await countLoadBalancers(region, credentials).catch((error: unknown) => {
          errors.push(`elb: ${error instanceof Error ? error.message : "failed"}`);
          return [] as LoadBalancer[];
        });
        counts.loadBalancers += loadBalancers.length;
        for (const loadBalancer of loadBalancers) {
          if (!loadBalancer.LoadBalancerArn) continue;
          const cloudWatchMetrics = await getLoadBalancerCloudWatchMetrics(region, credentials, loadBalancer.LoadBalancerArn).catch((error: unknown) => {
            errors.push(`cloudwatch/elb/${loadBalancer.LoadBalancerName ?? loadBalancer.LoadBalancerArn}: ${error instanceof Error ? error.message : "metrics failed"}`);
            return undefined;
          });
          resources.push({
            resourceId: loadBalancer.LoadBalancerArn,
            resourceName: loadBalancer.LoadBalancerName,
            resourceType: "load-balancer",
            region,
            service: "elasticloadbalancing",
            status: loadBalancer.State?.Code,
            metadata: {
              type: loadBalancer.Type,
              scheme: loadBalancer.Scheme,
              cloudWatchMetrics,
            },
          });
        }

        const functions = await countLambdaFunctions(region, credentials).catch((error: unknown) => {
          errors.push(`lambda: ${error instanceof Error ? error.message : "failed"}`);
          return [] as FunctionConfiguration[];
        });
        counts.lambdaFunctions += functions.length;
        for (const fn of functions) {
          if (!fn.FunctionArn && !fn.FunctionName) continue;
          const cloudWatchMetrics = fn.FunctionName
            ? await getLambdaCloudWatchMetrics(region, credentials, fn.FunctionName).catch((error: unknown) => {
                errors.push(`cloudwatch/lambda/${fn.FunctionName}: ${error instanceof Error ? error.message : "metrics failed"}`);
                return undefined;
              })
            : undefined;
          resources.push({
            resourceId: fn.FunctionArn ?? fn.FunctionName!,
            resourceName: fn.FunctionName,
            resourceType: "lambda-function",
            region,
            service: "lambda",
            status: fn.State,
            metadata: {
              runtime: fn.Runtime,
              memorySize: fn.MemorySize,
              codeSize: fn.CodeSize,
              lastModified: fn.LastModified,
              cloudWatchMetrics,
            },
          });
        }

        if (errors.length > 0) {
          regionErrors[region] = errors;
        }
      }

      const resourcesFound = Object.values(counts).reduce((total, count) => total + count, 0);
      for (const resource of resources) {
        resource.monthlyCost = formatMoney(estimateMonthlyCost(resource));
      }
      const estimatedMonthlyCost = formatMoney(resources.reduce((total, resource) => total + (resource.monthlyCost ?? 0), 0));

      const completedAt = new Date();

      await db
        .update(aiRecommendations)
        .set({ status: "stale" })
        .where(and(eq(aiRecommendations.organizationId, payload.organizationId), eq(aiRecommendations.status, "pending")));

      await db
        .delete(cloudResources)
        .where(and(eq(cloudResources.organizationId, payload.organizationId), eq(cloudResources.cloudAccountId, payload.cloudAccountId)));

      if (resources.length > 0) {
        await db.insert(cloudResources).values(
          resources.map((resource) => ({
            organizationId: payload.organizationId,
            cloudAccountId: payload.cloudAccountId,
            provider: "aws",
            resourceId: resource.resourceId,
            resourceName: resource.resourceName,
            resourceType: resource.resourceType,
            region: resource.region,
            service: resource.service,
            status: resource.status,
            monthlyCost: String(resource.monthlyCost ?? 0),
            utilization: typeof resource.utilization === "number" ? String(resource.utilization) : undefined,
            metadata: resource.metadata,
            firstSeenAt: completedAt,
            lastSeenAt: completedAt,
          })),
        );
      }

      const recommendations = await buildRecommendations(resources, counts).catch((error: unknown) => {
        regionErrors.ai = [error instanceof Error ? error.message : "OpenRouter recommendations failed"];
        return [] as AiRecommendation[];
      });

      if (recommendations.length > 0) {
        await db.insert(aiRecommendations).values(
          recommendations.map((recommendation) => ({
            organizationId: payload.organizationId,
            title: recommendation.title,
            recommendation: recommendation.recommendation,
            estimatedSavings: String(Math.max(0, recommendation.estimatedSavings || 0)),
            severity: recommendation.severity,
            confidence: recommendation.confidence,
            status: "pending",
          })),
        );
      }

      await db
        .update(scanJobs)
        .set({
          status: "completed",
          completedAt,
          resourcesFound,
          scanMetadata: {
            regions,
            counts,
            estimatedMonthlyCost,
            resourcesStored: resources.length,
            recommendationsCreated: recommendations.length,
            regionErrors,
            scannedServices: ["ec2", "rds", "elasticloadbalancingv2", "lambda", "s3"],
            note: "Initial scan validates access and counts common AWS resources across regions.",
          },
        })
        .where(eq(scanJobs.id, scanJob.id));

      await db
        .update(cloudAccounts)
        .set({
          status: "connected",
          lastScanAt: completedAt,
        })
        .where(eq(cloudAccounts.id, payload.cloudAccountId));

      return {
        status: "completed",
        scanJobId: scanJob.id,
        resourcesFound,
        estimatedMonthlyCost,
        counts,
        recommendationsCreated: recommendations.length,
      };
    } catch (error) {
      await db
        .update(scanJobs)
        .set({
          status: "failed",
          completedAt: new Date(),
          scanMetadata: {
            error: error instanceof Error ? error.message : "Initial scan failed",
          },
        })
        .where(eq(scanJobs.id, scanJob.id));

      await db
        .update(cloudAccounts)
        .set({ status: "validation_failed" })
        .where(eq(cloudAccounts.id, payload.cloudAccountId));

      throw error;
    }
  },
});
