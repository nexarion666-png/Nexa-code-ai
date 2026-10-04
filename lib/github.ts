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
    let message = typeof body === 'object' && body && 'message' in body ? String((body as { message: unknown }).message) : `GitHub request failed (${response.status}).`;
    const details = typeof body === 'object' && body && Array.isArray((body as { errors?: unknown }).errors)
      ? ((body as { errors: unknown[] }).errors).map(item => typeof item === 'string' ? item : String((item as { message?: unknown })?.message ?? '')).filter(Boolean).join('; ')
      : '';
    if (details) message += ` (${details})`;
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Writes all files to a branch as ONE commit using the Git Data API (a handful of requests),
// instead of one request and one commit per file.
export async function commitFiles(token: string, fullName: string, branch: string, files: { path: string; content: string | null }[], message: string) {
  const refPath = branch.split('/').map(encodeURIComponent).join('/');
  let headSha = '';
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const head = await githubRequest<{ object: { sha: string } }>(token, `/repos/${fullName}/git/ref/heads/${refPath}`);
      headSha = head.object.sha;
      break;
    } catch (error) {
      const status = (error as { status?: number }).status;
      if ((status !== 404 && status !== 409) || attempt === 5) throw error;
      await sleep(600); // a brand-new repo can take a moment to expose its first commit
    }
  }
  const headCommit = await githubRequest<{ tree: { sha: string } }>(token, `/repos/${fullName}/git/commits/${headSha}`);
  const entries: { path: string; mode: string; type: string; sha?: string; content?: string }[] = [];
  for (const file of files) {
    const path = file.path.replace(/^\/+/, '');
    if (!path || path.includes('..')) continue;
    const content = file.content ?? '';
    if (content === '') {
      const blob = await githubRequest<{ sha: string }>(token, `/repos/${fullName}/git/blobs`, { method: 'POST', body: JSON.stringify({ content: '', encoding: 'utf-8' }) });
      entries.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
    } else {
      entries.push({ path, mode: '100644', type: 'blob', content });
    }
  }
  if (!entries.length) return { changed: false };
  const tree = await githubRequest<{ sha: string }>(token, `/repos/${fullName}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: headCommit.tree.sha, tree: entries }) });
  if (tree.sha === headCommit.tree.sha) return { changed: false };
  const commit = await githubRequest<{ sha: string }>(token, `/repos/${fullName}/git/commits`, { method: 'POST', body: JSON.stringify({ message, tree: tree.sha, parents: [headSha] }) });
  await githubRequest(token, `/repos/${fullName}/git/refs/heads/${refPath}`, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  return { changed: true };
}
