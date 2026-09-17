import { validateRelativePath } from '@/lib/security';
import {
  AgentAction,
  ProjectFile,
  ValidationIssue,
  ValidationResult,
} from './types';

type JsonObject = Record<string, unknown>;

const codeExtensions = new Set([
  '.js',
  '.jsx',
  '.ts',
  '.tsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
]);

const builtinModules = new Set([
  'assert',
  'buffer',
  'child_process',
  'crypto',
  'events',
  'fs',
  'http',
  'https',
  'module',
  'net',
  'os',
  'path',
  'querystring',
  'stream',
  'string_decoder',
  'url',
  'util',
  'zlib',
]);

const utilityClassPattern =
  /^(?:sm|md|lg|xl|2xl|dark|hover|focus|active|disabled|group-hover):?(?:container|flex|inline-flex|grid|block|hidden|items-[\w-]+|justify-[\w-]+|content-[\w-]+|gap(?:-[xy])?-[\w[\].:/%-]+|space-[xy]-[\w[\].:/%-]+|p[trblxy]?-[\w[\].:/%-]+|m[trblxy]?-[\w[\].:/%-]+|w-[\w[\].:/%-]+|h-[\w[\].:/%-]+|min-[wh]-[\w[\].:/%-]+|max-[wh]-[\w[\].:/%-]+|text-[\w[\].:/%-]+|font-[\w[\].:/%-]+|leading-[\w[\].:/%-]+|tracking-[\w[\].:/%-]+|bg-[\w[\].:/%-]+|border(?:-[\w[\].:/%-]+)?|rounded(?:-[\w[\].:/%-]+)?|shadow(?:-[\w[\].:/%-]+)?|ring(?:-[\w[\].:/%-]+)?|overflow-[\w-]+|aspect-[\w-]+)$/;

function issue(
  severity: ValidationIssue['severity'],
  code: string,
  message: string,
  path?: string,
): ValidationIssue {
  return { severity, code, message, ...(path ? { path } : {}) };
}

function extension(path: string) {
  const match = path.toLowerCase().match(/\.[^./]+$/);
  return match?.[0] ?? '';
}

function isCodeFile(path: string) {
  return codeExtensions.has(extension(path));
}

function packageName(specifier: string) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function readPackage(files: Map<string, string>, errors: ValidationIssue[]) {
  const content = files.get('package.json');
  if (content === undefined) return null;

  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      errors.push(issue('error', 'invalid-package-json', 'package.json must contain a JSON object.', 'package.json'));
      return null;
    }
    return parsed as JsonObject;
  } catch (error) {
    errors.push(
      issue(
        'error',
        'invalid-package-json',
        `package.json is not valid JSON: ${error instanceof Error ? error.message : 'parse error'}`,
        'package.json',
      ),
    );
    return null;
  }
}

function objectRecord(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function declaredDependencies(packageJson: JsonObject) {
  const dependencies = new Set<string>();
  for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const values = objectRecord(packageJson[field]);
    Object.keys(values).forEach((name) => dependencies.add(name));
  }
  return dependencies;
}

function hasFile(files: Map<string, string>, base: string) {
  const normalized = base.replaceAll('\\', '/').replace(/^\/+/, '');
  const candidates = [
    normalized,
    `${normalized}.ts`,
    `${normalized}.tsx`,
    `${normalized}.js`,
    `${normalized}.jsx`,
    `${normalized}.mjs`,
    `${normalized}.cjs`,
    `${normalized}.json`,
    `${normalized}.css`,
    `${normalized}/index.ts`,
    `${normalized}/index.tsx`,
    `${normalized}/index.js`,
    `${normalized}/index.jsx`,
  ];
  return candidates.some((candidate) => files.has(candidate));
}

function resolveLocalImport(importer: string, specifier: string, files: Map<string, string>) {
  const importerParts = importer.split('/');
  importerParts.pop();
  const parts = [...importerParts, ...specifier.split('/')];
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  return hasFile(files, normalized.join('/'));
}

