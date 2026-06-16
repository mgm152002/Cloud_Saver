"use client";
import * as React from 'react';
import { useRouter, useParams } from "next/navigation";
import { authClient } from "../../lib/auth-client";
import { useCallback, useEffect, useState } from "react";
import DashboardLayout from "../../../components/dashboard-layout";
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Typography from '@mui/material/Typography';
import Button from '@mui/material/Button';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import Alert from '@mui/material/Alert';
import TextField from '@mui/material/TextField';
import CircularProgress from '@mui/material/CircularProgress';
import CloudIcon from '@mui/icons-material/Cloud';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import RefreshIcon from '@mui/icons-material/Refresh';
import HistoryIcon from '@mui/icons-material/History';
import Chip from '@mui/material/Chip';

interface CloudAccount {
  id: string;
  provider: string;
  accountName: string;
  accountId: string;
  region: string;
  status: string;
  createdAt: string;
  latestScanJob?: {
    id: string;
    status: string | null;
    resourcesFound: number | null;
  } | null;
}

interface Organization {
  id: string;
  name: string;
  plan: string;
}

export default function OrgDetailPage() {
  const params = useParams();
  const orgId = params.orgId as string;
  const router = useRouter();
  
  const [auth, setAuth] = useState(true);
  const [loading, setLoading] = useState(true);
  const [org, setOrg] = useState<Organization | null>(null);
  const [cloudAccounts, setCloudAccounts] = useState<CloudAccount[]>([]);
  const [showConnectDialog, setShowConnectDialog] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [deletingAccountId, setDeletingAccountId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CloudAccount | null>(null);
  const [onboarding, setOnboarding] = useState<{
    onboardingId: string;
    externalId: string;
    cloudFormationUrl: string;
    templateUrl: string;
  } | null>(null);
  const [roleArn, setRoleArn] = useState("");

  const fetchOrgDetails = useCallback(async () => {
    try {
      const response = await fetch("/api/org");
      if (response.ok) {
        const orgs = await response.json() as Organization[];
        const currentOrg = orgs.find((o) => o.id === orgId);
        setOrg(currentOrg || null);
      }
    } catch (err) {
      console.error('Failed to fetch org:', err);
    }
  }, [orgId]);

  const fetchCloudAccounts = useCallback(async () => {
    try {
      const response = await fetch(`/api/org/${orgId}/cloud-accounts`);
      if (response.ok) {
        const accounts = await response.json() as CloudAccount[];
        setCloudAccounts(accounts);
        
        if (accounts.length === 0) {
          setShowConnectDialog(true);
        }
      } else {
        setCloudAccounts([]);
        setShowConnectDialog(true);
      }
    } catch (err) {
      console.error('Failed to fetch cloud accounts:', err);
      setCloudAccounts([]);
      setShowConnectDialog(true);
    }
  }, [orgId]);

  useEffect(() => {
    const init = async () => {
      const { data: session } = await authClient.getSession();
      if (!session) {
        router.push("/login");
        return;
      }
      setAuth(true);
      
      await fetchOrgDetails();
      await fetchCloudAccounts();
      setLoading(false);
    };
    init();
  }, [fetchCloudAccounts, fetchOrgDetails, router]);

  const handleConnectAWS = async () => {
    setConnecting(true);
    setError("");
    
    try {
      const response = await fetch("/api/connect/aws", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          onboarding
            ? { orgId, onboardingId: onboarding.onboardingId, roleArn }
            : { orgId },
        ),
      });
      
      if (response.ok) {
        const data = await response.json();
        if (data.step === "launch-cloudformation") {
          setOnboarding({
            onboardingId: data.onboardingId,
            externalId: data.externalId,
            cloudFormationUrl: data.cloudFormationUrl,
            templateUrl: data.templateUrl,
          });
        } else {
          setShowConnectDialog(false);
          setOnboarding(null);
          setRoleArn("");
          await fetchCloudAccounts();
        }
      } else {
        const data = await response.json();
        setError(data.message || "Failed to connect AWS account");
      }
    } catch {
      setError("Failed to connect AWS account");
    } finally {
      setConnecting(false);
    }
  };

  const handleCloseDialog = () => {
    setShowConnectDialog(false);
    setError("");
    setOnboarding(null);
    setRoleArn("");
  };

  const handleDeleteAccount = async (account: CloudAccount) => {
    setDeletingAccountId(account.id);
    setError("");

    try {
      const response = await fetch(`/api/org/${orgId}/cloud-accounts/${account.id}`, {
        method: "DELETE",
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.message || "Failed to delete cloud account");
      }

      await fetchCloudAccounts();
      setDeleteTarget(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to delete cloud account");
    } finally {
      setDeletingAccountId(null);
    }
  };

  const handleAccountClick = (accountId: string) => {
    router.push(`/org/${orgId}/cloud-accounts/${accountId}`);
  };

  const handleRefreshAccounts = async () => {
    setRefreshing(true);
    setError("");
    try {
      await fetchCloudAccounts();
    } finally {
      setRefreshing(false);
    }
  };

  if (!auth || loading) {
    return (
      <DashboardLayout>
        <Box sx={{ display: 'flex', justifyContent: 'center', p: 3 }}>
          <Typography>Loading...</Typography>
        </Box>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <Box>
        <Box sx={{ mb: 3 }}>
          <Button 
            variant="text" 
            onClick={() => router.push('/dashboard')}
            sx={{ mb: 2, pl: 0 }}
          >
            ← Back to Dashboard
          </Button>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>
            {org?.name || 'Organization'}
          </Typography>
          <Typography variant="body1" sx={{ color: 'text.secondary' }}>
            Plan: {org?.plan || 'Free'}
          </Typography>
        </Box>

        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: { xs: 'stretch', sm: 'center' }, flexDirection: { xs: 'column', sm: 'row' }, gap: 2, mb: 3 }}>
          <Typography variant="h5" sx={{ fontWeight: 500 }}>
            Connected Cloud Accounts
          </Typography>
          <Box sx={{ display: 'flex', gap: 1, flexDirection: { xs: 'column', sm: 'row' } }}>
            <Button
              variant="outlined"
              startIcon={refreshing ? <CircularProgress color="inherit" size={16} /> : <RefreshIcon />}
              onClick={handleRefreshAccounts}
              disabled={refreshing}
            >
              {refreshing ? 'Refreshing' : 'Refresh'}
            </Button>
            <Button 
              variant="contained" 
              startIcon={<AddIcon />}
              onClick={() => setShowConnectDialog(true)}
            >
              Add Cloud Account
            </Button>
          </Box>
        </Box>

        {error && (
          <Alert severity="error" sx={{ mb: 3 }}>
            {error}
          </Alert>
        )}

        {cloudAccounts.length === 0 ? (
          <Card sx={{ p: 4, textAlign: 'center' }}>
            <CloudIcon sx={{ fontSize: 64, color: 'text.secondary', mb: 2 }} />
            <Typography variant="h6" gutterBottom>
              No Cloud Accounts Connected
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 3 }}>
              Connect your AWS account to start monitoring and optimizing your cloud costs.
            </Typography>
            <Button 
              variant="contained" 
              onClick={() => setShowConnectDialog(true)}
            >
              Connect AWS Account
            </Button>
          </Card>
        ) : (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: 'repeat(2, 1fr)', lg: 'repeat(3, 1fr)' }, gap: 2 }}>
            {cloudAccounts.map((account) => (
              <Card
                key={account.id}
                onClick={() => handleAccountClick(account.id)}
                sx={{
                  cursor: 'pointer',
                  border: 1,
                  borderColor: 'divider',
                  transition: 'transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease',
                  '&:hover': {
                    borderColor: 'primary.main',
                    boxShadow: 6,
                    transform: 'translateY(-3px)',
                  },
                }}
              >
                <CardContent>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 2 }}>
                    <Typography variant="h6" sx={{ fontWeight: 800 }}>
                      {account.accountName || 'AWS'}
                    </Typography>
                    <Chip 
                      label={account.status} 
                      color={account.status === 'active' ? 'success' : 'default'}
                      size="small"
                    />
                  </Box>
                  <Typography variant="body2" color="text.secondary">
                    Account ID: {account.accountId}
                  </Typography>
                  <Typography variant="body2" color="text.secondary">
                    Region: {account.region}
                  </Typography>
                  {account.latestScanJob && (
                    <Typography variant="body2" color="text.secondary">
                      Initial scan: {account.latestScanJob.status}
                      {typeof account.latestScanJob.resourcesFound === 'number'
                        ? ` (${account.latestScanJob.resourcesFound} resources)`
                        : ''}
                    </Typography>
                  )}
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                    Added: {new Date(account.createdAt).toLocaleDateString()}
                  </Typography>
                  <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', mt: 2 }}>
                    <Button
                      onClick={(event) => {
                        event.stopPropagation();
                        router.push(`/org/${orgId}/cloud-accounts/${account.id}/history`);
                      }}
                      size="small"
                      startIcon={<HistoryIcon fontSize="small" />}
                      variant="outlined"
                    >
                      History
                    </Button>
                    <Button
                      color="error"
                      disabled={deletingAccountId === account.id}
                      onClick={(event) => {
                        event.stopPropagation();
                        setDeleteTarget(account);
                      }}
                      size="small"
                      startIcon={<DeleteIcon fontSize="small" />}
                      variant="outlined"
                    >
                      Delete
                    </Button>
                  </Box>
                </CardContent>
              </Card>
            ))}
          </Box>
        )}

      </Box>

      {/* Connect AWS Dialog */}
      <Dialog open={showConnectDialog} onClose={handleCloseDialog} maxWidth="sm" fullWidth>
        <DialogTitle>Connect to AWS</DialogTitle>
        <DialogContent>
          {error && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          )}
          <Typography variant="body1" gutterBottom>
            Connect your AWS account with a read-only IAM role created from CloudFormation.
          </Typography>
          {onboarding ? (
            <Box sx={{ mt: 2, display: 'flex', flexDirection: 'column', gap: 2 }}>
              <Alert severity="info">
                External ID generated. Launch CloudFormation, create the role, then paste the Role ARN here.
              </Alert>
              <Box>
                <Typography variant="caption" color="text.secondary">
                  External ID
                </Typography>
                <Typography sx={{ fontFamily: 'var(--font-geist-mono)', overflowWrap: 'anywhere' }}>
                  {onboarding.externalId}
                </Typography>
              </Box>
              <Button
                variant="outlined"
                href={onboarding.cloudFormationUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Launch CloudFormation
              </Button>
              <TextField
                label="Role ARN"
                placeholder="arn:aws:iam::123456789012:role/CloudSaverReadOnlyRole"
                value={roleArn}
                onChange={(event) => setRoleArn(event.target.value)}
                fullWidth
              />
            </Box>
          ) : (
            <Box component="ol" sx={{ pl: 2, mt: 2 }}>
              <li><Typography variant="body2">Generate an External ID.</Typography></li>
              <li><Typography variant="body2">Launch CloudFormation with the CloudSaver template.</Typography></li>
              <li><Typography variant="body2">Create the read-only IAM role.</Typography></li>
              <li><Typography variant="body2">Paste the Role ARN so CloudSaver can validate AssumeRole.</Typography></li>
              <li><Typography variant="body2">Run the initial scan and open the savings dashboard.</Typography></li>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={handleCloseDialog}>Cancel</Button>
          <Button 
            onClick={handleConnectAWS} 
            variant="contained"
            disabled={connecting || Boolean(onboarding && !roleArn.trim())}
            startIcon={connecting ? <CircularProgress color="inherit" size={16} /> : undefined}
          >
            {connecting ? 'Working' : onboarding ? 'Validate & Scan' : 'Generate External ID'}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} maxWidth="xs" fullWidth>
        <DialogTitle>Delete cloud account?</DialogTitle>
        <DialogContent>
          <Typography sx={{ color: 'text.secondary' }}>
            This will remove {deleteTarget?.accountName || 'this cloud account'} and its scan data from Cloud Saver.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeleteTarget(null)} disabled={Boolean(deletingAccountId)}>
            Cancel
          </Button>
          <Button
            color="error"
            disabled={!deleteTarget || deletingAccountId === deleteTarget.id}
            onClick={() => deleteTarget && handleDeleteAccount(deleteTarget)}
            startIcon={deletingAccountId ? <CircularProgress color="inherit" size={16} /> : <DeleteIcon />}
            variant="contained"
          >
            {deletingAccountId ? 'Deleting' : 'Delete'}
          </Button>
        </DialogActions>
      </Dialog>
    </DashboardLayout>
  );
}
