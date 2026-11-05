import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { engine as e } from './load-desensitizer-test.mjs';

const root = process.cwd();
const output = path.resolve(process.env.AIOZ_BROWSER_OUTPUT ?? '.test-output/store-report-fix-20261104');
await mkdir(output, { recursive: true });
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
  const context=await browser.newContext({acceptDownloads:true}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const dictionary={version:1,batch:'1234567890ABCDEF',sourceName:'旧工作簿.xlsx',created:'2026-10-15T00:00:00.000Z',mappings:[{domain:'B:店铺',original:'甲店-US',masked:'S1-US'},{domain:'店铺',original:'乙店-UK',masked:'S1-UK'}],sheets:[{original:'原表',masked:'工作表1'}]};
  const dict=await e.writeDictionary(dictionary),upload=(name,bytes,type)=>({name,mimeType:type,buffer:Buffer.from(bytes)});
  await page.goto(`${base}/xlsx-desensitizer/`);await page.locator('[data-mode="report"]').click();
  await page.locator('#dictionaryFile').setInputFiles(upload('旧脱敏字典.xlsx',dict,'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
  const report='<html><body><p>S1-US</p><p>S1-UK</p><script>const shop="S1-UK";const site="UK";</script></body></html>';
  await page.locator('#sourceFile').setInputFiles(upload('更新后报告.html',e.encode(report),'text/html'));await page.locator('#dockRun').click();await page.waitForFunction(()=>!document.getElementById('dockDownload').classList.contains('hidden'));
  const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#dockDownload').click()]);const restored=await readFile(await download.path(),'utf8');assert.match(restored,/甲店-US/);assert.match(restored,/乙店-UK/);assert.ok(restored.includes('const site="UK"'));await writeFile(path.join(output,'restored-report.html'),restored);
  await page.locator('#sourceFile').setInputFiles(upload('截短报告.html',e.encode('<p>S1-US</p><p>S1</p>'),'text/html'));assert.equal(await page.locator('#dockDownload').getAttribute('href'),null);await page.locator('#dockRun').click();await page.waitForFunction(()=>document.getElementById('status').classList.contains('error'));assert.match(await page.locator('#status').innerText(),/末尾字符/);assert.equal(await page.locator('#dockDownload').getAttribute('href'),null);assert.deepEqual(errors,[]);
  await writeFile(path.join(output,'validation.json'),JSON.stringify({legacyDictionaryPassed:true,sharedPrefixPassed:true,separateSitePreserved:true,truncationRejected:true,staleDownloadCleared:true,consoleErrors:errors,browser:browser.version()},null,2));console.log('Legacy dictionary and shared-prefix report browser regression passed.');await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
