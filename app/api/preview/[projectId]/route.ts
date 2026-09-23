import { createClient } from '@/lib/supabase/server';

export const runtime = 'nodejs';

function escapeHtml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
}

function extractPageSource(source: string) {
  return source
    .replace(/^\s*import[^;]+;?\s*$/gm, '')
    .replace(/^\s*['"]use client['"];?\s*$/gm, '')
    .replace(/export\s+default\s+function\s+[A-Za-z_$][\w$]*/g, 'function Page')
    .replace(/export\s+default\s+/, '')
    .replace(/export\s+(?:async\s+)?function\s+/g, 'function ')
    .trim();
}

export async function GET(_request: Request, { params }: { params: { projectId: string } }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return new Response('Unauthorized', { status: 401 });

  const { data: project } = await supabase.from('projects').select('id,name').eq('id', params.projectId).eq('user_id', user.id).single();
  if (!project) return new Response('Project not found.', { status: 404 });

  const { data: files, error } = await supabase.from('project_files').select('path,content').eq('project_id', params.projectId).order('path');
  if (error) return new Response(error.message, { status: 500 });

  const page = files?.find((file: { path: string; content: string | null }) => ['app/page.tsx', 'app/page.jsx', 'pages/index.tsx', 'pages/index.jsx'].includes(file.path));
  const source = page?.content ?? '';
  const safeSource = escapeHtml(source);
  const runtimeJson = JSON.stringify(extractPageSource(source)).replace(/</g, '\\u003c');
  const projectName = escapeHtml(project.name);

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${projectName} · Live Preview</title><script src="https://cdn.tailwindcss.com"></script><style>html,body{margin:0;min-height:100%;background:#0e0e0e;color:#fafafa;font-family:Inter,ui-sans-serif,system-ui,sans-serif}*{box-sizing:border-box}#fallback{max-width:920px;margin:0 auto;padding:28px}pre{white-space:pre-wrap;word-break:break-word;color:#a1a1aa;background:#18181b;border:1px solid #27272a;border-radius:16px;padding:16px;font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace}.badge{display:inline-flex;border:1px solid #3f3f46;border-radius:999px;padding:5px 9px;color:#a78bfa;font-size:11px}</style></head><body><div id="root"></div><div id="fallback" hidden><span class="badge">Live Preview</span><h1 style="font-size:24px;margin:14px 0 6px">${projectName}</h1><p style="color:#a1a1aa;margin:0 0 18px">The current project files are available, but this MVP preview could not execute the generated React page directly.</p><pre>${safeSource || 'No app/page.tsx file yet.'}</pre></div><script crossorigin src="https://unpkg.com/react@18/umd/react.development.js"></script><script crossorigin src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script><script src="https://unpkg.com/@babel/standalone/babel.min.js"></script><script>(()=>{const source=${runtimeJson};const fallback=document.getElementById('fallback');try{if(!source.trim())throw new Error('No app/page.tsx file');const transformed=Babel.transform(source,{presets:['typescript','react']}).code;const factory=new Function('React','ReactDOM',transformed+'\\nreturn typeof Page !== "undefined" ? Page : null;');const Page=factory(React,ReactDOM);if(!Page)throw new Error('No default page component found');ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(Page));}catch(error){fallback.hidden=false;const message=document.createElement('p');message.style.cssText='color:#fca5a5;font-size:12px;margin:0 0 12px';message.textContent='Preview fallback: '+(error&&error.message?error.message:'runtime error');fallback.insertBefore(message,fallback.querySelector('pre'));}})();</script></body></html>`;

  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store, max-age=0', 'Content-Security-Policy': "default-src 'self' https://cdn.tailwindcss.com https://unpkg.com 'unsafe-inline' 'unsafe-eval'; img-src * data: blob:; style-src 'self' 'unsafe-inline'; connect-src 'none';" } });
}
