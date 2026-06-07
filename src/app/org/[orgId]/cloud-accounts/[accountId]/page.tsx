"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Grid,
  Stack,
  Divider,
  FormControlLabel,
  Typography,
  LinearProgress,
  Switch,
  TextField,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SavingsIcon from "@mui/icons-material/Savings";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import AssessmentIcon from "@mui/icons-material/Assessment";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
import NotificationsActiveIcon from "@mui/icons-material/NotificationsActive";
import PriceCheckIcon from "@mui/icons-material/PriceCheck";
import BoltIcon from "@mui/icons-material/Bolt";
import TaskAltIcon from "@mui/icons-material/TaskAlt";
import DoneIcon from "@mui/icons-material/Done";
import CloseIcon from "@mui/icons-material/Close";
import InsertChartIcon from "@mui/icons-material/InsertChart";
import SettingsSuggestIcon from "@mui/icons-material/SettingsSuggest";
import DashboardLayout from "../../../../../components/dashboard-layout";

interface CloudAccount {
  id: string;
  provider: string;
  accountName: string;
  accountId: string;
  region: string;
  status: string;
  createdAt: string;
  lastScanAt?: string | null;
  latestScanJob?: {
    id: string;
    status: string | null;
    resourcesFound: number | null;
  } | null;
}

interface CloudResource {
  id: string;
  resourceId: string;
  resourceName: string | null;
  resourceType: string;
  region: string | null;
  service: string | null;
  status: string | null;
  utilization: string | null;
  monthlyCost: string | null;
  metadata: Record<string, unknown> | null;
  lastSeenAt: string | null;
}

interface Recommendation {
  id: string;
  title: string | null;
  recommendation: string;
  estimatedSavings: string | null;
  severity: string | null;
  confidence: number | null;
}

interface UsagePolicy {
  id: string;
  monthlyLimit: string;
  alertThresholdPercent: number;
  alertEmail: string | null;
  enabled: boolean;
}

interface CostAlert {
  id: string;
  title: string | null;
  description: string | null;
  severity: string | null;
  createdAt: string;
}

interface ActionPlan {
  id: string;
  actionType: string | null;
  executionPlan: {
    recommendationTitle?: string | null;
    recommendation?: string;
    estimatedSavings?: string | number | null;
    resourceId?: string;
    resourceName?: string | null;
    currentState?: Record<string, unknown>;
    targetState?: Record<string, unknown>;
    evidence?: string[];
    steps?: string[];
    awsCli?: string[];
  } | null;
  rollbackPlan: {
    steps?: string[];
    awsCli?: string[];
  } | null;
  createdAt: string;
}

type MetricGap = {
  id: string;
  resourceName: string;
  message: string;
};

interface CostDashboardPayload {
  account: CloudAccount;
  resources: CloudResource[];
  recommendations: Recommendation[];
  actionPlans: ActionPlan[];
  usagePolicy: UsagePolicy | null;
  alerts: CostAlert[];
  totals: {
    estimatedMonthlyCost: number;
    estimatedSavings: number;
  };
}

const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const preciseCurrency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function formatValue(value: unknown) {
  if (value === null || typeof value === "undefined" || value === "") return "unknown";
  if (typeof value === "number") return Number.isFinite(value) ? value.toLocaleString() : "unknown";
  return String(value);
}

