export type ProjectFile = { path: string; content: string };

const DEFAULT_PACKAGE = {
  name: 'nexa-generated-app', version: '0.1.0', private: true,
  scripts: { dev: 'next dev', build: 'next build', start: 'next start', lint: 'next lint' },
  dependencies: { next: '14.2.15', react: '^18.3.1', 'react-dom': '^18.3.1' },
  devDependencies: { '@types/node': '^20.17.10', '@types/react': '^18.3.12', '@types/react-dom': '^18.3.1', autoprefixer: '^10.4.20', postcss: '^8.4.49', tailwindcss: '^3.4.16', typescript: '^5.7.2' },
};

function get(files: ProjectFile[], path: string) { return files.find(file => file.path === path); }
function upsert(files: ProjectFile[], path: string, content: string) { if (!get(files, path)) files.push({ path, content }); }

function looksLikeNextProject(files: ProjectFile[]) {
  const packageFile = get(files, 'package.json');
  if (packageFile) {
    try {
      const pkg = JSON.parse(packageFile.content) as { dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown> };
      return Boolean(pkg.dependencies?.next || pkg.devDependencies?.next);
    } catch { return true; }
  }
  return files.some(file => /^app\/(layout|page)\.(tsx?|jsx?)$/.test(file.path) || /^pages\/(index|_app)\.(tsx?|jsx?)$/.test(file.path));
}

function packageContent(files: ProjectFile[]) {
  const packageFile = get(files, 'package.json');
  let pkg: any;
  try { pkg = packageFile ? JSON.parse(packageFile.content) : { ...DEFAULT_PACKAGE }; } catch { pkg = { ...DEFAULT_PACKAGE }; }
  pkg.name = typeof pkg.name === 'string' && pkg.name.trim() ? pkg.name : DEFAULT_PACKAGE.name;
  pkg.version = typeof pkg.version === 'string' ? pkg.version : DEFAULT_PACKAGE.version;
  pkg.private = true;
  pkg.scripts = { ...DEFAULT_PACKAGE.scripts, ...(pkg.scripts ?? {}) };
  pkg.dependencies = { ...(pkg.dependencies ?? {}), ...DEFAULT_PACKAGE.dependencies };
  pkg.devDependencies = { ...(pkg.devDependencies ?? {}), ...DEFAULT_PACKAGE.devDependencies };
  return JSON.stringify(pkg, null, 2) + '\n';
}

function routeToFiles(route: string) {
  const clean = route.split('?')[0].replace(/^\/+|\/+$/g, '');
  if (!clean) return ['app/page.tsx', 'app/page.jsx', 'pages/index.tsx', 'pages/index.jsx'];
  const segments = clean.split('/');
  const dynamic = segments.map(segment => segment.startsWith(':') ? `[${segment.slice(1)}]` : segment);
  const base = dynamic.join('/');
  return [`app/${base}/page.tsx`, `app/${base}/page.jsx`, `pages/${base}.tsx`, `pages/${base}.jsx`];
}

function hasRoute(files: ProjectFile[], route: string) { return routeToFiles(route).some(path => Boolean(get(files, path))); }

function requestedRoutes(requirements: string) {
  const found = new Set<string>();
  const regex = /(?:^|\s|[(:])\/(?!\/)[a-zA-Z0-9_\-\[\]:]+(?:\/[a-zA-Z0-9_\-\[\]:]+)*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(requirements)) !== null) {
    const route = match[0].trim().replace(/^[(:\s]+/, '');
    if (route && route !== '/api' && !route.includes('http')) found.add(route);
  }
  return Array.from(found);
}

function validateSource(files: ProjectFile[]) {
  const errors: string[] = [];
  for (const file of files) {
    const content = file.content.trim();
    if (!content) { errors.push(`${file.path} is empty`); continue; }
    if (/```(?:tsx?|jsx?|json|css|js)?\s*$|^```/.test(content)) errors.push(`${file.path} contains an unfinished code fence`);
    if (/\b(?:TODO|FIXME)\s*:\s*(?:complete|implement|finish)/i.test(content)) errors.push(`${file.path} contains an unfinished implementation marker`);
    if (file.path.endsWith('.json')) {
      try { JSON.parse(content); } catch { errors.push(`${file.path} is not valid JSON`); }
    }
  }
  return errors;
}

export function ensureCompleteNextProject(input: ProjectFile[], requirements = '') {
  const files = input.map(file => ({ path: file.path, content: file.content }));
  if (!looksLikeNextProject(files)) return files;

  const packageJson = packageContent(files);
  const packageFile = get(files, 'package.json');
  if (packageFile) packageFile.content = packageJson; else files.push({ path: 'package.json', content: packageJson });

  upsert(files, 'tsconfig.json', `{
  "compilerOptions": { "target": "es5", "lib": ["dom", "dom.iterable", "esnext"], "allowJs": true, "skipLibCheck": true, "strict": true, "noEmit": true, "esModuleInterop": true, "module": "esnext", "moduleResolution": "bundler", "resolveJsonModule": true, "isolatedModules": true, "jsx": "preserve", "incremental": true, "plugins": [{ "name": "next" }], "paths": { "@/*": ["./*"] } },
  "include": ["next-env.d.ts", ".next/types/**/*.ts", "**/*.ts", "**/*.tsx"], "exclude": ["node_modules"]
}\n`);
  upsert(files, 'next-env.d.ts', `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n`);
  upsert(files, 'next.config.js', `/** @type {import('next').NextConfig} */\nconst nextConfig = { reactStrictMode: true };\nmodule.exports = nextConfig;\n`);
  upsert(files, 'postcss.config.js', `module.exports = { plugins: { tailwindcss: {}, autoprefixer: {} } };\n`);
  upsert(files, 'tailwind.config.ts', `import type { Config } from 'tailwindcss';\nconst config: Config = { content: ['./app/**/*.{js,ts,jsx,tsx,mdx}', './components/**/*.{js,ts,jsx,tsx,mdx}', './context/**/*.{js,ts,jsx,tsx,mdx}', './lib/**/*.{js,ts,jsx,tsx,mdx}'], theme: { extend: {} }, plugins: [] };\nexport default config;\n`);
  upsert(files, 'app/globals.css', `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\nhtml, body { min-height: 100%; }\nbody { margin: 0; }\n`);
  upsert(files, 'app/layout.tsx', `import './globals.css';\nexport const metadata = { title: 'Nexa App', description: 'Generated with Nexa Code AI' };\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body>{children}</body></html>; }\n`);

  const hasHome = hasRoute(files, '/');
  if (!hasHome) throw new Error('Nexa stopped before producing a complete project: app/page.tsx is missing.');

  const errors = validateSource(files);
  if (errors.length) throw new Error(`Nexa stopped before producing a complete project: ${errors.join('; ')}`);

  const required = requestedRoutes(requirements).filter(route => route !== '/');
  const missing = required.filter(route => !hasRoute(files, route));
  if (missing.length) throw new Error(`Nexa stopped before producing a complete project: missing requested route file(s): ${missing.join(', ')}`);

  return files;
}

export function serializeFileBlocks(files: ProjectFile[]) {
  return files.map(file => `---FILE: ${file.path}---\n${file.content.replace(/\s+$/, '\n')}`).join('\n');
}
