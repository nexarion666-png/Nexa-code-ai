import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/supabase/auth';

const MAX_BODY_BYTES = 1_500_000;

export async function guardRequest(req: Request, bucket: string, limit = 30) {
  const origin = req.headers.get('origin');
  const host = req.headers.get('host');
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.protocol !== new URL(req.url).protocol || originUrl.host !== host) {
        return NextResponse.json({ error: 'Cross-origin request rejected.' }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: 'Invalid request origin.' }, { status: 403 });
    }
  }
  const contentLength = Number(req.headers.get('content-length') ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Request body is too large.' }, { status: 413 });
  }
  const { supabase, user } = await requireUser();
  const { data, error } = await supabase.rpc('consume_rate_limit', {
    p_bucket: bucket,
    p_limit: limit,
    p_window_seconds: 60,
  });
  if (error) throw error;
  if (data === false) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Please wait a moment and try again.' },
      { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } },
    );
  }
  return { supabase, user };
}

export async function readJson(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) throw new Error('Request body is too large.');
  if (!raw.trim()) return {};
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object body is required.');
  return value as Record<string, unknown>;
}

export function validateRelativePath(path: unknown) {
  if (typeof path !== 'string') throw new Error('File path is required.');
  const value = path.trim().replaceAll('\\', '/');
  if (!value || value.startsWith('/') || value.includes('\0') || value.split('/').includes('..')) {
    throw new Error('Invalid relative file path.');
  }
  if (value.length > 300) throw new Error('File path is too long.');
  return value;
}
