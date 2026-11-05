import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { engine as e } from './load-desensitizer-test.mjs';

const root = process.cwd();
const output = path.resolve(process.env.AIOZ_BROWSER_OUTPUT ?? '.test-output/matrix-20261104');
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
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}}),page=await context.newPage();const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});context.on('request',r=>requests.push({url:r.url(),method:r.method(),body:r.postData()}));
  const dir=path.resolve('../../本地项目/工作簿脱敏与恢复/测试数据/原始样本'),names=(await(await import('node:fs/promises')).readdir(dir)).filter(n=>n.endsWith('.xlsx')).sort(),files=names.map(n=>path.join(dir,n)),hashes=await Promise.all(files.map(async f=>e.sha256(new Uint8Array(await readFile(f)))));
  await page.goto(`${base}/xlsx-desensitizer/`);await page.locator('#sourceFile').setInputFiles(files);await page.waitForFunction(()=>!document.getElementById('analysis').classList.contains('hidden')&&document.getElementById('cancel').classList.contains('hidden'));
  assert.equal(await page.locator('#matrixRoot').isVisible(),true);assert.equal(await page.locator('#legacyBoard').isVisible(),false);assert.equal(await page.locator('#mappingGroups').isVisible(),false);
  assert.equal(await page.locator('.mapping-matrix thead th').count(),4);
  await page.locator('#matrixRoot').getByRole('button',{name:'＋ 新建映射组',exact:true}).click();await page.locator('#bulkName').fill('父级商品标识');await page.locator('#bulkSearch').fill('父');
  for(const id of ['1:0:8','3:0:5','3:0:177'])await page.locator(`[data-bulk-field="${id}"]`).check();
  assert.match(await page.locator('#bulkPreview').innerText(),/已选 3 个字段/);await page.screenshot({path:path.join(output,'01-bulk-select.png'),fullPage:true});await page.locator('#bulkApply').click();await page.waitForFunction(()=>!document.getElementById('groupPicker').open);
  const row=page.locator('[data-matrix-group="组:父级商品标识"]');assert.equal(await row.locator('[data-matrix-field]').count(),3);assert.equal(await row.locator('[data-matrix-sheet="3:0"] [data-matrix-field]').count(),2);
  await row.getByLabel('选择本组',{exact:true}).check();assert.equal(await row.locator('td input:checked').count(),3);await row.getByLabel('选择本组',{exact:true}).uncheck();
  await page.locator('[data-matrix-select="1:0:8"]').check();await page.getByLabel('批量移入映射组',{exact:true}).selectOption('字段:ASIN');await page.getByRole('button',{name:'移入所选组',exact:true}).click();assert.equal(await row.locator('[data-matrix-field]').count(),2);
  await page.locator('[data-matrix-select="1:0:8"]').check();await page.getByLabel('批量移入映射组',{exact:true}).selectOption('组:父级商品标识');await page.getByRole('button',{name:'移入所选组',exact:true}).click();assert.equal(await row.locator('[data-matrix-field]').count(),3);
  assert.equal(await page.locator('[data-matrix-group="字段:父AISN"] [data-matrix-field="2:0:5"]').count(),0); // a singleton is intentionally outside the shared-groups view
  await page.getByLabel('矩阵字段范围',{exact:true}).selectOption('independent');assert.equal(await page.locator('[data-matrix-field="2:0:5"]').count(),1);await page.getByLabel('矩阵字段范围',{exact:true}).selectOption('shared');
  await page.locator('#fieldSearch').fill('ASIN | 父级');await page.locator('#analysis').screenshot({path:path.join(output,'02-matrix-workbench.png')});await page.locator('#fieldSearch').fill('');
  await context.setOffline(true);await page.locator('#dockRun').click();await page.waitForFunction(()=>!document.getElementById('dockDownload').classList.contains('hidden'),{timeout:60000});
  const dock=await page.locator('#dockDownload').boundingBox();assert.ok(dock.y>=0&&dock.y+dock.height<=1000);const [download]=await Promise.all([page.waitForEvent('download'),page.locator('#dockDownload').click()]);const bytes=new Uint8Array(await readFile(await download.path()));await writeFile(path.join(output,'matrix-result.zip'),bytes);const zip=e.openZip(bytes);
  assert.ok(zip['字段关联说明.md']&&zip['字段关联清单.json']);const association=JSON.parse(e.decode(zip['字段关联清单.json'])),group=association.groups.find(g=>g.domain==='组:父级商品标识');assert.equal(group.members.length,3);assert.equal(group.members.filter(m=>m.header==='父ASIN别称').length,1);assert.ok(group.members.every(m=>zip[m.outputFile]));assert.ok(group.members.every(m=>m.outputSheet==='工作表1'));
  for(const g of association.groups)for(const m of g.members){assert.ok(!('original' in m)&&!('examples' in m));const actual=e.readBook(zip[m.outputFile]).sheets.find(s=>s.name===m.outputSheet);assert.equal(actual.cells.find(c=>c.ref===m.column+'1')?.value??'',m.header);}
  const restored=[];for(const [name,b]of Object.entries(zip).filter(([n])=>n.startsWith('脱敏工作簿/')))restored.push(await e.restoreWorkbook(b,zip['批次脱敏字典.xlsx'],name));assert.equal(restored.length,3);
  const snapshot=e.readBook(Object.entries(zip).find(([n])=>n.startsWith('脱敏工作簿/1-1_'))[1]).sheets[0].cells.filter(c=>c.col===57&&c.row>1);assert.equal(snapshot.filter(c=>c.value==='0001-01-01').length,2);assert.equal(snapshot.filter(c=>typeof c.value==='number').length,48);
  await page.screenshot({path:path.join(output,'03-fixed-download.png'),fullPage:false});
  await row.getByRole('button',{name:'添加字段',exact:true}).click();await page.locator('#bulkSearch').fill('父');await page.locator('[data-bulk-field="2:0:5"]').check();await page.locator('#bulkApply').click();await page.waitForFunction(()=>!document.getElementById('groupPicker').open);assert.equal(await page.locator('#dockDownload').getAttribute('href'),null);assert.equal(await page.locator('#download').getAttribute('href'),null);assert.equal(await page.locator('#dockRun').isVisible(),true);
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.locator('#matrixRoot').getByRole('button',{name:'＋ 新建映射组',exact:true}).click();assert.equal(await page.locator('#groupPicker').evaluate(n=>n.scrollWidth<=n.clientWidth),true);await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('groupPicker').open);await page.screenshot({path:path.join(output,'04-matrix-mobile.png'),fullPage:false});
  await page.locator('#clear').click();assert.equal(await page.locator('#dockDownload').getAttribute('href'),null);assert.equal(await page.locator('#dockRun').isDisabled(),true);
  for(const [i,f]of files.entries())assert.equal(await e.sha256(new Uint8Array(await readFile(f))),hashes[i]);assert.deepEqual(errors,[]);assert.ok(requests.every(r=>r.method==='GET'&&r.url.startsWith(base)&&r.body===null));
  const summary={date:'2026-11-04',browser:browser.version(),matrixDefault:true,multiSelectSameAndCrossSheet:true,onlySelectedFieldsMoved:true,associationMembersVerified:association.groups.reduce((n,g)=>n+g.members.length,0),associationExportPassed:true,restorationPassed:true,sentinelDatesPassed:true,fixedDownloadVisible:true,staleResultRevoked:true,mobilePassed:true,offlinePassed:true,originalsUnchanged:true,consoleErrors:errors,requests};await writeFile(path.join(output,'validation.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
