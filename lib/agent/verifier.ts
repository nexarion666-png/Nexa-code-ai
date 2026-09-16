import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { validateProjectActions } from './validation';
import { ProjectFile, VerificationResult } from './types';
import { validateRelativePath } from '@/lib/security';

const execFileAsync = promisify(execFile);
const MAX_OUTPUT = 24000;
const BUILD_TIMEOUT_MS = 180000;

function truncate(value: string) {
  return value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}\n...[truncated]` : value;
}

function redact(value: string) {
  return truncate(
    value
      .replace(/(?:sk|rk)-[A-Za-z0-9_-]{12,}/g, '[redacted-key]')
      .replace(/AIza[A-Za-z0-9_-]{20,}/g, '[redacted-key]')
      .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, '[redacted-token]')
      .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer [redacted-token]'),
  );
}

function buildArgs(script: unknown) {
  if (script === 'next build') return [];
  if (script === 'next build --webpack') return ['--webpack'];
  if (script === 'next build --turbopack') return ['--turbopack'];
  return null;
}

async function writeWorkspace(root: string, files: ProjectFile[]) {
  for (const file of files) {
    const normalized = validateRelativePath(file.path);
    if (normalized === 'node_modules' || normalized.startsWith('node_modules/')) continue;
    if (normalized === '.git' || normalized.startsWith('.git/')) continue;
    const destination = path.resolve(root, ...normalized.split('/'));
    if (destination !== root && !destination.startsWith(`${root}${path.sep}`)) {
      throw new Error(`Unsafe verification path: ${file.path}`);
    }
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file.content, 'utf8');
  }
}

async function runCommand(command: string, args: string[], cwd: string) {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      shell: false,
      timeout: BUILD_TIMEOUT_MS,
      maxBuffer: 300000,
      env: {
        PATH: process.env.PATH ?? '',
        HOME: cwd,
        NODE_ENV: 'production',
        CI: '1',
        NEXT_TELEMETRY_DISABLED: '1',
        npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false',
        npm_config_fund: 'false',
      },
    });
    return { ok: true, output: redact(`${result.stdout}\n${result.stderr}`) };
  } catch (error) {
    const failure = error as { message?: string; stdout?: string; stderr?: string };
    return {
      ok: false,
      output: redact(`${failure.stdout ?? ''}\n${failure.stderr ?? ''}\n${failure.message ?? 'Command failed.'}`),
    };
  }
}

export async function verifyProjectBuild(files: ProjectFile[]): Promise<VerificationResult> {
  const staticValidation = validateProjectActions(files, []);
  if (!staticValidation.ok) {
    return {
      phase: 'static',
      ok: false,
      staticValidation,
      build: {
        attempted: false,
        passed: false,
        reason: 'Static project consistency checks failed.',
      },
    };
  }

  const packageFile = files.find((file) => file.path === 'package.json');
  if (!packageFile) {
    return {
      phase: 'unsupported',
      ok: false,
      staticValidation,
      build: {
        attempted: false,
        passed: false,
        reason: 'Build verification currently supports Next.js projects with package.json.',
      },
    };
  }

  let packageJson: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> };
  try {
    packageJson = JSON.parse(packageFile.content) as typeof packageJson;
  } catch {
    return {
      phase: 'static',
      ok: false,
      staticValidation: {
        ok: false,
        errors: [{ severity: 'error', code: 'invalid-package-json', message: 'package.json is not valid JSON.', path: 'package.json' }],
        warnings: staticValidation.warnings,
      },
      build: { attempted: false, passed: false, reason: 'package.json is not valid JSON.' },
    };
  }

  const hasNext = Boolean(packageJson.dependencies?.next || packageJson.devDependencies?.next);
  const args = buildArgs(packageJson.scripts?.build);
  if (!hasNext || !args) {
    return {
      phase: 'unsupported',
      ok: false,
      staticValidation,
      build: {
        attempted: false,
        passed: false,
        reason: 'Build verification currently supports only an explicit Next.js "next build" script.',
      },
    };
  }

  const root = await mkdtemp(path.join('/tmp', 'nexa-build-'));
  try {
    await writeWorkspace(root, files);
    const installArgs = files.some((file) => file.path === 'package-lock.json')
      ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
      : ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
    const install = await runCommand('npm', installArgs, root);
    if (!install.ok) {
      return {
        phase: 'build',
        ok: false,
        staticValidation,
        build: {
          attempted: true,
          passed: false,
          command: `${installArgs[0] === 'ci' ? 'npm ci' : 'npm install'} --ignore-scripts --no-audit --no-fund`,
          output: install.output,
          reason: 'Dependency installation failed before the production build.',
        },
      };
    }

    const nextCli = path.join(root, 'node_modules', 'next', 'dist', 'bin', 'next');
    try {
      await readFile(nextCli);
    } catch {
      return {
        phase: 'build',
        ok: false,
        staticValidation,
        build: {
          attempted: true,
          passed: false,
          command: `node node_modules/next/dist/bin/next build${args.length ? ` ${args.join(' ')}` : ''}`,
          output: 'Next.js was not installed after the controlled dependency installation.',
          reason: 'The Next.js build entrypoint is missing.',
        },
      };
    }

    const build = await runCommand(process.execPath, [nextCli, 'build', ...args], root);
    return {
      phase: 'build',
      ok: build.ok,
      staticValidation,
      build: {
        attempted: true,
        passed: build.ok,
        command: `node node_modules/next/dist/bin/next build${args.length ? ` ${args.join(' ')}` : ''}`,
        output: build.output,
        reason: build.ok ? undefined : 'The production build failed.',
      },
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}