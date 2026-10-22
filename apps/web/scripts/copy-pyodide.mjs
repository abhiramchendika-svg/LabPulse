// Copies the Pyodide runtime into public/pyodide so the student editor works on a
// lab network without internet access (no CDN needed).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.dirname(require.resolve('pyodide/package.json'));
const dest = path.resolve(here, '../public/pyodide');
const files = ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];

fs.mkdirSync(dest, { recursive: true });
for (const f of files) {
  const from = path.join(src, f);
  if (!fs.existsSync(from)) throw new Error(`Pyodide file missing: ${from}`);
  const to = path.join(dest, f);
  const a = fs.statSync(from);
  if (fs.existsSync(to) && fs.statSync(to).size === a.size) continue;
  fs.copyFileSync(from, to);
}
console.log(`Pyodide runtime ready in ${path.relative(process.cwd(), dest)}`);
