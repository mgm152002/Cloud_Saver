"use client";
import * as React from "react";
import { ThemeProvider, extendTheme } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";

const theme = extendTheme({
  colorSchemeSelector: "data",
  colorSchemes: {
    light: {
      palette: {
        primary: {
          main: "#2563eb",
        },
        background: {
          default: "#f4f7fb",
          paper: "#ffffff",
        },
      },
    },
    dark: {
      palette: {
        primary: {
          main: "#7dd3fc",
        },
        background: {
          default: "#101418",
          paper: "#18212b",
        },
      },
    },
  },
  shape: {
    borderRadius: 8,
  },
  typography: {
    fontFamily: "var(--font-geist-sans), Arial, Helvetica, sans-serif",
  },
  components: {
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: "none",
          fontWeight: 700,
        },
      },
    },
    MuiCard: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
  },
});

export default function ThemeRegistry({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
