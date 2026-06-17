type MetricSummary = {
  datapoints?: number;
  average?: number;
  sum?: number;
};

type S3CloudWatchMetrics = {
  namespace?: string;
  bucketSize?: MetricSummary;
  objectCount?: MetricSummary;
  allRequests?: MetricSummary;
  getRequests?: MetricSummary;
  putRequests?: MetricSummary;
  deleteRequests?: MetricSummary;
  bytesDownloaded?: MetricSummary;
  bytesUploaded?: MetricSummary;
  requestMetricsAvailable?: boolean;
  hasRecentRequests?: boolean;
  totalRequests?: number;
  storageBytes?: number;
};

type S3Activity = {
  requestMetricsAvailable?: boolean;
  hasRecentRequests?: boolean;
  totalRequests?: number;
  storageBytes?: number;
};

function metricDatapoints(metric?: MetricSummary) {
  return Number(metric?.datapoints ?? 0);
}

function metricSum(metric?: MetricSummary) {
  return Number(metric?.sum ?? 0);
}

export function getS3MetricState(metadata?: Record<string, unknown> | null) {
  const legacy = metadata?.s3Activity as S3Activity | undefined;
  const metrics = metadata?.cloudWatchMetrics as S3CloudWatchMetrics | undefined;
  const isS3Metrics = metrics?.namespace === "AWS/S3" || Boolean(metrics?.bucketSize || metrics?.allRequests);

  if (!isS3Metrics) {
    return {
      requestMetricsAvailable: legacy?.requestMetricsAvailable === true,
      hasRecentRequests: legacy?.hasRecentRequests,
      totalRequests: legacy?.totalRequests ?? 0,
      storageBytes: legacy?.storageBytes,
      storageMetricsAvailable: Boolean(legacy?.storageBytes),
    };
  }

  const s3Metrics = metrics ?? {};
  const requestDatapoints =
    metricDatapoints(s3Metrics.allRequests) +
    metricDatapoints(s3Metrics.getRequests) +
    metricDatapoints(s3Metrics.putRequests) +
    metricDatapoints(s3Metrics.deleteRequests) +
    metricDatapoints(s3Metrics.bytesDownloaded) +
    metricDatapoints(s3Metrics.bytesUploaded);
  const storageDatapoints = metricDatapoints(s3Metrics.bucketSize) + metricDatapoints(s3Metrics.objectCount);
  const totalRequests =
    s3Metrics.totalRequests ??
    legacy?.totalRequests ??
    metricSum(s3Metrics.allRequests) +
      metricSum(s3Metrics.getRequests) +
      metricSum(s3Metrics.putRequests) +
      metricSum(s3Metrics.deleteRequests);
  const storageBytes = s3Metrics.storageBytes ?? legacy?.storageBytes ?? s3Metrics.bucketSize?.average;
  const requestMetricsAvailable = s3Metrics.requestMetricsAvailable ?? legacy?.requestMetricsAvailable ?? requestDatapoints > 0;
  const hasRecentRequests =
    s3Metrics.hasRecentRequests ?? legacy?.hasRecentRequests ?? (requestDatapoints > 0 ? totalRequests > 0 : undefined);

  return {
    requestMetricsAvailable,
    hasRecentRequests,
    totalRequests,
    storageBytes,
    storageMetricsAvailable: storageDatapoints > 0 || typeof storageBytes === "number",
  };
}
