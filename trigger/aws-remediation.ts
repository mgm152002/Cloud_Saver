import { CreateSnapshotCommand, DeleteVolumeCommand, EC2Client, ModifyInstanceAttributeCommand, StartInstancesCommand, StopInstancesCommand } from "@aws-sdk/client-ec2";
import { DeleteFunctionCommand, LambdaClient, UpdateFunctionConfigurationCommand } from "@aws-sdk/client-lambda";
import { DeleteLoadBalancerCommand, ElasticLoadBalancingV2Client } from "@aws-sdk/client-elastic-load-balancing-v2";
import { CreateDBSnapshotCommand, ModifyDBInstanceCommand, RDSClient } from "@aws-sdk/client-rds";
import { PutBucketLifecycleConfigurationCommand, S3Client } from "@aws-sdk/client-s3";
import { task } from "@trigger.dev/sdk/v3";
import { eq } from "drizzle-orm";
import { validateAssumeRole, type AwsCredentialsMetadata } from "@/app/lib/aws-onboarding";
import { aiRecommendations, aiRemediations, cloudAccounts, cloudResources } from "@/db/auth-schema";
import { db } from "@/db/db";

type AwsRemediationPayload = {
  organizationId: string;
  cloudAccountId: string;
  remediationId: string;
  requestedByUserId: string;
};

type ExecutionPlan = {
  recommendation?: string;
  resourceId?: string;
  resourceName?: string | null;
  currentState?: Record<string, unknown>;
  targetState?: Record<string, unknown>;
  steps?: string[];
  awsCli?: string[];
  context?: {
    resourceDatabaseId?: string;
    resourceType?: string;
    service?: string | null;
    tags?: Record<string, string> | { key: string; value: string | number | boolean | null }[];
    tagContext?: {
      owner?: string | null;
      environment?: string | null;
      workload?: string | null;
      costCenter?: string | null;
    };
  };
};

type ToolResult = {
  status: "implemented" | "needs_review";
  message: string;
  logs: string[];
};

type ExecutionContext = {
  account: typeof cloudAccounts.$inferSelect;
  resource: typeof cloudResources.$inferSelect;
  remediation: typeof aiRemediations.$inferSelect;
  executionPlan: ExecutionPlan;
  credentials: Awaited<ReturnType<typeof validateAssumeRole>>;
  logs: string[];
};

function clientCredentials(credentials: Awaited<ReturnType<typeof validateAssumeRole>>) {
  return {
    accessKeyId: credentials.accessKeyId,
    secretAccessKey: credentials.secretAccessKey,
    sessionToken: credentials.sessionToken,
  };
}

function getString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function getNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
}

function commandLog(command: string) {
  return `$ ${command}`;
}

const instanceSizeOrder = ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge"];

function isPlaceholderValue(value: unknown) {
  return typeof value === "string" && /<.*>|placeholder|compatible|target/i.test(value);
}

function getCurrentInstanceType(resource: typeof cloudResources.$inferSelect) {
  const metadata = resource.metadata as { instanceType?: unknown } | null;
  return typeof metadata?.instanceType === "string" ? metadata.instanceType : null;
}

function getSmallerInstanceType(instanceType: string | null) {
  if (!instanceType?.includes(".")) return null;
  const [family, size] = instanceType.split(".");
  const currentIndex = instanceSizeOrder.indexOf(size);
  if (currentIndex <= 0) return null;
  return `${family}.${instanceSizeOrder[currentIndex - 1]}`;
}