function getMetricGap(resource: CloudResource): MetricGap | null {
  const metadata = resource.metadata as {
    s3Activity?: { requestMetricsAvailable?: boolean };
    attachments?: number;
    cloudWatchMetrics?: { enabled?: boolean; cpu?: { datapoints?: number; average?: number; maximum?: number } };
    cpu?: { datapoints?: number };
  } | null;

  if (resource.resourceType === "s3-bucket" && metadata?.s3Activity?.requestMetricsAvailable !== true) {
    return {
      id: resource.id,
      resourceName: resource.resourceName || resource.resourceId,
      message: "Enable S3 request metrics or server access logging before delete/archive recommendations.",
    };
  }

  const hasEc2Metrics =
    (metadata?.cloudWatchMetrics?.enabled === true && Boolean(metadata.cloudWatchMetrics.cpu?.datapoints)) ||
    Boolean(metadata?.cpu?.datapoints);
  if (resource.resourceType === "ec2-instance" && !hasEc2Metrics) {
    return {
      id: resource.id,
      resourceName: resource.resourceName || resource.resourceId,
      message: "Enable or verify EC2 CloudWatch CPU metrics before rightsizing recommendations.",
    };
  }

  if (resource.resourceType === "ec2-volume" && Number(metadata?.attachments ?? 0) > 0 && metadata?.cloudWatchMetrics?.enabled !== true) {
    return {
      id: resource.id,
      resourceName: resource.resourceName || resource.resourceId,
      message: "Enable or verify EBS CloudWatch volume metrics before idle-volume recommendations.",
    };
  }

  if (
    ["rds-instance", "load-balancer", "lambda-function"].includes(resource.resourceType) &&
    metadata?.cloudWatchMetrics?.enabled !== true
  ) {
    return {
      id: resource.id,
      resourceName: resource.resourceName || resource.resourceId,
      message: `Enable or verify ${resource.service || resource.resourceType} CloudWatch metrics before optimization recommendations.`,
    };
  }

  return null;
}

