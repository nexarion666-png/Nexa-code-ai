import { NextResponse } from 'next/server';
import ts from 'typescript';
import { createClient } from '@/lib/supabase/server';
import { streamWithFailover, type AIMessage, type FailoverKey, type Provider } from '@/lib/ai/failover';
import { loadUserProviderKeys, selectProvider } from '@/lib/ai/user-keys';
import { checkUsageLimit, incrementUsage } from '@/lib/limits';
import { ensureCompleteNextProject, serializeFileBlocks } from '@/lib/project-completeness';

export const runtime = 'nodejs';
export const maxDuration = 300;
// Stop starting provider calls well before Vercel kills the function, so the user
// gets a clean JSON error instead of a 504 FUNCTION_INVOCATION_TIMEOUT.
const TIME_BUDGET_MS = 270_000;

const SYSTEM = `You are Nexa, senior full-stack dev. Based on conversation, output detailed plan, then output files EXACTLY like:
---FILE: app/page.tsx---
full file content here
---FILE: lib/utils.ts---
content
List ALL files needed for feature. Every local module you import (e.g. @/components/Foo) MUST also be output as its own file block. Production-ready Next.js 14 Tailwind code. No explanation outside file blocks.`;

const FILE_PATTERN = /---\s*FILE:\s*(.+?)\s*---\s*([\s\S]*?)(?=---\s*FILE:|$)/g;

const GENERATE_NOW = 'The requirements are settled. Do not ask questions and do not write any text outside file blocks. Output the complete set of files now, each starting with a line exactly like ---FILE: path/to/file.tsx--- followed by the full file content.';

