/* Lightweight regression tests for NCA's static build validator. Run with: npm run test:build-validation */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-build-validation-'));
try {
  const completenessSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'project-completeness.ts'), 'utf8');
  const completenessJs = ts.transpileModule(completenessSource, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const completenessPath = path.join(temp, 'project-completeness.cjs');
  fs.writeFileSync(completenessPath, completenessJs);

  let validationJs = ts.transpileModule(fs.readFileSync(path.join(__dirname, '..', 'lib', 'build-validation.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  validationJs = validationJs.replace('require("@/lib/project-completeness")', `require(${JSON.stringify(completenessPath)})`);
  const validationPath = path.join(temp, 'build-validation.cjs');
  fs.writeFileSync(validationPath, validationJs);
  const validator = require(validationPath);

  const baseFiles = [
    { path: 'package.json', content: JSON.stringify({ scripts: { build: 'next build' }, dependencies: { next: '14.2.15', react: '18.3.1', 'react-dom': '18.3.1' } }) },
    { path: 'tsconfig.json', content: JSON.stringify({ compilerOptions: { strict: true, paths: { '@/*': ['./*'] } } }) },
    { path: 'app/page.tsx', content: 'import { Shoe } from "@/types"; export default function Page(){ const shoe = {} as Shoe; return <div>{shoe.name}</div> }' },
    { path: 'app/layout.tsx', content: 'import \"./globals.css\"; export default function RootLayout({children}:{children:any}) { return <html><body>{children}</body></html> }' },
    { path: 'app/globals.css', content: '@tailwind base;\nbody { color: #111; }' },
    { path: 'types.ts', content: 'export type Shoe = { id: string; name: string }' },
    { path: 'jsx.d.ts', content: 'declare namespace JSX { interface IntrinsicElements { [elemName: string]: any } }' },
  ];

  assert.equal(validator.validateProjectPreflight(baseFiles).ok, true, 'a valid project should pass static preflight');
  console.log('PASS valid project');

  const missingProperty = baseFiles.map(file => file.path === 'app/page.tsx' ? { ...file, content: file.content.replace('shoe.name', 'shoe.brand') } : file);
  assert.throws(() => validator.validateProjectPreflight(missingProperty), /Property 'brand' does not exist/, 'cross-file type mismatch should fail preflight');
  console.log('PASS cross-file type mismatch');

  assert.throws(
    () => validator.validateGeneratedSyntax([{ path: 'lib/data.ts', content: 'export const label = \"broken\n' }]),
    /Unterminated string literal|Invalid character|Declaration or statement expected/,
    'unterminated strings should be rejected before a proposal is saved',
  );
  console.log('PASS malformed generated string rejection');

  const changedSharedType = [{ path: 'types.ts', content: 'export type Shoe = { id: string }' }];
  assert.throws(
    () => validator.validateGeneratedTypes(changedSharedType, baseFiles),
    /app\/page\.tsx.*Property 'name' does not exist|Property 'name' does not exist.*app\/page\.tsx/,
    'a change to a shared type must catch errors in unchanged dependent files',
  );
  console.log('PASS changed shared type checks unchanged dependents');

  const existingBrokenPage = baseFiles.map(file => file.path === 'app/page.tsx' ? { ...file, content: file.content.replace('shoe.name', 'shoe.brand') } : file);
  assert.throws(
    () => validator.validateGeneratedTypes([{ path: 'app/page.tsx', content: existingBrokenPage.find(file => file.path === 'app/page.tsx').content }], existingBrokenPage),
    /Property 'brand' does not exist/,
    'generated files must not inherit the baseline exemption for their own errors',
  );
  console.log('PASS generated file errors cannot be hidden by baseline');

  const unsafePath = baseFiles.map(file => file.path === 'types.ts' ? { ...file, path: '../types.ts' } : file);
  assert.throws(() => validator.validateProjectPreflight(unsafePath), /Unsafe project file path/, 'unsafe paths should fail preflight');
  console.log('PASS unsafe path rejection');

  const malformedJson = baseFiles.map(file => file.path === 'package.json' ? { ...file, content: '{invalid' } : file);
  assert.throws(() => validator.validateProjectPreflight(malformedJson), /package\.json is not valid JSON/, 'malformed package.json should fail preflight');
  console.log('PASS malformed package.json');

  const missingDependency = baseFiles.map(file => file.path === 'app/page.tsx' ? { ...file, content: 'import { motion } from "framer-motion"; export default function Page(){ return <div>{String(motion)}</div> }' } : file);
  assert.throws(() => validator.validateProjectPreflight(missingDependency), /does not declare it/, 'undeclared package imports should fail preflight');
  console.log('PASS undeclared dependency');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
