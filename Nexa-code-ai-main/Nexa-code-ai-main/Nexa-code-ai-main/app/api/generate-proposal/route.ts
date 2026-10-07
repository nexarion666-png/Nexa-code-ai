import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { streamWithFailover, type AIMessage, type FailoverKey, type Provider } from '@/lib/ai/failover';
import { loadUserProviderKeys, selectProvider } from '@/lib/ai/user-keys';
import { checkUsageLimit, incrementUsage } from '@/lib/limits';

export const runtime = 'nodejs';
export const maxDuration = 60;

const SYSTEM = `You are Nexa, a senior full-stack engineer and project generator. Generate a COMPLETE, self-contained, production-ready Next.js 14 project for the user's request.

NON-NEGOTIABLE COMPLETENESS RULES:
- This is a real project, not a snippet or partial mock. Generate every file required for the app to install and build.
- For a new project ALWAYS include package.json, tsconfig.json, next.config.js, postcss.config.js, tailwind.config.ts, app/globals.css, app/layout.tsx, and app/page.tsx.
- package.json MUST declare next, react, react-dom, and every external package imported by generated source.
- Every local import must resolve to a generated file or an existing project file. Never import a component, CSS file, utility, context, type, route, or module that does not exist.
- Every route linked or referenced by the UI must exist. Do not create dead navigation links to unimplemented routes.
- Preserve compatible existing project infrastructure when editing. Do not remove required files unless an equivalent replacement is generated.
- Include loading, error, and empty states where needed. Do not leave TODOs, pseudo-code, placeholder components, or 'implement later' sections.
- For mock/test apps, prefer local sample data unless the user explicitly requests an external API. Handle loading/error/empty states for external APIs.
- The final file set must be deployable with npm install && npm run build on Vercel without manual file creation.

Output ONLY file blocks in this exact format:
---FILE: app/page.tsx---
full file content here
---FILE: lib/utils.ts---
content
Output the COMPLETE SET of files. No explanation outside file blocks.`;

const FILE_PATTERN = /---\s*FILE:\s*(.+?)\s*---\s*([\s\S]*?)(?=---\s*FILE:|$)/g;

const GENERATE_NOW = 'The requirements are settled. Do not ask questions and do not write any text outside file blocks. Output the complete set of files now, each starting with a line exactly like ---FILE: path/to/file.tsx--- followed by the full file content.';

function parseFiles(content: string) {
  const files: { path: string; content: string }[] = [];
  FILE_PATTERN.lastIndex = 0;
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = FILE_PATTERN.exec(content)) !== null) {
    const path = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/^\/+/, '');
    const fileContent = match[2]
      .replace(/^\s*```[\w-]*\r?\n/, '')
      .replace(/\r?\n?```\s*$/, '')
      .replace(/^\n/, '')
      .replace(/\s+$/, '\n');
    if (!path || path.includes('..') || path.includes('\\') || seen.has(path)) continue;
    seen.add(path);
    files.push({ path, content: fileContent });
  }
  return files;
}


const BASE_PACKAGE = {
  name: 'nexa-generated-app', version: '1.0.0', private: true,
  scripts: { dev: 'next dev', build: 'next build', start: 'next start' },
  dependencies: { next: '14.2.15', react: '^18.3.1', 'react-dom': '^18.3.1' },
  devDependencies: { typescript: '^5.7.2', '@types/node': '^20.17.10', '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1', tailwindcss: '^3.4.16', postcss: '^8.4.49', autoprefixer: '^10.4.20' },
};

const COMMON_DEPENDENCIES: Record<string, string> = {
  'lucide-react': '^0.468.0', clsx: '^2.1.1', 'tailwind-merge': '^2.5.5',
  'framer-motion': '^11.15.0', 'date-fns': '^4.1.0', sonner: '^1.7.1',
  recharts: '^2.15.0', 'react-hook-form': '^7.54.2', zod: '^3.24.1',
};

function ensureFile(files: { path: string; content: string }[], path: string, content: string) {
  if (!files.some(file => file.path === path)) files.push({ path, content });
}

function execMatches(content: string, pattern: RegExp): RegExpExecArray[] {
  const matches: RegExpExecArray[] = [];
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content)) !== null) matches.push(match);
  return matches;
}

