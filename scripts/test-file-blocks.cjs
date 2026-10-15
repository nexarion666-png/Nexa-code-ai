/* Regression tests for generated-file response parsing. */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');
const assert = require('node:assert/strict');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nca-file-blocks-'));
try {
  const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'file-blocks.ts'), 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const compiledPath = path.join(temp, 'file-blocks.cjs');
  fs.writeFileSync(compiledPath, compiled);
  const { parseGeneratedFileBlocks: parse } = require(compiledPath);

  const valid = parse('---FILE: components/Hero.tsx---\nexport default function Hero(){ return <section>Hi</section>; }\n---FILE: app/page.tsx---\nimport Hero from "../components/Hero";\nexport default function Page(){ return <Hero/>; }');
  assert.equal(valid.length, 2);
  assert.equal(valid[0].path, 'components/Hero.tsx');
  assert.match(valid[0].content, /<\/section>/);
  console.log('PASS standard multi-file blocks');

  const fenced = parse('---FILE: components/Hero.tsx---\n```tsx\nexport default function Hero(){ return <section>Hi</section>; }\n```');
  assert.equal(fenced.length, 1);
  assert.match(fenced[0].content, /export default function Hero/);
  assert.doesNotMatch(fenced[0].content, /```/);
  console.log('PASS fenced code inside file block');

  assert.deepEqual(parse('I fixed the file, here is the explanation but no code block.'), []);
  assert.deepEqual(parse(''), []);
  console.log('PASS prose-only and empty responses rejected');

  assert.equal(parse('```tsx\nexport default function Hero(){ return <section>Hi</section>; }\n```', 'components/Hero.tsx')[0].path, 'components/Hero.tsx');
  console.log('PASS single fenced repair uses known target path');

  const json = parse(JSON.stringify({ files: [{ path: 'components/Hero.tsx', content: 'export default function Hero(){ return null; }' }] }));
  assert.equal(json.length, 1);
  assert.equal(json[0].path, 'components/Hero.tsx');
  console.log('PASS strict JSON file list');

  assert.deepEqual(parse('---FILE: ../secret.ts---\nnope'), []);
  assert.deepEqual(parse('---FILE: /etc/passwd---\nnope'), []);
  console.log('PASS unsafe paths rejected');

  const broken = parse('---FILE: components/Hero.tsx---\nexport default function Hero(){ return <section>broken; }');
  assert.equal(broken.length, 1);
  const transpile = ts.transpileModule(broken[0].content, { fileName: broken[0].path, reportDiagnostics: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX } });
  assert.ok((transpile.diagnostics || []).some(d => d.category === ts.DiagnosticCategory.Error), 'malformed JSX must remain detectable by syntax validation');
  console.log('PASS malformed JSX remains subject to syntax validation');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
