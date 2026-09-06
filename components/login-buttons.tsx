'use client';

import { useState } from "react";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

type Provider = "google" | "github";

export function LoginButtons() {
  const [loading, setLoading] = useState<Provider | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function login(provider: Provider) {
    setLoading(provider);
    setError(null);

    const supabase = createSupabaseBrowserClient();
    const { error: signInError } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`
      }
    });

    if (signInError) {
      setError(signInError.message);
      setLoading(null);
    }
  }

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <button
        className="primary"
        disabled={loading !== null}
        onClick={() => login("google")}
      >
        {loading === "google" ? "Connecting…" : "Continue with Google"}
      </button>
      <button
        className="primary"
        disabled={loading !== null}
        onClick={() => login("github")}
      >
        {loading === "github" ? "Connecting…" : "Continue with GitHub"}
      </button>
      {error ? <p className="muted">Sign-in failed: {error}</p> : null}
    </div>
  );
}
