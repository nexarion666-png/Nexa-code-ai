export type ProjectFile = { path: string; content: string };

const DEFAULT_PACKAGE = {
  name: 'nexa-generated-app',
  version: '0.1.0',
  private: true,
  scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
  dependencies: { next: '14.2.15', react: '^18.3.1', 'react-dom': '^18.3.1' },
  devDependencies: {
    '@types/node': '^20.17.10',
    '@types/react': '^18.3.12',
    '@types/react-dom': '^18.3.1',
    autoprefixer: '^10.4.20',
    postcss: '^8.4.49',
    tailwindcss: '^3.4.16',
    typescript: '^5.7.2',
  },
};

function get(files: ProjectFile[], path: string) {
  return files.find(file => file.path === path);
}

function upsert(files: ProjectFile[], path: string, content: string) {
  const existing = get(files, path);
  if (existing) return;
  files.push({ path, content });
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

function packageContent(files: ProjectFile[]) {
  const packageFile = get(files, 'package.json');
  let pkg: any = { ...DEFAULT_PACKAGE, dependencies: { ...DEFAULT_PACKAGE.dependencies }, devDependencies: { ...DEFAULT_PACKAGE.devDependencies } };
  if (packageFile) {
    try {
      pkg = JSON.parse(packageFile.content);
    } catch {
      throw new Error('Generated package.json is not valid JSON.');
    }
  }
  pkg.name = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name : 'nexa-generated-app';
  pkg.version = typeof pkg.version === 'string' ? pkg.version : '0.1.0';
  pkg.private = true;
  pkg.scripts = { ...DEFAULT_PACKAGE.scripts, ...(pkg.scripts ?? {}) };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), ...DEFAULT_PACKAGE.dependencies };
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), ...DEFAULT_PACKAGE.devDependencies };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function validateSource(file: ProjectFile): string | null {
  const content = file.content.trim();
  if (!content) return `${file.path} is empty.`;

  if (/```(?:tsx?|jsx?|json|css|javascript|typescript)?\s*$/.test(content) || /^```/.test(content)) {
    return `${file.path} still contains an unfinished code fence.`;
  }

  const pairs: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
  const stack: string[] = [];
  let quote: string | null = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = 0; i < content.length; i += 1) {
    const c = content[i];
    const n = content[i + 1];

    if (lineComment) {
      if (c === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (c === '*' && n === '/') {
        blockComment = false;
        i += 1;
      }
      continue;
    }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === '}' || c === ']' || c === ')') {
      if (stack.pop() !== c) return `${file.path} has unbalanced syntax.`;
    }
  }

  if (quote || blockComment || stack.length) return `${file.path} appears truncated or has unclosed syntax.`;

  if (file.path === 'package.json') {
    try { JSON.parse(file.content); } catch { return 'package.json is not valid JSON.'; }
  }
  return null;
}

function routeFileExists(files: ProjectFile[], route: string) {
  const clean = route.replace(/^\/+/, '').replace(/\/+$/, '');
  return [
    `app/${clean}/page.tsx`,
    `app/${clean}/page.ts`,
    `app/${clean}/page.jsx`,
    `app/${clean}/page.js`,
    `pages/${clean}.tsx`,
    `pages/${clean}.jsx`,
  ].some(path => Boolean(get(files, path)));
}

function inferRequiredRoutes(requirements: string) {
  const routes = new Set<string>();
  const matches = requirements.match(/(?:^|[\s`"'(])\/([a-zA-Z0-9_-]+(?:\/\[[^\]]+\])?)(?=$|[\s`"'.,):])/g) ?? [];
  for (const raw of matches) {
    const route = raw.trim().replace(/^[`"'(\s]+/, '').replace(/[.,):`"'\s]+$/, '');
    if (route && route !== '/api' && !route.includes('http')) routes.add(route);
  }
  return [...routes];
}

export function ensureCompleteNextProject(input: ProjectFile[], requirements = '') {
  const files = input.map(file => ({ path: file.path, content: file.content }));
  if (!looksLikeNextProject(files)) return files;

  const packageJson = packageContent(files);
  const packageFile = get(files, 'package.json');
  if (packageFile) packageFile.content = packageJson;
  else upsert(files, 'package.json', packageJson);

  upsert(files, 'tsconfig.json', `{
  "compilerOptions": {
    "target": "es5",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": true,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", ".next/types/**/*.ts", "**/*.ts", "**/*.tsx"],
  "exclude": ["node_modules"]
}
`);
  upsert(files, 'next-env.d.ts', `/// <reference types="next" />
/// <reference types="next/image-types/global" />
`);
  upsert(files, 'next.config.js', `/** @type {import('next').NextConfig} */
const nextConfig = { reactStrictMode: true };
module.exports = nextConfig;
`);
  upsert(files, 'postcss.config.js', `module.exports = {
  plugins: { tailwindcss: {}, autoprefixer: {} },
};
`);
  upsert(files, 'tailwind.config.ts', `import type { Config } from 'tailwindcss';

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './context/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: { extend: {} },
  plugins: [],
};
export default config;
`);
  upsert(files, 'app/globals.css', `@tailwind base;
@tailwind components;
@tailwind utilities;

:root { color-scheme: light; }
html, body { min-height: 100%; }
body { margin: 0; }
`);
  upsert(files, 'app/layout.tsx', `import './globals.css';

export const metadata = {
  title: 'Nexa App',
  description: 'Generated with Nexa Code AI',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
`);

  const hasHome = ['app/page.tsx', 'app/page.jsx', 'app/page.js', 'pages/index.tsx', 'pages/index.jsx'].some(path => Boolean(get(files, path)));
  if (!hasHome) throw new Error('Generated project is missing the required homepage (app/page.tsx or pages/index). Nexa will not create a fake placeholder page.');

  const errors = files.map(validateSource).filter((error): error is string => Boolean(error));
  if (errors.length) throw new Error(`Generated project validation failed: ${errors.slice(0, 8).join(' ')}`);

  const requiredRoutes = inferRequiredRoutes(requirements);
  const missingRoutes = requiredRoutes.filter(route => !routeFileExists(files, route));
  if (missingRoutes.length) {
    throw new Error(`Generated project is incomplete. Missing requested route page(s): ${missingRoutes.join(', ')}. Regenerate instead of saving a partial proposal.`);
  }

  return files;
}

export function serializeFileBlocks(files: ProjectFile[]) {
  return files.map(file => `---FILE: ${file.path}---
${file.content.replace(/\s+$/, '\n')}`).join('\n');
}
