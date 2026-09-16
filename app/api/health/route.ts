import { NextResponse } from 'next/server';

export async function GET() {
  const checks = {
    supabase: Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY),
    encryption: Boolean(process.env.PROVIDER_KEY_ENCRYPTION_SECRET && process.env.PROVIDER_KEY_ENCRYPTION_SECRET.length >= 32),
    ai: Boolean(process.env.GOOGLE_AI_API_KEYS || process.env.GROQ_API_KEYS || process.env.OPENROUTER_API_KEYS || process.env.HUGGINGFACE_API_KEYS),
    github: Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET),
    vercel: Boolean(process.env.VERCEL_TOKEN),
  };
  const ready = checks.supabase && checks.encryption && checks.ai;
  return NextResponse.json({ status: ready ? 'ok' : 'configuration_required', checks }, { status: ready ? 200 : 503, headers: { 'Cache-Control': 'no-store' } });
}
