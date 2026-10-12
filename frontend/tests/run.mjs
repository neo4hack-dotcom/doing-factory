// Frontend unit tests without a test framework dependency: esbuild (already shipped with Vite)
// bundles each tests/*.test.ts(x) for Node, then Node's built-in runner executes them.
// A hard timeout guards against hangs — the Markdown regression tests exist to catch exactly that.
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = dirname(fileURLToPath(import.meta.url));
const outdir = join(here, '..', 'node_modules', '.cache', 'factory-tests');
const only = process.argv.slice(2);

const entries = readdirSync(here)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .filter((f) => only.length === 0 || only.some((o) => f.includes(o)))
  .map((f) => join(here, f));

if (entries.length === 0) {
  console.error('No test files matched.');
  process.exit(1);
}

rmSync(outdir, { recursive: true, force: true });
mkdirSync(outdir, { recursive: true });

await build({
  entryPoints: entries,
  outdir,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  jsx: 'automatic',
  outExtension: { '.js': '.mjs' },
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"test"' },
  // Bundled CommonJS deps (react-dom/server) require Node built-ins; give the ESM bundle a require().
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});

const files = readdirSync(outdir).filter((f) => f.endsWith('.mjs')).map((f) => join(outdir, f));
const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], { stdio: 'inherit', timeout: 120_000 });
if (res.error || res.signal) {
  console.error(`Test run aborted (${res.error?.message ?? res.signal}) — a test probably hung.`);
  process.exit(1);
}
process.exit(res.status ?? 1);