async function loadExecutionContext(payload: AwsRemediationPayload): Promise<ExecutionContext> {
  const [remediation] = await db
    .select()
    .from(aiRemediations)
    .where(eq(aiRemediations.id, payload.remediationId))
    .limit(1);

  if (!remediation || remediation.organizationId !== payload.organizationId) {
    throw new Error("Action plan not found.");
  }

  const [recommendation] = remediation.recommendationId
    ? await db.select().from(aiRecommendations).where(eq(aiRecommendations.id, remediation.recommendationId)).limit(1)
    : [];

  const executionPlan = (remediation.executionPlan ?? {}) as ExecutionPlan;
  const resourceDatabaseId = recommendation?.resourceId ?? executionPlan.context?.resourceDatabaseId;
  if (!resourceDatabaseId) {
    throw new Error("Action plan is not linked to a resource.");
  }

  const [account] = await db
    .select()
    .from(cloudAccounts)
    .where(eq(cloudAccounts.id, payload.cloudAccountId))
    .limit(1);

  if (!account || account.organizationId !== payload.organizationId) {
    throw new Error("Cloud account not found.");
  }

  const [resource] = await db
    .select()
    .from(cloudResources)
    .where(eq(cloudResources.id, resourceDatabaseId))
    .limit(1);

  if (!resource || resource.organizationId !== payload.organizationId || resource.cloudAccountId !== payload.cloudAccountId) {
    throw new Error("Linked resource not found.");
  }

  const accountCredentials = account.credentials as AwsCredentialsMetadata | null;
  if (!accountCredentials?.roleArn || !accountCredentials.externalId) {
    throw new Error("AWS account is missing role credentials.");
  }

  const credentials = await validateAssumeRole(accountCredentials.roleArn, accountCredentials.externalId);
  const logs = [
    `Loaded action plan ${remediation.id}.`,
    `Loaded resource ${resource.resourceId} (${resource.resourceType}).`,
    `Assumed AWS role ${accountCredentials.roleArn}.`,
  ];

  return { account, resource, remediation, executionPlan, credentials, logs };
}

function requireNonProd(ctx: ExecutionContext) {
  const tags = ctx.resource.tags as Record<string, string> | null;
  const env = (tags?.environment ?? tags?.env ?? ctx.executionPlan.context?.tagContext?.environment ?? "").toLowerCase();
  if (env === "prod" || env === "production") {
    ctx.logs.push("Production tag detected. Proceeding because the user explicitly clicked Approve and implement.");
  }
}

async function executeEc2Stop(ctx: ExecutionContext): Promise<ToolResult> {
  requireNonProd(ctx);
  const ec2 = new EC2Client({ region: ctx.resource.region ?? "us-east-1", credentials: clientCredentials(ctx.credentials) });
  ctx.logs.push(commandLog(`aws ec2 stop-instances --instance-ids ${ctx.resource.resourceId}`));
  await ec2.send(new StopInstancesCommand({ InstanceIds: [ctx.resource.resourceId] }));
  return { status: "implemented", message: `Stop requested for EC2 instance ${ctx.resource.resourceId}.`, logs: ctx.logs };
}

async function executeEc2Rightsize(ctx: ExecutionContext): Promise<ToolResult> {
  requireNonProd(ctx);
  const planTargetType = getString(ctx.executionPlan.targetState?.instanceType);
  const currentInstanceType = getCurrentInstanceType(ctx.resource);
  const derivedTargetType = getSmallerInstanceType(currentInstanceType);
  const targetType = planTargetType && !isPlaceholderValue(planTargetType) ? planTargetType : derivedTargetType;
  if (!targetType) {
    return { status: "needs_review", message: "No concrete EC2 target instance type could be determined.", logs: ctx.logs };
  }
  if (!planTargetType || isPlaceholderValue(planTargetType)) {
    ctx.logs.push(`Derived target instance type ${targetType} from current instance type ${currentInstanceType ?? "unknown"}.`);
  }

  const ec2 = new EC2Client({ region: ctx.resource.region ?? "us-east-1", credentials: clientCredentials(ctx.credentials) });
  ctx.logs.push(commandLog(`aws ec2 stop-instances --instance-ids ${ctx.resource.resourceId}`));
  await ec2.send(new StopInstancesCommand({ InstanceIds: [ctx.resource.resourceId] }));
  ctx.logs.push(commandLog(`aws ec2 modify-instance-attribute --instance-id ${ctx.resource.resourceId} --instance-type '{"Value":"${targetType}"}'`));
  await ec2.send(new ModifyInstanceAttributeCommand({ InstanceId: ctx.resource.resourceId, InstanceType: { Value: targetType } }));
  ctx.logs.push(commandLog(`aws ec2 start-instances --instance-ids ${ctx.resource.resourceId}`));
  await ec2.send(new StartInstancesCommand({ InstanceIds: [ctx.resource.resourceId] }));
  return { status: "implemented", message: `EC2 instance ${ctx.resource.resourceId} resized to ${targetType}.`, logs: ctx.logs };
}

