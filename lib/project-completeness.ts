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
  return files.some(file => /^(?:src\/)?app\/(layout|page)\.(tsx?|jsx?)$/.test(file.path) || /^(?:src\/)?pages\/(index|_app)\.(tsx?|jsx?)$/.test(file.path));
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

function readPathAliases(files: ProjectFile[]) {
  const aliases: Array<{ pattern: string; targets: string[] }> = [];
  const tsconfig = get(files, 'tsconfig.json');
  if (!tsconfig) return aliases;

  try {
    const config = JSON.parse(tsconfig.content) as {
      compilerOptions?: {
        baseUrl?: string;
        paths?: Record<string, string[]>;
      };
    };
    const baseUrl = config.compilerOptions?.baseUrl ?? '.';
    const paths = config.compilerOptions?.paths ?? {};
    Object.entries(paths).forEach(([pattern, targets]) => {
      if (!Array.isArray(targets)) return;
      aliases.push({
        pattern,
        targets: targets.map(target => normalizePath(`${baseUrl}/${target}`)),
      });
    });
  } catch {
    // Invalid tsconfig is reported by validateJson before this resolver is used.
  }

  return aliases;
}

function aliasMatches(pattern: string, specifier: string) {
  if (pattern.endsWith('/*')) return specifier.startsWith(pattern.slice(0, -1));
  return specifier === pattern;
}

function replaceAlias(pattern: string, target: string, specifier: string) {
  if (pattern.endsWith('/*')) {
    const prefix = pattern.slice(0, -1);
    return target.endsWith('*')
      ? `${target.slice(0, -1)}${specifier.slice(prefix.length)}`
      : target;
  }
  return target;
}

function resolveCandidates(base: string) {
  return [
    base,
    `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`, `${base}.cjs`,
    `${base}.css`, `${base}.json`,
    `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.jsx`,
  ];
}

function resolveLocalImport(fromPath: string, specifier: string, files: Set<string>, aliases: Array<{ pattern: string; targets: string[] }>) {
  const bases: string[] = [];

  if (specifier.startsWith('@/')) {
    aliases.forEach(alias => {
      if (!aliasMatches(alias.pattern, specifier)) return;
      alias.targets.forEach(target => bases.push(replaceAlias(alias.pattern, target, specifier)));
    });
    // Support the common Nexa src-layout even when a generated tsconfig omitted
    // the alias entry. The generated project's own tsconfig remains authoritative
    // for the actual build; this fallback prevents a false validation failure when
    // the files themselves clearly use the standard src/ structure.
    if (!bases.length && files.has('src/app/layout.tsx')) bases.push(`src/${specifier.slice(2)}`);
    if (!bases.length) bases.push(specifier.slice(2));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    bases.push(normalizePath(`${fromPath.split('/').slice(0, -1).join('/')}/${specifier}`));
  } else {
    return true;
  }

  return bases.some(base => resolveCandidates(base).some(candidate => files.has(normalizePath(candidate))));
}

function validateLocalImports(files: ProjectFile[]) {
  const paths = new Set(files.map(file => file.path));
  const aliases = readPathAliases(files);
  const importPattern = /(?:import\s+(?:[\s\S]*?\s+from\s+|['"])|export\s+[\s\S]*?\s+from\s+|require\()(['"])([^'"]+)\1/g;
  for (const file of files) {
    importPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(file.content)) !== null) {
      const specifier = match[2];
      if ((specifier.startsWith('@/') || specifier.startsWith('./') || specifier.startsWith('../')) && !resolveLocalImport(file.path, specifier, paths, aliases)) {
        throw new ProjectCompletenessError(`Generated file ${file.path} imports missing local module ${specifier}.`);
      }
    }
  }
}

