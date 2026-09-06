import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const providerError =
    requestUrl.searchParams.get("error_description") ||
    requestUrl.searchParams.get("error");

  if (providerError) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(providerError)}`, requestUrl.origin)
    );
  }

  if (!code) {
    return NextResponse.redirect(
      new URL("/login?error=No%20OAuth%20authorization%20code%20was%20returned.", requestUrl.origin)
    );
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(
      new URL(`/login?error=${encodeURIComponent(error.message)}`, requestUrl.origin)
    );
  }

  return NextResponse.redirect(new URL("/", requestUrl.origin));
}
