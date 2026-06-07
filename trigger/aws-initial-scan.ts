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
import { and, eq } from "drizzle-orm";
import { validateAssumeRole } from "@/app/lib/aws-onboarding";
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
  metadata?: Record<string, unknown>;
};

type AiRecommendation = {
  title: string;
  recommendation: string;
  estimatedSavings: number;
  severity: string;
  confidence: number;
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

async function getAverageEc2Cpu(region: string, credentials: AssumedCredentials, instanceId: string) {
  const cloudwatch = new CloudWatchClient({ region, credentials: clientCredentials(credentials) });
  const endTime = new Date();
  const startTime = new Date(endTime.getTime() - 14 * 24 * 60 * 60 * 1000);
  const response = await cloudwatch.send(
    new GetMetricStatisticsCommand({
      Namespace: "AWS/EC2",
      MetricName: "CPUUtilization",
      Dimensions: [{ Name: "InstanceId", Value: instanceId }],
      StartTime: startTime,
      EndTime: endTime,
      Period: 86400,
      Statistics: ["Average", "Maximum"],
    }),
  );

  const datapoints = response.Datapoints ?? [];
  if (datapoints.length === 0) return undefined;

  const average = datapoints.reduce((total, point) => total + (point.Average ?? 0), 0) / datapoints.length;
  const maximum = Math.max(...datapoints.map((point) => point.Maximum ?? 0));
  return {
    average: Number(average.toFixed(2)),
    maximum: Number(maximum.toFixed(2)),
    datapoints: datapoints.length,
  };
}

function getNameTag(tags?: { Key?: string; Value?: string }[]) {
  return tags?.find((tag) => tag.Key === "Name")?.Value;
}

async function buildRecommendations(resources: ScannedResource[], counts: Record<string, number>) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || resources.length === 0) return [];

  const promptResources = resources.slice(0, 80).map((resource) => ({
    id: resource.resourceId,
    name: resource.resourceName,
    type: resource.resourceType,
    service: resource.service,
    region: resource.region,
    status: resource.status,
    utilization: resource.utilization,
    metadata: resource.metadata,
  }));

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:3000",
      "X-Title": "Cloud Saver",
    },
    body: JSON.stringify({
      model: process.env.OPENROUTER_MODEL ?? "openai/gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a cloud cost optimization assistant. Return only valid JSON with a recommendations array. Do not invent exact costs; estimate conservatively from resource type, status, and utilization metrics.",
        },
        {
          role: "user",
          content: JSON.stringify({
            instruction:
              "Create up to 6 AWS cost-saving recommendations. Include title, recommendation, estimatedSavings monthly USD number, severity low/medium/high, confidence 0-100.",
            counts,
            resources: promptResources,
          }),
        },
      ],
      response_format: { type: "json_object" },
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenRouter recommendation request failed: ${response.status}`);
  }

  const data = await response.json() as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) return [];

  const parsed = JSON.parse(content) as { recommendations?: AiRecommendation[] };
  return parsed.recommendations?.slice(0, 6) ?? [];
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
        resources.push({
          resourceId: bucket.Name,
          resourceName: bucket.Name,
          resourceType: "s3-bucket",
          service: "s3",
          region: "global",
          metadata: { creationDate: bucket.CreationDate?.toISOString() },
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
          const cpu = await getAverageEc2Cpu(region, credentials, instance.InstanceId).catch(() => undefined);
          resources.push({
            resourceId: instance.InstanceId,
            resourceName: getNameTag(instance.Tags),
            resourceType: "ec2-instance",
            region,
            service: "ec2",
            status: instance.State?.Name,
            utilization: cpu?.average,
            metadata: {
              instanceType: instance.InstanceType,
              launchTime: instance.LaunchTime?.toISOString(),
              cpu,
            },
          });
        }

        for (const volume of ec2Counts.volumes) {
          if (!volume.VolumeId) continue;
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
            },
          });
        }

        if (errors.length > 0) {
          regionErrors[region] = errors;
        }
      }

      const resourcesFound = Object.values(counts).reduce((total, count) => total + count, 0);

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
