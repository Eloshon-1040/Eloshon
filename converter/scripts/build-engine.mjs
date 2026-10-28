/**
 * Transpiles the pure TypeScript converter engine (core/src/*.ts, copied AS-IS
 * from Homie Book) into runnable ESM (core/dist/*.mjs). Types are stripped and
 * relative imports get an explicit .mjs extension (Node ESM requires it).
 * No bundler, no native binary — just the TypeScript compiler API.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'core', 'src');
const OUT = path.join(ROOT, 'core', 'dist');

// Clean slate: a renamed/deleted .ts must not leave its stale .mjs behind —
// `core/dist/**/*` ships into the installer, so staleness here ships too.
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const files = fs.readdirSync(SRC).filter((f) => f.endsWith('.ts'));
for (const f of files) {
  const source = fs.readFileSync(path.join(SRC, f), 'utf8');
  let { outputText } = ts.transpileModule(source, {
    fileName: f,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, isolatedModules: true, verbatimModuleSyntax: false },
  });
  // Add .mjs to EXTENSIONLESS relative specifiers in `... from './x'`,
  // `from '../x'`, `from './sub/x'` and dynamic `import('./x')`. The captured
  // segment allows no dot, so './x.mjs' is never double-suffixed.
  outputText = outputText.replace(/(from\s+|import\s*\(\s*)(['"])(\.\.?\/[A-Za-z0-9_/-]+)\2/g, (_m, pre, q, spec) => `${pre}${q}${spec}.mjs${q}`);
  fs.writeFileSync(path.join(OUT, f.replace(/\.ts$/, '.mjs')), outputText);
}

// GATE, not a courtesy log: the installer's `core/dist/**/*` glob does NOT
// fail when this directory is empty — electron-builder would happily package
// an app that crashes on `import '../core/dist/index.mjs'`. So an empty or
// index-less build is an error here, where it can still stop the pipeline.
if (files.length === 0 || !fs.existsSync(path.join(OUT, 'index.mjs'))) {
  console.error(`build-engine: produced ${files.length} modules and ${fs.existsSync(path.join(OUT, 'index.mjs')) ? 'an' : 'NO'} index.mjs — refusing to continue`);
  process.exit(1);
}
console.log('built', files.length, 'engine modules → core/dist');
