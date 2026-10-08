export type ProjectFile = { path: string; content: string };

export class ProjectCompletenessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectCompletenessError';
  }
}

function normalizePath(path: string) {
  const parts: string[] = [];
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { parts.pop(); continue; }
    parts.push(part);
  }
  return parts.join('/').replace(/^\/+/, '');
}

function isPathSafe(path: string) {
  return Boolean(path) && !path.includes('..') && !path.includes('\\') && !path.startsWith('/');
}

function dedupeLast(files: ProjectFile[]) {
  const byPath = new Map<string, ProjectFile>();
  for (const file of files) {
    const path = normalizePath(file.path);
    if (!isPathSafe(path)) continue;
    byPath.set(path, { path, content: file.content });
  }
  const result: ProjectFile[] = [];
  byPath.forEach(file => result.push(file));
  return result;
}

function get(files: ProjectFile[], path: string) {
  return files.find(file => file.path === path);
}

function looksLikeNextProject(files: ProjectFile[]) {
  const packageFile = get(files, 'package.json');
  if (packageFile) {
    try {
      const pkg = JSON.parse(packageFile.content) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      return Boolean(pkg.dependencies?.next || pkg.devDependencies?.next);
    } catch {
      return true;
    }
  }
  return files.some(file => /^app\/(layout|page)\.(tsx?|jsx?)$/.test(file.path) || /^pages\/(index|_app)\.(tsx?|jsx?)$/.test(file.path));
}

function validateJson(files: ProjectFile[]) {
  for (const path of ['package.json', 'tsconfig.json']) {
    const file = get(files, path);
    if (!file) continue;
    try {
      JSON.parse(file.content);
    } catch (error) {
      throw new ProjectCompletenessError(`${path} is not valid JSON and will not be saved.`);
    }
  }
}

function obviousTruncation(file: ProjectFile) {
  const content = file.content.trim();
  if (!content) return true;
  if (/```$/.test(content)) return true;
  if (/^(?:import|export)\s+[^\n]*\bfrom\s*['"][^'"]*$/.test(content)) return true;
  const last = content.split(/\r?\n/).at(-1)?.trim() ?? '';
  if (/^(?:const|let|var|return|throw|await|new)\b.*(?:=|\(|\{|\[|,)$/.test(last)) return true;
  if (/[({\[]\s*$/.test(last)) return true;
  return false;
}

function validateContents(files: ProjectFile[]) {
  for (const file of files) {
    if (obviousTruncation(file)) throw new ProjectCompletenessError(`Generated file ${file.path} is empty or appears truncated.`);
    if (/^```[\w-]*\s*$/m.test(file.content)) throw new ProjectCompletenessError(`Generated file ${file.path} contains an unfinished code fence.`);
  }
}

