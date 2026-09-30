import { decryptApiKey, encryptApiKey } from '@/lib/ai/crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

const API = 'https://api.github.com';

export function githubHeaders(token: string) {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    'User-Agent': 'Nexa-Code-AI'
  };
}

export async function githubRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, { ...init, headers: { ...githubHeaders(token), ...(init.headers ?? {}) }, cache: 'no-store' });
  const text = await response.text();
  let body: unknown = {};
  try { body = text ? JSON.parse(text) : {}; } catch { body = { message: text }; }
  if (!response.ok) {
    const message = typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : `GitHub request failed (${response.status}).`;
    const error = new Error(message) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return body as T;
}

export async function getGitHubToken(supabase: SupabaseClient, userId: string) {
  const { data, error } = await supabase.from('user_github_tokens').select('access_token,username').eq('user_id', userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!data?.access_token) return null;
  return { token: decryptApiKey(data.access_token), username: data.username ?? '' };
}

export async function saveGitHubToken(supabase: SupabaseClient, userId: string, token: string, username: string) {
  const encrypted = encryptApiKey(token);
  const { error } = await supabase.from('user_github_tokens').upsert({ user_id: userId, access_token: encrypted, username }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

export function parseGithubUrl(value: string) {
  const url = new URL(value.trim());
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') throw new Error('Enter a valid https://github.com/owner/repository URL.');
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) throw new Error('GitHub URL must include owner and repository.');
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
}

export function encodeContent(content: string) {
  return Buffer.from(content, 'utf8').toString('base64');
}