async function executeEbsCleanup(ctx: ExecutionContext): Promise<ToolResult> {
  requireNonProd(ctx);
  const metadata = ctx.resource.metadata as { attachments?: number } | null;
  const ec2 = new EC2Client({ region: ctx.resource.region ?? "us-east-1", credentials: clientCredentials(ctx.credentials) });

  ctx.logs.push(commandLog(`aws ec2 create-snapshot --volume-id ${ctx.resource.resourceId}`));
  const snapshot = await ec2.send(
    new CreateSnapshotCommand({
      VolumeId: ctx.resource.resourceId,
      Description: `Cloud Saver pre-delete snapshot for ${ctx.resource.resourceId}`,
    }),
  );
  ctx.logs.push(`Created snapshot ${snapshot.SnapshotId ?? "unknown"}.`);

  if (Number(metadata?.attachments ?? 0) > 0) {
    return {
      status: "needs_review",
      message: "Snapshot created, but the EBS volume is attached. Detach manually before deletion.",
      logs: ctx.logs,
    };
  }

  ctx.logs.push(commandLog(`aws ec2 delete-volume --volume-id ${ctx.resource.resourceId}`));
  await ec2.send(new DeleteVolumeCommand({ VolumeId: ctx.resource.resourceId }));
  return { status: "implemented", message: `Snapshot created and unattached EBS volume ${ctx.resource.resourceId} deleted.`, logs: ctx.logs };
}

async function executeRdsOptimization(ctx: ExecutionContext): Promise<ToolResult> {
  requireNonProd(ctx);
  const dbIdentifier = ctx.resource.resourceName ?? getString(ctx.executionPlan.resourceName);
  const targetClass = getString(ctx.executionPlan.targetState?.instanceClass);
  if (!dbIdentifier || !targetClass) {
    return { status: "needs_review", message: "Missing RDS DB identifier or target instance class.", logs: ctx.logs };
  }

  const rds = new RDSClient({ region: ctx.resource.region ?? "us-east-1", credentials: clientCredentials(ctx.credentials) });
  const snapshotId = `cloudsaver-before-${dbIdentifier}-${Date.now()}`.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 255);
  ctx.logs.push(commandLog(`aws rds create-db-snapshot --db-instance-identifier ${dbIdentifier} --db-snapshot-identifier ${snapshotId}`));
  await rds.send(new CreateDBSnapshotCommand({ DBInstanceIdentifier: dbIdentifier, DBSnapshotIdentifier: snapshotId }));
  ctx.logs.push(commandLog(`aws rds modify-db-instance --db-instance-identifier ${dbIdentifier} --db-instance-class ${targetClass} --no-apply-immediately`));
  await rds.send(new ModifyDBInstanceCommand({ DBInstanceIdentifier: dbIdentifier, DBInstanceClass: targetClass, ApplyImmediately: false }));
  return { status: "implemented", message: `RDS resize queued for ${dbIdentifier} to ${targetClass}.`, logs: ctx.logs };
}

async function executeLoadBalancerCleanup(ctx: ExecutionContext): Promise<ToolResult> {
  requireNonProd(ctx);
  const elb = new ElasticLoadBalancingV2Client({ region: ctx.resource.region ?? "us-east-1", credentials: clientCredentials(ctx.credentials) });
  ctx.logs.push(commandLog(`aws elbv2 delete-load-balancer --load-balancer-arn ${ctx.resource.resourceId}`));
  await elb.send(new DeleteLoadBalancerCommand({ LoadBalancerArn: ctx.resource.resourceId }));
  return { status: "implemented", message: `Delete requested for load balancer ${ctx.resource.resourceName ?? ctx.resource.resourceId}.`, logs: ctx.logs };
}

