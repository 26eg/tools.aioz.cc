import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { engine as e } from './load-desensitizer-test.mjs';

const root = process.cwd();
const samplePath = path.resolve(process.argv[2] ?? '../自动脱敏工作簿/可测试功能的数据源.xlsx');
const output = path.resolve(process.env.AIOZ_BROWSER_OUTPUT ?? '.test-output/browser');
await mkdir(output, { recursive: true });
const source = new Uint8Array(await readFile(samplePath));
const sourceName = path.basename(samplePath);
const headersText = await readFile('_headers', 'utf8');
const csp = headersText.match(/Content-Security-Policy: (.*)/)[1];
const serverRequests = [];
const server = createServer(async (request, response) => {
  serverRequests.push({ method: request.method, url: request.url, contentLength: request.headers['content-length'] ?? null });
  try {
    if (request.method !== 'GET') { response.writeHead(405).end(); return; }
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith('/xlsx-desensitizer/') && pathname !== '/' && pathname !== '/index.html' && pathname !== '/favicon.ico') { response.writeHead(404).end(); return; }
    if (pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
    let filename = path.resolve(root, `.${pathname}`);
    if (!filename.startsWith(`${root}${path.sep}`) && filename !== root) { response.writeHead(403).end(); return; }
    if ((await stat(filename)).isDirectory()) filename = path.join(filename, 'index.html');
    const type = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' }[path.extname(filename)] ?? 'text/plain';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Security-Policy': csp, 'X-Content-Type-Options': 'nosniff' });
    response.end(await readFile(filename));
  } catch { response.writeHead(404).end(); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, ...(process.env.AIOZ_BROWSER_CHANNEL ? { channel: process.env.AIOZ_BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1050 } });
  const page = await context.newPage();
  const errors = [], network = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  context.on('request', (request) => network.push({ method: request.method(), url: request.url(), body: request.postData() }));
  await page.goto(`${base}/xlsx-desensitizer/`);
  await page.screenshot({ path: path.join(output, '01-empty-desktop.png'), fullPage: true });
  await page.locator('#sourceFile').setInputFiles(samplePath);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('全列扫描完成'));
  assert.match(await page.locator('#analysisSummary').innerText(), /100 条数据 · 177 列 · 477 个假空白/);
  assert.equal(await page.locator('#columns tr').count(), 21);
  await page.locator('#focusColumns').uncheck();
  assert.equal(await page.locator('#columns tr').count(), 177);
  await page.locator('#focusColumns').check();
  await page.screenshot({ path: path.join(output, '02-analysis-desktop.png'), fullPage: true });
  // All dependencies are already loaded: each operation below also runs with networking disabled.
  await context.setOffline(true);
  const downloadResult = async () => {
    await page.waitForFunction(() => !document.getElementById('result').classList.contains('hidden'), { timeout: 60000 });
    const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#download').click()]);
    return { name: download.suggestedFilename(), bytes: new Uint8Array(await readFile(await download.path())) };
  };
  await page.locator('#run').click();
  const zipped = await downloadResult();
  const zip = e.openZip(zipped.bytes);
  assert.equal(Object.keys(zip).length, 2);
  const workbookName = Object.keys(zip).find((name) => name.includes('_已脱密_'));
  const dictionaryName = Object.keys(zip).find((name) => name.includes('_脱密字典_'));
  assert.ok(workbookName && dictionaryName);
  const dict = await e.readDictionary(zip[dictionaryName]);
  assert.equal(dict.mappings.length, 411);
  await writeFile(path.join(output, 'browser-masked.zip'), zipped.bytes);
  await page.screenshot({ path: path.join(output, '03-result-desktop.png'), fullPage: true });
  const upload = (name, bytes, mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') => ({ name, mimeType, buffer: Buffer.from(bytes) });
  await page.locator('[data-mode="restore"]').click();
  await page.locator('#sourceFile').setInputFiles(upload(workbookName, zip[workbookName]));
  await page.locator('#dictionaryFile').setInputFiles(upload(dictionaryName, zip[dictionaryName]));
  await page.locator('#run').click();
  const recovered = await downloadResult();
  await writeFile(path.join(output, 'browser-restored.xlsx'), recovered.bytes);
  const recoveredBook = e.readBook(recovered.bytes);
  assert.equal(recoveredBook.sheets[0].cells.find((cell) => cell.ref === 'A2').value, e.readBook(source).sheets[0].cells.find((cell) => cell.ref === 'A2').value);
  assert.equal(recoveredBook.sheets[0].cells.find((cell) => cell.ref === 'FL2').date, true);
  const selected = dict.mappings.slice(0, 4);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Report</title></head><body><h1>${selected[0].masked}</h1><div title="${selected[1].masked}">报告</div><script type="application/json" id="data">${JSON.stringify(selected.map((item) => item.masked))}</script><script>window.names=${JSON.stringify(selected.map((item) => item.masked))};</script></body></html>`;
  await page.locator('[data-mode="report"]').click();
  await page.locator('#sourceFile').setInputFiles(upload('分析报告.html', new TextEncoder().encode(html), 'text/html'));
  await page.locator('#dictionaryFile').setInputFiles(upload(dictionaryName, zip[dictionaryName]));
  await page.locator('#run').click();
  const report = await downloadResult();
  const reportHtml = new TextDecoder().decode(report.bytes);
  assert.ok(reportHtml.includes(selected[0].original));
  // Only our controlled synthetic fixture is executed, in a separate blank browser context.
  const checkContext = await browser.newContext();
  const checkPage = await checkContext.newPage();
  await checkPage.setContent(reportHtml);
  assert.deepEqual(await checkPage.evaluate(() => window.names), selected.map((item) => item.original));
  assert.deepEqual(await checkPage.locator('#data').evaluate((node) => JSON.parse(node.textContent)), selected.map((item) => item.original));
  await checkContext.close();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, '04-report-mobile.png'), fullPage: true });
  // Wrong dictionary must invalidate a previous downloadable result.
  await page.locator('#dictionaryFile').setInputFiles(upload(sourceName, source));
  assert.equal(await page.locator('#result').isVisible(), false);
  await page.locator('#run').click();
  await page.waitForFunction(() => document.getElementById('status').classList.contains('error'));
  assert.equal(await page.locator('#download').getAttribute('href'), null);
  await page.locator('#clear').click();
  assert.equal(await page.locator('#fileSummary').isVisible(), false);
  assert.equal(await page.locator('#run').isDisabled(), true);
  assert.equal(await page.evaluate(() => localStorage.length + sessionStorage.length), 0);
  const resourcesBefore = network.length;
  // Drag-and-drop + cancel: give the worker a nontrivial operation and immediately cancel it.
  await context.setOffline(false);
  await page.locator('[data-mode="mask"]').click();
  const dataTransfer = await page.evaluateHandle(({ name, bytes }) => { const dt = new DataTransfer(); dt.items.add(new File([new Uint8Array(bytes)], name)); return dt; }, { name: sourceName, bytes: Array.from(source) });
  await page.locator('#sourceDrop').dispatchEvent('drop', { dataTransfer });
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('全列扫描完成'));
  const selectedFile = await page.locator('#fileSummary').innerText(); assert.ok(selectedFile.includes(sourceName));
  await page.screenshot({ path: path.join(output, '05-analysis-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.evaluate(() => { document.getElementById('run').click(); document.getElementById('cancel').click(); });
  assert.match(await page.locator('#status').innerText(), /取消/);
  assert.equal(await page.locator('#result').isVisible(), false);
  assert.ok(resourcesBefore >= 3);
  assert.ok(network.every((request) => request.method === 'GET' && request.url.startsWith(base) && request.body === null));
  assert.ok(serverRequests.every((request) => request.method === 'GET' && request.contentLength === null));
  assert.deepEqual(errors, []);
  const summary = { browser: browser.version(), workflows: ['mask ZIP', 'restore XLSX', 'restore HTML'], offlinePassed: true, sampleMappingCount: dict.mappings.length, networkRequests: network, consoleErrors: errors, mobileWidth: 390, sourceSha256: await e.sha256(source), output };
  await writeFile(path.join(output, 'browser-validation.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