function parseFiles(content: string) {
  const files: { path: string; content: string }[] = [];
  FILE_PATTERN.lastIndex = 0;
  const byPath = new Map<string, { path: string; content: string }>();
  let match: RegExpExecArray | null;
  while ((match = FILE_PATTERN.exec(content)) !== null) {
    const path = match[1].trim().replace(/^['"]|['"]$/g, '').replace(/^\/+/, '');
    const fileContent = match[2]
      .replace(/^\s*```[\w-]*\r?\n/, '')
      .replace(/\r?\n?```\s*$/, '')
      .replace(/^\n/, '')
      .replace(/\s+$/, '\n');
    if (!path || path.includes('..') || path.includes('\\')) continue;
    // Last complete occurrence wins. This prevents an earlier truncated duplicate
    // from replacing a later complete version of the same file.
    byPath.set(path, { path, content: fileContent });
  }
  byPath.forEach(file => files.push(file));
  return files;
}

// TypeScript's parser catches malformed JSX/TSX before a proposal can be saved.
// This is deliberately a syntax check, not a replacement for the real Vercel build.
function validateGeneratedSyntax(files: { path: string; content: string }[]) {
  const sourceExtensions = /\.(?:tsx?|jsx?)$/i;
  for (const file of files) {
    if (!sourceExtensions.test(file.path)) continue;
    const result = ts.transpileModule(file.content, {
      fileName: file.path,
      reportDiagnostics: true,
      compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        target: ts.ScriptTarget.ES2020,
        module: ts.ModuleKind.ESNext,
        isolatedModules: true,
      },
    });
    const diagnostic = (result.diagnostics ?? []).find(item => item.category === ts.DiagnosticCategory.Error);
    if (!diagnostic) continue;
    const position = diagnostic.file && diagnostic.start !== undefined
      ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
      : null;
    const where = position ? `:${position.line + 1}:${position.character + 1}` : '';
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
    throw new Error(`Generated file ${file.path}${where} has a TypeScript/JSX syntax error: ${message}`);
  }
}

// transpileModule checks syntax only; it does not compare types across files.
// Build an in-memory TypeScript program for the whole generated project so errors
// such as `shoe.brand` when `Shoe` has no `brand` property are caught before the
// proposal is saved. Missing third-party packages are ignored here because the
// generated project's dependencies have not been installed yet; internal type
// errors in generated files are still reported.
function validateGeneratedTypes(
  files: { path: string; content: string }[],
  existingFiles: { path: string; content: string }[] = [],
) {
  const allFiles = new Map<string, string>();
  for (const file of existingFiles) allFiles.set(file.path.replace(/^\/+/, ''), file.content);
  for (const file of files) allFiles.set(file.path.replace(/^\/+/, ''), file.content);

  const sourcePaths = [...allFiles.keys()].filter(path => /\.(?:tsx?|jsx?)$/i.test(path));
  if (!sourcePaths.length) return;

  const root = '/__nexa_generated_project__';
  const virtualPath = (path: string) => `${root}/${path.replace(/^\/+/, '').replace(/\\/g, '/')}`;
  const virtualContents = new Map<string, string>();
  for (const [path, content] of allFiles) virtualContents.set(virtualPath(path), content);
  const generatedPaths = new Set(files.map(file => virtualPath(file.path)));

  let compilerOptions: ts.CompilerOptions = {
    jsx: ts.JsxEmit.ReactJSX,
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowJs: true,
    checkJs: false,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    strict: false,
  };
  const tsconfig = allFiles.get('tsconfig.json');
  if (tsconfig) {
    try {
      const parsed = JSON.parse(tsconfig) as { compilerOptions?: Record<string, unknown> };
      const converted = ts.convertCompilerOptionsFromJson(parsed.compilerOptions ?? {}, root);
      compilerOptions = { ...compilerOptions, ...converted.options, noEmit: true, skipLibCheck: true };
    } catch {
      // The JSON validator reports malformed tsconfig separately.
    }
  }

  const host = ts.createCompilerHost(compilerOptions, true);
  const originalFileExists = host.fileExists.bind(host);
  const originalDirectoryExists = host.directoryExists?.bind(host);
  const originalReadFile = host.readFile.bind(host);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  host.getCurrentDirectory = () => root;
  host.fileExists = fileName => virtualContents.has(fileName.replace(/\\/g, '/')) || originalFileExists(fileName);
  host.directoryExists = directoryName => {
    const normalized = directoryName.replace(/\\/g, '/').replace(/\/$/, '');
    return [...virtualContents.keys()].some(fileName => fileName.startsWith(`${normalized}/`)) || Boolean(originalDirectoryExists?.(directoryName));
  };
  host.readFile = fileName => virtualContents.get(fileName.replace(/\\/g, '/')) ?? originalReadFile(fileName);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const normalized = fileName.replace(/\\/g, '/');
    const source = virtualContents.get(normalized);
    if (source !== undefined) return ts.createSourceFile(fileName, source, languageVersion, true);
    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };
  host.resolveModuleNames = (moduleNames, containingFile) => moduleNames.map(moduleName =>
    ts.resolveModuleName(moduleName, containingFile, compilerOptions, host).resolvedModule,
  );

  const program = ts.createProgram(sourcePaths.map(virtualPath), compilerOptions, host);
  // These are environment/package diagnostics rather than reliable project-code
  // diagnostics until the generated project's own npm dependencies are installed.
  const unavailableEnvironmentCodes = new Set([2307, 2503, 2580, 2688, 2875, 7026]);
  const diagnostic = ts.getPreEmitDiagnostics(program).find(item => {
    if (item.category !== ts.DiagnosticCategory.Error || !item.file) return false;
    if (!generatedPaths.has(item.file.fileName.replace(/\\/g, '/'))) return false;
    if (unavailableEnvironmentCodes.has(item.code)) return false;
    return true;
  });
  if (!diagnostic) return;

  const path = diagnostic.file!.fileName.replace(/\\/g, '/').slice(root.length + 1);
  const position = diagnostic.start === undefined ? null : diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start);
  const where = position ? `:${position.line + 1}:${position.character + 1}` : '';
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ');
  throw new Error(`Generated file ${path}${where} has a TypeScript type error (TS${diagnostic.code}): ${message}`);
}

