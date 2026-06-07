"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Alert,
  Button,
  CircularProgress,
  IconButton,
  InputAdornment,
  Stack,
  TextField,
} from "@mui/material";
import { Visibility, VisibilityOff } from "@mui/icons-material";
import { AuthPageFrame } from "../components/auth-page-frame";
import { authClient } from "../lib/auth-client";

interface SignUpFormData {
  email: string;
  image: string;
  name: string;
  password: string;
}

const callbackURL = "/dashboard";

export default function SignUpPage() {
  const router = useRouter();
  const [formData, setFormData] = useState<SignUpFormData>({
    email: "",
    image: "",
    name: "",
    password: "",
  });
  const [errorMessage, setErrorMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");
    setIsSubmitting(true);

    const { error } = await authClient.signUp.email(
      {
        email: formData.email,
        image: formData.image || undefined,
        name: formData.name,
        password: formData.password,
        callbackURL,
      },
      {
        onError: (ctx) => {
          setErrorMessage(ctx.error.message);
        },
      },
    );

    if (error) {
      setErrorMessage(error.message || "Could not create your account.");
      setIsSubmitting(false);
      return;
    }

    router.push(callbackURL);
    router.refresh();
  }

  return (
    <AuthPageFrame
      eyebrow="Cloud Saver"
      footerHref="/login"
      footerLinkLabel="Log in"
      footerText="Already have an account?"
      subtitle="Create your account and keep your saved cloud files organized."
      title="Create account"
    >
      <Stack component="form" spacing={2.5} onSubmit={handleSubmit}>
        <TextField
          label="Name"
          value={formData.name}
          onChange={(event) =>
            setFormData((current) => ({
              ...current,
              name: event.target.value,
            }))
          }
          autoComplete="name"
          required
          fullWidth
        />

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
          autoComplete="new-password"
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

        <TextField
          label="Profile image URL"
          type="url"
          value={formData.image}
          onChange={(event) =>
            setFormData((current) => ({
              ...current,
              image: event.target.value,
            }))
          }
          autoComplete="url"
          fullWidth
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
          {isSubmitting ? "Creating account..." : "Sign up"}
        </Button>
      </Stack>
    </AuthPageFrame>
  );
}
