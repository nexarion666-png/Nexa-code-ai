const api = 'https://api.vercel.com';
async function vercelFetch(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${api}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers || {}) }, cache: 'no-store' });
  const text = await response.text();
  if (!response.ok) throw new Error(`Vercel API ${response.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}
export async function getVercelProject(projectId: string, token: string) { return vercelFetch(`/v9/projects/${encodeURIComponent(projectId)}`, token); }
export async function listVercelProjects(token: string) { return vercelFetch('/v9/projects?limit=100', token); }
export async function deployVercelProject(input: { name: string; files: { file: string; data: string }[]; token: string; projectId?: string }) {
  return vercelFetch('/v13/deployments', input.token, { method: 'POST', body: JSON.stringify({ name: input.name, project: input.projectId, files: input.files, target: 'production' }) });
}