async function repairGeneratedProject({
  provider,
  keysByProvider,
  currentFiles,
  validationError,
  deadline,
}: {
  deadline: number;
  provider: Provider;
  keysByProvider: Record<Provider, FailoverKey[]>;
  currentFiles: { path: string; content: string }[];
  validationError: string;
}) {
  // Repair must be a small, focused request. Re-sending the original generation
  // history + every existing project file can exceed provider TPM/credit limits.
  const missingImportMatch = validationError.match(/Generated file\s+([^\s:]+)(?::\d+:\d+)?\s+imports missing local module\s+([^\.\s]+(?:\.[^\s]+)*)/i);
  const syntaxMatch = validationError.match(/Generated file\s+([^\s:]+)(?::\d+:\d+)?\s+has a TypeScript\/JSX syntax error/i);
  const typeMatch = validationError.match(/Generated file\s+([^\s:]+)(?::\d+:\d+)?\s+has a TypeScript type error/i);
  const missingFileMatch = validationError.match(/(?:requires|missing|Missing)\s+(?:file\s+)?([^\s,.]+\.(?:tsx?|jsx?|json|css|md))/i);
  const relevantPath = missingImportMatch?.[1] || syntaxMatch?.[1] || typeMatch?.[1] || missingFileMatch?.[1] || '';
  const missingSpecifier = missingImportMatch?.[2] || '';
  const impliedModulePath = missingSpecifier.startsWith('@/') ? missingSpecifier.slice(2) : '';
  const relevant = currentFiles.filter(file =>
    file.path === 'package.json' ||
    file.path === 'tsconfig.json' ||
    file.path === relevantPath ||
    (impliedModulePath && (file.path === impliedModulePath || file.path.startsWith(impliedModulePath + '/'))) ||
    (relevantPath && file.path.startsWith(relevantPath.replace(/\/[^/]+$/, '') + '/')) ||
    /(^|\/)(layout|page|utils|types|index|data|shoes|products)\.(tsx?|jsx?)$/.test(file.path) ||
    (typeMatch && /(?:interface|type)\s+(?:Shoe|Product|Item)\b/.test(file.content)),
  ).slice(0, 12);
  const context = relevant.map(file => `---CURRENT: ${file.path}---\n${file.content}`).join('\n');
  const repairSystem: AIMessage = {
    role: 'system',
    content: `You are Nexa's focused project-repair agent. Fix ONLY the validation failure below. Do not redesign the project. Do not replace valid files. Do not create fake placeholders. Output ONLY complete FILE blocks. Keep the existing framework, aliases, and conventions.\n\nVALIDATION ERROR:\n${validationError}\n\nRELEVANT CURRENT FILES:\n${context || '(none)'}`,
  };
  const needsProjectShell = /requires package\.json|requires app\/page\.tsx or pages\/index\.tsx|requires app\/layout\.tsx/i.test(validationError);
  const repairUser: AIMessage = {
    role: 'user',
    content: missingImportMatch
      ? `Fix this missing import only. The file ${missingImportMatch[1]} imports ${missingSpecifier}. Create the real module at the path implied by tsconfig.json (for @/components/CartDrawer, use components/CartDrawer.tsx or the appropriate existing extension). Infer the component's props and behavior from the importing file and relevant project context. Do not regenerate the importing page unless it is genuinely necessary. Output only the missing/changed complete FILE block(s):\n---FILE: path/to/file.tsx---\nfull file content`
      : syntaxMatch
        ? `Repair the TypeScript/JSX syntax error in ${syntaxMatch[1]} only. The exact compiler diagnostic is: ${validationError}. Inspect the complete current file and return a syntactically valid complete replacement for that file. Preserve its design, content, and behavior; do not rewrite unrelated files. Output only this complete file block:\n---FILE: ${syntaxMatch[1]}---\nfull corrected file content`
      : typeMatch
        ? `Fix the TypeScript type error in ${typeMatch[1]} only. The exact compiler diagnostic is: ${validationError}. Inspect the referenced types/interfaces and all relevant project files. Make the smallest consistent change: either correct the property usage or update the shared type/data model if the property is genuinely part of the product. Do not silence the error with any, type assertions, or disabling TypeScript checks. Output only complete changed FILE blocks.\n---FILE: ${typeMatch[1]}---\nfull corrected file content`
      : needsProjectShell
        ? `Complete the required Next.js project shell in ONE repair response. Inspect the CURRENT FILES and create every missing required file in this same response: package.json with Next.js and all packages imported by generated files, a real app/page.tsx (or pages/index.tsx if the project uses Pages Router), and app/layout.tsx when using App Router. Preserve the existing design and feature requirements; do not create a fake placeholder homepage. Do not repeat files that already exist unless they need a compatible update. Output only complete FILE blocks.`
        : `Fix only the validation error. Create the real required file(s), preserve project conventions, and do not regenerate unrelated files. Output only complete FILE blocks:\n---FILE: path/to/file.tsx---\nfull file content`,
  };

  // Repair with the provider that just produced the generation successfully;
  // streamWithFailover still falls through the others if it fails.
  const repairProvider: Provider = provider;
  let repaired = '';
  await streamWithFailover({
    provider: repairProvider,
    messages: [repairSystem, repairUser],
    keys: keysByProvider[repairProvider] ?? [],
    keysByProvider,
    mode: 'repair',
    deadline,
    onChunk: async chunk => { repaired += chunk; },
  });
  return parseFiles(repaired);
}

