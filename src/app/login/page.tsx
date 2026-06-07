"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
} from "@mui/material";
import { Visibility, VisibilityOff } from "@mui/icons-material";
import { AuthPageFrame } from "../components/auth-page-frame";
import { authClient } from "../lib/auth-client";

interface LoginFormData {
  email: string;
  password: string;
  rememberMe: boolean;
}

const callbackURL = "/dashboard";

export default function LoginPage() {
  const router = useRouter();
  const [formData, setFormData] = useState<LoginFormData>({
    email: "",
    password: "",
    rememberMe: true,
  });
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);

    const { error } = await authClient.signIn.email(
      {
        email: formData.email,
        password: formData.password,
        rememberMe: formData.rememberMe,
        callbackURL,
      },
      {
        onError: (ctx) => {
          setErrorMessage(ctx.error.message);
        },
      },
    );

    if (error) {
      setErrorMessage(error.message || "Could not log in.");
      setIsSubmitting(false);
      return;
    }

    router.push(callbackURL);
    router.refresh();
  }

  return (
    <AuthPageFrame
      eyebrow="Cloud Saver"
      footerHref="/signup"
      footerLinkLabel="Create one"
      footerText="Need an account?"
      subtitle="Welcome back. Log in to continue managing your saved files."
      title="Log in"
    >
      <Stack component="form" spacing={2.5} onSubmit={handleSubmit}>
        <TextField
          label="Email"
          type="email"
          value={formData.email}
          onChange={(event) =>
            setFormData((current) => ({
              ...current,
              email: event.target.value,
            }))
          }
          autoComplete="email"
          required
          fullWidth
        />

        <TextField
          label="Password"
          type={showPassword ? "text" : "password"}
          value={formData.password}
          onChange={(event) =>
            setFormData((current) => ({
              ...current,
              password: event.target.value,
            }))
          }
          autoComplete="current-password"
          required
          fullWidth
          slotProps={{
            input: {
              endAdornment: (
                <InputAdornment position="end">
                  <IconButton
                    aria-label={showPassword ? "Hide password" : "Show password"}
                    edge="end"
                    onClick={() => setShowPassword((current) => !current)}
                  >
                    {showPassword ? <VisibilityOff /> : <Visibility />}
                  </IconButton>
                </InputAdornment>
              ),
            },
          }}
        />

        <FormControlLabel
          control={
            <Checkbox
              checked={formData.rememberMe}
              onChange={(event) =>
                setFormData((current) => ({
                  ...current,
                  rememberMe: event.target.checked,
                }))
              }
            />
          }
          label="Remember me"
        />

        {errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}

        <Button
          type="submit"
          variant="contained"
          size="large"
          disabled={isSubmitting}
          startIcon={isSubmitting ? <CircularProgress color="inherit" size={18} /> : undefined}
          sx={{ py: 1.3 }}
        >
          {isSubmitting ? "Logging in..." : "Log in"}
        </Button>
      </Stack>
    </AuthPageFrame>
  );
}
