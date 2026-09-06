'use client';

import { useEffect, useState } from 'react';

type Repo = {
  full_name: string;
  name: string;
  default_branch: string;
  private: boolean;
  html_url?: string;
};

export function IntegrationsPanel({
  projectId,
  onNotice,
}: {
  projectId?: string;
  onNotice: (s: string) => void;
}) {
  const [connected, setConnected] = useState(false);
  const [login, setLogin] = useState('');
  const [repos, setRepos] = useState<Repo[]>([]);
  const [repo, setRepo] = useState('');
  const [branch, setBranch] = useState('main');

  const [repoName, setRepoName] = useState('');
  const [repoDescription, setRepoDescription] = useState('');
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [creatingRepo, setCreatingRepo] = useState(false);

  const [deploying, setDeploying] = useState(false);
  const [vercel, setVercel] = useState(false);

  async function load() {
    const r = await fetch('/api/github/repos');

    if (r.ok) {
      const d = await r.json();

      setConnected(!!d.connected);
      setLogin(d.login || '');
      setRepos(d.repositories || []);

      if (!repo && d.repositories?.[0]) {
        setRepo(d.repositories[0].full_name);
        setBranch(d.repositories[0].default_branch || 'main');
      }
    } else {
      setConnected(false);
      setRepos([]);
    }

    const v = await fetch('/api/vercel/projects');

    if (v.ok) {
      setVercel(!!(await v.json()).configured);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function createRepo() {
    if (!projectId || !repoName.trim() || creatingRepo) return;

    setCreatingRepo(true);

    try {
      const r = await fetch('/api/github/create-repo', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          projectId,
          name: repoName.trim(),
          description: repoDescription.trim(),
          private: repoPrivate,
        }),
      });

      const d = await r.json();

      if (!r.ok) {
        onNotice(d.error || 'Could not create GitHub repository.');
        return;
      }

      const created = d.repository;

      setRepo(created.full_name);
      setBranch(created.default_branch || 'main');
      setRepoName('');
      setRepoDescription('');

      await load();

      setRepo(created.full_name);
      setBranch(created.default_branch || 'main');

      onNotice(
        `Created and linked ${created.full_name}.`
      );
    } catch {
      onNotice('Could not create GitHub repository.');
    } finally {
      setCreatingRepo(false);
    }
  }

  async function publish() {
    if (!projectId || !repo) return;

    const r = await fetch('/api/github/publish', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        projectId,
        repo,
        branch,
        message: 'Update from Nexa Code AI',
      }),
    });

    const d = await r.json();

    onNotice(
      r.ok
        ? `Published ${d.result.files} file(s) to ${d.result.repository}. Commit ${d.result.commit.slice(0, 7)}.`
        : d.error || 'GitHub publish failed.'
    );
  }

  async function deploy() {
    if (!projectId) return;

    setDeploying(true);

    const r = await fetch('/api/vercel/deploy', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({ projectId }),
    });

    const d = await r.json();

    setDeploying(false);

    onNotice(
      r.ok
        ? `Vercel deployment created${d.deployment?.url ? `: ${d.deployment.url}` : ''}.`
        : d.error || 'Vercel deployment failed.'
    );
  }

  return (
    <div className="integration-panel">
      {!connected ? (
        <button
          className="primary full"
          onClick={() => {
            location.href = '/api/github/connect';
          }}
        >
          Connect GitHub
        </button>
      ) : (
        <>
          <div className="muted">
            GitHub connected as <strong>{login}</strong>
          </div>

          <div className="integration-section">
            <strong>Create GitHub Repository</strong>

            <input
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder="Repository name"
              disabled={creatingRepo}
            />

            <input
              value={repoDescription}
              onChange={(e) => setRepoDescription(e.target.value)}
              placeholder="Description (optional)"
              disabled={creatingRepo}
            />

            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={repoPrivate}
                onChange={(e) => setRepoPrivate(e.target.checked)}
                disabled={creatingRepo}
              />
              Private repository
            </label>

            <button
              className="primary full"
              onClick={createRepo}
              disabled={
                !projectId ||
                !repoName.trim() ||
                creatingRepo
              }
            >
              {creatingRepo
                ? 'Creating repository…'
                : 'Create & Link Repository'}
            </button>
          </div>

          <div className="integration-section">
            <strong>Linked Repository</strong>

            <select
              value={repo}
              onChange={(e) => {
                setRepo(e.target.value);

                const selectedRepo = repos.find(
                  (item) => item.full_name === e.target.value
                );

                setBranch(
                  selectedRepo?.default_branch || 'main'
                );
              }}
            >
              <option value="">
                Select a repository
              </option>

              {repos.map((r) => (
                <option
                  key={r.full_name}
                  value={r.full_name}
                >
                  {r.full_name}
                  {r.private ? ' · private' : ''}
                </option>
              ))}
            </select>

            <input
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              placeholder="Branch"
            />

            <div className="integration-actions">
              <button
                onClick={publish}
                disabled={!projectId || !repo}
              >
                Push Files
              </button>

              <button
                onClick={load}
              >
                Refresh
              </button>

              <button
                onClick={() => {
                  location.href = '/api/github/connect';
                }}
              >
                Reconnect
              </button>
            </div>
          </div>

          <button
            className="primary full"
            onClick={deploy}
            disabled={
              !projectId ||
              deploying ||
              !vercel
            }
          >
            {deploying
              ? 'Deploying…'
              : 'Deploy to Vercel'}
          </button>

          {!vercel && (
            <div className="muted">
              Set VERCEL_TOKEN on the server to enable deployments.
            </div>
          )}

          <button
            className="danger full"
            onClick={async () => {
              const r = await fetch(
                '/api/github/disconnect',
                { method: 'POST' }
              );

              if (r.ok) {
                setConnected(false);
                setRepos([]);
                setRepo('');
                onNotice('GitHub disconnected.');
              } else {
                onNotice('Could not disconnect GitHub.');
              }
            }}
          >
            Disconnect GitHub
          </button>
        </>
      )}
    </div>
  );
}
