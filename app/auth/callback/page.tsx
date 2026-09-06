'use client';

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function finishAuth() {
      const url = new URL(window.location.href);
      const code = url.searchParams.get("code");
      const providerError = url.searchParams.get("error_description") || url.searchParams.get("error");

      if (providerError) {
        if (!cancelled) setError(providerError);
        return;
      }

      if (!code) {
        if (!cancelled) setError("No OAuth authorization code was returned.");
        return;
      }

      try {
        const supabase = createSupabaseBrowserClient();
        const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);

        if (exchangeError) {
          if (!cancelled) setError(exchangeError.message);
          return;
        }

        if (!cancelled) router.replace("/");
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : "Could not complete sign-in.");
        }
      }
    }

    void finishAuth();
    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: 24 }}>
      <section className="card" style={{ width: "min(520px,100%)" }}>
        <h1>Nexa Code AI</h1>
        {error ? (
          <>
            <p>Google sign-in could not be completed.</p>
            <p className="muted">{error}</p>
            <button className="primary" onClick={() => router.replace("/login")}>Back to login</button>
          </>
        ) : (
          <p className="muted">Finishing secure sign-in…</p>
        )}
      </section>
    </main>
  );
}
