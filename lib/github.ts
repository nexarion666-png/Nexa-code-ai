type GitHubFile = { path: string; content: string };

const api = 'https://api.github.com';

async function githubFetch(
  path: string,
  token: string,
  init: RequestInit = {}
) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status}: ${await response.text()}`
    );
  }

  return response.status === 204 ? null : response.json();
}

export async function getGitHubUser(token: string) {
  return githubFetch('/user', token);
}

export async function listGitHubRepos(token: string) {
  return githubFetch(
    '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator',
    token
  );
}

export async function createGitHubRepo(input: {
  name: string;
  description?: string;
  private?: boolean;
  token: string;
}) {
  const name = input.name.trim();

  if (!name) {
    throw new Error('Repository name is required.');
  }

  return githubFetch('/user/repos', input.token, {
    method: 'POST',
    body: JSON.stringify({
      name,
      description: input.description?.trim() || '',
      private: !!input.private,
      auto_init: false,
    }),
  });
}

export async function getGitHubRepo(
  owner: string,
  repo: string,
  token: string
) {
  const safeOwner = encodeURIComponent(owner);
  const safeRepo = encodeURIComponent(repo);

  return githubFetch(
    `/repos/${safeOwner}/${safeRepo}`,
    token
  );
}

export async function publishRepositoryFiles(input: {
  owner: string;
  repo: string;
  branch?: string;
  files: GitHubFile[];
  message: string;
  token: string;
}) {
  const branch = input.branch?.trim() || 'main';

  if (!input.files.length) {
    throw new Error('The project has no files to publish.');
  }

  const safeOwner = encodeURIComponent(input.owner);
  const safeRepo = encodeURIComponent(input.repo);
  const safeBranch = encodeURIComponent(branch);

  /*
   * A newly-created GitHub repository has no branch/ref yet.
   * First try the normal existing-branch flow.
   */
  let baseSha: string | null = null;
  let baseTreeSha: string | null = null;

  try {
    const ref = await githubFetch(
      `/repos/${safeOwner}/${safeRepo}/git/ref/heads/${safeBranch}`,
      input.token
    );

    baseSha = ref.object.sha;

    const baseCommit = await githubFetch(
      `/repos/${safeOwner}/${safeRepo}/git/commits/${baseSha}`,
      input.token
    );

    baseTreeSha = baseCommit.tree.sha;
  } catch (error) {
    /*
     * 404 means this is probably an empty/new repository.
     * We intentionally continue and create the first commit.
     */
    const message = error instanceof Error ? error.message : '';

    if (!message.includes('GitHub API 404')) {
      throw error;
    }
  }

  const treeEntries: Array<{
    path: string;
    mode: '100644';
    type: 'blob';
    sha: string;
  }> = [];

  for (const file of input.files) {
    const blob = await githubFetch(
      `/repos/${safeOwner}/${safeRepo}/git/blobs`,
      input.token,
      {
        method: 'POST',
        body: JSON.stringify({
          content: file.content,
          encoding: 'utf-8',
        }),
      }
    );

    treeEntries.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      sha: blob.sha,
    });
  }

  const treeBody: {
    tree: typeof treeEntries;
    base_tree?: string;
  } = {
    tree: treeEntries,
  };

  if (baseTreeSha) {
    treeBody.base_tree = baseTreeSha;
  }

  const tree = await githubFetch(
    `/repos/${safeOwner}/${safeRepo}/git/trees`,
    input.token,
    {
      method: 'POST',
      body: JSON.stringify(treeBody),
    }
  );

  const commitBody: {
    message: string;
    tree: string;
    parents?: string[];
  } = {
    message: input.message,
    tree: tree.sha,
  };

  if (baseSha) {
    commitBody.parents = [baseSha];
  }

  const commit = await githubFetch(
    `/repos/${safeOwner}/${safeRepo}/git/commits`,
    input.token,
    {
      method: 'POST',
      body: JSON.stringify(commitBody),
    }
  );

  if (baseSha) {
    await githubFetch(
      `/repos/${safeOwner}/${safeRepo}/git/refs/heads/${safeBranch}`,
      input.token,
      {
        method: 'PATCH',
        body: JSON.stringify({
          sha: commit.sha,
        }),
      }
    );
  } else {
    /*
     * First branch of an empty repository.
     */
    await githubFetch(
      `/repos/${safeOwner}/${safeRepo}/git/refs`,
      input.token,
      {
        method: 'POST',
        body: JSON.stringify({
          ref: `refs/heads/${branch}`,
          sha: commit.sha,
        }),
      }
    );
  }

  return {
    repository: `${input.owner}/${input.repo}`,
    branch,
    commit: commit.sha,
    files: input.files.length,
  };
}