function ensureNextProject(files: { path: string; content: string }[], existingProject: boolean) {
  if (!existingProject) {
    ensureFile(files, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2017', lib: ['dom', 'dom.iterable', 'esnext'], allowJs: false, skipLibCheck: true, strict: true, noEmit: true, esModuleInterop: true, module: 'esnext', moduleResolution: 'bundler', resolveJsonModule: true, isolatedModules: true, jsx: 'preserve', incremental: true, plugins: [{ name: 'next' }], paths: { '@/*': ['./*'] } }, include: ['next-env.d.ts', '**/*.ts', '**/*.tsx', '.next/types/**/*.ts'], exclude: ['node_modules'] }, null, 2) + '\n');
    ensureFile(files, 'next.config.js', "/** @type {import('next').NextConfig} */\nmodule.exports = { reactStrictMode: true };\n");
    ensureFile(files, 'postcss.config.js', 'module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n');
    ensureFile(files, 'tailwind.config.ts', "import type { Config } from 'tailwindcss';\nconst config: Config = { content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}', './context/**/*.{js,ts,jsx,tsx,mdx}', './lib/**/*.{js,ts,jsx,tsx,mdx}'], theme: { extend: {} }, plugins: [] };\nexport default config;\n");
    ensureFile(files, 'app/globals.css', '@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nhtml, body { min-height: 100%; }\nbody { margin: 0; }\n');
    ensureFile(files, 'app/layout.tsx', "import './globals.css';\n\nexport const metadata = { title: 'Nexa App', description: 'Generated by Nexa Code AI' };\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) { return <html lang=\"en\"><body>{children}</body></html>; }\n");
    ensureFile(files, 'app/page.tsx', "export default function HomePage() { return <main className=\"min-h-screen p-6\"><h1 className=\"text-3xl font-bold\">Nexa App</h1></main>; }\n");
  }

  let pkg: any = null;
  const packageFile = files.find(file => file.path === 'package.json');
  try { pkg = packageFile ? JSON.parse(packageFile.content) : null; } catch { pkg = null; }
  if (!pkg || typeof pkg !== 'object') pkg = JSON.parse(JSON.stringify(BASE_PACKAGE));
  pkg.name = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name : 'nexa-generated-app';
  pkg.version = typeof pkg.version === 'string' ? pkg.version : '1.0.0';
  pkg.private = true;
  pkg.scripts = { ...(pkg.scripts ?? {}), dev: 'next dev', build: 'next build', start: 'next start' };
  pkg.dependencies = { ...(pkg.dependencies ?? {}) };
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}) };
  for (const [name, version] of Object.entries(BASE_PACKAGE.dependencies)) if (!pkg.dependencies[name]) pkg.dependencies[name] = version;
  for (const [name, version] of Object.entries(BASE_PACKAGE.devDependencies)) if (!pkg.devDependencies[name]) pkg.devDependencies[name] = version;

  const imported = new Set<string>();
  for (const file of files) for (const match of execMatches(file.content, /(?:from|import)\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    if (spec.startsWith('.') || spec.startsWith('@/') || spec.startsWith('node:')) continue;
    imported.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
  }
  imported.forEach(name => {
    if (!pkg.dependencies[name] && COMMON_DEPENDENCIES[name]) pkg.dependencies[name] = COMMON_DEPENDENCIES[name];
  });
  const serialized = JSON.stringify(pkg, null, 2) + '\n';
  if (packageFile) packageFile.content = serialized; else files.push({ path: 'package.json', content: serialized });
}

function missingLocalImports(files: { path: string; content: string }[]) {
  const paths = new Set(files.map(file => file.path.replace(/\.(tsx?|jsx?|css|json)$/, '')));
  const missing = new Set<string>();
  for (const file of files) for (const match of execMatches(file.content, /(?:from|import)\s*["']([^"']+)["']/g)) {
    const spec = match[1];
    let base = '';
    if (spec.startsWith('@/')) base = spec.slice(2);
    else if (spec.startsWith('.')) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/') + 1) : '';
      base = `${dir}${spec}`.replace(/\/\.\//g, '/').replace(/^\.\//, '');
    } else continue;
    base = base.replace(/\.(tsx?|jsx?|css|json)$/, '');
    if (!paths.has(base) && !paths.has(`${base}/index`)) missing.add(spec);
  }
  const result: string[] = [];
  missing.forEach(value => result.push(value));
  return result;
}

function routeExists(files: { path: string; content: string }[], route: string) {
  const clean = route.split('?')[0].split('#')[0].replace(/^\/+|\/+$/g, '');
  if (!clean) return true;
  const segments = clean.split('/').filter(Boolean);
  const appRoot = `app/${segments.join('/')}`;
  const candidates = [
    `${appRoot}/page.tsx`, `${appRoot}/page.ts`, `${appRoot}/page.jsx`, `${appRoot}/page.js`,
    `${appRoot}/page.mdx`, `${appRoot}/index.tsx`, `${appRoot}/index.ts`,
  ];
  if (files.some(file => candidates.includes(file.path))) return true;
  // A dynamic route can satisfy a concrete link such as /products/123.
  const dynamicSegments = segments.map(() => '[id]').join('/');
  return files.some(file => file.path === `app/${dynamicSegments}/page.tsx` || file.path === `app/${dynamicSegments}/page.ts`);
}

