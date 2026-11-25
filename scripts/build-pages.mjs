import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, '.pages-dist');
const assets = [
  'index.html', '404.html', 'site.css', '_headers', '_redirects',
  'qr-code-tool/index.html',
  'qr-code-tool/vendor/jsQR.js', 'qr-code-tool/vendor/qrcode-generator.js',
  'tampermonkey-scripts/index.html',
  'tampermonkey-scripts/amazon-category-insights-json-capture/amazon-category-insights-json-capture.user.js',
  'tampermonkey-scripts/amazon-category-insights-json-capture/LICENSE-fflate.txt',
  'tampermonkey-scripts/amazon-category-node-mapper/amazon-category-node-mapper.user.js',
  'tampermonkey-scripts/amazon-category-node-mapper/LICENSE-SheetJS.txt',
  'tampermonkey-scripts/amazon-signin-blocker/amazon-signin-blocker.user.js',
  'tampermonkey-scripts/gas-spring-scraper/gas-spring-scraper.user.js',
  'xlsx-desensitizer/index.html', 'xlsx-desensitizer/style.css',
  'xlsx-desensitizer/dist/app.js', 'xlsx-desensitizer/dist/worker.js',
  'xlsx-desensitizer/dist/THIRD-PARTY-LICENSES.txt',
  'xlsx-image-link-to-image-tool/index.html',
  'xlsx-workbook-merger/index.html', 'xlsx-workbook-merger/app.js', 'xlsx-workbook-merger/core.js',
  'xlsx-workbook-merger/vendor/exceljs.min.js', 'xlsx-workbook-merger/vendor/LICENSE.exceljs.txt',
];
const manifest = 'tampermonkey-scripts/manifest.json';
const allowed = [...assets, manifest];

async function checkOutput(relative = '') {
  for (const entry of await readdir(join(output, relative), { withFileTypes: true })) {
    const name = relative + entry.name;
    if (entry.isDirectory() && allowed.some((file) => file.startsWith(name + '/'))) {
      await checkOutput(name + '/');
    } else if (!entry.isFile() || !allowed.includes(name)) {
      throw new Error(`Unexpected Pages output: ${name}. Move the output directory aside and rebuild.`);
    }
  }
}

await mkdir(output, { recursive: true });
const outputEntry = (await readdir(root, { withFileTypes: true })).find((entry) => entry.name === '.pages-dist');
if (!outputEntry?.isDirectory()) throw new Error('Pages output must be a real directory.');
await checkOutput();
for (const asset of assets) {
  const target = join(output, asset);
  await mkdir(dirname(target), { recursive: true });
  await copyFile(join(root, asset), target);
}
execFileSync(process.execPath, [join(root, 'scripts/build-manifest.mjs'), join(output, manifest)], { stdio: 'inherit' });
console.log(`Pages preview built in ${output}`);
