import ts from 'typescript';
import path from 'node:path';
import { ensureCompleteNextProject, type ProjectFile } from '@/lib/project-completeness';

function getVirtualScriptExtension(filePath: string): ts.Extension {
  const normalized = filePath.replace(/\\/g, '/').toLowerCase();
  if (normalized.endsWith('.d.ts')) return ts.Extension.Dts;
  if (normalized.endsWith('.tsx')) return ts.Extension.Tsx;
  if (normalized.endsWith('.ts')) return ts.Extension.Ts;
  if (normalized.endsWith('.jsx')) return ts.Extension.Jsx;
  if (normalized.endsWith('.js')) return ts.Extension.Js;
  if (normalized.endsWith('.json')) return ts.Extension.Json;
  if (normalized.endsWith('.mts')) return ts.Extension.Mts;
  if (normalized.endsWith('.cts')) return ts.Extension.Cts;
  if (normalized.endsWith('.mjs')) return ts.Extension.Mjs;
  if (normalized.endsWith('.cjs')) return ts.Extension.Cjs;
  return ts.Extension.Ts;
}

export type BuildFile = { path: string; content: string };

/** Fast syntax validation. This catches malformed TS/JS/JSX without emitting output. */
export function validateGeneratedSyntax(files: BuildFile[]) {
  const sourceExtensions = /\.(?:tsx?|jsx?)$/i;
  for (const file of files) {
    if (!sourceExtensions.test(file.path) || /\.d\.ts$/i.test(file.path)) continue;
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

/**
 * Cross-file type check for generated source. Syntax transpilation alone misses
 * errors such as `shoe.brand` when the shared Shoe type has no `brand` field.
 * The virtual project prevents generated source from being written to disk.
 * External package resolution uses NCA's installed types as a best-effort check;
 * missing external modules are handled by validatePackage / the real deployment build.
 */
function collectTypeDiagnostics(
  generatedFiles: { path: string; content: string }[],
  existingFiles: { path: string; content: string }[],
) {
  const all = new Map<string, string>();
  for (const file of existingFiles) all.set(file.path.replace(/^\.\//, ''), file.content);
  for (const file of generatedFiles) all.set(file.path.replace(/^\.\//, ''), file.content);

  const sourceFiles = [...all.keys()].filter(filePath => /\.(?:tsx?|jsx?)$/i.test(filePath));
  const sourceFileSet = new Set(sourceFiles);
  if (!sourceFiles.length) return [] as { path: string; code: number; message: string; line: number; column: number }[];

  const virtualRoot = '/__nexa_generated_project__';
  const virtualPath = (relative: string) => `${virtualRoot}/${relative.replace(/^\//, '')}`;
  const virtualContents = new Map([...all.entries()].map(([filePath, content]) => [virtualPath(filePath), content]));
  const configText = all.get('tsconfig.json');
  let declaredDependencies = new Set<string>();
  try {
    const packageJson = JSON.parse(all.get('package.json') ?? '{}');
    declaredDependencies = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ]);
  } catch { /* Package validation reports malformed JSON separately. */ }
  let config: any = {};
  if (configText) {
    try { config = JSON.parse(configText); } catch { /* validateJson reports this first */ }
  }
  const rawOptions = config.compilerOptions ?? {};
  const parsedOptions = ts.convertCompilerOptionsFromJson(rawOptions, virtualRoot).options;
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.Preserve,
    strict: rawOptions.strict !== false,
    skipLibCheck: true,
    allowJs: sourceFiles.some(filePath => /\.jsx?$/i.test(filePath)),
    esModuleInterop: true,
    resolveJsonModule: true,
    ...parsedOptions,
    typeRoots: [path.join(process.cwd(), 'node_modules', '@types')],
    noEmit: true,
    incremental: false,
  };
  const baseHost = ts.createCompilerHost(options, true);
  const normalize = (fileName: string) => fileName.replace(/\\/g, '/');
  const host: ts.CompilerHost = {
    ...baseHost,
    getCurrentDirectory: () => virtualRoot,
    fileExists(fileName) {
      const name = normalize(fileName);
      return virtualContents.has(name) || baseHost.fileExists(fileName);
    },
    readFile(fileName) {
      const name = normalize(fileName);
      return virtualContents.get(name) ?? baseHost.readFile(fileName);
    },
    getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile) {
      const name = normalize(fileName);
      const content = virtualContents.get(name);
      if (content !== undefined) return ts.createSourceFile(fileName, content, languageVersion, true);
      return baseHost.getSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    },
    resolveModuleNames(moduleNames, containingFile) {
      return moduleNames.map(specifier => {
        // Styles and static assets are handled by the framework bundler, not the
        // TypeScript source checker. Do not accidentally parse CSS as TypeScript.
        if (/\.(?:css|scss|sass|less|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i.test(specifier)) return undefined;
        const normalizedContaining = normalize(containingFile);
        const relative = normalizedContaining.startsWith(`${virtualRoot}/`)
          ? normalizedContaining.slice(virtualRoot.length + 1)
          : '';
        const base = relative.split('/').slice(0, -1).join('/');
        const tsConfigPaths = rawOptions.paths ?? { '@/*': ['./*'] };
        const baseUrl = String(rawOptions.baseUrl ?? '.');
        const candidates: string[] = [];
        if (specifier.startsWith('./') || specifier.startsWith('../')) {
          candidates.push(`${base}/${specifier}`);
        } else {
          for (const [pattern, targets] of Object.entries(tsConfigPaths) as [string, string[]][]) {
            const star = pattern.indexOf('*');
            if (star >= 0 && specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1))) {
              const middle = specifier.slice(pattern.slice(0, star).length, specifier.length - pattern.slice(star + 1).length);
              for (const target of targets) candidates.push(`${baseUrl}/${target.replace('*', middle)}`);
            } else if (pattern === specifier) {
              for (const target of targets) candidates.push(`${baseUrl}/${target}`);
            }
          }
        }
        const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json', '.d.ts', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];
        for (const candidate of candidates) {
          const clean = path.posix.normalize(candidate).replace(/^\.\//, '');
          for (const extension of extensions) {
            const resolved = virtualPath(`${clean}${extension}`);
            if (virtualContents.has(resolved)) {
              return { resolvedFileName: resolved, extension: getVirtualScriptExtension(resolved) };
            }
          }
        }
        const packageContainingFile = `${process.cwd()}/__nexa_generated_project__/${relative}`;
        return ts.resolveModuleName(specifier, packageContainingFile, options, ts.sys).resolvedModule;
      });
    },
  };
  const program = ts.createProgram({ rootNames: sourceFiles.map(virtualPath), options, host });
  return ts.getPreEmitDiagnostics(program)
    .filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)
    .filter(diagnostic => !diagnostic.file || sourceFileSet.has(normalize(diagnostic.file.fileName).startsWith(`${virtualRoot}/`) ? normalize(diagnostic.file.fileName).slice(virtualRoot.length + 1) : normalize(diagnostic.file.fileName)))
    .filter(diagnostic => ![2307, 7016, 2688].includes(diagnostic.code))
    // If @types/react is declared by the generated project but unavailable in
    // NCA's own install tree, don't misreport the missing ambient React namespace
    // as a project defect. The isolated/real project build will verify it.
    .filter(diagnostic => !(declaredDependencies.has('@types/react') && (
      (diagnostic.code === 2503 && /Cannot find namespace ['\"]React['\"]/.test(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '))) ||
      (diagnostic.code === 7026 && /JSX element implicitly has type ['\"]any['\"] because no interface ['\"]JSX\.IntrinsicElements['\"] exists/.test(ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')))
    )))
    .map(diagnostic => {
      const fullPath = diagnostic.file ? normalize(diagnostic.file.fileName) : '';
      const relativePath = fullPath.startsWith(`${virtualRoot}/`) ? fullPath.slice(virtualRoot.length + 1) : 'project';
      const position = diagnostic.file && diagnostic.start !== undefined
        ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
        : null;
      return {
        path: relativePath,
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
        line: position ? position.line + 1 : 0,
        column: position ? position.character + 1 : 0,
      };
    });
}

/**
 * Type-check the merged project, not only files returned by the model. A changed
 * shared type can break an unchanged page/component, so diagnostics from every
 * file are compared against the pre-change baseline. Only newly introduced
 * errors block a proposal; unrelated legacy errors do not prevent all editing.
 */
export function validateGeneratedTypes(
  generatedFiles: { path: string; content: string }[],
  existingFiles: { path: string; content: string }[],
) {
  const baseline = collectTypeDiagnostics([], existingFiles);
  const after = collectTypeDiagnostics(generatedFiles, existingFiles);
  const fingerprint = (diagnostic: { path: string; code: number; message: string }) =>
    `${diagnostic.path}|TS${diagnostic.code}|${diagnostic.message}`;
  const generatedPaths = new Set(generatedFiles.map(file => file.path.replace(/^\.\//, '')));
  const baselineCounts = new Map<string, number>();
  for (const diagnostic of baseline) {
    const key = fingerprint(diagnostic);
    baselineCounts.set(key, (baselineCounts.get(key) ?? 0) + 1);
  }
  const introduced = after.filter(diagnostic => {
    // A generated file must be valid even if the same error already existed in
    // its previous version. Baseline suppression applies only to untouched files.
    if (generatedPaths.has(diagnostic.path)) return true;
    const key = fingerprint(diagnostic);
    const remaining = baselineCounts.get(key) ?? 0;
    if (remaining > 0) {
      baselineCounts.set(key, remaining - 1);
      return false;
    }
    return true;
  });
  if (!introduced.length) return;
  const diagnostic = introduced[0];
  const where = diagnostic.line ? `:${diagnostic.line}:${diagnostic.column}` : '';
  throw new Error(`Generated project file ${diagnostic.path}${where} has a TypeScript type error (TS${diagnostic.code}): ${diagnostic.message}`);
}


/**
 * Static preflight before deployment. This does not execute project code or install
 * untrusted packages; Vercel's own production build remains the final authority.
 */
export function validateProjectPreflight(files: BuildFile[]) {
  if (!files.length) throw new Error('The project has no files to build.');
  const seen = new Set<string>();
  for (const file of files) {
    const filePath = file.path.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '');
    if (!filePath || filePath.startsWith('/') || /^[a-zA-Z]:/.test(filePath) || filePath.split('/').some(part => part === '..' || part === '.')) {
      throw new Error(`Unsafe project file path: ${file.path}`);
    }
    if (/[\u0000-\u001f]/.test(filePath)) throw new Error(`Invalid control character in project file path: ${file.path}`);
    if (seen.has(filePath)) throw new Error(`Duplicate project file path: ${filePath}`);
    seen.add(filePath);
    if (typeof file.content !== 'string') throw new Error(`File ${filePath} has no text content.`);
  }
  const byPath = new Map(files.map(file => [file.path.replace(/^\.\//, ''), file.content]));
  const packageText = byPath.get('package.json');
  if (!packageText) throw new Error('Build preflight failed: package.json is missing.');
  let packageJson: { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
  try { packageJson = JSON.parse(packageText); }
  catch { throw new Error('Build preflight failed: package.json is not valid JSON.'); }
  if (!packageJson.dependencies?.next && !packageJson.devDependencies?.next) {
    throw new Error('Build preflight failed: package.json must declare Next.js.');
  }
  const hasPage = ['app/page.tsx','app/page.jsx','app/page.ts','app/page.js','src/app/page.tsx','src/app/page.jsx','src/app/page.ts','src/app/page.js','pages/index.tsx','pages/index.jsx','pages/index.ts','pages/index.js','src/pages/index.tsx','src/pages/index.jsx','src/pages/index.ts','src/pages/index.js'].some(path => byPath.has(path));
  if (!hasPage) throw new Error('Build preflight failed: the project needs app/page.* or pages/index.*.');
  const hasAppPage = ['app/page.tsx','app/page.jsx','app/page.ts','app/page.js','src/app/page.tsx','src/app/page.jsx','src/app/page.ts','src/app/page.js'].some(path => byPath.has(path));
  const hasLayout = ['app/layout.tsx','app/layout.jsx','app/layout.ts','app/layout.js','src/app/layout.tsx','src/app/layout.jsx','src/app/layout.ts','src/app/layout.js'].some(path => byPath.has(path));
  if (hasAppPage && !hasLayout) throw new Error('Build preflight failed: App Router projects need app/layout.* or src/app/layout.*.');
  for (const file of files) {
    if (/\.json$/i.test(file.path)) {
      try { JSON.parse(file.content); } catch { throw new Error(`Build preflight failed: ${file.path} is not valid JSON.`); }
    }
  }
  const safeFiles: ProjectFile[] = files.map(file => ({ path: file.path, content: file.content }));
  ensureCompleteNextProject(safeFiles, { requireShell: true });
  validateGeneratedSyntax(files);
  validateGeneratedTypes(files, []);
  return { ok: true as const, filesChecked: files.length, checks: ['safe-paths', 'project-structure', 'json-and-dependencies', 'local-imports', 'syntax', 'cross-file-types'] };
}
