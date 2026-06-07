import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";

type UsageAlertEmail = {
  to: string;
  accountName: string;
  monthlyCost: number;
  monthlyLimit: number;
  thresholdPercent: number;
};

export async function sendUsageAlertEmail({
  to,
  accountName,
  monthlyCost,
  monthlyLimit,
  thresholdPercent,
}: UsageAlertEmail) {
  const from = process.env.AWS_SES_FROM_EMAIL;
  if (!from) {
    throw new Error("AWS_SES_FROM_EMAIL is not set");
  }

  const client = new SESClient({
    region: process.env.AWS_SES_REGION ?? process.env.AWS_REGION ?? "us-east-1",
  });

  const subject = `Cloud Saver alert: ${accountName} crossed ${thresholdPercent}% of its usage limit`;
  const text = [
    `${accountName} is projected at $${monthlyCost.toFixed(2)} this month.`,
    `The configured monthly limit is $${monthlyLimit.toFixed(2)} and alerts are enabled at ${thresholdPercent}%.`,
    "Review the Cloud Saver dashboard for the resources and AI savings recommendations driving this projection.",
  ].join("\n\n");

  await client.send(
    new SendEmailCommand({
      Source: from,
      Destination: { ToAddresses: [to] },
      Message: {
        Subject: { Data: subject },
        Body: {
          Text: { Data: text },
          Html: {
            Data: `<p><strong>${accountName}</strong> is projected at <strong>$${monthlyCost.toFixed(
              2,
            )}</strong> this month.</p><p>The monthly limit is $${monthlyLimit.toFixed(
              2,
            )}; alerts are enabled at ${thresholdPercent}%.</p><p>Review Cloud Saver for the resources and AI savings recommendations driving this projection.</p>`,
          },
        },
      },
    }),
  );
}
