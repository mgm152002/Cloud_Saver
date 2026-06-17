import { auth } from "@/app/lib/auth";
import { getS3MetricState } from "@/app/lib/s3-metrics";
import { aiRecommendations, aiRemediations, cloudAccounts, cloudResources, organizations } from "@/db/auth-schema";
import { db } from "@/db/db";
import { and, eq } from "drizzle-orm";

const allowedActions = new Set(["create_plan", "mark_done", "dismiss"]);

const sizeOrder = ["nano", "micro", "small", "medium", "large", "xlarge", "2xlarge", "4xlarge", "8xlarge", "12xlarge", "16xlarge", "24xlarge"];

function findMentionedResource(
  recommendation: typeof aiRecommendations.$inferSelect,
  resources: (typeof cloudResources.$inferSelect)[],
) {
  const text = `${recommendation.title ?? ""} ${recommendation.recommendation}`.toLowerCase();
  const mentioned = resources.find((resource) => {
    const idMatch = text.includes(resource.resourceId.toLowerCase());
    const nameMatch = resource.resourceName ? text.includes(resource.resourceName.toLowerCase()) : false;
    return idMatch || nameMatch;
  });
  if (mentioned) return mentioned;

  if (/\bec2\b|\binstance\b|\brightsize\b|downsize|resize/.test(text)) {
    return resources
      .filter((resource) => resource.resourceType === "ec2-instance")
      .sort((left, right) => {
        const leftMetadata = left.metadata as { cloudWatchMetrics?: { cpu?: { average?: number } }; cpu?: { average?: number } } | null;
        const rightMetadata = right.metadata as { cloudWatchMetrics?: { cpu?: { average?: number } }; cpu?: { average?: number } } | null;
        const leftCpu = leftMetadata?.cloudWatchMetrics?.cpu?.average ?? leftMetadata?.cpu?.average ?? 100;
        const rightCpu = rightMetadata?.cloudWatchMetrics?.cpu?.average ?? rightMetadata?.cpu?.average ?? 100;
        return leftCpu - rightCpu;
      })[0];
  }

  return undefined;
}

function nextSmallerInstanceType(instanceType?: unknown) {
  if (typeof instanceType !== "string" || !instanceType.includes(".")) return "t3.micro";
  const [family, size] = instanceType.split(".");
  const currentIndex = sizeOrder.indexOf(size);
  if (currentIndex <= 0) return instanceType;
  return `${family}.${sizeOrder[currentIndex - 1]}`;
}