export default function CostDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;
  const accountId = params.accountId as string;
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [resources, setResources] = useState<CloudResource[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [actionPlans, setActionPlans] = useState<ActionPlan[]>([]);
  const [usagePolicy, setUsagePolicy] = useState<UsagePolicy | null>(null);
  const [alerts, setAlerts] = useState<CostAlert[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [savingPolicy, setSavingPolicy] = useState(false);
  const [actingRecommendationId, setActingRecommendationId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [policyForm, setPolicyForm] = useState({
    monthlyLimit: "",
    alertThresholdPercent: "80",
    alertEmail: "",
    enabled: true,
  });

  const fetchAccount = useCallback(async () => {
    const response = await fetch(`/api/org/${orgId}/cloud-accounts/${accountId}`);
    if (!response.ok) {
      throw new Error("Failed to load cost dashboard");
    }

    return response.json() as Promise<CostDashboardPayload>;
  }, [accountId, orgId]);

  useEffect(() => {
    let active = true;

    fetchAccount()
      .then((data) => {
        if (active) {
          setAccount(data.account);
          setResources(data.resources);
          setRecommendations(data.recommendations);
          setActionPlans(data.actionPlans);
          setUsagePolicy(data.usagePolicy);
          setAlerts(data.alerts);
          setPolicyForm({
            monthlyLimit: data.usagePolicy?.monthlyLimit ?? "",
            alertThresholdPercent: String(data.usagePolicy?.alertThresholdPercent ?? 80),
            alertEmail: data.usagePolicy?.alertEmail ?? "",
            enabled: data.usagePolicy?.enabled ?? true,
          });
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setError(err instanceof Error ? err.message : "Failed to load cost dashboard");
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [fetchAccount]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError("");

    try {
      const data = await fetchAccount();
      setAccount(data.account);
      setResources(data.resources);
      setRecommendations(data.recommendations);
      setActionPlans(data.actionPlans);
      setUsagePolicy(data.usagePolicy);
      setAlerts(data.alerts);
      setPolicyForm({
        monthlyLimit: data.usagePolicy?.monthlyLimit ?? "",
        alertThresholdPercent: String(data.usagePolicy?.alertThresholdPercent ?? 80),
        alertEmail: data.usagePolicy?.alertEmail ?? "",
        enabled: data.usagePolicy?.enabled ?? true,
      });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to refresh cost dashboard");
    } finally {
      setRefreshing(false);
    }
  };

  const handleManualScan = async () => {
    setScanning(true);
    setError("");

    try {
      const response = await fetch(`/api/org/${orgId}/cloud-accounts/${accountId}/scan`, {
        method: "POST",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Failed to queue manual scan");
      }

      setAccount((current) => current ? { ...current, status: "scan_queued" } : current);
      setTimeout(() => {
        handleRefresh();
      }, 1500);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to queue manual scan");
    } finally {
      setScanning(false);
    }
  };

  const handleSavePolicy = async () => {
    setSavingPolicy(true);
    setError("");
    setSuccess("");

    try {
      const response = await fetch(`/api/org/${orgId}/cloud-accounts/${accountId}/usage-policy`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          monthlyLimit: Number(policyForm.monthlyLimit),
          alertThresholdPercent: Number(policyForm.alertThresholdPercent),
          alertEmail: policyForm.alertEmail,
          enabled: policyForm.enabled,
        }),
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Failed to save usage policy");
      }

      setUsagePolicy(data.policy);
      setSuccess(data.emailSent ? "Usage policy saved and an SES alert email was sent." : "Usage policy saved.");
      if (data.emailError) {
        setError(`Policy saved, but SES email failed: ${data.emailError}`);
      }
      await handleRefresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to save usage policy");
    } finally {
      setSavingPolicy(false);
    }
  };

  const handleRecommendationAction = async (recommendationId: string, action: "create_plan" | "mark_done" | "dismiss") => {
    setActingRecommendationId(recommendationId);
    setError("");
    setSuccess("");

    try {
      const response = await fetch(
        `/api/org/${orgId}/cloud-accounts/${accountId}/recommendations/${recommendationId}/action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        },
      );

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || "Failed to update recommendation");
      }

      if (data.remediation) {
        setActionPlans((current) => [data.remediation, ...current]);
      }
      if (action !== "create_plan") {
        setRecommendations((current) => current.filter((recommendation) => recommendation.id !== recommendationId));
      }
      setSuccess(
        action === "create_plan"
          ? "Action plan created for this recommendation."
          : action === "mark_done"
            ? "Recommendation marked done."
            : "Recommendation dismissed.",
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to update recommendation");
    } finally {
      setActingRecommendationId(null);
    }
  };

  const resourcesFound = resources.length || account?.latestScanJob?.resourcesFound || 0;
  const estimatedMonthlyCost = useMemo(
    () => resources.reduce((total, resource) => total + Number(resource.monthlyCost ?? 0), 0),
    [resources],
  );
  const estimatedSavings = useMemo(() => {
    const aiSavings = recommendations.reduce((total, recommendation) => total + Number(recommendation.estimatedSavings ?? 0), 0);
    return Math.min(estimatedMonthlyCost, Math.max(0, aiSavings));
  }, [estimatedMonthlyCost, recommendations]);
  const monthlyLimit = Number((usagePolicy?.monthlyLimit ?? policyForm.monthlyLimit) || 0);
  const usagePercent = monthlyLimit > 0 ? Math.min(100, Math.round((estimatedMonthlyCost / monthlyLimit) * 100)) : 0;
  const thresholdPercent = Number((usagePolicy?.alertThresholdPercent ?? policyForm.alertThresholdPercent) || 80);
  const metricGaps = useMemo(() => resources.map(getMetricGap).filter((gap): gap is MetricGap => Boolean(gap)), [resources]);
  const costByService = useMemo(() => {
    const totals = new Map<string, number>();
    for (const resource of resources) {
      totals.set(resource.service || "other", (totals.get(resource.service || "other") ?? 0) + Number(resource.monthlyCost ?? 0));
    }
    return [...totals.entries()]
      .map(([service, cost]) => ({ service, cost }))
      .sort((left, right) => right.cost - left.cost)
      .slice(0, 6);
  }, [resources]);
  const resourcesByService = useMemo(() => {
    const totals = new Map<string, number>();
    for (const resource of resources) {
      totals.set(resource.service || "other", (totals.get(resource.service || "other") ?? 0) + 1);
    }
    return [...totals.entries()]
      .map(([service, count]) => ({ service, count }))
      .sort((left, right) => right.count - left.count)
      .slice(0, 6);
  }, [resources]);
  const maxServiceCost = Math.max(...costByService.map((item) => item.cost), 1);
  const maxServiceCount = Math.max(...resourcesByService.map((item) => item.count), 1);

  if (loading) {
    return (
      <DashboardLayout>
        <Box sx={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", gap: 2 }}>
          <CircularProgress />
          <Typography sx={{ color: "text.secondary", fontWeight: 600 }}>Loading cost dashboard</Typography>
        </Box>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <Box sx={{ maxWidth: 1180, mx: "auto" }}>
        <Button
          onClick={() => router.push(`/org/${orgId}`)}
          startIcon={<ArrowBackIcon />}
          sx={{ mb: 2 }}
          variant="text"
        >
          Back to accounts
        </Button>

        {error || !account ? (
          <Card sx={{ border: 1, borderColor: "divider" }}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 800 }}>
                {error || "Cloud account not found"}
              </Typography>
            </CardContent>
          </Card>
        ) : (
          <>
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: { xs: "stretch", sm: "flex-start" }, flexDirection: { xs: "column", sm: "row" }, gap: 2, mb: 3 }}>
              <Box>
                <Typography variant="overline" sx={{ color: "primary.main", fontWeight: 900, letterSpacing: 0 }}>
                  AWS cost intelligence
                </Typography>
                <Typography variant="h3" sx={{ fontWeight: 900, fontSize: { xs: 32, md: 44 }, lineHeight: 1.05 }}>
                  {account.accountName}
                </Typography>
                <Typography sx={{ color: "text.secondary", mt: 0.5 }}>
                  Account {account.accountId} · Region baseline {account.region}
                </Typography>
              </Box>
              <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                <Chip label={account.status} color={account.status === "connected" ? "success" : "default"} />
                <Button
                  disabled={refreshing}
                  onClick={handleRefresh}
                  startIcon={refreshing ? <CircularProgress color="inherit" size={16} /> : <RefreshIcon />}
                  variant="outlined"
                >
                  {refreshing ? "Refreshing" : "Refresh"}
                </Button>
                <Button
                  disabled={scanning}
                  onClick={handleManualScan}
                  startIcon={scanning ? <CircularProgress color="inherit" size={16} /> : <PlayArrowIcon />}
                  variant="contained"
                >
                  {scanning ? "Queuing" : "Manual Scan"}
                </Button>
              </Box>
            </Box>

            {error && (
              <Alert severity="error" sx={{ mb: 3 }}>
                {error}
              </Alert>
            )}
            {success && (
              <Alert severity="success" sx={{ mb: 3 }} onClose={() => setSuccess("")}>
                {success}
              </Alert>
            )}

            <Grid container spacing={2.5}>
              <Grid size={{ xs: 12, md: 3 }}>
                <Card sx={{ height: "100%", border: 1, borderColor: "divider", bgcolor: "background.paper" }}>
                  <CardContent sx={{ p: 2.5 }}>
                    <CloudQueueIcon color="primary" />
                    <Typography variant="h4" sx={{ mt: 1, fontWeight: 900 }}>
                      {resourcesFound.toLocaleString()}
                    </Typography>
                    <Typography color="text.secondary">Resources found</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 12, md: 3 }}>
                <Card sx={{ height: "100%", border: 1, borderColor: "divider", bgcolor: "background.paper" }}>
                  <CardContent sx={{ p: 2.5 }}>
                    <AssessmentIcon color="primary" />
                    <Typography variant="h4" sx={{ mt: 1, fontWeight: 900 }}>
                      {currency.format(estimatedMonthlyCost)}
                    </Typography>
                    <Typography color="text.secondary">Estimated monthly cost</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 12, md: 3 }}>
                <Card sx={{ height: "100%", border: 1, borderColor: "divider", bgcolor: "background.paper" }}>
                  <CardContent sx={{ p: 2.5 }}>
                    <SavingsIcon color="primary" />
                    <Typography variant="h4" sx={{ mt: 1, fontWeight: 900 }}>
                      {currency.format(estimatedSavings)}
                    </Typography>
                    <Typography color="text.secondary">AI-backed savings</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 12, md: 3 }}>
                <Card sx={{ height: "100%", border: 1, borderColor: usagePercent >= thresholdPercent ? "warning.main" : "divider", bgcolor: "background.paper" }}>
                  <CardContent sx={{ p: 2.5 }}>
                    <NotificationsActiveIcon color={usagePercent >= thresholdPercent ? "warning" : "primary"} />
                    <Typography variant="h4" sx={{ mt: 1, fontWeight: 900 }}>
                      {monthlyLimit > 0 ? `${usagePercent}%` : "Off"}
                    </Typography>
                    <Typography color="text.secondary">Limit usage</Typography>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            <Grid container spacing={2.5} sx={{ mt: 0.5 }}>
              <Grid size={{ xs: 12, md: 7 }}>
                <Card sx={{ mt: 3, border: 1, borderColor: "divider" }}>
                  <CardContent sx={{ p: 3 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
                      <PriceCheckIcon color="primary" />
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>
                        Usage limits and alerts
                      </Typography>
                    </Box>
                    <Grid container spacing={2}>
                      <Grid size={{ xs: 12, sm: 4 }}>
                        <TextField
                          label="Monthly limit"
                          type="number"
                          value={policyForm.monthlyLimit}
                          onChange={(event) => setPolicyForm((current) => ({ ...current, monthlyLimit: event.target.value }))}
                          fullWidth
                          size="small"
                        />
                      </Grid>
                      <Grid size={{ xs: 12, sm: 4 }}>
                        <TextField
                          label="Alert at %"
                          type="number"
                          value={policyForm.alertThresholdPercent}
                          onChange={(event) => setPolicyForm((current) => ({ ...current, alertThresholdPercent: event.target.value }))}
                          fullWidth
                          size="small"
                        />
                      </Grid>
                      <Grid size={{ xs: 12, sm: 4 }}>
                        <TextField
                          label="Alert email"
                          type="email"
                          value={policyForm.alertEmail}
                          onChange={(event) => setPolicyForm((current) => ({ ...current, alertEmail: event.target.value }))}
                          fullWidth
                          size="small"
                        />
                      </Grid>
                    </Grid>
                    <Box sx={{ mt: 2 }}>
                      <LinearProgress
                        variant="determinate"
                        value={monthlyLimit > 0 ? usagePercent : 0}
                        color={usagePercent >= thresholdPercent ? "warning" : "primary"}
                        sx={{ height: 10, borderRadius: 1 }}
                      />
                      <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                        {monthlyLimit > 0
                          ? `${preciseCurrency.format(estimatedMonthlyCost)} projected against ${preciseCurrency.format(monthlyLimit)} monthly limit`
                          : "Set a monthly limit to enable projected spend tracking."}
                      </Typography>
                    </Box>
                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 2, mt: 2, flexWrap: "wrap" }}>
                      <FormControlLabel
                        control={
                          <Switch
                            checked={policyForm.enabled}
                            onChange={(event) => setPolicyForm((current) => ({ ...current, enabled: event.target.checked }))}
                          />
                        }
                        label="Enable alerts"
                      />
                      <Button
                        variant="contained"
                        onClick={handleSavePolicy}
                        disabled={savingPolicy}
                        startIcon={savingPolicy ? <CircularProgress color="inherit" size={16} /> : <NotificationsActiveIcon />}
                      >
                        {savingPolicy ? "Saving" : "Save limits"}
                      </Button>
                    </Box>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 12, md: 5 }}>
                <Card sx={{ mt: 3, border: 1, borderColor: "divider", height: "calc(100% - 24px)" }}>
                  <CardContent sx={{ p: 3 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
                      <BoltIcon color="primary" />
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>
                        Scan health
                      </Typography>
                    </Box>
                    <Stack spacing={1}>
                      <Typography color="text.secondary">Status: {account.latestScanJob?.status || "No scan yet"}</Typography>
                      <Typography color="text.secondary">
                        Last scan: {account.lastScanAt ? new Date(account.lastScanAt).toLocaleString() : "Not available"}
                      </Typography>
                      <Typography color="text.secondary">Region baseline: {account.region}</Typography>
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            {alerts.length > 0 && (
              <Card sx={{ mt: 3, border: 1, borderColor: "warning.main" }}>
                <CardContent sx={{ p: 3 }}>
                  <Typography variant="h6" sx={{ fontWeight: 900, mb: 2 }}>
                    Recent alerts
                  </Typography>
                  <Stack divider={<Divider />} spacing={0}>
                    {alerts.map((alert) => (
                      <Box key={alert.id} sx={{ py: 1.25 }}>
                        <Typography sx={{ fontWeight: 800 }}>{alert.title || "Cost alert"}</Typography>
                        <Typography color="text.secondary">{alert.description}</Typography>
                      </Box>
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            )}

            {metricGaps.length > 0 && (
              <Card sx={{ mt: 3, border: 1, borderColor: "warning.main" }}>
                <CardContent sx={{ p: 3 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
                    <SettingsSuggestIcon color="warning" />
                    <Typography variant="h6" sx={{ fontWeight: 900 }}>
                      Enable metrics for better recommendations
                    </Typography>
                  </Box>
                  <Stack spacing={1.25}>
                    {metricGaps.slice(0, 5).map((gap) => (
                      <Alert key={gap.id} severity="warning" variant="outlined">
                        <Typography sx={{ fontWeight: 800 }}>{gap.resourceName}</Typography>
                        <Typography variant="body2">{gap.message}</Typography>
                      </Alert>
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            )}

            <Grid container spacing={2.5}>
              <Grid size={{ xs: 12, md: 6 }}>
                <Card sx={{ mt: 3, border: 1, borderColor: "divider", height: "calc(100% - 24px)" }}>
                  <CardContent sx={{ p: 3 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
                      <InsertChartIcon color="primary" />
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>
                        Cost by service
                      </Typography>
                    </Box>
                    <Stack spacing={1.5}>
                      {costByService.length === 0 ? (
                        <Typography color="text.secondary">No cost data yet.</Typography>
                      ) : costByService.map((item) => (
                        <Box key={item.service}>
                          <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
                            <Typography sx={{ fontWeight: 800 }}>{item.service}</Typography>
                            <Typography color="text.secondary">{preciseCurrency.format(item.cost)}</Typography>
                          </Box>
                          <Box sx={{ height: 10, bgcolor: "action.hover", borderRadius: 1, overflow: "hidden" }}>
                            <Box sx={{ height: "100%", width: `${Math.max(4, (item.cost / maxServiceCost) * 100)}%`, bgcolor: "primary.main" }} />
                          </Box>
                        </Box>
                      ))}
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 12, md: 6 }}>
                <Card sx={{ mt: 3, border: 1, borderColor: "divider", height: "calc(100% - 24px)" }}>
                  <CardContent sx={{ p: 3 }}>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
                      <InsertChartIcon color="primary" />
                      <Typography variant="h6" sx={{ fontWeight: 900 }}>
                        Resources by service
                      </Typography>
                    </Box>
                    <Stack spacing={1.5}>
                      {resourcesByService.length === 0 ? (
                        <Typography color="text.secondary">No inventory data yet.</Typography>
                      ) : resourcesByService.map((item) => (
                        <Box key={item.service}>
                          <Box sx={{ display: "flex", justifyContent: "space-between", mb: 0.5 }}>
                            <Typography sx={{ fontWeight: 800 }}>{item.service}</Typography>
                            <Typography color="text.secondary">{item.count}</Typography>
                          </Box>
                          <Box sx={{ height: 10, bgcolor: "action.hover", borderRadius: 1, overflow: "hidden" }}>
                            <Box sx={{ height: "100%", width: `${Math.max(4, (item.count / maxServiceCount) * 100)}%`, bgcolor: "success.main" }} />
                          </Box>
                        </Box>
                      ))}
                    </Stack>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            <Card sx={{ mt: 3, border: 1, borderColor: "divider" }}>
              <CardContent sx={{ p: 3 }}>
                <Typography variant="h6" sx={{ fontWeight: 900, mb: 2 }}>
                  AI Savings Recommendations
                </Typography>
                {recommendations.length === 0 ? (
                  <Typography color="text.secondary">
                    No AI recommendations yet. Run a manual scan after resources are discovered.
                  </Typography>
                ) : (
                  <Stack spacing={2}>
                    {recommendations.map((recommendation) => (
                      <Card key={recommendation.id} variant="outlined" sx={{ bgcolor: "background.default" }}>
                        <CardContent sx={{ p: 2 }}>
                          <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, mb: 1, alignItems: "flex-start" }}>
                            <Box>
                              <Typography sx={{ fontWeight: 900 }}>
                                {recommendation.title || "Savings opportunity"}
                              </Typography>
                              <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 0.75 }}>
                                <Chip label={recommendation.severity || "medium"} size="small" color={recommendation.severity === "high" ? "error" : "default"} />
                                <Chip label={`${recommendation.confidence ?? 0}% confidence`} size="small" variant="outlined" />
                              </Box>
                            </Box>
                            <Chip
                              label={`${preciseCurrency.format(estimatedMonthlyCost > 0 ? Math.min(Number(recommendation.estimatedSavings ?? 0), estimatedMonthlyCost) : 0)}/mo`}
                              size="small"
                              color="success"
                            />
                          </Box>
                          <Typography color="text.secondary" sx={{ mb: 1.5 }}>
                            {recommendation.recommendation}
                          </Typography>
                          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                            <Button
                              size="small"
                              variant="contained"
                              startIcon={actingRecommendationId === recommendation.id ? <CircularProgress color="inherit" size={14} /> : <TaskAltIcon />}
                              disabled={Boolean(actingRecommendationId)}
                              onClick={() => handleRecommendationAction(recommendation.id, "create_plan")}
                            >
                              Build action plan
                            </Button>
                            <Button
                              size="small"
                              variant="outlined"
                              startIcon={<DoneIcon />}
                              disabled={Boolean(actingRecommendationId)}
                              onClick={() => handleRecommendationAction(recommendation.id, "mark_done")}
                            >
                              Done
                            </Button>
                            <Button
                              size="small"
                              variant="text"
                              startIcon={<CloseIcon />}
                              disabled={Boolean(actingRecommendationId)}
                              onClick={() => handleRecommendationAction(recommendation.id, "dismiss")}
                            >
                              Dismiss
                            </Button>
                          </Box>
                        </CardContent>
                      </Card>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>

            {actionPlans.length > 0 && (
              <Card sx={{ mt: 3, border: 1, borderColor: "divider" }}>
                <CardContent sx={{ p: 3 }}>
                  <Typography variant="h6" sx={{ fontWeight: 900, mb: 2 }}>
                    Action plans
                  </Typography>
                  <Stack spacing={2}>
                    {actionPlans.map((plan) => (
                      <Card key={plan.id} variant="outlined" sx={{ bgcolor: "background.default" }}>
                        <CardContent sx={{ p: 2.5 }}>
                          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 2, mb: 1.5 }}>
                            <Box>
                              <Typography sx={{ fontWeight: 900 }}>
                                {plan.executionPlan?.recommendationTitle || "Manual review plan"}
                              </Typography>
                              <Typography variant="body2" color="text.secondary" sx={{ overflowWrap: "anywhere" }}>
                                {plan.executionPlan?.resourceName || plan.executionPlan?.resourceId || "Resource pending review"}
                              </Typography>
                            </Box>
                            <Chip
                              label={plan.actionType?.replaceAll("_", " ") || "plan"}
                              size="small"
                              color={plan.actionType === "ec2_rightsize_instance" ? "primary" : "default"}
                            />
                          </Box>

                          <Typography color="text.secondary" sx={{ mb: 2 }}>
                            {plan.executionPlan?.recommendation}
                          </Typography>

                          {(plan.executionPlan?.currentState || plan.executionPlan?.targetState) && (
                            <Grid container spacing={1.5} sx={{ mb: 2 }}>
                              <Grid size={{ xs: 12, sm: 6 }}>
                                <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5, bgcolor: "background.paper" }}>
                                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }}>
                                    Current
                                  </Typography>
                                  {Object.entries(plan.executionPlan.currentState ?? {}).map(([key, value]) => (
                                    <Typography key={key} variant="body2">
                                      {key}: {formatValue(value)}
                                    </Typography>
                                  ))}
                                </Box>
                              </Grid>
                              <Grid size={{ xs: 12, sm: 6 }}>
                                <Box sx={{ border: 1, borderColor: "divider", borderRadius: 1, p: 1.5, bgcolor: "background.paper" }}>
                                  <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 800 }}>
                                    Target
                                  </Typography>
                                  {Object.entries(plan.executionPlan.targetState ?? {}).map(([key, value]) => (
                                    <Typography key={key} variant="body2">
                                      {key}: {formatValue(value)}
                                    </Typography>
                                  ))}
                                </Box>
                              </Grid>
                            </Grid>
                          )}

                          {plan.executionPlan?.evidence?.length ? (
                            <Box sx={{ mb: 2 }}>
                              <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 0.75 }}>
                                Evidence
                              </Typography>
                              <Stack spacing={0.5}>
                                {plan.executionPlan.evidence.map((item) => (
                                  <Typography key={item} variant="body2" color="text.secondary">
                                    {item}
                                  </Typography>
                                ))}
                              </Stack>
                            </Box>
                          ) : null}

                          <Box sx={{ mb: 2 }}>
                            <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 0.75 }}>
                              Steps
                            </Typography>
                            <Stack spacing={0.75}>
                              {(plan.executionPlan?.steps ?? []).map((step, index) => (
                                <Typography key={step} variant="body2" color="text.secondary">
                                  {index + 1}. {step}
                                </Typography>
                              ))}
                            </Stack>
                          </Box>

                          {plan.executionPlan?.awsCli?.length ? (
                            <Box sx={{ mb: 2 }}>
                              <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 0.75 }}>
                                AWS CLI
                              </Typography>
                              <Stack spacing={0.75}>
                                {plan.executionPlan.awsCli.map((command) => (
                                  <Box
                                    key={command}
                                    sx={{
                                      fontFamily: "var(--font-geist-mono)",
                                      fontSize: 12,
                                      p: 1,
                                      borderRadius: 1,
                                      bgcolor: "action.hover",
                                      overflowWrap: "anywhere",
                                    }}
                                  >
                                    {command}
                                  </Box>
                                ))}
                              </Stack>
                            </Box>
                          ) : null}

                          {plan.rollbackPlan?.steps?.length ? (
                            <Box>
                              <Typography variant="subtitle2" sx={{ fontWeight: 900, mb: 0.75 }}>
                                Rollback
                              </Typography>
                              <Stack spacing={0.5}>
                                {plan.rollbackPlan.steps.map((step, index) => (
                                  <Typography key={step} variant="body2" color="text.secondary">
                                    {index + 1}. {step}
                                  </Typography>
                                ))}
                              </Stack>
                            </Box>
                          ) : null}
                        </CardContent>
                      </Card>
                    ))}
                  </Stack>
                </CardContent>
              </Card>
            )}

            <Card sx={{ mt: 3, border: 1, borderColor: "divider" }}>
              <CardContent sx={{ p: 3 }}>
                <Typography variant="h6" sx={{ fontWeight: 900, mb: 2 }}>
                  Resources
                </Typography>
                {resources.length === 0 ? (
                  <Typography color="text.secondary">
                    No resources stored yet. Run a manual scan to refresh inventory.
                  </Typography>
                ) : (
                  <Stack divider={<Divider />} spacing={0}>
                    {resources.map((resource) => (
                      <Box
                        key={resource.id}
                        sx={{
                          display: "grid",
                          gridTemplateColumns: { xs: "1fr", md: "1.2fr 1fr 0.8fr 0.8fr 0.8fr" },
                          gap: 1.5,
                          py: 1.5,
                        }}
                      >
                        <Box>
                          <Typography sx={{ fontWeight: 800, overflowWrap: "anywhere" }}>
                            {resource.resourceName || resource.resourceId}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere", display: "block" }}>
                            {resource.resourceId}
                          </Typography>
                        </Box>
                        <Typography color="text.secondary">
                          {resource.service} · {resource.resourceType}
                        </Typography>
                        <Typography color="text.secondary">
                          {resource.region || "global"}
                        </Typography>
                        <Typography sx={{ fontWeight: 800 }}>
                          {preciseCurrency.format(Number(resource.monthlyCost ?? 0))}/mo
                        </Typography>
                        <Typography color="text.secondary">
                          {resource.utilization ? `${resource.utilization}% avg CPU` : resource.status || "tracked"}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>
          </>
        )}
      </Box>
    </DashboardLayout>
  );
}
