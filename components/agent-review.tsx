'use client';

import { useEffect, useState } from 'react';

type Action = {
  id: string;
  iteration: number;
  action_type: string;
  path: string | null;
  before_content: string | null;
  after_content: string | null;
};

type Run = {
  id: string;
  status: string;
  summary: string | null;
};

export function AgentReview({ runId, onApproved }: { runId?: string; onApproved?: () => void }) {
  const [actions, setActions] = useState<Action[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    if (!runId) return;

    setNotice('');

    fetch(`/api/agent/runs/${runId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setRun(d?.run ?? null);
        setActions(d?.actions ?? []);
      });
  }, [runId]);

  async function reject() {
    if (!runId || busy) return;

    setBusy(true);
    setNotice('');

    try {
      const response = await fetch(
        `/api/agent/runs/${runId}/reject`,
        { method: 'POST' }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || 'Rejection failed.');
      }

      setRun((current) =>
        current
          ? {
              ...current,
              status: 'rejected',
              summary: data.summary ?? current.summary,
            }
          : current
      );

      setNotice('Proposal rejected. No project files were changed.');
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Could not reject the proposal.'
      );
    } finally {
      setBusy(false);
    }
  }

  async function approve() {
    if (!runId || busy) return;

    setBusy(true);
    setNotice('');

    try {
      const response = await fetch(
        `/api/agent/runs/${runId}/approve`,
        { method: 'POST' }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data?.error || 'Approval failed.');
      }

      setRun((current) =>
        current
          ? {
              ...current,
              status: 'completed',
              summary: data.summary ?? current.summary,
            }
          : current
      );

      setNotice('Approved and implemented successfully.');
      onApproved?.();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : 'Could not approve the proposal.'
      );
    } finally {
      setBusy(false);
    }
  }

  if (!runId) {
    return <div className="muted">No agent run selected.</div>;
  }

  const fileColor = (path: string | null) => {
    const ext = (path || '').split('.').pop()?.toLowerCase() || '';
    const map: Record<string, string> = { ts: '#4f7dff', tsx: '#4f7dff', js: '#f2c94c', jsx: '#f2c94c', json: '#8a93a8', css: '#9b5cff', md: '#8a93a8', html: '#ff7a59', sql: '#3ecf8e', env: '#ff6b7d' };
    return map[ext] || '#6b7488';
  };

  return (
    <div className="diff-list">
      {actions.length > 0 && (
        <div className="review-header">
          <span>Changes ready for review</span>
          <span className="muted">{actions.length} file{actions.length === 1 ? '' : 's'} changed</span>
        </div>
      )}

      {run?.summary && (
        <div className="muted" style={{ marginBottom: 12 }}>
          {run.summary}
        </div>
      )}

      {run?.status === 'pending' && (
        <div className="review-actions" style={{ marginBottom: 12 }}>
          <button
            type="button"
            className="primary"
            onClick={approve}
            disabled={busy}
          >
            {busy ? 'Implementing…' : 'Apply changes'}
          </button>
          <button
            type="button"
            className="review-reject"
            onClick={reject}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Reject proposal'}
          </button>
        </div>
      )}

      {notice && (
        <div className="muted" style={{ marginBottom: 12 }}>
          {notice}
        </div>
      )}

      {actions.length === 0 ? (
        <div className="muted">No file changes in this proposal.</div>
      ) : (
        actions.map((a) => {
          const beforeLines = (a.before_content ?? '').split('\n').length;
          const afterLines = (a.after_content ?? '').split('\n').length;
          const delta = a.path ? afterLines - beforeLines : 0;

          return (
            <details key={a.id} className="diff-item">
              <summary>
                <span className="diff-item-name">
                  <span className="file-dot" style={{ background: fileColor(a.path) }} aria-hidden="true"></span>
                  <span>{a.action_type.replace('_', ' ')}</span>{' '}
                  {a.path || 'memory'}
                </span>
                <span className="diff-item-meta">
                  {a.path && (
                    <span className={`diff-delta ${delta >= 0 ? 'add' : 'remove'}`}>
                      {delta >= 0 ? `+${delta}` : delta}
                    </span>
                  )}
                  <small>step {a.iteration}</small>
                </span>
              </summary>

              {a.path && (
                <div className="diff">
                  <pre className="diff-old">
                    {a.before_content ?? '(new file)'}
                  </pre>
                  <pre className="diff-new">
                    {a.after_content ?? '(deleted)'}
                  </pre>
                </div>
              )}
            </details>
          );
        })
      )}
    </div>
  );
}