function buildExecutionPlan(
  accountId: string,
  accountName: string,
  recommendation: typeof aiRecommendations.$inferSelect,
  resource?: typeof cloudResources.$inferSelect,
) {
  const metadata = resource?.metadata as {
    instanceType?: string;
    size?: number;
    volumeType?: string;
    attachments?: number;
    instanceClass?: string;
    engine?: string;
    allocatedStorage?: number;
    type?: string;
    memorySize?: number;
    cloudWatchMetrics?: {
      cpu?: { average?: number; maximum?: number; datapoints?: number };
      databaseConnections?: { average?: number; maximum?: number };
      requestCount?: { sum?: number };
      activeConnectionCount?: { sum?: number };
      invocations?: { sum?: number };
      errors?: { sum?: number };
      duration?: { average?: number };
      readOps?: { sum?: number };
      writeOps?: { sum?: number };
    };
    cpu?: { average?: number; maximum?: number; datapoints?: number };
  } | null;
  const cpu = metadata?.cloudWatchMetrics?.cpu ?? metadata?.cpu;

  if (resource?.resourceType === "ec2-instance") {
    const currentType = metadata?.instanceType ?? "unknown";
    const targetType = nextSmallerInstanceType(currentType);
    return {
      actionType: "ec2_rightsize_instance",
      executionPlan: {
        cloudAccountId: accountId,
        accountName,
        resourceId: resource.resourceId,
        resourceName: resource.resourceName,
        currentState: {
          instanceType: currentType,
          monthlyCost: resource.monthlyCost,
          cpuAverage: cpu?.average,
          cpuMaximum: cpu?.maximum,
          cpuDatapoints: cpu?.datapoints,
        },
        targetState: {
          instanceType: targetType,
          expectedMonthlySavings: recommendation.estimatedSavings,
        },
        recommendationTitle: recommendation.title,
        recommendation: recommendation.recommendation,
        estimatedSavings: recommendation.estimatedSavings,
        evidence: [
          `CloudWatch CPU average: ${cpu?.average ?? "unknown"}%`,
          `CloudWatch CPU maximum: ${cpu?.maximum ?? "unknown"}%`,
          `CloudWatch datapoints: ${cpu?.datapoints ?? 0}`,
          `Current instance type: ${currentType}`,
          `Recommended target type: ${targetType}`,
        ],
        steps: [
          `Confirm ${resource.resourceName || resource.resourceId} is not production-critical during the change window.`,
          `Create an AMI or snapshot for ${resource.resourceId}.`,
          `Stop EC2 instance ${resource.resourceId}.`,
          `Change instance type from ${currentType} to ${targetType}.`,
          `Start EC2 instance ${resource.resourceId}.`,
          "Watch CloudWatch CPUUtilization and StatusCheckFailed for at least 30 minutes.",
          "Run a Cloud Saver scan to verify the lower projected monthly cost.",
        ],
        awsCli: [
          `aws ec2 stop-instances --instance-ids ${resource.resourceId}`,
          `aws ec2 modify-instance-attribute --instance-id ${resource.resourceId} --instance-type '{\"Value\":\"${targetType}\"}'`,
          `aws ec2 start-instances --instance-ids ${resource.resourceId}`,
        ],
      },
      rollbackPlan: {
        steps: [
          `Stop EC2 instance ${resource.resourceId}.`,
          `Change instance type back to ${currentType}.`,
          `Start EC2 instance ${resource.resourceId}.`,
          "Verify health checks and application latency.",
        ],
        awsCli: [
          `aws ec2 stop-instances --instance-ids ${resource.resourceId}`,
          `aws ec2 modify-instance-attribute --instance-id ${resource.resourceId} --instance-type '{\"Value\":\"${currentType}\"}'`,
          `aws ec2 start-instances --instance-ids ${resource.resourceId}`,
        ],
      },
    };
  }

  if (resource?.resourceType === "ec2-volume") {
    const totalOps = Number(metadata?.cloudWatchMetrics?.readOps?.sum ?? 0) + Number(metadata?.cloudWatchMetrics?.writeOps?.sum ?? 0);
    const isUnattached = Number(metadata?.attachments ?? 0) === 0;
    return {
      actionType: isUnattached ? "ebs_delete_unattached_volume" : "ebs_review_idle_volume",
      executionPlan: {
        cloudAccountId: accountId,
        accountName,
        resourceId: resource.resourceId,
        resourceName: resource.resourceName,
        currentState: {
          volumeType: metadata?.volumeType,
          sizeGiB: metadata?.size,
          attachments: metadata?.attachments,
          monthlyCost: resource.monthlyCost,
          readWriteOps14d: totalOps,
        },
        targetState: {
          action: isUnattached ? "snapshot and delete unattached EBS volume" : "confirm owner before detach/delete",
          expectedMonthlySavings: recommendation.estimatedSavings,
        },
        recommendationTitle: recommendation.title,
        recommendation: recommendation.recommendation,
        estimatedSavings: recommendation.estimatedSavings,
        evidence: [
          `Attachments: ${metadata?.attachments ?? 0}`,
          `CloudWatch read ops: ${metadata?.cloudWatchMetrics?.readOps?.sum ?? "unknown"}`,
          `CloudWatch write ops: ${metadata?.cloudWatchMetrics?.writeOps?.sum ?? "unknown"}`,
          `Volume size: ${metadata?.size ?? "unknown"} GiB`,
        ],
        steps: [
          `Confirm ${resource.resourceId} is not required by an application or backup workflow.`,
          `Create a final snapshot for ${resource.resourceId}.`,
          isUnattached ? `Delete EBS volume ${resource.resourceId}.` : `If safe, detach ${resource.resourceId} from its instance before deletion.`,
          "Run a Cloud Saver scan to verify the volume is gone and savings are reflected.",
        ],
        awsCli: [
          `aws ec2 create-snapshot --volume-id ${resource.resourceId} --description "Cloud Saver pre-delete snapshot for ${resource.resourceId}"`,
          ...(isUnattached ? [`aws ec2 delete-volume --volume-id ${resource.resourceId}`] : []),
        ],
      },
      rollbackPlan: {
        steps: [
          "Create a new EBS volume from the snapshot.",
          "Attach the restored volume to the original instance if needed.",
          "Run a Cloud Saver scan to confirm tracking.",
        ],
        awsCli: [`aws ec2 create-volume --snapshot-id <snapshot-id> --availability-zone <availability-zone>`],
      },
    };
  }

  if (resource?.resourceType === "rds-instance") {
    const currentClass = metadata?.instanceClass ?? "unknown";
    const targetClass = typeof currentClass === "string" && currentClass.includes(".")
      ? currentClass.replace(/\.(large|xlarge|2xlarge|4xlarge|8xlarge|12xlarge|16xlarge|24xlarge)$/, ".medium")
      : currentClass;
    return {
      actionType: "rds_rightsize_instance",
      executionPlan: {
        cloudAccountId: accountId,
        accountName,
        resourceId: resource.resourceId,
        resourceName: resource.resourceName,
        currentState: {
          instanceClass: currentClass,
          engine: metadata?.engine,
          allocatedStorageGiB: metadata?.allocatedStorage,
          monthlyCost: resource.monthlyCost,
          cpuAverage: metadata?.cloudWatchMetrics?.cpu?.average,
          cpuMaximum: metadata?.cloudWatchMetrics?.cpu?.maximum,
          connectionAverage: metadata?.cloudWatchMetrics?.databaseConnections?.average,
        },
        targetState: {
          instanceClass: targetClass,
          expectedMonthlySavings: recommendation.estimatedSavings,
        },
        recommendationTitle: recommendation.title,
        recommendation: recommendation.recommendation,
        estimatedSavings: recommendation.estimatedSavings,
        evidence: [
          `CloudWatch CPU average: ${metadata?.cloudWatchMetrics?.cpu?.average ?? "unknown"}%`,
          `CloudWatch CPU maximum: ${metadata?.cloudWatchMetrics?.cpu?.maximum ?? "unknown"}%`,
          `Database connections average: ${metadata?.cloudWatchMetrics?.databaseConnections?.average ?? "unknown"}`,
          `Current DB class: ${currentClass}`,
          `Suggested DB class: ${targetClass}`,
        ],
        steps: [
          `Confirm maintenance window and backup policy for ${resource.resourceName || resource.resourceId}.`,
          "Create a manual DB snapshot.",
          `Modify DB instance class from ${currentClass} to ${targetClass}.`,
          "Apply during the maintenance window unless the owner approves immediate downtime.",
          "Watch CPUUtilization, DatabaseConnections, and application latency after the change.",
          "Run a Cloud Saver scan to verify savings.",
        ],
        awsCli: [
          `aws rds create-db-snapshot --db-instance-identifier ${resource.resourceName || "<db-instance-id>"} --db-snapshot-identifier cloudsaver-before-rightsize-${resource.resourceName || "db"}`,
          `aws rds modify-db-instance --db-instance-identifier ${resource.resourceName || "<db-instance-id>"} --db-instance-class ${targetClass} --no-apply-immediately`,
        ],
      },
      rollbackPlan: {
        steps: [
          `Modify DB instance class back to ${currentClass}.`,
          "Restore from the manual snapshot only if the resize causes data or availability issues.",
          "Verify application health and database connections.",
        ],
        awsCli: [`aws rds modify-db-instance --db-instance-identifier ${resource.resourceName || "<db-instance-id>"} --db-instance-class ${currentClass} --no-apply-immediately`],
      },
    };
  }

  if (resource?.resourceType === "load-balancer") {
    return {
      actionType: "elb_remove_idle_load_balancer",
      executionPlan: {
        cloudAccountId: accountId,
        accountName,
        resourceId: resource.resourceId,
        resourceName: resource.resourceName,
        currentState: {
          type: metadata?.type,
          monthlyCost: resource.monthlyCost,
          requestCount14d: metadata?.cloudWatchMetrics?.requestCount?.sum,
          activeConnections14d: metadata?.cloudWatchMetrics?.activeConnectionCount?.sum,
        },
        targetState: {
          action: "delete idle load balancer after DNS/target-group validation",
          expectedMonthlySavings: recommendation.estimatedSavings,
        },
        recommendationTitle: recommendation.title,
        recommendation: recommendation.recommendation,
        estimatedSavings: recommendation.estimatedSavings,
        evidence: [
          `CloudWatch RequestCount: ${metadata?.cloudWatchMetrics?.requestCount?.sum ?? "unknown"}`,
          `ActiveConnectionCount: ${metadata?.cloudWatchMetrics?.activeConnectionCount?.sum ?? "unknown"}`,
          `Load balancer type: ${metadata?.type ?? "unknown"}`,
        ],
        steps: [
          `Confirm ${resource.resourceName || resource.resourceId} is not referenced by DNS, ingress, or application config.`,
          "Export listener, rule, target group, and security group configuration.",
          "Remove or update DNS records that point to this load balancer.",
          `Delete load balancer ${resource.resourceName || resource.resourceId}.`,
          "Run a Cloud Saver scan to verify savings.",
        ],
        awsCli: [`aws elbv2 delete-load-balancer --load-balancer-arn ${resource.resourceId}`],
      },
      rollbackPlan: {
        steps: [
          "Recreate the load balancer from exported listener/rule/target group config.",
          "Restore DNS records.",
          "Verify target health and request routing.",
        ],
      },
    };
  }

  if (resource?.resourceType === "lambda-function") {
    const currentMemory = metadata?.memorySize ?? "unknown";
    const targetMemory = typeof currentMemory === "number" ? Math.max(128, Math.floor(currentMemory / 2)) : "review";
    return {
      actionType: "lambda_optimize_or_remove_idle_function",
      executionPlan: {
        cloudAccountId: accountId,
        accountName,
        resourceId: resource.resourceId,
        resourceName: resource.resourceName,
        currentState: {
          memoryMb: currentMemory,
          monthlyCost: resource.monthlyCost,
          invocations14d: metadata?.cloudWatchMetrics?.invocations?.sum,
          errors14d: metadata?.cloudWatchMetrics?.errors?.sum,
          averageDurationMs: metadata?.cloudWatchMetrics?.duration?.average,
        },
        targetState: {
          action: Number(metadata?.cloudWatchMetrics?.invocations?.sum ?? 1) === 0 ? "disable triggers or delete idle function" : `reduce memory to ${targetMemory} MB`,
          expectedMonthlySavings: recommendation.estimatedSavings,
        },
        recommendationTitle: recommendation.title,
        recommendation: recommendation.recommendation,
        estimatedSavings: recommendation.estimatedSavings,
        evidence: [
          `CloudWatch invocations: ${metadata?.cloudWatchMetrics?.invocations?.sum ?? "unknown"}`,
          `CloudWatch errors: ${metadata?.cloudWatchMetrics?.errors?.sum ?? "unknown"}`,
          `Average duration: ${metadata?.cloudWatchMetrics?.duration?.average ?? "unknown"} ms`,
          `Current memory: ${currentMemory} MB`,
        ],
        steps: [
          `Confirm ${resource.resourceName || resource.resourceId} has no active event source mapping, schedule, or API dependency.`,
          "Publish a new version or export current configuration.",
          Number(metadata?.cloudWatchMetrics?.invocations?.sum ?? 1) === 0
            ? "Disable triggers first, monitor for impact, then delete if still unused."
            : `Update memory from ${currentMemory} MB to ${targetMemory} MB and monitor duration/errors.`,
          "Run a Cloud Saver scan to verify savings.",
        ],
        awsCli: [
          `aws lambda get-function-configuration --function-name ${resource.resourceName || resource.resourceId}`,
          ...(Number(metadata?.cloudWatchMetrics?.invocations?.sum ?? 1) === 0
            ? [`aws lambda delete-function --function-name ${resource.resourceName || resource.resourceId}`]
            : [`aws lambda update-function-configuration --function-name ${resource.resourceName || resource.resourceId} --memory-size ${targetMemory}`]),
        ],
      },
      rollbackPlan: {
        steps: [
          "Restore the exported Lambda configuration or redeploy from IaC.",
          `Set memory back to ${currentMemory} MB if performance regresses.`,
          "Verify CloudWatch Errors and Duration.",
        ],
        awsCli: typeof currentMemory === "number"
          ? [`aws lambda update-function-configuration --function-name ${resource.resourceName || resource.resourceId} --memory-size ${currentMemory}`]
          : [],
      },
    };
  }

  if (resource?.resourceType === "s3-bucket") {
    const s3Metrics = getS3MetricState(metadata as Record<string, unknown> | null);
    return {
      actionType: "s3_archive_or_delete_idle_bucket",
      executionPlan: {
        cloudAccountId: accountId,
        accountName,
        resourceId: resource.resourceId,
        resourceName: resource.resourceName,
        currentState: {
          monthlyCost: resource.monthlyCost,
          totalRequests30d: s3Metrics.totalRequests,
          storageBytes: s3Metrics.storageBytes,
        },
        targetState: {
          action: "archive objects or delete bucket only after owner approval",
          expectedMonthlySavings: recommendation.estimatedSavings,
        },
        recommendationTitle: recommendation.title,
        recommendation: recommendation.recommendation,
        estimatedSavings: recommendation.estimatedSavings,
        evidence: [
          `S3 requests over 30d: ${s3Metrics.totalRequests ?? "unknown"}`,
          `Bucket size bytes: ${s3Metrics.storageBytes ?? "unknown"}`,
        ],
        steps: [
          `Confirm bucket owner and retention requirements for ${resource.resourceId}.`,
          "Export object inventory or list current prefixes.",
          "Move retained objects to cheaper storage class, or empty the bucket if deletion is approved.",
          `Delete bucket ${resource.resourceId} only after object retention is satisfied.`,
          "Run a Cloud Saver scan to verify savings.",
        ],
        awsCli: [
          `aws s3api get-bucket-location --bucket ${resource.resourceId}`,
          `aws s3 ls s3://${resource.resourceId} --recursive --summarize`,
          `aws s3 rb s3://${resource.resourceId} --force`,
        ],
      },
      rollbackPlan: {
        steps: [
          "Recreate the bucket with the original name and region if needed.",
          "Restore objects from backup or archive source.",
          "Restore bucket policy, lifecycle, encryption, and event notifications.",
        ],
        awsCli: [`aws s3 mb s3://${resource.resourceId}`],
      },
    };
  }

  return {
    actionType: "manual_review_plan",
    executionPlan: {
      cloudAccountId: accountId,
      accountName,
      resourceId: resource?.resourceId,
      resourceName: resource?.resourceName,
      currentState: resource
        ? {
            resourceType: resource.resourceType,
            service: resource.service,
            monthlyCost: resource.monthlyCost,
            status: resource.status,
            metrics: metadata?.cloudWatchMetrics,
          }
        : undefined,
      recommendationTitle: recommendation.title,
      recommendation: recommendation.recommendation,
      estimatedSavings: recommendation.estimatedSavings,
      evidence: resource ? ["CloudWatch/resource metadata is attached to this plan for review."] : ["No exact resource match was found."],
      steps: resource
        ? [
            `Open ${resource.service || "AWS"} resource ${resource.resourceName || resource.resourceId}.`,
            "Review the attached CloudWatch metric evidence and confirm owner/environment.",
            "Apply the recommended change using AWS console or IaC.",
            "Monitor service health and run a Cloud Saver scan after the change.",
          ]
        : [
            "Identify the affected AWS resource from the recommendation text.",
            "Review CloudWatch metrics and ownership before applying changes.",
            "Apply the recommended change using AWS console or IaC.",
            "Run a Cloud Saver scan after the change.",
          ],
    },
    rollbackPlan: {
      steps: [
        "Revert the AWS setting or IaC change.",
        "Restore the prior resource size/state when applicable.",
        "Run a Cloud Saver scan to confirm the resource is tracked again.",
      ],
    },
  };
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ orgId: string; accountId: string; recommendationId: string }> },
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return new Response("Unauthorized", { status: 401 });
  }

  const { orgId, accountId, recommendationId } = await params;
  const body = await request.json().catch(() => ({}));
  const action = typeof body.action === "string" ? body.action : "";

  if (!allowedActions.has(action)) {
    return Response.json({ message: "Unsupported recommendation action" }, { status: 400 });
  }

  const [organization] = await db
    .select()
    .from(organizations)
    .where(and(eq(organizations.id, orgId), eq(organizations.ownerId, session.user.id)))
    .limit(1);

  if (!organization) {
    return Response.json({ message: "Organization not found" }, { status: 404 });
  }

  const [account] = await db
    .select()
    .from(cloudAccounts)
    .where(and(eq(cloudAccounts.id, accountId), eq(cloudAccounts.organizationId, orgId)))
    .limit(1);

  if (!account) {
    return Response.json({ message: "Cloud account not found" }, { status: 404 });
  }

  const [recommendation] = await db
    .select()
    .from(aiRecommendations)
    .where(and(eq(aiRecommendations.id, recommendationId), eq(aiRecommendations.organizationId, orgId)))
    .limit(1);

  if (!recommendation) {
    return Response.json({ message: "Recommendation not found" }, { status: 404 });
  }

  const resources = await db
    .select()
    .from(cloudResources)
    .where(and(eq(cloudResources.organizationId, orgId), eq(cloudResources.cloudAccountId, accountId)));
  const resource = findMentionedResource(recommendation, resources);

  if (action === "dismiss") {
    const [updated] = await db
      .update(aiRecommendations)
      .set({ status: "dismissed" })
      .where(eq(aiRecommendations.id, recommendationId))
      .returning();

    return Response.json({ action, recommendation: updated });
  }

  if (action === "mark_done") {
    const [updated] = await db
      .update(aiRecommendations)
      .set({ status: "completed" })
      .where(eq(aiRecommendations.id, recommendationId))
      .returning();

    return Response.json({ action, recommendation: updated });
  }

  const plan = buildExecutionPlan(accountId, account.accountName, recommendation, resource);

  const [remediation] = await db
    .insert(aiRemediations)
    .values({
      recommendationId,
      organizationId: orgId,
      actionType: plan.actionType,
      approvedByUser: true,
      status: "approved",
      executionPlan: plan.executionPlan,
      rollbackPlan: plan.rollbackPlan,
    })
    .returning();

  const [updated] = await db
    .update(aiRecommendations)
    .set({ status: "approved" })
    .where(eq(aiRecommendations.id, recommendationId))
    .returning();

  return Response.json({ action, recommendation: updated, remediation });
}
