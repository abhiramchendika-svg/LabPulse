// Pre-compresses the built web app (gzip + brotli) so the server can send small
// files without spending CPU on every request. Matters most on small/free hosts.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const COMPRESSIBLE = /\.(js|mjs|css|html|svg|json|wasm|ttf|txt|map)$/;
let before = 0;
let after = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (COMPRESSIBLE.test(entry.name)) compress(file);
  }
}

function compress(file) {
  const data = fs.readFileSync(file);
  if (data.length < 1024) return;
  const br = zlib.brotliCompressSync(data, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  const gz = zlib.gzipSync(data, { level: 9 });
  fs.writeFileSync(`${file}.br`, br);
  fs.writeFileSync(`${file}.gz`, gz);
  before += data.length;
  after += br.length;
}

walk(dist);
console.log(`Pre-compressed web app: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB (brotli)`);
