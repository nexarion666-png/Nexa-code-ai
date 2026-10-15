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
  return Boolean(path) && !path.split('/').some(part => part === '..') && !path.includes('\\') && !path.startsWith('/');
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

function normalizeEncodedManifest(files: ProjectFile[]) {
  const packageFile = get(files, 'package.json');
  if (!packageFile) return;
  try {
    JSON.parse(packageFile.content);
    return;
  } catch {
    // Some model responses accidentally put base64-encoded JSON into package.json.
    // Decode only when the entire payload is valid base64 and decodes to a JSON object.
    const encoded = packageFile.content.trim();
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return;
    try {
      const decoded = Buffer.from(encoded, 'base64').toString('utf8');
      const parsed = JSON.parse(decoded);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        packageFile.content = `${JSON.stringify(parsed, null, 2)}\n`;
      }
    } catch {
      // Leave invalid manifests untouched so validation reports the real failure.
    }
  }
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

// Known runtime packages commonly emitted by Next.js app builders. Pinning a
// compatible major range lets Nexa repair the manifest deterministically instead
// of spending another model call on a dependency that can be inferred safely.
const KNOWN_PACKAGE_RANGES: Record<string, string> = {
  clsx: '^2.1.1',
  'tailwind-merge': '^2.6.0',
  'class-variance-authority': '^0.7.1',
  'lucide-react': '^0.468.0',
  zod: '^3.24.1',
  'react-hook-form': '^7.54.2',
  '@hookform/resolvers': '^3.9.1',
  'date-fns': '^4.1.0',
  recharts: '^2.15.0',
  sonner: '^1.7.1',
  'framer-motion': '^11.15.0',
  'react-icons': '^5.4.0',
  zustand: '^5.0.2',
  'lucide': '^0.468.0',
  '@radix-ui/react-dialog': '^1.1.4',
  '@radix-ui/react-slot': '^1.1.1',
  '@radix-ui/react-dropdown-menu': '^2.1.4',
  '@radix-ui/react-tabs': '^1.1.2',
  '@radix-ui/react-label': '^2.1.1',
  '@radix-ui/react-select': '^2.1.4',
  '@radix-ui/react-separator': '^1.1.1',
  '@radix-ui/react-avatar': '^1.1.2',
  '@radix-ui/react-checkbox': '^1.1.3',
  '@radix-ui/react-switch': '^1.1.2',
};

function packageNameFromSpecifier(specifier: string) {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
}

function validatePackage(files: ProjectFile[]) {
  const packageFile = get(files, 'package.json');
  if (!packageFile) return;
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; [key: string]: unknown };
  try {
    pkg = JSON.parse(packageFile.content);
  } catch {
    throw new ProjectCompletenessError('package.json is not valid JSON. Nexa will repair the manifest before saving.');
  }
  pkg.dependencies ??= {};
  pkg.devDependencies ??= {};
  const deps = new Set([...Object.keys(pkg.dependencies), ...Object.keys(pkg.devDependencies)]);
  const builtin = new Set(['fs', 'path', 'url', 'crypto', 'http', 'https', 'os', 'stream', 'util', 'events', 'buffer', 'assert', 'child_process', 'zlib', 'net', 'tls', 'module', 'querystring', 'string_decoder', 'timers', 'worker_threads', 'dns', 'readline', 'tty', 'vm', 'perf_hooks', 'async_hooks', 'console', 'process']);
  const importPattern = /(?:import\s+(?:[\s\S]*?\s+from\s+|['"])|export\s+[\s\S]*?\s+from\s+|require\s*\(|import\s*\()(['"])([^'"]+)\1/g;
  const missingKnown = new Set<string>();
  for (const file of files) {
    importPattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = importPattern.exec(file.content)) !== null) {
      const specifier = match[2];
      if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('@/')) continue;
      const packageName = packageNameFromSpecifier(specifier);
      if (builtin.has(packageName.replace(/^node:/, '')) || deps.has(packageName)) continue;
      if (KNOWN_PACKAGE_RANGES[packageName]) missingKnown.add(packageName);
      else throw new ProjectCompletenessError(`Generated file ${file.path} imports ${packageName}, but package.json does not declare it. Add a compatible dependency or correct the import.`);
    }
  }
  if (missingKnown.size) {
    for (const name of Array.from(missingKnown)) pkg.dependencies[name] = KNOWN_PACKAGE_RANGES[name];
    packageFile.content = `${JSON.stringify(pkg, null, 2)}\n`;
  }
}

export function ensureCompleteNextProject(input: ProjectFile[], options: { requireShell?: boolean; existingFiles?: ProjectFile[] } = {}) {
  const files = dedupeLast(input);
  if (!files.length) throw new ProjectCompletenessError('Nexa returned no files.');
  if (!looksLikeNextProject(files)) return files;

  normalizeEncodedManifest(files);
  validateJson(files);
  validateContents(files);
  validatePackage(files);
  validateLocalImports(files, options.existingFiles ?? []);

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
    if (!hasAppPage && !hasPagesIndex) throw new ProjectCompletenessError('Complete generation requires app/page.tsx or pages/index.tsx. Nexa will not create a fake placeholder homepage.');
    const hasAppRouterPage = Boolean(get(files, 'app/page.tsx') || get(files, 'app/page.jsx') || get(files, 'app/page.ts') || get(files, 'app/page.js') || get(files, 'src/app/page.tsx') || get(files, 'src/app/page.jsx') || get(files, 'src/app/page.ts') || get(files, 'src/app/page.js'));
    const hasLayout = Boolean(
      get(files, 'app/layout.tsx') || get(files, 'app/layout.jsx') || get(files, 'app/layout.ts') || get(files, 'app/layout.js') ||
      get(files, 'src/app/layout.tsx') || get(files, 'src/app/layout.jsx') || get(files, 'src/app/layout.ts') || get(files, 'src/app/layout.js')
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