function validatePackage(files: ProjectFile[]) {
  const packageFile = get(files, 'package.json');
  if (!packageFile) return;
  let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try {
    pkg = JSON.parse(packageFile.content);
  } catch {
    return;
  }
  const deps = new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})]);
  const builtin = new Set(['fs', 'path', 'url', 'crypto', 'http', 'https', 'os', 'stream', 'util', 'events', 'buffer', 'assert', 'child_process', 'zlib', 'net', 'tls', 'module', 'querystring', 'string_decoder', 'timers', 'worker_threads']);
  const importPattern = /(?:import\s+(?:[\s\S]*?\s+from\s+|['"])|require\()(['"])([^'"./@][^'"]*|@[^/]+\/[^'"]+)\1/g;
  for (const file of files) {
    importPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(file.content)) !== null) {
      const specifier = match[2];
      const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      if (!builtin.has(packageName) && !deps.has(packageName)) {
        throw new ProjectCompletenessError(`Generated file ${file.path} imports ${packageName}, but package.json does not declare it.`);
      }
    }
  }
}

export function ensureCompleteNextProject(input: ProjectFile[], options: { requireShell?: boolean } = {}) {
  const files = dedupeLast(input);
  if (!files.length) throw new ProjectCompletenessError('Nexa returned no files.');
  if (!looksLikeNextProject(files)) return files;

  validateJson(files);
  validateContents(files);
  validatePackage(files);
  validateLocalImports(files);

  const requireShell = options.requireShell ?? true;
  const packageFile = get(files, 'package.json');
  if (requireShell) {
    if (!packageFile) throw new ProjectCompletenessError('Complete Next.js generation requires package.json.');
    let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    try { pkg = JSON.parse(packageFile.content); } catch { throw new ProjectCompletenessError('package.json is invalid JSON.'); }
    if (!pkg.dependencies?.next && !pkg.devDependencies?.next) throw new ProjectCompletenessError('package.json does not declare Next.js.');

    const hasAppPage = Boolean(
      get(files, 'app/page.tsx') || get(files, 'app/page.jsx') || get(files, 'app/page.ts') || get(files, 'app/page.js') ||
      get(files, 'src/app/page.tsx') || get(files, 'src/app/page.jsx') || get(files, 'src/app/page.ts') || get(files, 'src/app/page.js')
    );
    const hasPagesIndex = Boolean(
      get(files, 'pages/index.tsx') || get(files, 'pages/index.jsx') || get(files, 'pages/index.ts') || get(files, 'pages/index.js') ||
      get(files, 'src/pages/index.tsx') || get(files, 'src/pages/index.jsx') || get(files, 'src/pages/index.ts') || get(files, 'src/pages/index.js')
    );
    if (!hasAppPage && !hasPagesIndex) throw new ProjectCompletenessError('Complete generation requires app/page.tsx, src/app/page.tsx, pages/index.tsx, or src/pages/index.tsx. Nexa will not create a fake placeholder homepage.');
    const hasRootAppPage = Boolean(get(files, 'app/page.tsx') || get(files, 'app/page.jsx') || get(files, 'app/page.ts') || get(files, 'app/page.js'));
    const hasSrcAppPage = Boolean(get(files, 'src/app/page.tsx') || get(files, 'src/app/page.jsx') || get(files, 'src/app/page.ts') || get(files, 'src/app/page.js'));
    const hasRootLayout = Boolean(get(files, 'app/layout.tsx') || get(files, 'app/layout.jsx') || get(files, 'app/layout.ts') || get(files, 'app/layout.js'));
    const hasSrcLayout = Boolean(get(files, 'src/app/layout.tsx') || get(files, 'src/app/layout.jsx') || get(files, 'src/app/layout.ts') || get(files, 'src/app/layout.js'));
    if (hasRootAppPage && !hasRootLayout) throw new ProjectCompletenessError('App Router generation requires app/layout.tsx.');
    if (hasSrcAppPage && !hasSrcLayout) throw new ProjectCompletenessError('App Router generation requires src/app/layout.tsx.');
  }

  return files;
}

export function serializeFileBlocks(files: ProjectFile[]) {
  return files.map(file => `---FILE: ${file.path}---\n${file.content.replace(/\s+$/, '\n')}`).join('\n');
}
