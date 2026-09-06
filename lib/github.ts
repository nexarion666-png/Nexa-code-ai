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
    const errorMessage =
      error instanceof Error ? error.message : '';

    const isEmptyRepository =
      errorMessage.includes('GitHub API 409') &&
      errorMessage.includes('Git Repository is empty');

    const isMissingBranch =
      errorMessage.includes('GitHub API 404');

    if (!isEmptyRepository && !isMissingBranch) {
      throw error;
    }

    /*
     * GitHub does not allow the raw Git database API to create
     * blobs/trees in a completely empty repository.
     *
     * Initialize the repository through the Contents API using
     * the first real project file.
     */
    const initializer = input.files.find(
      (file) => !file.path.startsWith('.github/workflows/')
    );

    if (!initializer) {
      throw new Error(
        'The repository is empty and the project only contains GitHub Actions workflow files.'
      );
    }

    const safeInitializerPath = initializer.path
      .split('/')
      .map(encodeURIComponent)
      .join('/');

    const initialized = await githubFetch(
      `/repos/${safeOwner}/${safeRepo}/contents/${safeInitializerPath}`,
      input.token,
      {
        method: 'PUT',
        body: JSON.stringify({
          message:
            input.message ||
            'Initialize repository from Nexa Code AI',
          content: Buffer.from(
            initializer.content,
            'utf8'
          ).toString('base64'),
        }),
      }
    );

    const initialCommitSha = initialized?.commit?.sha;

    if (!initialCommitSha) {
      throw new Error(
        'GitHub initialized the repository but did not return the initial commit SHA.'
      );
    }

    /*
     * If Nexa requested a non-default branch, create it
     * from the initial commit.
     */
    if (branch !== 'main') {
      let requestedBranchExists = true;

      try {
        await githubFetch(
          `/repos/${safeOwner}/${safeRepo}/git/ref/heads/${safeBranch}`,
          input.token
        );
      } catch (branchError) {
        const branchMessage =
          branchError instanceof Error
            ? branchError.message
            : '';

        if (branchMessage.includes('GitHub API 404')) {
          requestedBranchExists = false;
        } else {
          throw branchError;
        }
      }

      if (!requestedBranchExists) {
        await githubFetch(
          `/repos/${safeOwner}/${safeRepo}/git/refs`,
          input.token,
          {
            method: 'POST',
            body: JSON.stringify({
              ref: `refs/heads/${branch}`,
              sha: initialCommitSha,
            }),
          }
        );
      }
    }

    /*
     * The repository now has a real Git commit.
     */
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

  return {
    repository: `${input.owner}/${input.repo}`,
    branch,
    commit: commit.sha,
    files: input.files.length,
  };
}
