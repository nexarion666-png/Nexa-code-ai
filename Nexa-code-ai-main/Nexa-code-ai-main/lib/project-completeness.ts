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

function has(files: ProjectFile[], path: string) {
  return files.some(file => file.path === path);
}

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
      pkg = { ...DEFAULT_PACKAGE, dependencies: { ...DEFAULT_PACKAGE.dependencies }, devDependencies: { ...DEFAULT_PACKAGE.devDependencies } };
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

function defaultPage(files: ProjectFile[]) {
  const existing = get(files, 'app/page.tsx') || get(files, 'pages/index.tsx');
  if (existing) return existing.content;
  const title = get(files, 'package.json')?.content.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || 'Nexa App';
  return `export default function HomePage() {\n  return (\n    <main className="min-h-screen bg-white text-zinc-900">\n      <div className="mx-auto flex min-h-screen max-w-6xl items-center justify-center px-6 py-16">\n        <section className="w-full max-w-3xl">\n          <p className="text-sm font-medium text-zinc-500">Next.js application</p>\n          <h1 className="mt-3 text-4xl font-bold tracking-tight">${title}</h1>\n          <p className="mt-4 text-zinc-600">Your project is ready to build and customize.</p>\n        </section>\n      </div>\n    </main>\n  );\n}\n`;
}

export function ensureCompleteNextProject(input: ProjectFile[]) {
  const files = input.map(file => ({ path: file.path, content: file.content }));
  if (!looksLikeNextProject(files)) return files;

  const packageJson = packageContent(files);
  upsert(files, 'package.json', packageJson);
  const packageFile = get(files, 'package.json');
  if (packageFile) packageFile.content = packageJson;

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
}\n`);
  upsert(files, 'next-env.d.ts', `/// <reference types="next" />\n/// <reference types="next/image-types/global" />\n\n// NOTE: This file should not be edited\n// see https://nextjs.org/docs/basic-features/typescript for more information.\n`);
  upsert(files, 'next.config.js', `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  reactStrictMode: true,\n};\n\nmodule.exports = nextConfig;\n`);
  upsert(files, 'postcss.config.js', `module.exports = {\n  plugins: {\n    tailwindcss: {},\n    autoprefixer: {},\n  },\n};\n`);
  upsert(files, 'tailwind.config.ts', `import type { Config } from 'tailwindcss';\n\nconst config: Config = {\n  content: [\n    './app/**/*.{js,ts,jsx,tsx,mdx}',\n    './components/**/*.{js,ts,jsx,tsx,mdx}',\n    './context/**/*.{js,ts,jsx,tsx,mdx}',\n    './lib/**/*.{js,ts,jsx,tsx,mdx}',\n  ],\n  theme: { extend: {} },\n  plugins: [],\n};\n\nexport default config;\n`);
  upsert(files, 'app/globals.css', `@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n:root {\n  color-scheme: light;\n}\n\nhtml, body {\n  min-height: 100%;\n}\n\nbody {\n  margin: 0;\n}\n`);
  upsert(files, 'app/layout.tsx', `import './globals.css';\n\nexport const metadata = {\n  title: 'Nexa App',\n  description: 'Generated with Nexa Code AI',\n};\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`);
  upsert(files, 'app/page.tsx', defaultPage(files));

  return files;
}

export function serializeFileBlocks(files: ProjectFile[]) {
  return files.map(file => `---FILE: ${file.path}---\n${file.content.replace(/\s+$/, '\n')}`).join('\n');
}
