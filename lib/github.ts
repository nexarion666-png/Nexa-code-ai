type GitHubFile = { path: string; content: string };
const api = 'https://api.github.com';

async function githubFetch(path: string, token: string, init: RequestInit = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'content-type': 'application/json',
      ...(init.headers || {})
    },
    cache: 'no-store'
  });
  if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  return response.status === 204 ? null : response.json();
}

export async function getGitHubUser(token: string) { return githubFetch('/user', token); }
export async function listGitHubRepos(token: string) {
  return githubFetch('/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator', token);
}

export async function publishRepositoryFiles(input: { owner: string; repo: string; branch?: string; files: GitHubFile[]; message: string; token: string }) {
  const branch = input.branch || 'main';
  const safeOwner = encodeURIComponent(input.owner), safeRepo = encodeURIComponent(input.repo), safeBranch = encodeURIComponent(branch);
  const ref = await githubFetch(`/repos/${safeOwner}/${safeRepo}/git/ref/heads/${safeBranch}`, input.token);
  const baseSha = ref.object.sha;
  const baseCommit = await githubFetch(`/repos/${safeOwner}/${safeRepo}/git/commits/${baseSha}`, input.token);
  const treeEntries = [];
  for (const file of input.files) {
    const blob = await githubFetch(`/repos/${safeOwner}/${safeRepo}/git/blobs`, input.token, { method: 'POST', body: JSON.stringify({ content: file.content, encoding: 'utf-8' }) });
    treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = await githubFetch(`/repos/${safeOwner}/${safeRepo}/git/trees`, input.token, { method: 'POST', body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree: treeEntries }) });
  const commit = await githubFetch(`/repos/${safeOwner}/${safeRepo}/git/commits`, input.token, { method: 'POST', body: JSON.stringify({ message: input.message, tree: tree.sha, parents: [baseSha] }) });
  await githubFetch(`/repos/${safeOwner}/${safeRepo}/git/refs/heads/${safeBranch}`, input.token, { method: 'PATCH', body: JSON.stringify({ sha: commit.sha }) });
  return { repository: `${input.owner}/${input.repo}`, branch, commit: commit.sha, files: input.files.length };
}