function collectImports(source: string) {
  const imports: string[] = [];
  const patterns = [
    /(?:^|[;\n])\s*import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /(?:^|[;\n])\s*export\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/gm,
    /(?:^|[;\n])\s*(?:const\s+[\w$]+\s*=\s*)?require\s*\(\s*['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) imports.push(match[1]);
  }
  return imports;
}

function isExternalReference(specifier: string) {
  return !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('@/') && !specifier.startsWith('~');
}

function validateImports(
  files: Map<string, string>,
  packageJson: JsonObject | null,
  errors: ValidationIssue[],
) {
  const dependencies = packageJson ? declaredDependencies(packageJson) : new Set<string>();
  for (const [path, content] of files) {
    if (!isCodeFile(path)) continue;
    for (const specifier of collectImports(content)) {
      if (path === 'next-env.d.ts' && specifier.startsWith('./.next/')) continue;
      if (specifier.startsWith('@/')) {
        if (!hasFile(files, specifier.slice(2))) {
          errors.push(issue('error', 'missing-local-import', `The import "${specifier}" does not resolve to a project file.`, path));
        }
        continue;
      }
      if (specifier.startsWith('.')) {
        if (!resolveLocalImport(path, specifier, files)) {
          errors.push(issue('error', 'missing-local-import', `The relative import "${specifier}" does not resolve from ${path}.`, path));
        }
        continue;
      }
      if (!isExternalReference(specifier) || specifier.startsWith('node:')) continue;
      const root = packageName(specifier);
      if (builtinModules.has(root) || builtinModules.has(specifier)) continue;
      if (!dependencies.has(root)) {
        errors.push(issue('error', 'missing-dependency', `The imported package "${root}" is missing from package.json.`, path));
      }
    }
  }
}

function detectTailwindClasses(files: Map<string, string>) {
  const classes = new Set<string>();
  for (const [path, content] of files) {
    if (!/\.(?:tsx?|jsx?)$/i.test(path)) continue;
    for (const match of content.matchAll(/\bclassName\s*=\s*["'`]([^"'`]+)["'`]/g)) {
      for (const token of match[1].split(/\s+/)) {
        if (utilityClassPattern.test(token)) classes.add(token);
      }
    }
  }
  return classes;
}

function dependencyMajor(packageJson: JsonObject | null, name: string) {
  if (!packageJson) return null;
  const dependencies = {
    ...objectRecord(packageJson.dependencies),
    ...objectRecord(packageJson.devDependencies),
    ...objectRecord(packageJson.peerDependencies),
  };
  const spec = typeof dependencies[name] === 'string' ? dependencies[name] : '';
  const match = spec.match(/(?:^|[^\d])(\d+)(?:\.|$)/);
  return match ? Number(match[1]) : null;
}

function validateStyling(
  files: Map<string, string>,
  packageJson: JsonObject | null,
  errors: ValidationIssue[],
  warnings: ValidationIssue[],
) {
  const allSource = [...files.values()].join('\n');
  const directives = /@tailwind\s+(?:base|components|utilities)\b/.test(allSource);
  const hasTailwindDependency = packageJson ? declaredDependencies(packageJson).has('tailwindcss') : false;
  const tailwindMajor = dependencyMajor(packageJson, 'tailwindcss');
  const classes = detectTailwindClasses(files);
  const tailwindConfig = [...files.keys()].find((path) => /^tailwind\.config\.(?:js|cjs|mjs|ts)$/.test(path));
  const postcssConfig = [...files.keys()].find((path) => /^postcss\.config\.(?:js|cjs|mjs|ts)$/.test(path));
  const usesTailwind = directives || tailwindMajor !== null || classes.size >= 3;

  if (!usesTailwind) return;

  if (!hasTailwindDependency) {
    errors.push(
      issue(
        'error',
        'tailwind-missing-dependency',
        'Tailwind directives or utility classes were detected, but tailwindcss is not declared in package.json.',
        'package.json',
      ),
    );
    return;
  }

  if (tailwindMajor === null) {
    warnings.push(
      issue(
        'warning',
        'tailwind-version-unknown',
        'Tailwind is declared with a version range that could not be classified as v3 or v4; verify that its CSS and configuration syntax match the installed version.',
        'package.json',
      ),
    );
    return;
  }

  if (tailwindMajor >= 4) {
    if (directives) {
      errors.push(
        issue(
          'error',
          'tailwind-version-mismatch',
          'Tailwind v4 is declared, but the project uses Tailwind v3 @tailwind directives. Use the v4 CSS import or declare a compatible v3 version.',
          'app/globals.css',
        ),
      );
    }
    if (tailwindConfig || postcssConfig) {
      warnings.push(
        issue(
          'warning',
          'tailwind-v4-legacy-config',
          'Tailwind v4 is declared alongside a legacy Tailwind/PostCSS config. Confirm that the config is intentional.',
          tailwindConfig ?? postcssConfig,
        ),
      );
    }
    return;
  }

  if (!tailwindConfig) {
    errors.push(
      issue(
        'error',
        'tailwind-config-missing',
        'Tailwind v3 is used, but tailwind.config.js (or an equivalent config) is missing.',
        'tailwind.config.js',
      ),
    );
  }
  if (!postcssConfig) {
    errors.push(
      issue(
        'error',
        'postcss-config-missing',
        'Tailwind v3 is used, but postcss.config.js (or an equivalent config) is missing.',
        'postcss.config.js',
      ),
    );
  }

  if (tailwindConfig) {
    const config = files.get(tailwindConfig) ?? '';
    const requiredDirectories = ['app', 'components', 'pages'].filter((directory) =>
      [...files.keys()].some((path) => path.startsWith(`${directory}/`)),
    );
    const missingContentPath = requiredDirectories.some((directory) => !new RegExp(`(?:\\./)?${directory}/`).test(config));
    if (missingContentPath) {
      errors.push(
        issue(
          'error',
          'tailwind-content-paths-missing',
          `Tailwind content paths do not cover all project source directories: ${requiredDirectories.join(', ')}.`,
          tailwindConfig,
        ),
      );
    }
  }

  if (postcssConfig && !/tailwindcss/.test(files.get(postcssConfig) ?? '')) {
    warnings.push(
      issue(
        'warning',
        'postcss-tailwind-plugin-not-found',
        'The PostCSS config does not visibly reference tailwindcss; verify the plugin matches the declared Tailwind version.',
        postcssConfig,
      ),
    );
  }
  if (postcssConfig && /autoprefixer/.test(files.get(postcssConfig) ?? '') && !declaredDependencies(packageJson ?? {}).has('autoprefixer')) {
    errors.push(
      issue(
        'error',
        'missing-postcss-dependency',
        'The PostCSS config uses autoprefixer, but autoprefixer is missing from package.json.',
        postcssConfig,
      ),
    );
  }
}

function validateAssets(files: Map<string, string>, errors: ValidationIssue[]) {
  const assetPattern = /(?:src|href)\s*=\s*["']([^"']+\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(?:\?[^"']*)?)["']/gi;
  const cssAssetPattern = /url\(\s*["']?([^)"']+\.(?:png|jpe?g|gif|svg|webp|ico|woff2?|ttf)(?:\?[^)"']*)?)["']?\s*\)/gi;

  for (const [path, content] of files) {
    if (!isCodeFile(path)) continue;
    const references = [...content.matchAll(assetPattern), ...content.matchAll(cssAssetPattern)].map((match) => match[1]);
    for (const reference of references) {
      const clean = reference.split('?')[0];
      if (/^(?:https?:|data:|#)/i.test(clean)) continue;
      const target = clean.startsWith('/')
        ? `public/${clean.slice(1)}`
        : resolveAssetPath(path, clean);
      if (!hasFile(files, target)) {
        errors.push(issue('error', 'missing-asset', `The asset reference "${reference}" does not resolve to a project file.`, path));
      }
    }
  }
}

function resolveAssetPath(importer: string, reference: string) {
  const parts = importer.split('/');
  parts.pop();
  for (const part of reference.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

function validateFramework(packageJson: JsonObject | null, files: Map<string, string>, errors: ValidationIssue[], warnings: ValidationIssue[]) {
  if (!packageJson) {
    warnings.push(issue('warning', 'package-json-missing', 'No package.json is present, so dependency and production-build checks are unavailable.', 'package.json'));
    return;
  }

  const scripts = objectRecord(packageJson.scripts);
  const nextDependency = declaredDependencies(packageJson).has('next');
  if (nextDependency && typeof scripts.build !== 'string') {
    errors.push(issue('error', 'build-script-missing', 'A Next.js project must define a package.json build script.', 'package.json'));
  }
  if (!files.has('package-lock.json') && nextDependency) {
    warnings.push(issue('warning', 'lockfile-missing', 'The Next.js project has no package-lock.json; reproducible installation may not be available.', 'package-lock.json'));
  }
}

function validateWebsiteCompleteness(
  request: string | undefined,
  existingFiles: ProjectFile[],
  files: Map<string, string>,
  errors: ValidationIssue[],
) {
  if (existingFiles.length > 0 || !request || !/\b(?:website|web site|landing page|online store|e-?commerce|portfolio|dashboard|dealership)\b/i.test(request)) {
    return;
  }

  const pagePath = [...files.keys()].find((path) =>
    /^(?:app\/page|pages\/index)\.(?:tsx?|jsx?)$/.test(path),
  );
  const source = [...files.entries()]
    .filter(([path]) => /\.(?:tsx?|jsx?)$/i.test(path))
    .map(([path, content]) => `FILE: ${path}\n${content}`)
    .join('\n');

  if (!pagePath) {
    errors.push(
      issue(
        'error',
        'website-entrypoint-missing',
        'A new website must include an app/page.tsx or pages/index.tsx entrypoint.',
        'app/page.tsx',
      ),
    );
    return;
  }

  if (!/<(?:nav|header)\b/i.test(source)) {
    errors.push(
      issue(
        'error',
        'website-navigation-missing',
        'The website needs a navigation or header section so visitors can move through the experience.',
        pagePath,
      ),
    );
  }

  if (!/<main\b/i.test(source)) {
    errors.push(
      issue(
        'error',
        'website-main-missing',
        'The website needs a main content region beyond the page shell.',
        pagePath,
      ),
    );
  }

  const sectionCount = (source.match(/<section\b/gi) ?? []).length;
  if (sectionCount < 3) {
    errors.push(
      issue(
        'error',
        'website-sections-incomplete',
        `A complete website needs at least three meaningful content sections; only ${sectionCount} section${sectionCount === 1 ? '' : 's'} were generated.`,
        pagePath,
      ),
    );
  }

  if (!/<footer\b/i.test(source)) {
    errors.push(
      issue(
        'error',
        'website-footer-missing',
        'The website needs a footer with useful closing navigation or contact details.',
        pagePath,
      ),
    );
  }

  if (!/(?:<button\b|<a\b[^>]+href=|<form\b|onClick\s*=)/i.test(source)) {
    errors.push(
      issue(
        'error',
        'website-interaction-missing',
        'The website needs at least one usable call to action, link, form, or interaction.',
        pagePath,
      ),
    );
  }

  if (!/<button\b|type\s*=\s*["']submit["']|onClick\s*=/i.test(source)) {
    errors.push(
      issue(
        'error',
        'website-buttons-missing',
        'The website needs a visible button or interactive action, not only passive text and navigation.',
        pagePath,
      ),
    );
  }

  if (!/<(?:img|Image)\b|background-image\s*:|https?:\/\/[^"'` )]+(?:\.(?:png|jpe?g|gif|svg|webp)|[/?]image)/i.test(source)) {
    errors.push(
      issue(
        'error',
        'website-visual-missing',
        'The website needs at least one visual image or deliberate visual media treatment in the hero or content.',
        pagePath,
      ),
    );
  }

  if (!/(?:\b(?:bg|text|border|from|via|to)-[\w[\]/:%.-]+|#[0-9a-f]{3,8}\b|(?:color|background|font-family)\s*:)/i.test(source)) {
    errors.push(
      issue(
        'error',
        'website-design-missing',
        'The website needs an explicit visual design system with colors, backgrounds, or typography styling.',
        pagePath,
      ),
    );
  }

  if (!/(?:\b(?:sm|md|lg|xl):|@media\b)/i.test(source)) {
    errors.push(
      issue(
        'error',
        'website-responsive-missing',
        'The website needs responsive behavior for mobile and desktop layouts.',
        pagePath,
      ),
    );
  }
}

export function validateProjectActions(
  existingFiles: ProjectFile[],
  actions: AgentAction[],
  request?: string,
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const files = new Map<string, string>();
  const seenActions = new Set<string>();

  for (const file of existingFiles) {
    try {
      const path = validateRelativePath(file.path);
      files.set(path, file.content);
    } catch {
      errors.push(issue('error', 'invalid-project-path', `Existing project file "${file.path}" is not a safe relative path.`, file.path));
    }
  }

  for (const action of actions) {
    if (action.type === 'save_memory') {
      if (!action.content.trim()) errors.push(issue('error', 'empty-memory', 'A memory action cannot have empty content.'));
      continue;
    }

    let path: string;
    try {
      path = validateRelativePath(action.path);
    } catch {
      errors.push(issue('error', 'invalid-action-path', `The proposed path "${action.path}" is not a safe relative path.`, action.path));
      continue;
    }

    if (seenActions.has(path)) {
      errors.push(issue('error', 'duplicate-action-path', `Multiple proposed actions target "${path}"; the plan must resolve the conflict first.`, path));
    }
    seenActions.add(path);

    if (action.type === 'delete_file') files.delete(path);
    else files.set(path, action.content);
  }

  const packageJson = readPackage(files, errors);
  validateFramework(packageJson, files, errors, warnings);
  validateImports(files, packageJson, errors);
  validateStyling(files, packageJson, errors, warnings);
  validateAssets(files, errors);
  validateWebsiteCompleteness(request, existingFiles, files, errors);

  return {
    ok: errors.length === 0,
    errors,
    warnings,
  };
}