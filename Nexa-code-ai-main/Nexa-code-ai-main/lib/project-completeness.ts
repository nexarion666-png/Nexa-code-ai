export type ProjectFile = { path: string; content: string };

const REQUIRED_SHELL: Record<string, string> = {
  'tsconfig.json': `{
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
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}\n`,
  'next-env.d.ts': `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// NOTE: This file should not be edited\n// see https://nextjs.org/docs/basic-features/typescript for more information.\n`,
  'next.config.js': `/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\nmodule.exports = nextConfig;\n`,
  'postcss.config.js': `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`,
  'tailwind.config.ts': `import type { Config } from 'tailwindcss';\n\nconst config: Config = {\n  content: [\n    './app/**/*.{js,ts,jsx,tsx,mdx}',\n    './components/**/*.{js,ts,jsx,tsx,mdx}',\n    './context/**/*.{js,ts,jsx,tsx,mdx}',\n    './lib/**/*.{js,ts,jsx,tsx,mdx}',\n  ],\n  theme: { extend: {} },\n  plugins: [],\n};\n\nexport default config;\n`,
  'app/globals.css': `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root { color-scheme: dark; }\n\n* { box-sizing: border-box; }\n\nhtml, body { margin: 0; padding: 0; min-height: 100%; }\n\nbody { background: #09090b; color: #fafafa; }\n`,
  'app/layout.tsx': `import './globals.css';\nimport type { Metadata } from 'next';\n\nexport const metadata: Metadata = { title: 'Nexa App', description: 'Built with Nexa Code AI' };\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return <html lang="en"><body>{children}</body></html>;\n}\n`,
};

function normalizePath(path: string): string {
  return path.trim().replace(/^\/+/, '').replace(/\\/g, '/');
}

function has(files: ProjectFile[], path: string): boolean {
  return files.some(file => normalizePath(file.path) === path);
}

function get(files: ProjectFile[], path: string): ProjectFile | undefined {
  return files.find(file => normalizePath(file.path) === path);
}

function looksLikeNext(files: ProjectFile[]): boolean {
  const packageFile = get(files, 'package.json');
  if (packageFile) {
    try {
      const pkg = JSON.parse(packageFile.content || '{}');
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) return true;
    } catch { /* validation below reports malformed package.json */ }
  }
  return has(files, 'app/page.tsx') || has(files, 'app/page.jsx') || has(files, 'pages/index.tsx') || has(files, 'pages/index.jsx');
}

function balancedSource(source: string): boolean {
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  const stack: string[] = [];
  const pairs: Record<string, string> = { ')': '(', ']': '[', '}': '{' };
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const n = source[i + 1];
    if (lineComment) { if (c === '\n') lineComment = false; continue; }
    if (blockComment) { if (c === '*' && n === '/') { blockComment = false; i += 1; } continue; }
    if (quote) {
      if (escaped) { escaped = false; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '/' && n === '/') { lineComment = true; i += 1; continue; }
    if (c === '/' && n === '*') { blockComment = true; i += 1; continue; }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      if (stack.pop() !== pairs[c]) return false;
    }
  }
  return !quote && !blockComment && stack.length === 0;
}

export function ensureProjectPackage(files: ProjectFile[]): ProjectFile[] {
  const out = files.slice();
  const pkg = get(out, 'package.json');
  let parsed: Record<string, unknown> = {};
  if (pkg) {
    try { parsed = JSON.parse(pkg.content || '{}') as Record<string, unknown>; } catch { return out; }
  }
  const deps = { ...((parsed.dependencies as Record<string, string>) || {}) };
  if (!deps.next) deps.next = '14.2.15';
  if (!deps.react) deps.react = '^18.3.1';
  if (!deps['react-dom']) deps['react-dom'] = '^18.3.1';
  parsed.dependencies = deps;
  const content = JSON.stringify(parsed, null, 2) + '\n';
  if (pkg) pkg.content = content;
  else out.push({ path: 'package.json', content });
  return out;
}

export function ensureNextProjectShell(files: ProjectFile[]): { files: ProjectFile[]; errors: string[]; warnings: string[] } {
  let out = files.map(file => ({ path: normalizePath(file.path), content: file.content ?? '' }));
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!looksLikeNext(out)) return { files: out, errors, warnings };

  const pkg = get(out, 'package.json');
  if (!pkg) errors.push('package.json is missing.');
  else {
    try {
      const parsed = JSON.parse(pkg.content || '{}') as Record<string, unknown>;
      const deps = { ...((parsed.dependencies as Record<string, string>) || {}), ...((parsed.devDependencies as Record<string, string>) || {}) };
      if (!deps.next || !deps.react || !deps['react-dom']) errors.push('package.json is missing Next.js core dependencies (next, react, react-dom).');
    } catch { errors.push('package.json is not valid JSON.'); }
  }

  const hasAppPage = has(out, 'app/page.tsx') || has(out, 'app/page.jsx') || has(out, 'pages/index.tsx') || has(out, 'pages/index.jsx');
  if (!hasAppPage) {
    errors.push('app/page.tsx is missing. Nexa will not create a fake placeholder page; the proposal is rejected as incomplete so the model can regenerate it.');
  }

  const shellDefaults = REQUIRED_SHELL;
  for (const path of Object.keys(shellDefaults)) {
    if (!has(out, path)) {
      out.push({ path, content: shellDefaults[path] });
      warnings.push(`Added missing project shell file: ${path}`);
    }
  }

  for (const file of out) {
    const p = normalizePath(file.path);
    if (!file.content.trim()) errors.push(`${p} is empty.`);
    if (/\.(tsx?|jsx?|mjs|cjs)$/.test(p) && !balancedSource(file.content)) errors.push(`${p} appears to contain unbalanced or truncated source syntax.`);
    if (p.endsWith('.json')) {
      try { JSON.parse(file.content); } catch { errors.push(`${p} is not valid JSON.`); }
    }
    if (/\.(tsx?|jsx?)$/.test(p) && /```(?:tsx?|jsx?)/i.test(file.content)) errors.push(`${p} contains an unclosed markdown code fence.`);
  }
  return { files: out, errors, warnings };
}
