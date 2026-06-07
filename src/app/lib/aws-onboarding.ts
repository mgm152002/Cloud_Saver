import crypto from "crypto";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";

export const CLOUDSAVER_TEMPLATE_URL =
  "https://cloudsaverbucket.s3.ap-south-1.amazonaws.com/get_access.yaml";

export const DEFAULT_AWS_REGION = "ap-south-1";

export type AwsCredentialsMetadata = {
  externalId: string;
  roleArn?: string;
  templateUrl: string;
  triggerRunId?: string;
  validatedAt?: string;
};

export function generateExternalId() {
  return `cs_${crypto.randomBytes(24).toString("hex")}`;
}

export function buildCloudFormationLaunchUrl(externalId: string) {
  const params = new URLSearchParams({
    templateURL: CLOUDSAVER_TEMPLATE_URL,
    stackName: "CloudSaverReadOnlyAccess",
    param_ExternalId: externalId,
  });

  return `https://${DEFAULT_AWS_REGION}.console.aws.amazon.com/cloudformation/home?region=${DEFAULT_AWS_REGION}#/stacks/create/review?${params.toString()}`;
}

export function parseAwsAccountId(roleArn: string) {
  const match = roleArn.match(/^arn:aws:iam::(\d{12}):role\/(.+)$/);
  return match?.[1] ?? null;
}

export function assertValidRoleArn(roleArn: string) {
  if (!parseAwsAccountId(roleArn)) {
    throw new Error("Enter a valid IAM Role ARN, for example arn:aws:iam::123456789012:role/CloudSaverReadOnlyRole");
  }
}

function getCloudSaverAwsCredentials() {
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing AWS_ACCESS_KEY_ID or AWS_SECRET_ACCESS_KEY. Add CloudSaver source AWS credentials to .env.local before validating AssumeRole.",
    );
  }

  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.AWS_SESSION_TOKEN,
  };
}

export async function validateAssumeRole(roleArn: string, externalId: string) {
  assertValidRoleArn(roleArn);

  const sts = new STSClient({
    region: DEFAULT_AWS_REGION,
    credentials: getCloudSaverAwsCredentials(),
  });
  const response = await sts.send(
    new AssumeRoleCommand({
      RoleArn: roleArn,
      RoleSessionName: `cloudsaver-validate-${Date.now()}`,
      ExternalId: externalId,
      DurationSeconds: 900,
    }),
  );

  if (!response.Credentials) {
    throw new Error("AWS did not return temporary credentials for this role.");
  }

  return {
    accessKeyId: response.Credentials.AccessKeyId!,
    secretAccessKey: response.Credentials.SecretAccessKey!,
    sessionToken: response.Credentials.SessionToken!,
    expiration: response.Credentials.Expiration,
  };
}
