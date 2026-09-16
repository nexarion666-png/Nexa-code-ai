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

  return (
    <div className="diff-list">
      {run?.summary && (
        <div className="muted" style={{ marginBottom: 12 }}>
          {run.summary}
        </div>
      )}

      {run?.status === 'pending' && (
        <div style={{ marginBottom: 12 }}>
          <button
            type="button"
            onClick={approve}
            disabled={busy}
          >
            {busy ? 'Implementing...' : '✓ Approve & Implement'}
          </button>
          <button
            type="button"
            onClick={reject}
            disabled={busy}
            style={{ marginLeft: 8 }}
          >
            {busy ? 'Working...' : '✕ Reject Proposal'}
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
        actions.map((a) => (
          <details key={a.id} className="diff-item">
            <summary>
              <span>{a.action_type.replace('_', ' ')}</span>{' '}
              {a.path || 'memory'}{' '}
              <small>step {a.iteration}</small>
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
        ))
      )}
    </div>
  );
}