export async function POST(request: Request) {
  const deadline = Date.now() + TIME_BUDGET_MS;
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
    cleanapis: (keysByProvider.cleanapis ?? []).map((value, index) => ({ id: `cleanapis-key-${index + 1}`, value })),
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
  let usedProvider: Provider = provider;
  try {
    const used = await streamWithFailover({
      provider,
      messages,
      keys: failoverKeysByProvider[provider].map(key => key.value),
      keysByProvider: failoverKeysByProvider,
      mode: 'generation',
      deadline,
      onChunk: async chunk => { generated += chunk; },
    });
    usedProvider = used.provider;
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

  let files = parseFiles(generated);
  if (!files.length) return NextResponse.json({ error: 'Nexa returned no file blocks. Ask Nexa to clarify the feature and try again.' }, { status: 422 });

  // Never save an incomplete proposal. Give the same provider/failover engine a targeted
  // repair pass so missing shell files (especially src/app/page.tsx) are generated instead
  // of creating fake placeholders or forcing the user to regenerate manually.
  let validationError = '';
  for (let repairAttempt = 0; repairAttempt < 3; repairAttempt++) {
    try {
      files = ensureCompleteNextProject(files, { existingFiles: existingFiles.map(file => ({ path: file.path, content: file.content ?? '' })) });
      validateGeneratedSyntax(files);
      validateGeneratedTypes(files, existingFiles.map(file => ({ path: file.path, content: file.content ?? '' })));
      validationError = '';
      break;
    } catch (error) {
      validationError = error instanceof Error ? error.message : String(error);
      console.warn(`[NEXA PROPOSAL REPAIR] attempt=${repairAttempt + 1}: ${validationError}`);
      if (repairAttempt === 2) {
        console.error('[NEXA PROPOSAL VALIDATION ERROR]', validationError);
        return NextResponse.json({ error: validationError, code: 'PROPOSAL_VALIDATION_FAILED', repairAttempts: 2 }, { status: 422 });
      }
      if (deadline - Date.now() < 40_000) {
        console.error('[NEXA PROPOSAL REPAIR SKIPPED] not enough time left');
        return NextResponse.json({ error: validationError, code: 'PROPOSAL_VALIDATION_FAILED', message: 'Ran out of time repairing the proposal. Try again, or ask Nexa for a smaller feature.' }, { status: 422 });
      }
      try {
        const repairedFiles = await repairGeneratedProject({
          deadline,
          provider: usedProvider,
          keysByProvider: failoverKeysByProvider,
          currentFiles: [
            ...existingFiles.map(file => ({ path: file.path, content: file.content ?? '' })),
            ...files.filter(file => !existingFiles.some(existing => existing.path === file.path)),
            ...files.filter(file => existingFiles.some(existing => existing.path === file.path)),
          ],
          validationError,
        });
        if (!repairedFiles.length) throw new Error('Repair provider returned no file blocks.');
        const byPath = new Map(files.map(file => [file.path, file]));
        repairedFiles.forEach(file => byPath.set(file.path, file));
        const merged: { path: string; content: string }[] = [];
        byPath.forEach(file => merged.push(file));
        files = merged;
      } catch (repairError) {
        const repairMessage = repairError instanceof Error ? repairError.message : String(repairError);
        console.error('[NEXA PROPOSAL REPAIR FAILED]', repairMessage);
        return NextResponse.json({ error: validationError, code: 'PROPOSAL_VALIDATION_FAILED', repairAttempts: repairAttempt + 1 }, { status: 422 });
      }
    }
  }

  generated = serializeFileBlocks(files);

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