async function executeLambdaOptimization(ctx: ExecutionContext): Promise<ToolResult> {
  requireNonProd(ctx);
  const functionName = ctx.resource.resourceName ?? ctx.resource.resourceId;
  const targetMemory = getNumber(ctx.executionPlan.targetState?.memoryMb ?? ctx.executionPlan.targetState?.memorySize);
  const shouldDelete = `${ctx.executionPlan.recommendation ?? ""} ${(ctx.executionPlan.steps ?? []).join(" ")}`.toLowerCase().includes("delete");
  const lambda = new LambdaClient({ region: ctx.resource.region ?? "us-east-1", credentials: clientCredentials(ctx.credentials) });

  if (shouldDelete) {
    ctx.logs.push(commandLog(`aws lambda delete-function --function-name ${functionName}`));
    await lambda.send(new DeleteFunctionCommand({ FunctionName: functionName }));
    return { status: "implemented", message: `Deleted Lambda function ${functionName}.`, logs: ctx.logs };
  }

  if (!targetMemory) {
    return { status: "needs_review", message: "No target Lambda memory size was present in the action plan.", logs: ctx.logs };
  }

  ctx.logs.push(commandLog(`aws lambda update-function-configuration --function-name ${functionName} --memory-size ${targetMemory}`));
  await lambda.send(new UpdateFunctionConfigurationCommand({ FunctionName: functionName, MemorySize: targetMemory }));
  return { status: "implemented", message: `Updated Lambda ${functionName} memory to ${targetMemory} MB.`, logs: ctx.logs };
}

async function executeS3Optimization(ctx: ExecutionContext): Promise<ToolResult> {
  requireNonProd(ctx);
  const bucket = ctx.resource.resourceId;
  const s3 = new S3Client({ region: ctx.resource.region ?? "us-east-1", credentials: clientCredentials(ctx.credentials) });
  ctx.logs.push(commandLog(`aws s3api put-bucket-lifecycle-configuration --bucket ${bucket} --lifecycle-configuration <cloudsaver-intelligent-tiering-rule>`));
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: "cloudsaver-intelligent-tiering",
            Status: "Enabled",
            Filter: { Prefix: "" },
            Transitions: [{ Days: 30, StorageClass: "INTELLIGENT_TIERING" }],
          },
        ],
      },
    }),
  );
  return { status: "implemented", message: `Applied S3 lifecycle optimization to bucket ${bucket}.`, logs: ctx.logs };
}

async function executeByActionType(ctx: ExecutionContext): Promise<ToolResult> {
  const actionType = (ctx.remediation.actionType ?? "").toLowerCase().replaceAll("-", "_").replaceAll(" ", "_");

  switch (actionType) {
    case "ec2_schedule_or_stop_instance":
    case "stop_or_schedule":
    case "stop_or_schedule_instance":
    case "stopped_or_scheduled":
      return executeEc2Stop(ctx);
    case "ec2_rightsize_instance":
    case "rightsize_instance":
    case "rightsize_ec2_instance":
      return executeEc2Rightsize(ctx);
    case "ebs_volume_cleanup":
    case "ebs_delete_unattached_volume":
    case "ebs_review_idle_volume":
      return executeEbsCleanup(ctx);
    case "s3_storage_optimization":
    case "s3_archive_or_delete_idle_bucket":
      return executeS3Optimization(ctx);
    case "rds_instance_optimization":
    case "rds_rightsize_instance":
      return executeRdsOptimization(ctx);
    case "elb_remove_idle_load_balancer":
      return executeLoadBalancerCleanup(ctx);
    case "lambda_optimize_or_remove_idle_function":
      return executeLambdaOptimization(ctx);
    default:
      return { status: "needs_review", message: `No implementation tool is registered for ${ctx.remediation.actionType ?? "unknown action"}.`, logs: ctx.logs };
  }
}

export const awsRemediation = task({
  id: "aws-remediation",
  run: async (payload: AwsRemediationPayload) => {
    await db
      .update(aiRemediations)
      .set({
        status: "executing",
        executionLogs: [{ at: new Date().toISOString(), message: "Trigger.dev remediation task started.", payload }],
      })
      .where(eq(aiRemediations.id, payload.remediationId));

    try {
      const ctx = await loadExecutionContext(payload);
      const result = await executeByActionType(ctx);

      await db
        .update(aiRemediations)
        .set({
          status: result.status,
          approvedByUser: true,
          executedAt: result.status === "implemented" ? new Date() : null,
          executionLogs: [...result.logs, result.message].map((message) => ({ at: new Date().toISOString(), message })),
        })
        .where(eq(aiRemediations.id, payload.remediationId));

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "AWS remediation failed.";
      await db
        .update(aiRemediations)
        .set({
          status: "failed",
          executionLogs: [{ at: new Date().toISOString(), message }],
        })
        .where(eq(aiRemediations.id, payload.remediationId));
      throw error;
    }
  },
});
