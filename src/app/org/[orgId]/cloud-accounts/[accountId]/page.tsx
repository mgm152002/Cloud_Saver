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
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import SavingsIcon from "@mui/icons-material/Savings";
import CloudQueueIcon from "@mui/icons-material/CloudQueue";
import AssessmentIcon from "@mui/icons-material/Assessment";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import RefreshIcon from "@mui/icons-material/Refresh";
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

interface CostDashboardPayload {
  account: CloudAccount;
  resources: CloudResource[];
  recommendations: Recommendation[];
}

export default function CostDashboardPage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;
  const accountId = params.accountId as string;
  const [account, setAccount] = useState<CloudAccount | null>(null);
  const [resources, setResources] = useState<CloudResource[]>([]);
  const [recommendations, setRecommendations] = useState<Recommendation[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");

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

  const resourcesFound = resources.length || account?.latestScanJob?.resourcesFound || 0;
  const estimatedMonthlyCost = useMemo(() => resourcesFound * 12, [resourcesFound]);
  const estimatedSavings = useMemo(() => {
    const aiSavings = recommendations.reduce((total, recommendation) => total + Number(recommendation.estimatedSavings ?? 0), 0);
    return aiSavings || Math.round(estimatedMonthlyCost * 0.18);
  }, [estimatedMonthlyCost, recommendations]);

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
                <Typography variant="h4" sx={{ fontWeight: 800 }}>
                  Cost Dashboard
                </Typography>
                <Typography sx={{ color: "text.secondary", mt: 0.5 }}>
                  {account.accountName} · {account.accountId}
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

            <Grid container spacing={2.5}>
              <Grid size={{ xs: 12, md: 4 }}>
                <Card sx={{ height: "100%", border: 1, borderColor: "divider" }}>
                  <CardContent>
                    <CloudQueueIcon color="primary" />
                    <Typography variant="h5" sx={{ mt: 1, fontWeight: 800 }}>
                      {resourcesFound}
                    </Typography>
                    <Typography color="text.secondary">Resources found</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 12, md: 4 }}>
                <Card sx={{ height: "100%", border: 1, borderColor: "divider" }}>
                  <CardContent>
                    <AssessmentIcon color="primary" />
                    <Typography variant="h5" sx={{ mt: 1, fontWeight: 800 }}>
                      ${estimatedMonthlyCost}
                    </Typography>
                    <Typography color="text.secondary">Estimated monthly cost</Typography>
                  </CardContent>
                </Card>
              </Grid>
              <Grid size={{ xs: 12, md: 4 }}>
                <Card sx={{ height: "100%", border: 1, borderColor: "divider" }}>
                  <CardContent>
                    <SavingsIcon color="primary" />
                    <Typography variant="h5" sx={{ mt: 1, fontWeight: 800 }}>
                      ${estimatedSavings}
                    </Typography>
                    <Typography color="text.secondary">Estimated savings</Typography>
                  </CardContent>
                </Card>
              </Grid>
            </Grid>

            <Card sx={{ mt: 3, border: 1, borderColor: "divider" }}>
              <CardContent>
                <Typography variant="h6" sx={{ fontWeight: 800, mb: 2 }}>
                  Initial Scan
                </Typography>
                <Typography color="text.secondary">
                  Status: {account.latestScanJob?.status || "No scan yet"}
                </Typography>
                <Typography color="text.secondary">
                  Last scan: {account.lastScanAt ? new Date(account.lastScanAt).toLocaleString() : "Not available"}
                </Typography>
                <Typography color="text.secondary">
                  Region: {account.region}
                </Typography>
              </CardContent>
            </Card>

            <Card sx={{ mt: 3, border: 1, borderColor: "divider" }}>
              <CardContent>
                <Typography variant="h6" sx={{ fontWeight: 800, mb: 2 }}>
                  AI Savings Recommendations
                </Typography>
                {recommendations.length === 0 ? (
                  <Typography color="text.secondary">
                    No AI recommendations yet. Run a manual scan after resources are discovered.
                  </Typography>
                ) : (
                  <Stack spacing={2}>
                    {recommendations.map((recommendation) => (
                      <Box key={recommendation.id}>
                        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, mb: 0.5 }}>
                          <Typography sx={{ fontWeight: 800 }}>
                            {recommendation.title || "Savings opportunity"}
                          </Typography>
                          <Chip
                            label={`$${Number(recommendation.estimatedSavings ?? 0)}/mo`}
                            size="small"
                            color={recommendation.severity === "high" ? "error" : "default"}
                          />
                        </Box>
                        <Typography color="text.secondary">
                          {recommendation.recommendation}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Severity: {recommendation.severity || "medium"} · Confidence: {recommendation.confidence ?? 0}%
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>

            <Card sx={{ mt: 3, border: 1, borderColor: "divider" }}>
              <CardContent>
                <Typography variant="h6" sx={{ fontWeight: 800, mb: 2 }}>
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
                          gridTemplateColumns: { xs: "1fr", md: "1.1fr 1fr 0.8fr 0.8fr" },
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