function resolveLocalImport(fromPath: string, specifier: string, files: Set<string>) {
  const base = specifier.startsWith('@/')
    ? specifier.slice(2)
    : specifier.startsWith('./') || specifier.startsWith('../')
      ? normalizePath(`${fromPath.split('/').slice(0, -1).join('/')}/${specifier}`)
      : null;
  if (!base) return true;
  const candidates = [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}.css`, `${base}.json`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ];
  return candidates.some(candidate => files.has(normalizePath(candidate)));
}

function validateLocalImports(files: ProjectFile[]) {
  const paths = new Set(files.map(file => file.path));
  const importPattern = /(?:import\s+(?:[\s\S]*?\s+from\s+|['"])|export\s+[\s\S]*?\s+from\s+|require\()(['"])([^'"]+)\1/g;
  for (const file of files) {
    importPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(file.content)) !== null) {
      const specifier = match[2];
      if ((specifier.startsWith('@/') || specifier.startsWith('./') || specifier.startsWith('../')) && !resolveLocalImport(file.path, specifier, paths)) {
        throw new ProjectCompletenessError(`Generated file ${file.path} imports missing local module ${specifier}.`);
      }
    }
  }
}

function validatePackage(files: ProjectFile[]) {
  const packageFile = get(files, 'package.json');
  if (!packageFile) return files;

  let pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  try {
    pkg = JSON.parse(packageFile.content);
  } catch {
    return files;
  }

  const dependencies = { ...(pkg.dependencies ?? {}) };
  const devDependencies = { ...(pkg.devDependencies ?? {}) };
  const declared = new Set([...Object.keys(dependencies), ...Object.keys(devDependencies)]);
  const builtin = new Set([
    'fs', 'path', 'url', 'crypto', 'http', 'https', 'os', 'stream', 'util', 'events',
    'buffer', 'assert', 'child_process', 'zlib', 'net', 'tls', 'module', 'querystring',
    'string_decoder', 'timers', 'worker_threads', 'node:fs', 'node:path', 'node:url',
    'node:crypto', 'node:http', 'node:https', 'node:os', 'node:stream', 'node:util',
  ]);

  // Common packages Nexa may legitimately use in generated React/Next projects.
  // Keep versions pinned to known-good public releases instead of inventing versions.
  const knownVersions: Record<string, string> = {
    '@headlessui/react': '^2.2.10',
  };

  const missing = new Set<string>();
  const importPattern = /(?:import\s+(?:[\s\S]*?\s+from\s+|['"])|export\s+[\s\S]*?\s+from\s+|require\()(['"])([^'"./@][^'"]*|@[^/]+\/[^'"]+)\1/g;

  for (const file of files) {
    importPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(file.content)) !== null) {
      const specifier = match[2];
      const packageName = specifier.startsWith('@')
        ? specifier.split('/').slice(0, 2).join('/')
        : specifier.split('/')[0];
      if (!builtin.has(packageName) && !declared.has(packageName)) missing.add(packageName);
    }
  }

  if (!missing.size) return files;

  let missingError: ProjectCompletenessError | null = null;
  missing.forEach(packageName => {
    if (missingError) return;
    const version = knownVersions[packageName];
    if (!version) {
      missingError = new ProjectCompletenessError(
        `Generated file ${files.find(file => file.content.includes(packageName))?.path ?? 'unknown'} imports ${packageName}, but package.json does not declare it.`,
      );
      return;
    }
    dependencies[packageName] = version;
    declared.add(packageName);
  });
  if (missingError) throw missingError;

  const updatedPackage = { ...pkg, dependencies };
  const updated = files.map(file =>
    file.path === 'package.json'
      ? { ...file, content: JSON.stringify(updatedPackage, null, 2) + '\n' }
      : file,
  );

  console.warn('[NEXA DEPENDENCY REPAIR]', Array.from(missing).join(', '));
  return updated;
}

export function ensureCompleteNextProject(input: ProjectFile[], options: { requireShell?: boolean } = {}) {
  const files = dedupeLast(input);
  if (!files.length) throw new ProjectCompletenessError('Nexa returned no files.');
  if (!looksLikeNextProject(files)) return files;

  validateJson(files);
  validateContents(files);
  const validatedFiles = validatePackage(files);
  validateLocalImports(validatedFiles);

  const requireShell = options.requireShell ?? true;
  const packageFile = get(validatedFiles, 'package.json');
  if (requireShell) {
    if (!packageFile) throw new ProjectCompletenessError('Complete Next.js generation requires package.json.');
    let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    try { pkg = JSON.parse(packageFile.content); } catch { throw new ProjectCompletenessError('package.json is invalid JSON.'); }
    if (!pkg.dependencies?.next && !pkg.devDependencies?.next) throw new ProjectCompletenessError('package.json does not declare Next.js.');

    const hasAppPage = Boolean(get(validatedFiles, 'app/page.tsx') || get(validatedFiles, 'app/page.jsx') || get(validatedFiles, 'app/page.ts') || get(validatedFiles, 'app/page.js'));
    const hasPagesIndex = Boolean(get(validatedFiles, 'pages/index.tsx') || get(validatedFiles, 'pages/index.jsx') || get(validatedFiles, 'pages/index.ts') || get(validatedFiles, 'pages/index.js'));
    if (!hasAppPage && !hasPagesIndex) throw new ProjectCompletenessError('Complete generation requires app/page.tsx or pages/index.tsx. Nexa will not create a fake placeholder homepage.');
    if (hasAppPage && !get(validatedFiles, 'app/layout.tsx') && !get(validatedFiles, 'app/layout.jsx') && !get(validatedFiles, 'app/layout.ts') && !get(validatedFiles, 'app/layout.js')) {
      throw new ProjectCompletenessError('App Router generation requires app/layout.tsx.');
    }
  }

  return validatedFiles;
}

export function serializeFileBlocks(files: ProjectFile[]) {
  return files.map(file => `---FILE: ${file.path}---\n${file.content.replace(/\s+$/, '\n')}`).join('\n');
}
