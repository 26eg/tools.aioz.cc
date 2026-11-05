import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { engine as e } from './load-desensitizer-test.mjs';

const root = process.cwd();
const samplePath = path.resolve(process.argv[2] ?? '../../本地项目/工作簿脱敏与恢复/测试数据/原始样本/日利润报表-2026-09.xlsx');
const output = path.resolve(process.env.AIOZ_BROWSER_OUTPUT ?? '.test-output/browser');
await mkdir(output, { recursive: true });
const source = new Uint8Array(await readFile(samplePath));
const sourceName = path.basename(samplePath);
const sourceBook = e.readBook(source);
const sourceAnalysis = e.analyze(sourceBook);
const expectedLegacy = await e.maskWorkbook(source, sourceName);
const expectedMappingCount = expectedLegacy.stats.unique;
const focusedCount = sourceAnalysis.rules.filter(r=>!['数值','布尔','空列'].includes(r.type)||r.uncertainDates).length;
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
  assert.equal(await page.locator('#ruleGuide').getAttribute('open'),null);
  assert.equal(await page.locator('aside.guide').count(),0);
  assert.equal(await page.locator('#showConnections').isChecked(),false);
  await page.screenshot({ path: path.join(output, '01-empty-desktop.png'), fullPage: true });
  await page.locator('#sourceFile').setInputFiles(samplePath);
  await page.waitForFunction(() => document.getElementById('status').textContent.includes('全列扫描完成'));
  assert.ok((await page.locator('#analysisSummary').innerText()).includes(`${sourceAnalysis.rows.toLocaleString()} 条数据 · ${sourceAnalysis.rules.length} 列 · ${sourceAnalysis.fakeBlanks} 个假空白`));
  assert.equal(await page.locator('#columns .field-card').count(), focusedCount);
  await page.locator('#viewSheets').click();
  await page.locator('#focusColumns').uncheck();
  assert.equal(await page.locator('#columns .field-card').count(), sourceAnalysis.rules.length);
  await page.locator('#focusColumns').check();
  await page.locator('#viewSheets').click();
  await page.locator('#showConnections').check();
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
  assert.equal(Object.keys(zip).length, 5);
  const workbookName = Object.keys(zip).find((name) => name.includes('_已脱密_'));
  const dictionaryName = Object.keys(zip).find((name) => name === '批次脱敏字典.xlsx');
  assert.ok(workbookName && dictionaryName);
  const dict = await e.readDictionary(zip[dictionaryName]);
  assert.equal(dict.mappings.length, expectedMappingCount);
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
  const dateCell = sourceBook.sheets[0].cells.find(cell=>cell.row>1&&(cell.date||(typeof cell.value==='string'&&sourceAnalysis.rules.some(r=>r.col===cell.col&&r.mode==='date')&&e.parseDate(cell.value,sourceBook.date1904,true))));
  if (dateCell) assert.equal(recoveredBook.sheets[0].cells.find(cell=>cell.ref===dateCell.ref).date,true);
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
  // Batch acceptance: heterogeneous headers, per-file sheet selection and continuation.
  await context.setOffline(false);
  await page.locator('#clear').click();
  const fixtureA = e.tableWorkbook([
    {name:'销量',rows:[['ASIN','品牌'],['B012345678','品牌甲'],['B012345678','品牌乙']]},
    {name:'库存',rows:[['ASIN'],['B012345678']]},
    {name:'排除页',rows:[['ASIN'],['不应输出的秘密']]},
  ]);
  const fixtureB = e.tableWorkbook([
    {name:'排除首页',rows:[['ASIN'],['不应输出的另一秘密']]},
    {name:'商品表',rows:[['品牌','商品ASIN'],['品牌甲','B012345678'],['品牌丙','B999999999']]},
  ]);
  const idle = () => page.waitForFunction(() => document.getElementById('cancel').classList.contains('hidden'));
  await page.locator('#sourceFile').setInputFiles([upload('同名.xlsx',fixtureA),upload('同名.xlsx',fixtureB)]);
  await page.waitForFunction(() => document.querySelectorAll('#sheetChoices fieldset').length===2);
  await idle();
  assert.match(await page.locator('#sheetChoices').innerText(),/不进入输出：库存、排除页/);
  await page.locator('#sheetChoices input[data-file="1"][data-sheet="1"]').check();await idle();
  await page.locator('#sheetChoices input[data-file="2"][data-sheet="0"]').uncheck();await idle();
  assert.equal(await page.locator('#run').isDisabled(),true);
  await page.locator('#sheetChoices input[data-file="2"][data-sheet="1"]').check();await idle();
  await page.locator('[data-field="1:0:1"][data-port="right"]').click();
  await page.locator('[data-field="2:0:2"][data-port="left"]').click();
  assert.equal(await page.locator('[data-field-card="2:0:2"]').getAttribute('data-domain'),'字段:ASIN');
  await page.setViewportSize({width:1440,height:1050});
  await page.screenshot({path:path.join(output,'06-batch-selection.png'),fullPage:true});
  await context.setOffline(true);
  await page.locator('#run').click();const batchResult=await downloadResult();const batchZip=e.openZip(batchResult.bytes);
  const batchOutputs=Object.entries(batchZip).filter(([name])=>name.startsWith('脱敏工作簿/'));
  assert.equal(batchOutputs.length,2);
  const cell=(bytes,ref,si=0)=>e.readBook(bytes).sheets[si].cells.find(c=>c.ref===ref)?.value;
  assert.equal(cell(batchOutputs[0][1],'A2'),cell(batchOutputs[1][1],'B2'));
  assert.equal(cell(batchOutputs[0][1],'A2'),cell(batchOutputs[0][1],'A2',1));
  const manifest=JSON.parse(e.decode(batchZip['批次处理清单.json']));
  assert.deepEqual(manifest.files.map(f=>f.excluded),[['排除页'],['排除首页']]);
  const batchDict=await e.readDictionary(batchZip['批次脱敏字典.xlsx']);
  await writeFile(path.join(output,'browser-batch.zip'),batchResult.bytes);
  await page.locator('[data-mode="restore"]').click();
  await page.locator('#sourceFile').setInputFiles(batchOutputs.map(([name,bytes])=>upload(path.basename(name),bytes)));
  await page.locator('#dictionaryFile').setInputFiles(upload('批次字典.xlsx',batchZip['批次脱敏字典.xlsx']));
  await page.locator('#run').click();const restoredBatch=e.openZip((await downloadResult()).bytes);
  const restoredBooks=Object.values(restoredBatch).map(bytes=>e.readBook(bytes));
  assert.deepEqual(restoredBooks.map(b=>b.sheets.map(s=>s.name)),[['销量','库存'],['商品表']]);
  await page.locator('[data-mode="mask"]').click();
  await page.locator('#dictionaryFile').setInputFiles(upload('续批字典.xlsx',batchZip['批次脱敏字典.xlsx']));
  const continuedSource=e.tableWorkbook([{name:'新增商品',rows:[['商品ASIN'],['B012345678'],['B888888888']]}]);
  await page.locator('#sourceFile').setInputFiles(upload('续批.xlsx',continuedSource));
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('全列扫描完成'));await idle();
  assert.equal(await page.locator('[data-field-card="1:0:1"]').getAttribute('data-domain'),'字段:ASIN');
  await page.locator('#run').click();const continuedZip=e.openZip((await downloadResult()).bytes);
  const continuedOutput=Object.entries(continuedZip).find(([n])=>n.startsWith('脱敏工作簿/'));
  assert.equal(cell(continuedOutput[1],'A2'),cell(batchOutputs[0][1],'A2'));
  const continuedDict=await e.readDictionary(continuedZip['批次脱敏字典.xlsx']);assert.equal(continuedDict.extension.revision,2);
  for(const [name,bytes] of batchOutputs) await e.restoreWorkbook(bytes,continuedZip['批次脱敏字典.xlsx'],name);
  await writeFile(path.join(output,'browser-continued.zip'),e.pack(continuedZip));
  await page.locator('[data-mode="mask"]').click();
  const legacy=await e.maskWorkbook(fixtureA,'旧版.xlsx');
  await page.locator('#dictionaryFile').setInputFiles(upload('旧字典.xlsx',legacy.dictionary));
  await page.locator('#sourceFile').setInputFiles(upload('旧数据.xlsx',fixtureA));
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('全列扫描完成'));await idle();
  assert.ok(await page.locator('#legacyDomains input').count()>0);
  await page.locator('#run').click();const upgradedZip=e.openZip((await downloadResult()).bytes);
  assert.equal((await e.readDictionary(upgradedZip['批次脱敏字典.xlsx'])).version,2);
  assert.equal(cell(Object.entries(upgradedZip).find(([n])=>n.startsWith('脱敏工作簿/'))[1],'A2'),cell(legacy.workbook,'A2'));
  await page.setViewportSize({width:390,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:path.join(output,'07-batch-mobile.png'),fullPage:true});

  // User scenario: two sales workbooks with an added field, plus an inventory workbook.
  await page.locator('[data-mode="mask"]').click();await page.setViewportSize({width:1440,height:1050});
  const salesOne=e.tableWorkbook([{name:'销售表',rows:[['ASIN','店铺','销量'],['B012345678','旗舰店-US',10]]}]);
  const salesTwo=e.tableWorkbook([{name:'销售表',rows:[['ASIN','店铺','新增字段'],['B012345678','旗舰店-US','新增内容']]}]);
  const stockBook=e.tableWorkbook([{name:'库存表',rows:[['商品ASIN','店铺名称','库存'],['B012345678','旗舰店-US',99]]}]);
  await page.locator('#sourceFile').setInputFiles([upload('销售一.xlsx',salesOne),upload('销售二.xlsx',salesTwo),upload('库存.xlsx',stockBook)]);
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('全列扫描完成'));await idle();
  assert.equal(await page.locator('.sheet-heading').count(),3);assert.ok(await page.locator('.field-empty').count()>0);
  const asins=page.locator('[data-field-card="1:0:1"], [data-field-card="2:0:1"]');
  const aligned=await asins.evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().top));assert.ok(Math.abs(aligned[0]-aligned[1])<1);
  await page.locator('#fieldSearch').fill('ASIN | 商品ASIN');
  const sourcePort=page.locator('[data-field="2:0:1"][data-port="right"]'),targetPort=page.locator('[data-field="3:0:1"][data-port="left"]');
  await sourcePort.scrollIntoViewIfNeeded();await targetPort.scrollIntoViewIfNeeded();
  const from=await sourcePort.boundingBox(),to=await targetPort.boundingBox();
  await page.mouse.move(from.x+from.width/2,from.y+from.height/2);await page.mouse.down();await page.mouse.move(to.x+to.width/2,to.y+to.height/2,{steps:12});await page.mouse.up();
  assert.equal(await page.locator('[data-field-card="3:0:1"]').getAttribute('data-domain'),'字段:ASIN');
  await page.waitForFunction(()=>document.querySelector('path[data-link-to="3:0:1"]'));
  await targetPort.scrollIntoViewIfNeeded();
  const linePoint=await page.locator('path[data-link-to="3:0:1"]').evaluate(node=>{const p=node.getPointAtLength(node.getTotalLength()/2),box=node.ownerSVGElement.getBoundingClientRect();return {x:box.x+p.x,y:box.y+p.y};});
  await page.mouse.click(linePoint.x,linePoint.y);
  assert.match(await page.locator('[data-field-card="3:0:1"]').getAttribute('data-domain'),/^独立:/);
  // Keyboard alternative: Enter on each port establishes the same relation.
  await sourcePort.focus();await page.keyboard.press('Enter');await targetPort.focus();await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-field-card="3:0:1"]').getAttribute('data-domain'),'字段:ASIN');
  await page.locator('#fieldSearch').fill('店铺');
  await page.locator('[data-field="1:0:2"][data-port="right"]').click();await page.locator('[data-field="3:0:2"][data-port="left"]').click();
  assert.equal(await page.locator('[data-field-card="3:0:2"]').getAttribute('data-domain'),'店铺');
  assert.match(await page.locator('[data-field-card="3:0:2"] .type').innerText(),/保留末3字/);
  await page.locator('[data-detach="3:0:2"]').click();assert.match(await page.locator('[data-field-card="3:0:2"]').getAttribute('data-domain'),/^独立:/);
  await page.locator('[data-field="1:0:2"][data-port="right"]').click();await page.locator('[data-field="3:0:2"][data-port="left"]').click();
  await page.locator('#fieldSearch').fill('');
  await page.screenshot({path:path.join(output,'08-three-workbook-connections.png'),fullPage:true});
  await page.locator('#run').click();const connected=await downloadResult(),connectedZip=e.openZip(connected.bytes);
  const connectedBooks=Object.entries(connectedZip).filter(([n])=>n.startsWith('脱敏工作簿/'));
  assert.equal(connectedBooks.length,3);
  assert.equal(cell(connectedBooks[0][1],'A2'),cell(connectedBooks[2][1],'A2'));
  assert.equal(cell(connectedBooks[0][1],'B2'),cell(connectedBooks[2][1],'B2'));assert.ok(cell(connectedBooks[2][1],'B2').endsWith('-US'));
  assert.equal(cell(connectedBooks[2][1],'A1'),'商品ASIN');assert.equal(cell(connectedBooks[2][1],'B1'),'店铺名称');
  await writeFile(path.join(output,'browser-connected-three.zip'),connected.bytes);

  // Staged performance acceptance in the actual browser worker; time includes result packaging.
  await page.locator('[data-mode="mask"]').click();
  const performanceFixture=e.tableWorkbook([{name:'性能表',rows:[['ASIN','SKU','销售员','金额'],...Array.from({length:10000},(_,i)=>[`B${String(i%5000).padStart(9,'0')}`,`SKU${i}`,`人员${i%25}`,-1.005-i/1000])]}]);
  await page.locator('#sourceFile').setInputFiles([upload('性能1.xlsx',performanceFixture),upload('性能2.xlsx',performanceFixture)]);
  await page.waitForFunction(()=>document.getElementById('status').textContent.includes('全列扫描完成'));await idle();
  const batchStarted=performance.now();await page.locator('#run').click();const performanceResult=await downloadResult();
  const browserPerformance={files:2,rowsPerFile:10000,storedCells:80008,elapsedMs:Math.round(performance.now()-batchStarted),inputBytes:performanceFixture.length*2,outputBytes:performanceResult.bytes.length};
  assert.equal((await e.readDictionary(e.openZip(performanceResult.bytes)['批次脱敏字典.xlsx'])).mappings.length,15025);
  await writeFile(path.join(output,'browser-performance.json'),JSON.stringify(browserPerformance,null,2));
  assert.ok(resourcesBefore >= 3);
  assert.ok(network.every((request) => request.method === 'GET' && request.url.startsWith(base) && request.body === null));
  assert.ok(serverRequests.every((request) => request.method === 'GET' && request.contentLength === null));
  assert.deepEqual(errors, []);
  const summary = { browser: browser.version(), workflows: ['mask ZIP', 'restore XLSX', 'restore HTML', 'batch heterogeneous ASIN joins', 'per-file multiple sheet selection', 'batch restore', 'v2 continuation', 'v1 dictionary upgrade', 'three workbook header alignment', 'drag and keyboard relations', 'unlink relations', 'store alias suffix protection'], offlinePassed: true, browserPerformance, sampleMappingCount: dict.mappings.length, networkRequests: network, consoleErrors: errors, mobileWidth: 390, sourceSha256: await e.sha256(source), output };
  await writeFile(path.join(output, 'browser-validation.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
  await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
