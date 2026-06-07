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
import Card from '@mui/material/Card';
import CardContent from '@mui/material/CardContent';
import Stack from '@mui/material/Stack';
import CircularProgress from '@mui/material/CircularProgress';
import AddIcon from '@mui/icons-material/Add';
import LogoutIcon from '@mui/icons-material/Logout';
import DarkModeIcon from '@mui/icons-material/DarkMode';
import LightModeIcon from '@mui/icons-material/LightMode';
import ChatIcon from '@mui/icons-material/Chat';
import CloseIcon from '@mui/icons-material/Close';
import SendIcon from '@mui/icons-material/Send';
import { useColorScheme } from '@mui/material/styles';
import { authClient } from "../app/lib/auth-client";

interface DashboardLayoutProps {
  children: React.ReactNode;
}

interface AgentMessage {
  role: "user" | "assistant";
  content: string;
}

export default function DashboardLayout({ children }: DashboardLayoutProps) {
  const [anchorEl, setAnchorEl] = React.useState<null | HTMLElement>(null);
  const [addOrgOpen, setAddOrgOpen] = React.useState(false);
  const [orgName, setOrgName] = React.useState('');
  const [user, setUser] = React.useState<{ name?: string; email?: string; image?: string | null } | null>(null);
  const [assistantOpen, setAssistantOpen] = React.useState(false);
  const [chatSessionId, setChatSessionId] = React.useState<string | null>(null);
  const [agentMessages, setAgentMessages] = React.useState<AgentMessage[]>([
    { role: "assistant", content: "I can help across all organizations and accounts. Ask about cost, recommendations, metrics, or action plans." },
  ]);
  const [chatInput, setChatInput] = React.useState('');
  const [chatting, setChatting] = React.useState(false);
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

  React.useEffect(() => {
    let active = true;
    fetch('/api/chat')
      .then((response) => response.ok ? response.json() : null)
      .then((data: { sessionId: string | null; messages: AgentMessage[] } | null) => {
        if (!active || !data) return;
        if (data.sessionId) setChatSessionId(data.sessionId);
        if (data.messages.length > 0) setAgentMessages(data.messages);
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
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

  const handleGlobalChatSubmit = async () => {
    const content = chatInput.trim();
    if (!content) return;

    const nextMessages: AgentMessage[] = [...agentMessages, { role: "user", content }];
    setAgentMessages(nextMessages);
    setChatInput('');
    setChatting(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: chatSessionId, messages: nextMessages }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.message || 'Assistant failed');
      }
      setChatSessionId(data.sessionId);
      setAgentMessages((current) => [...current, { role: "assistant", content: data.message }]);
    } catch (error) {
      setAgentMessages((current) => [
        ...current,
        { role: "assistant", content: error instanceof Error ? error.message : "Assistant failed" },
      ]);
    } finally {
      setChatting(false);
    }
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

      {assistantOpen && (
        <Card
          sx={{
            position: 'fixed',
            right: { xs: 12, sm: 24 },
            bottom: { xs: 84, sm: 96 },
            width: { xs: 'calc(100vw - 24px)', sm: 420 },
            maxHeight: 'min(680px, calc(100vh - 128px))',
            zIndex: 1300,
            border: 1,
            borderColor: 'divider',
            boxShadow: 10,
          }}
        >
          <CardContent sx={{ p: 0, display: 'flex', flexDirection: 'column', maxHeight: 'inherit' }}>
            <Box sx={{ px: 2, py: 1.5, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'center', gap: 1 }}>
              <ChatIcon color="primary" />
              <Box sx={{ flexGrow: 1 }}>
                <Typography sx={{ fontWeight: 900 }}>Cloud Saver assistant</Typography>
                <Typography variant="caption" color="text.secondary">Global across all orgs and accounts</Typography>
              </Box>
              <IconButton size="small" onClick={() => setAssistantOpen(false)} aria-label="close assistant">
                <CloseIcon fontSize="small" />
              </IconButton>
            </Box>

            <Stack spacing={1.25} sx={{ p: 2, overflow: 'auto', flexGrow: 1 }}>
              {agentMessages.map((message, index) => (
                <Box
                  key={`${message.role}-${index}`}
                  sx={{
                    alignSelf: message.role === 'user' ? 'flex-end' : 'flex-start',
                    maxWidth: '88%',
                    px: 1.5,
                    py: 1,
                    borderRadius: 1,
                    bgcolor: message.role === 'user' ? 'primary.main' : 'action.hover',
                    color: message.role === 'user' ? 'primary.contrastText' : 'text.primary',
                  }}
                >
                  <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
                    {message.content}
                  </Typography>
                </Box>
              ))}
            </Stack>

            <Box sx={{ p: 1.5, borderTop: 1, borderColor: 'divider', display: 'flex', gap: 1 }}>
              <TextField
                value={chatInput}
                onChange={(event) => setChatInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    handleGlobalChatSubmit();
                  }
                }}
                placeholder="Ask about your cloud estate"
                fullWidth
                size="small"
              />
              <Button
                variant="contained"
                onClick={handleGlobalChatSubmit}
                disabled={chatting || !chatInput.trim()}
                startIcon={chatting ? <CircularProgress color="inherit" size={16} /> : <SendIcon />}
              >
                Send
              </Button>
            </Box>
          </CardContent>
        </Card>
      )}

      <Button
        variant="contained"
        startIcon={<ChatIcon />}
        onClick={() => setAssistantOpen((current) => !current)}
        sx={{
          position: 'fixed',
          right: { xs: 12, sm: 24 },
          bottom: { xs: 16, sm: 24 },
          zIndex: 1301,
          boxShadow: 8,
          minHeight: 48,
        }}
      >
        Assistant
      </Button>
    </Box>
  );
}
