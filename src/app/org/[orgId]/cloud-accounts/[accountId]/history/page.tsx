"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  Chip,
  CircularProgress,
  Divider,
  Stack,
  Typography,
} from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import HistoryIcon from "@mui/icons-material/History";
import RefreshIcon from "@mui/icons-material/Refresh";
import DashboardLayout from "../../../../../../components/dashboard-layout";

interface CloudAccount {
  id: string;
  provider: string;
  accountName: string;
  accountId: string;
  status: string | null;
  lastScanAt: string | null;
}

interface JobHistoryRow {
  id: string;
  triggerRunId: string | null;
  taskIdentifier: string;
  jobType: string;
  status: string;
  message: string | null;
  resourcesFound: number | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

interface ScanRow {
  id: string;
  status: string | null;
  startedAt: string | null;
  completedAt: string | null;
  resourcesFound: number | null;
  createdAt: string;
  scanMetadata: Record<string, unknown> | null;
}

interface HistoryPayload {
  account: CloudAccount;
  history: JobHistoryRow[];
  scans: ScanRow[];
}

function statusColor(status?: string | null) {
  if (status === "completed") return "success";
  if (status === "failed") return "error";
  if (status === "running") return "primary";
  return "default";
}

function formatDate(value?: string | null) {
  return value ? new Date(value).toLocaleString() : "Not available";
}

export default function AccountHistoryPage() {
  const params = useParams();
  const router = useRouter();
  const orgId = params.orgId as string;
  const accountId = params.accountId as string;
  const [data, setData] = useState<HistoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const fetchHistory = useCallback(async () => {
    const response = await fetch(`/api/org/${orgId}/cloud-accounts/${accountId}/history`);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.message || "Failed to load job history");
    }
    return payload as HistoryPayload;
  }, [accountId, orgId]);

  useEffect(() => {
    let active = true;

    fetchHistory()
      .then((payload) => {
        if (active) setData(payload);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Failed to load job history");
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [fetchHistory]);

  const handleRefresh = async () => {
    setRefreshing(true);
    setError("");
    try {
      setData(await fetchHistory());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to refresh job history");
    } finally {
      setRefreshing(false);
    }
  };

  if (loading) {
    return (
      <DashboardLayout>
        <Box sx={{ minHeight: "60vh", display: "flex", alignItems: "center", justifyContent: "center", gap: 2 }}>
          <CircularProgress />
          <Typography sx={{ color: "text.secondary", fontWeight: 600 }}>Loading job history</Typography>
        </Box>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <Box sx={{ maxWidth: 980, mx: "auto" }}>
        <Button
          onClick={() => router.push(`/org/${orgId}/cloud-accounts/${accountId}`)}
          startIcon={<ArrowBackIcon />}
          sx={{ mb: 2 }}
          variant="text"
        >
          Back to account
        </Button>

        {error || !data ? (
          <Alert severity="error">{error || "Job history not found"}</Alert>
        ) : (
          <>
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: { xs: "stretch", sm: "flex-start" }, flexDirection: { xs: "column", sm: "row" }, gap: 2, mb: 3 }}>
              <Box>
                <Typography variant="overline" sx={{ color: "primary.main", fontWeight: 900, letterSpacing: 0 }}>
                  Trigger.dev job history
                </Typography>
                <Typography variant="h3" sx={{ fontWeight: 900, fontSize: { xs: 32, md: 42 }, lineHeight: 1.05 }}>
                  {data.account.accountName}
                </Typography>
                <Typography sx={{ color: "text.secondary", mt: 0.5 }}>
                  Account {data.account.accountId} · Last scan {formatDate(data.account.lastScanAt)}
                </Typography>
              </Box>
              <Button
                disabled={refreshing}
                onClick={handleRefresh}
                startIcon={refreshing ? <CircularProgress color="inherit" size={16} /> : <RefreshIcon />}
                variant="outlined"
              >
                {refreshing ? "Refreshing" : "Refresh"}
              </Button>
            </Box>

            <Card sx={{ border: 1, borderColor: "divider" }}>
              <CardContent sx={{ p: 3 }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 2 }}>
                  <HistoryIcon color="primary" />
                  <Typography variant="h6" sx={{ fontWeight: 900 }}>
                    Job events
                  </Typography>
                </Box>
                {data.history.length === 0 ? (
                  <Typography color="text.secondary">No job history has been recorded for this account yet.</Typography>
                ) : (
                  <Stack divider={<Divider />} spacing={0}>
                    {data.history.map((job) => (
                      <Box key={job.id} sx={{ py: 1.75 }}>
                        <Box sx={{ display: "flex", justifyContent: "space-between", gap: 2, alignItems: "flex-start", flexWrap: "wrap" }}>
                          <Box>
                            <Typography sx={{ fontWeight: 900 }}>{job.taskIdentifier}</Typography>
                            <Typography variant="body2" color="text.secondary">
                              {job.message || job.jobType.replaceAll("_", " ")}
                            </Typography>
                            {job.triggerRunId && (
                              <Typography variant="caption" color="text.secondary" sx={{ overflowWrap: "anywhere", display: "block" }}>
                                Trigger run: {job.triggerRunId}
                              </Typography>
                            )}
                          </Box>
                          <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
                            <Chip label={job.status} color={statusColor(job.status)} size="small" />
                            {typeof job.resourcesFound === "number" && <Chip label={`${job.resourcesFound} resources`} size="small" variant="outlined" />}
                          </Stack>
                        </Box>
                        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
                          Created {formatDate(job.createdAt)} · Started {formatDate(job.startedAt)} · Completed {formatDate(job.completedAt)}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                )}
              </CardContent>
            </Card>

            <Card sx={{ mt: 3, border: 1, borderColor: "divider" }}>
              <CardContent sx={{ p: 3 }}>
                <Typography variant="h6" sx={{ fontWeight: 900, mb: 2 }}>
                  Scan snapshots
                </Typography>
                {data.scans.length === 0 ? (
                  <Typography color="text.secondary">No scan snapshots yet.</Typography>
                ) : (
                  <Stack divider={<Divider />} spacing={0}>
                    {data.scans.map((scan) => (
                      <Box key={scan.id} sx={{ py: 1.5, display: "flex", justifyContent: "space-between", gap: 2, flexWrap: "wrap" }}>
                        <Box>
                          <Typography sx={{ fontWeight: 800 }}>{formatDate(scan.createdAt)}</Typography>
                          <Typography variant="body2" color="text.secondary">
                            Started {formatDate(scan.startedAt)} · Completed {formatDate(scan.completedAt)}
                          </Typography>
                        </Box>
                        <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", rowGap: 1 }}>
                          <Chip label={scan.status || "pending"} color={statusColor(scan.status)} size="small" />
                          {typeof scan.resourcesFound === "number" && <Chip label={`${scan.resourcesFound} resources`} size="small" variant="outlined" />}
                        </Stack>
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
