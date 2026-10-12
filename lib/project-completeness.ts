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
  const sourceOrConfig = /\.(?:tsx?|jsx?|mjs|cjs|json)$/i;
  for (const file of files) {
    // Documentation and arbitrary text assets may legitimately contain examples
    // or end with punctuation that resembles a truncated source file.
    if (!sourceOrConfig.test(file.path)) continue;
    if (obviousTruncation(file)) throw new ProjectCompletenessError(`Generated file ${file.path} is empty or appears truncated.`);
    if (/^```[\w-]*\s*$/m.test(file.content)) throw new ProjectCompletenessError(`Generated file ${file.path} contains an unfinished code fence.`);
  }
}

function getTsconfigPaths(files: ProjectFile[]) {
  const file = get(files, 'tsconfig.json');
  if (!file) return [{ alias: '@/', roots: [''] }];
  try {
    const config = JSON.parse(file.content) as {
      compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> };
    };
    const baseUrl = config.compilerOptions?.baseUrl ?? '.';
    const paths = config.compilerOptions?.paths ?? { '@/*': ['./*'] };
    const aliases: { alias: string; roots: string[] }[] = [];
    Object.entries(paths).forEach(([pattern, targets]) => {
      if (!pattern.endsWith('/*') || !Array.isArray(targets)) return;
      const alias = pattern.slice(0, -1);
      const wildcardTargets = targets.map(target => target.endsWith('/*') ? target.slice(0, -1) : target);
      aliases.push({ alias, roots: wildcardTargets.map(target => normalizePath(`${baseUrl}/${target}`)) });
    });
    return aliases.length ? aliases : [{ alias: '@/', roots: [normalizePath(baseUrl)] }];
  } catch {
    return [{ alias: '@/', roots: [''] }];
  }
}

function resolveLocalImport(fromPath: string, specifier: string, files: Set<string>, aliases: { alias: string; roots: string[] }[]) {
  let baseCandidates: string[] = [];
  const alias = aliases.find(item => specifier.startsWith(item.alias));
  if (alias) {
    const suffix = specifier.slice(alias.alias.length);
    baseCandidates = alias.roots.map(root => normalizePath(`${root}/${suffix}`));
  } else if (specifier.startsWith('./') || specifier.startsWith('../')) {
    baseCandidates = [normalizePath(`${fromPath.split('/').slice(0, -1).join('/')}/${specifier}`)];
  } else {
    return true;
  }
  const suffixes = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
  return baseCandidates.some(base => suffixes.some(suffix => files.has(normalizePath(`${base}${suffix}`))));
}

function validateLocalImports(files: ProjectFile[], existingFiles: ProjectFile[] = []) {
  // Imports may legitimately point to files already present in the project, even
  // when those files are not part of this proposal. Use both sets for resolution.
  const allFiles = [...existingFiles, ...files];
  const paths = new Set(allFiles.map(file => normalizePath(file.path)));
  const aliases = getTsconfigPaths(allFiles);
  const importPattern = /(?:import\s+(?:[\s\S]*?\s+from\s+|['"])|export\s+[\s\S]*?\s+from\s+|require\()(['"])([^'"]+)\1/g;
  for (const file of files) {
    if (!/\.(?:tsx?|jsx?|mjs|cjs)$/i.test(file.path)) continue;
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
    if (!/\.(?:tsx?|jsx?|mjs|cjs)$/i.test(file.path)) continue;
    importPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(file.content)) !== null) {
      const specifier = match[2];
      const importedName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
      const packageName = importedName.startsWith('node:') ? importedName.slice(5) : importedName;
      if (!builtin.has(packageName) && !deps.has(packageName)) {
        throw new ProjectCompletenessError(`Generated file ${file.path} imports ${packageName}, but package.json does not declare it.`);
      }
    }
  }
}

export function ensureCompleteNextProject(input: ProjectFile[], options: { requireShell?: boolean; existingFiles?: ProjectFile[] } = {}) {
  const files = dedupeLast(input);
  if (!files.length) throw new ProjectCompletenessError('Nexa returned no files.');

  // Validate a proposal in the context of the whole project. Proposals usually
  // contain only changed files, so the existing package.json/homepage/layout
  // must count when checking whether this is a complete Next.js project.
  const existingFiles = options.existingFiles ?? [];
  const projectFiles = dedupeLast([...existingFiles, ...files]);
  if (!looksLikeNextProject(projectFiles)) return files;

  // Only validate generated content. Existing files are context, not new output.
  validateJson(files);
  validateContents(files);
  validatePackage(files);
  validateLocalImports(files, existingFiles);

  const requireShell = options.requireShell ?? true;
  const packageFile = get(projectFiles, 'package.json');
  if (requireShell) {
    if (!packageFile) throw new ProjectCompletenessError('Complete Next.js generation requires package.json.');
    let pkg: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
    try { pkg = JSON.parse(packageFile.content); } catch { throw new ProjectCompletenessError('package.json is invalid JSON.'); }
    if (!pkg.dependencies?.next && !pkg.devDependencies?.next) throw new ProjectCompletenessError('package.json does not declare Next.js.');

    const hasAppPage = Boolean(
      get(projectFiles, 'app/page.tsx') || get(projectFiles, 'app/page.jsx') || get(projectFiles, 'app/page.ts') || get(projectFiles, 'app/page.js') ||
      get(projectFiles, 'src/app/page.tsx') || get(projectFiles, 'src/app/page.jsx') || get(projectFiles, 'src/app/page.ts') || get(projectFiles, 'src/app/page.js')
    );
    const hasPagesIndex = Boolean(
      get(projectFiles, 'pages/index.tsx') || get(projectFiles, 'pages/index.jsx') || get(projectFiles, 'pages/index.ts') || get(projectFiles, 'pages/index.js') ||
      get(projectFiles, 'src/pages/index.tsx') || get(projectFiles, 'src/pages/index.jsx') || get(projectFiles, 'src/pages/index.ts') || get(projectFiles, 'src/pages/index.js')
    );
    if (!hasAppPage && !hasPagesIndex) throw new ProjectCompletenessError('Complete generation requires app/page.tsx or pages/index.tsx. Nexa will not create a fake placeholder homepage.');
    const hasAppRouterPage = Boolean(get(projectFiles, 'app/page.tsx') || get(projectFiles, 'app/page.jsx') || get(projectFiles, 'app/page.ts') || get(projectFiles, 'app/page.js') || get(projectFiles, 'src/app/page.tsx') || get(projectFiles, 'src/app/page.jsx') || get(projectFiles, 'src/app/page.ts') || get(projectFiles, 'src/app/page.js'));
    const hasLayout = Boolean(
      get(projectFiles, 'app/layout.tsx') || get(projectFiles, 'app/layout.jsx') || get(projectFiles, 'app/layout.ts') || get(projectFiles, 'app/layout.js') ||
      get(projectFiles, 'src/app/layout.tsx') || get(projectFiles, 'src/app/layout.jsx') || get(projectFiles, 'src/app/layout.ts') || get(projectFiles, 'src/app/layout.js')
    );
    if (hasAppRouterPage && !hasLayout) {
      throw new ProjectCompletenessError('App Router generation requires app/layout.tsx or src/app/layout.tsx.');
    }
  }

  return files;
}

export function serializeFileBlocks(files: ProjectFile[]) {
  return files.map(file => `---FILE: ${file.path}---\n${file.content.replace(/\s+$/, '\n')}`).join('\n');
}