function missingLinkedRoutes(files: { path: string; content: string }[]) {
  const routes = new Set<string>();
  for (const file of files) {
    for (const match of execMatches(file.content, /(?:href|router\.(?:push|replace)|redirect)\s*[=(]\s*["'](\/[^"'#?]*)/g)) {
      const route = match[1];
      if (!route || route.startsWith('//') || route.startsWith('/api')) continue;
      routes.add(route);
    }
  }
  const result: string[] = [];
  routes.forEach(route => {
    if (!routeExists(files, route)) result.push(route);
  });
  return result;
}

function validateProject(files: { path: string; content: string }[]) {
  const errors: string[] = [];
  const pkg = files.find(file => file.path === 'package.json');
  if (!pkg) errors.push('package.json is missing');
  else {
    try {
      const value = JSON.parse(pkg.content);
      if (!value.dependencies?.next && !value.devDependencies?.next) errors.push('package.json does not declare next');
      if (!value.dependencies?.react || !value.dependencies?.['react-dom']) errors.push('package.json is missing react/react-dom');
    } catch { errors.push('package.json is invalid JSON'); }
  }
  for (const required of ['tsconfig.json', 'next.config.js', 'postcss.config.js', 'tailwind.config.ts', 'app/globals.css', 'app/layout.tsx', 'app/page.tsx']) if (!files.some(file => file.path === required)) errors.push(`${required} is missing`);
  const missing = missingLocalImports(files);
  if (missing.length) errors.push(`unresolved local imports: ${missing.slice(0, 15).join(', ')}`);
  const missingRoutes = missingLinkedRoutes(files);
  if (missingRoutes.length) errors.push(`unimplemented local routes: ${missingRoutes.slice(0, 12).join(', ')}`);
  return errors;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json().catch(() => ({}));
  const projectId = String(body.projectId ?? '');
  const history = Array.isArray(body.history) ? body.history : [];
  const requestedProvider = typeof body.provider === 'string' ? body.provider : undefined;
  if (!projectId) return NextResponse.json({ error: 'projectId is required.' }, { status: 400 });

  const { data: project } = await supabase.from('projects').select('id').eq('id', projectId).eq('user_id', user.id).single();
  if (!project) return NextResponse.json({ error: 'Project not found.' }, { status: 404 });

  const usageCheck = await checkUsageLimit(supabase, user, 'proposal');
  if (!usageCheck.allowed) return NextResponse.json({ error: `Daily proposal limit reached (${usageCheck.limit}). Upgrade to Pro for unlimited proposals.`, usage: usageCheck.usage }, { status: 429 });
  const keysByProvider = await loadUserProviderKeys(supabase, user.id);
  const provider = selectProvider(keysByProvider, requestedProvider);
  // loadUserProviderKeys returns decrypted string[] values. Normalize them once
  // at the route boundary so the failover engine receives its expected key shape.
  const failoverKeysByProvider: Record<Provider, FailoverKey[]> = {
    gemini: (keysByProvider.gemini ?? []).map((value, index) => ({ id: `gemini-key-${index + 1}`, value })),
    groq: (keysByProvider.groq ?? []).map((value, index) => ({ id: `groq-key-${index + 1}`, value })),
    openrouter: (keysByProvider.openrouter ?? []).map((value, index) => ({ id: `openrouter-key-${index + 1}`, value })),
  };
  if (!provider) return NextResponse.json({ error: 'No AI provider keys are configured. Open AI Settings and add a key.' }, { status: 400 });

  const safeHistory: AIMessage[] = history
    .slice(-50)
    .filter((m: unknown): m is { role: string; content: string } => {
      if (!m || typeof m !== 'object') return false;
      const candidate = m as { role?: unknown; content?: unknown };
      return (candidate.role === 'user' || candidate.role === 'assistant') && typeof candidate.content === 'string';
    })
    .map((m: { role: 'user' | 'assistant'; content: string }) => ({ role: m.role, content: m.content }));
  if (!safeHistory.length) return NextResponse.json({ error: 'A conversation is required before generating a proposal.' }, { status: 400 });

  const { data: existingFilesRaw, error: filesError } = await supabase
    .from('project_files')
    .select('path,content')
    .eq('project_id', projectId)
    .order('path');
  if (filesError) return NextResponse.json({ error: filesError.message }, { status: 500 });
  const existingFiles: { path: string; content: string | null }[] = existingFilesRaw ?? [];

  const context = existingFiles?.length
    ? `\n\nExisting project files are listed below. Preserve compatible existing behavior and update files where necessary:\n${existingFiles.map(file => `---EXISTING: ${file.path}---\n${file.content ?? ''}`).join('\n')}`
    : '';
  // The chat history ends on an assistant turn (or a conversation-mode message), so tell the
  // model explicitly to emit the file blocks now.
  const lastMessage = safeHistory[safeHistory.length - 1];
  const closingHistory: AIMessage[] = lastMessage.role === 'user'
    ? [...safeHistory.slice(0, -1), { role: 'user', content: `${lastMessage.content}\n\n${GENERATE_NOW}` }]
    : [...safeHistory, { role: 'user', content: GENERATE_NOW }];
  const messages: AIMessage[] = [
    { role: 'system', content: SYSTEM + context },
    ...closingHistory,
  ];

  let generated = '';
  try {
    await streamWithFailover({
      provider,
      messages,
      keys: keysByProvider[provider],
      keysByProvider: failoverKeysByProvider,
      onChunk: async chunk => { generated += chunk; },
    });
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.startsWith('KEYS_EXHAUSTED::')) {
      const payload = raw.slice('KEYS_EXHAUSTED::'.length);
      const separator = payload.lastIndexOf('::');
      const triedJson = separator >= 0 ? payload.slice(0, separator) : payload;
      const lastErr = separator >= 0 ? payload.slice(separator + 2) : 'All providers failed';
      let tried: unknown[] = [];
      try { tried = JSON.parse(triedJson); } catch { /* Keep UI-safe fallback. */ }
      console.error('[NEXA PROPOSAL KEYS_EXHAUSTED]', error);
      return NextResponse.json({ error: 'KEYS_EXHAUSTED', tried, message: lastErr, retryAfter: 60 }, { status: 429 });
    }
    console.error('[NEXA PROPOSAL ERROR]', error);
    return NextResponse.json({ error: 'Nexa could not generate the proposal.' }, { status: 502 });
  }

  const files = parseFiles(generated);
  if (!files.length) console.error('[NEXA PROPOSAL NO FILE BLOCKS]', JSON.stringify(generated.slice(0, 500)), `length=${generated.length}`);
  if (!files.length) return NextResponse.json({ error: 'Nexa returned no file blocks. Ask Nexa to clarify the feature and try again.' }, { status: 422 });

  const existingProject = existingFiles.some(file => file.path === 'package.json' || file.path === 'app/layout.tsx' || file.path === 'src/app/layout.tsx');
  ensureNextProject(files, existingProject);
  const integrityErrors = validateProject(files);
  if (integrityErrors.length) {
    console.error('[NEXA PROJECT INTEGRITY FAILED]', integrityErrors);
    return NextResponse.json({ error: 'Generated project is incomplete.', details: integrityErrors, retryable: true }, { status: 422 });
  }

  const existingByPath = new Map((existingFiles ?? []).map(file => [file.path, file.content ?? '']));
  const { data: proposal, error: proposalError } = await supabase
    .from('proposals')
    .insert({ project_id: projectId, user_id: user.id, content: generated, status: 'pending' })
    .select('id')
    .single();
  if (proposalError || !proposal) return NextResponse.json({ error: proposalError?.message ?? 'Could not create proposal.' }, { status: 500 });

  const changes = files
    .filter(file => !existingByPath.has(file.path) || existingByPath.get(file.path) !== file.content)
    .map(file => ({
      proposal_id: proposal.id,
      path: file.path,
      operation: existingByPath.has(file.path) ? 'update' : 'create',
      old_content: existingByPath.get(file.path) ?? null,
      new_content: file.content,
    }));

  if (changes.length) {
    const { error: changesError } = await supabase.from('file_changes').insert(changes);
    if (changesError) {
      await supabase.from('proposals').delete().eq('id', proposal.id);
      return NextResponse.json({ error: changesError.message }, { status: 500 });
    }
  }

  try {
    await incrementUsage(supabase, user.id, 'proposal');
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : 'Could not update usage.' }, { status: 500 });
  }

  const summary = `Proposal ready: ${changes.length} files to modify. [Review Changes]`;
  const { error: messageError } = await supabase.from('messages').insert({ project_id: projectId, user_id: user.id, role: 'assistant', content: summary });
  if (messageError) return NextResponse.json({ proposalId: proposal.id, changesCount: changes.length, warning: 'Proposal created, but the chat summary could not be saved.' });

  return NextResponse.json({ proposalId: proposal.id, changesCount: changes.length, provider });
}
