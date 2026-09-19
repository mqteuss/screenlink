import { constants as zlibConstants, brotliCompress, gzip } from 'node:zlib';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const brotli = promisify(brotliCompress);
const gzipFile = promisify(gzip);
const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = path.join(PROJECT_DIR, 'dist');
const COMPRESSIBLE_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.svg', '.wasm']);
const MINIMUM_BYTES = 256;

async function filesBelow(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(entry => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(entryPath) : [entryPath];
  }));
  return nested.flat();
}

let originalBytes = 0;
let brotliBytes = 0;
let gzipBytes = 0;
let compressedFiles = 0;

for (const filePath of await filesBelow(DIST_DIR)) {
  const extension = path.extname(filePath).toLowerCase();
  if (!COMPRESSIBLE_EXTENSIONS.has(extension)) continue;
  const source = await readFile(filePath);
  if (source.byteLength < MINIMUM_BYTES) continue;

  const [brotliResult, gzipResult] = await Promise.all([
    brotli(source, {
      params: {
        [zlibConstants.BROTLI_PARAM_MODE]: extension === '.wasm' ? zlibConstants.BROTLI_MODE_GENERIC : zlibConstants.BROTLI_MODE_TEXT,
        [zlibConstants.BROTLI_PARAM_QUALITY]: 11
      }
    }),
    gzipFile(source, { level: 9 })
  ]);

  const writes = [];
  if (brotliResult.byteLength < source.byteLength) writes.push(writeFile(`${filePath}.br`, brotliResult));
  if (gzipResult.byteLength < source.byteLength) writes.push(writeFile(`${filePath}.gz`, gzipResult));
  if (!writes.length) continue;
  await Promise.all(writes);
  originalBytes += source.byteLength;
  brotliBytes += brotliResult.byteLength;
  gzipBytes += gzipResult.byteLength;
  compressedFiles += 1;
}

const percentage = (compressed, original) => original ? Math.round((1 - compressed / original) * 1_000) / 10 : 0;
console.log(`Precompressed ${compressedFiles} files: Brotli -${percentage(brotliBytes, originalBytes)}%, gzip -${percentage(gzipBytes, originalBytes)}%.`);
