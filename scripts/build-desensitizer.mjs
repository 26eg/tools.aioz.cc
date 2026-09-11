import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

await mkdir('xlsx-desensitizer/dist', { recursive: true });
await build({
  entryPoints: ['xlsx-desensitizer/src/app.ts', 'xlsx-desensitizer/src/worker.ts'],
  outdir: 'xlsx-desensitizer/dist', bundle: true, format: 'esm',
  target: 'es2022', minify: true, legalComments: 'eof', charset: 'utf8',
});
const licenses = [];
for (const [name, path] of [
  ['fflate 0.8.3', 'fflate/LICENSE'],
  ['@xmldom/xmldom 0.9.12', '@xmldom/xmldom/LICENSE'],
  ['acorn 8.18.0', 'acorn/LICENSE'],
  ['parse5 8.0.1', 'parse5/LICENSE'],
  ['entities (parse5 dependency)', 'entities/LICENSE'],
]) licenses.push(`${name}\n${await readFile(`node_modules/${path}`, 'utf8')}`);
await writeFile('xlsx-desensitizer/dist/THIRD-PARTY-LICENSES.txt', licenses.join('\n\n'));
console.log('Desensitizer browser bundles built.');
