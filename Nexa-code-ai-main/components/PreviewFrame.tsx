'use client';

import { ExternalLink, Loader2, RefreshCw } from 'lucide-react';
import { useCallback, useState } from 'react';

export function PreviewFrame({ projectId }: { projectId: string }) {
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    setVersion((value) => value + 1);
  }, []);

  const previewUrl = `/api/preview/${encodeURIComponent(projectId)}?v=${version}`;

  return (
    <div className="overflow-hidden rounded-3xl border border-zinc-800 bg-[#0a0a0a]">
      <div className="flex items-center gap-2 border-b border-zinc-800 bg-[#121214] px-3 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,.65)]" />
          <span className="truncate text-xs text-zinc-400">Live Preview</span>
        </div>
        <button onClick={refresh} aria-label="Refresh preview" className="grid h-8 w-8 place-items-center rounded-lg border border-zinc-800 text-zinc-400 hover:text-white">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
        <button onClick={() => window.open(previewUrl, '_blank', 'noopener,noreferrer')} aria-label="Open preview in new tab" className="grid h-8 w-8 place-items-center rounded-lg border border-zinc-800 text-zinc-400 hover:text-white">
          <ExternalLink size={14} />
        </button>
      </div>
      <div className="relative min-h-[420px] bg-[#0e0e0e]">
        {loading && <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center bg-[#0e0e0e]/80"><div className="flex items-center gap-2 rounded-full border border-zinc-800 bg-[#151515] px-4 py-2 text-xs text-zinc-400"><Loader2 size={14} className="animate-spin text-violet-400" />Loading preview…</div></div>}
        <iframe
          key={version}
          title="Nexa live preview"
          src={previewUrl}
          loading="lazy"
          onLoad={() => setLoading(false)}
          className="h-[58vh] min-h-[420px] w-full border-0 bg-[#0e0e0e]"
          sandbox="allow-scripts allow-same-origin"
        />
      </div>
    </div>
  );
}
