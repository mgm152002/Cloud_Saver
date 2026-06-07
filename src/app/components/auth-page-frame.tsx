"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import {
  Box,
  Container,
  Divider,
  Paper,
  Stack,
  Typography,
} from "@mui/material";

interface AuthPageFrameProps {
  children: ReactNode;
  eyebrow: string;
  footerHref: string;
  footerLinkLabel: string;
  footerText: string;
  subtitle: string;
  title: string;
}

export function AuthPageFrame({
  children,
  eyebrow,
  footerHref,
  footerLinkLabel,
  footerText,
  subtitle,
  title,
}: AuthPageFrameProps) {
  return (
    <Box
      component="main"
      sx={{
        minHeight: "100vh",
        bgcolor: "background.default",
        color: "text.primary",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        px: 2,
        py: { xs: 5, sm: 8 },
      }}
    >
      <Container maxWidth="sm" disableGutters>
        <Paper
          elevation={3}
          sx={{
            border: "1px solid",
            borderColor: "divider",
            borderRadius: 2,
            overflow: "hidden",
            bgcolor: "background.paper",
            width: "100%",
          }}
        >
          <Box
            sx={{
              bgcolor: "primary.main",
              color: "primary.contrastText",
              px: { xs: 3, sm: 5 },
              py: { xs: 4, sm: 5 },
            }}
          >
            <Typography
              component="p"
              sx={{
                color: "primary.contrastText",
                fontSize: 13,
                fontWeight: 700,
                mb: 1.5,
                opacity: 0.78,
                textTransform: "uppercase",
              }}
            >
              {eyebrow}
            </Typography>
            <Typography component="h1" variant="h4" sx={{ fontWeight: 700 }}>
              {title}
            </Typography>
            <Typography sx={{ color: "primary.contrastText", mt: 1.5, opacity: 0.86 }}>
              {subtitle}
            </Typography>
          </Box>

          <Stack spacing={3} sx={{ bgcolor: "background.paper", p: { xs: 3, sm: 5 } }}>
            {children}

            <Divider />

            <Typography color="text.secondary" sx={{ textAlign: "center" }}>
              {footerText}{" "}
              <Link
                href={footerHref}
                style={{
                  fontWeight: 700,
                  textDecoration: "none",
                }}
                className="auth-footer-link"
              >
                {footerLinkLabel}
              </Link>
            </Typography>
          </Stack>
        </Paper>
      </Container>
    </Box>
  );
}
