"use client";
import * as React from 'react';
import { useRouter } from "next/navigation";
import { authClient } from "../lib/auth-client";
import { useCallback, useEffect, useState } from "react";
import DashboardLayout from "../../components/dashboard-layout";
import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import CardActionArea from '@mui/material/CardActionArea';
import Typography from '@mui/material/Typography';
import Grid from '@mui/material/Grid';
import Button from '@mui/material/Button';
import CircularProgress from '@mui/material/CircularProgress';
import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogTitle from '@mui/material/DialogTitle';
import TextField from '@mui/material/TextField';
import Alert from '@mui/material/Alert';
import AddIcon from '@mui/icons-material/Add';

interface Organization {
  id: string;
  name: string;
  plan: string;
}

export default function Dashboard() {
  const [message, setMessage] = useState("");
  const [auth, setAuth] = useState(true);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [addOrgOpen, setAddOrgOpen] = useState(false);
  const [orgName, setOrgName] = useState("");
  const [error, setError] = useState("");
  const [orgs, setOrgs] = useState<Organization[]>([]);
  const router = useRouter();

  const fetchOrganizations = useCallback(async () => {
    const response = await fetch("/api/org");
    if (!response.ok) {
      throw new Error("Failed to fetch organizations");
    }

    return response.json() as Promise<Organization[]>;
  }, []);

  const loadDashboard = useCallback(async () => {
    const { data: session } = await authClient.getSession();
    if (!session) {
      setAuth(false);
      setLoading(false);
      router.push("/login");
      return;
    }

    setAuth(true);
    setMessage(session.user.name || session.user.email || "User");

    try {
      const data = await fetchOrganizations();
      setOrgs(data);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to fetch organizations");
    } finally {
      setLoading(false);
    }
  }, [fetchOrganizations, router]);

  useEffect(() => {
    let active = true;

    authClient.getSession()
      .then(async ({ data: session }) => {
        if (!active) return;

        if (!session) {
          setAuth(false);
          setLoading(false);
          router.push("/login");
          return;
        }

        setAuth(true);
        setMessage(session.user.name || session.user.email || "User");

        try {
          const data = await fetchOrganizations();
          if (!active) return;
          setOrgs(data);
        } catch (err: unknown) {
          if (!active) return;
          setError(err instanceof Error ? err.message : "Failed to fetch organizations");
        } finally {
          if (active) {
            setLoading(false);
          }
        }
      })
      .catch((err: unknown) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : "Failed to load dashboard");
        setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [fetchOrganizations, router]);

  const handleOrgClick = (orgId: string) => {
    router.push(`/org/${orgId}`);
  };

  const handleAddOrgClose = () => {
    if (creating) return;
    setAddOrgOpen(false);
    setOrgName("");
  };

  const handleAddOrgSubmit = async () => {
    const trimmedName = orgName.trim();
    if (!trimmedName) return;

    setCreating(true);
    setError("");

    try {
      const response = await fetch("/api/org", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmedName }),
      });

      if (!response.ok) {
        throw new Error("Failed to create organization");
      }

      setAddOrgOpen(false);
      setOrgName("");
      await loadDashboard();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to create organization");
    } finally {
      setCreating(false);
    }
  };

  if (!auth) {
    return null;
  }

  const dashboardContent = (
    <Box sx={{ maxWidth: 1180, mx: 'auto', width: '100%' }}>
      <Box 
        sx={{ 
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: { xs: 'stretch', sm: 'center' },
          flexDirection: { xs: 'column', sm: 'row' },
          gap: 2,
          mb: 3,
        }}
      >
        <Box>
          <Typography variant="h4" sx={{ color: 'text.primary', fontWeight: 800 }}>
            Dashboard
          </Typography>
          <Typography variant="subtitle1" sx={{ mt: 0.5, color: 'text.secondary' }}>
            Welcome, {message}!
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<AddIcon />}
          onClick={() => setAddOrgOpen(true)}
          sx={{ alignSelf: { xs: 'stretch', sm: 'center' }, minHeight: 42 }}
        >
          Add Organization
        </Button>
      </Box>

      <Typography variant="h5" sx={{ mb: 2, fontWeight: 500 }}>
        Your Organizations
      </Typography>

      {error && (
        <Alert severity="error" sx={{ mb: 3 }}>{error}</Alert>
      )}

      {!loading && !error && (
        <Grid container spacing={3}>
          {orgs.length === 0 ? (
            <Grid size={12}>
              <Card sx={{ border: 1, borderColor: 'divider', bgcolor: 'background.paper' }}>
                <CardContent sx={{ p: { xs: 3, sm: 4 }, display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                  <Typography variant="h6" sx={{ fontWeight: 700 }}>
                    No organizations yet
                  </Typography>
                  <Typography sx={{ color: 'text.secondary' }}>
                    Create an organization to start tracking your cloud savings.
                  </Typography>
                  <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddOrgOpen(true)}>
                    Add Organization
                  </Button>
                </CardContent>
              </Card>
            </Grid>
          ) : (
            orgs.map((org) => (
              <Grid key={org.id} size={{ xs: 12, sm: 6, md: 4 }}>
                <Card 
                  sx={{ 
                    height: '100%',
                    bgcolor: 'background.paper',
                    border: 1,
                    borderColor: 'divider',
                    boxShadow: 2,
                    transition: 'transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease',
                    '&:hover': { transform: 'translateY(-4px)', boxShadow: 6, borderColor: 'primary.main' }
                  }}
                >
                  <CardActionArea 
                    onClick={() => handleOrgClick(org.id)}
                    sx={{ height: '100%', minHeight: 136 }}
                  >
                    <CardContent sx={{ height: '100%', p: 3 }}>
                      <Typography variant="h6" gutterBottom sx={{ fontWeight: 800 }}>
                        {org.name}
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        Plan: {org.plan}
                      </Typography>
                    </CardContent>
                  </CardActionArea>
                </Card>
              </Grid>
            ))
          )}
        </Grid>
      )}

      <Dialog open={addOrgOpen} onClose={handleAddOrgClose} maxWidth="sm" fullWidth>
        <DialogTitle>Add Organization</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            margin="dense"
            label="Organization Name"
            fullWidth
            variant="outlined"
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleAddOrgSubmit()}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={handleAddOrgClose} disabled={creating}>Cancel</Button>
          <Button 
            onClick={handleAddOrgSubmit} 
            variant="contained" 
            disabled={!orgName.trim() || creating}
            startIcon={creating ? <CircularProgress color="inherit" size={16} /> : <AddIcon />}
          >
            {creating ? 'Creating' : 'Create'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );

  return (
    <DashboardLayout>
      {loading ? (
        <Box 
          sx={{ 
            minHeight: 'calc(100vh - 160px)',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 2,
            color: 'text.secondary',
          }}
        >
          <CircularProgress size={48} thickness={4} />
          <Typography sx={{ fontWeight: 600 }}>Loading dashboard</Typography>
        </Box>
      ) : auth ? (
        dashboardContent
      ) : null}
    </DashboardLayout>
  );
}
