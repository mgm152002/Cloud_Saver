"use client";
import * as React from 'react';
import AppBar from '@mui/material/AppBar';
import Toolbar from '@mui/material/Toolbar';
import Typography from '@mui/material/Typography';
import Box from '@mui/material/Box';
import IconButton from '@mui/material/IconButton';
import Avatar from '@mui/material/Avatar';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import Tooltip from '@mui/material/Tooltip';
import AddIcon from '@mui/icons-material/Add';
import LogoutIcon from '@mui/icons-material/Logout';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import { useColorScheme } from '@mui/material/styles';
import { authClient } from "../app/lib/auth-client";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [addOrgOpen, setAddOrgOpen] = React.useState(false);
  const [orgName, setOrgName] = React.useState('');
  const [user, setUser] = React.useState<{ name?: string; email?: string; image?: string | null } | null>(null);
  const { mode, setMode } = useColorScheme();

  React.useEffect(() => {
    const getUser = async () => {
      const { data: session } = await authClient.getSession();
      if (session?.user) {
        setUser(session.user);
      }
    };
    getUser();
  }, []);

  const handleProfileMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleProfileMenuClose = () => {
    setAnchorEl(null);
  };

  const handleSignOut = async () => {
    await authClient.signOut();
    window.location.href = '/login';
  };

  const handleAddOrgOpen = () => {
    setAddOrgOpen(true);
    handleProfileMenuClose();
  };

  const handleAddOrgClose = () => {
    setAddOrgOpen(false);
    setOrgName('');
  };

  const handleAddOrgSubmit = async () => {
    if (!orgName.trim()) return;
    
    try {
      const response = await fetch('/api/org', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: orgName }),
      });
      
      if (response.ok) {
        handleAddOrgClose();
        window.location.reload();
      }
    } catch (error) {
      console.error('Failed to create org:', error);
    }
  };

  const getInitials = (name?: string, email?: string) => {
    if (name) return name.charAt(0).toUpperCase();
    if (email) return email.charAt(0).toUpperCase();
    return 'U';
  };

  const toggleMode = () => {
    setMode(mode === 'dark' ? 'light' : 'dark');
  };

  return (
    <Box sx={{ flexGrow: 1, minHeight: '100vh', display: 'flex', flexDirection: 'column', bgcolor: 'background.default' }}>
      <AppBar 
        position="static" 
        elevation={0}
        sx={{ 
          bgcolor: 'background.paper',
          color: 'text.primary',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        <Toolbar>
          <Typography variant="h6" sx={{ flexGrow: 0, mr: 4, fontWeight: 800 }}>
            Cloud Saver
          </Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <Tooltip title={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
              <span>
                <IconButton 
                  onClick={toggleMode} 
                  size="small" 
                  color="inherit" 
                  aria-label="toggle color mode"
                  sx={{ border: 1, borderColor: 'divider' }}
                >
                  {mode === 'dark' ? <LightModeIcon fontSize="small" /> : <DarkModeIcon fontSize="small" />}
                </IconButton>
              </span>
            </Tooltip>
            <Tooltip title="Profile">
              <IconButton onClick={handleProfileMenuOpen} size="small" sx={{ p: 0.5 }}>
                <Avatar sx={{ width: 36, height: 36, bgcolor: 'primary.main', color: 'primary.contrastText', fontWeight: 800 }}>
                  {getInitials(user?.name, user?.email)}
                </Avatar>
              </IconButton>
            </Tooltip>
          </Box>
        </Toolbar>
      </AppBar>

      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={handleProfileMenuClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: { sx: { minWidth: 200, mt: 1 } }
        }}
      >
        <Box sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle2" sx={{ color: 'text.primary', fontWeight: 800 }}>
            {user?.name || 'User'}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary' }}>
            {user?.email}
          </Typography>
        </Box>
        <Divider />
        <MenuItem onClick={handleAddOrgOpen} sx={{ gap: 1.25 }}>
          <AddIcon fontSize="small" color="primary" />
          <Typography sx={{ color: 'text.primary' }}>Add Organization</Typography>
        </MenuItem>
        <MenuItem onClick={handleSignOut} sx={{ gap: 1.25 }}>
          <LogoutIcon fontSize="small" />
          <Typography sx={{ color: 'text.primary' }}>Sign Out</Typography>
        </MenuItem>
      </Menu>

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
          <Button onClick={handleAddOrgClose}>Cancel</Button>
          <Button onClick={handleAddOrgSubmit} variant="contained" disabled={!orgName.trim()}>
            Create
          </Button>
        </DialogActions>
      </Dialog>

      <Box component="main" sx={{ flexGrow: 1, p: { xs: 2, sm: 3 }, bgcolor: 'background.default', minHeight: 'calc(100vh - 64px)' }}>
        {children}
      </Box>
    </Box>
  );
}
