import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { engine as e } from './load-desensitizer-test.mjs';

const root = process.cwd();
const output = path.resolve(process.env.AIOZ_BROWSER_OUTPUT ?? '.test-output/real-20261015-after');
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
  const dir=path.resolve(process.env.AIOZ_REAL_SAMPLE_DIR ?? '../../本地项目/工作簿脱敏与恢复/测试数据/原始样本');
  const names=(await (await import('node:fs/promises')).readdir(dir)).filter(n=>n.endsWith('.xlsx')).sort();assert.equal(names.length,3,'Expected the current three workbook samples');
  const inputs=names.map(n=>path.join(dir,n)),originals=await Promise.all(inputs.map(async p=>new Uint8Array(await readFile(p))));const hashes=await Promise.all(originals.map(e.sha256));
  const pureScan=await e.scanFiles(originals.map((bytes,i)=>new File([bytes],names[i])));const validIndexes=pureScan.files.flatMap((f,i)=>f.error?[]:[i]);assert.equal(validIndexes.length,3);
  const context=await browser.newContext({acceptDownloads:true,viewport:{width:1440,height:1000}}),page=await context.newPage();const errors=[],network=[];page.on('pageerror',err=>errors.push(err.message));context.on('request',r=>network.push({method:r.method(),url:r.url(),body:r.postData()}));
  const idle=()=>page.waitForFunction(()=>document.getElementById('cancel').classList.contains('hidden'));
  const load=async(paths)=>{await page.locator('#sourceFile').setInputFiles(paths);await page.waitForFunction(n=>document.querySelectorAll('#sheetChoices fieldset').length===n,paths.length);await idle();await page.locator('#viewSheets').click();};
  await page.goto(`${base}/xlsx-desensitizer/`);await load(inputs);
  assert.equal(await page.locator('.sheet-heading').count(),3);assert.equal(await page.locator('.field-error').count(),0);assert.equal(await page.locator('.file-error').count(),0);assert.equal(await page.locator('#run').isDisabled(),false);
  const initial={boardTop:await page.locator('.field-board-scroll').evaluate(n=>n.getBoundingClientRect().top),uploadHeight:await page.locator('#sourceDrop').evaluate(n=>n.getBoundingClientRect().height),headings:await page.locator('.sheet-heading').allTextContents(),status:await page.locator('#status').innerText()};assert.ok(initial.uploadHeight>=70&&initial.uploadHeight<=96);assert.ok(initial.boardTop<1600);
  await page.screenshot({path:path.join(output,'01-three-files-compact.png'),fullPage:true});
  await page.locator('#fieldSearch').fill('商品信息');assert.equal(await page.locator('.sheet-heading').count(),3);assert.match(await page.locator('#columns').innerText(),/没有符合当前筛选条件/);await page.locator('#fieldSearch').fill('');
  const linkParent=async(target)=>{
    await page.locator('[data-pick-source="1:0:8"]').click();assert.equal(await page.locator('#fieldPicker').evaluate(n=>n.open),true);assert.match(await page.locator('#pickerSource').innerText(),/父ASIN/);await page.locator('#pickerSearch').fill('父');
    await page.screenshot({path:path.join(output,`02-picker-${target.replaceAll(':','-')}.png`),fullPage:true});
    await page.locator(`[data-pick-target="${target}"]`).click();assert.equal(await page.locator('#fieldPicker').evaluate(n=>n.open),false);assert.equal(await page.locator(`[data-field-card="${target}"]`).getAttribute('data-domain'),'字段:父ASIN');
  };
  // The far-down added column can be selected without scrolling to its card.
  await page.locator('[data-pick-source="3:0:177"]').click();await page.locator('#pickerSearch').fill('父');await page.locator('[data-pick-target="3:0:5"]').click();assert.equal(await page.locator('[data-field-card="3:0:177"]').getAttribute('data-domain'),await page.locator('[data-field-card="3:0:5"]').getAttribute('data-domain'));
  await linkParent('3:0:177');
  await page.locator('#clear').click();await load(validIndexes.map(i=>inputs[i]));await linkParent('3:0:5');await linkParent('3:0:177');
  await page.locator('[data-pick-source="3:0:177"]').click();await page.locator('#pickerSearch').fill('父');assert.ok(await page.locator('[data-pick-target="3:0:5"]').count());await page.locator('#pickerClose').click();
  assert.ok(await page.locator('#groupList').innerText().then(t=>t.includes('父AISN')&&t.includes('父ASIN别称')));
  assert.equal(await page.locator('#showConnections').isChecked(),false);
  await page.locator('[data-group-domain="字段:父ASIN"]').click();assert.ok(await page.locator('.field-card').count()>=3);await page.locator('#showAllGroups').click();
  await context.setOffline(true);await page.locator('#run').click();await page.waitForFunction(()=>!document.getElementById('result').classList.contains('hidden'),{timeout:60000});
  const getDownload=async()=>{const [d]=await Promise.all([page.waitForEvent('download'),page.locator('#download').click()]);return new Uint8Array(await readFile(await d.path()));};
  const zipped=await getDownload();await writeFile(path.join(output,'real-valid-two-mask.zip'),zipped);const zip=e.openZip(zipped);const workbooks=Object.entries(zip).filter(([n])=>n.startsWith('脱敏工作簿/'));assert.equal(workbooks.length,validIndexes.length);const dict=await e.readDictionary(zip['批次脱敏字典.xlsx']);
  const snapshot=e.readBook(workbooks[0][1]).sheets[0].cells.filter(c=>c.col===57&&c.row>1);assert.equal(snapshot.filter(c=>c.value==='0001-01-01').length,2);assert.equal(snapshot.filter(c=>typeof c.value==='number').length,48);assert.ok(!dict.mappings.some(m=>m.domain.includes('DDP3-库龄快照')));
  const domains=new Map();let sharedChecks=0;
  for(const [i,[,bytes]] of workbooks.entries()){
    const original=e.readBook(originals[validIndexes[i]]),masked=e.readBook(bytes),headers=new Map(original.sheets[0].cells.filter(c=>c.row===1).map(c=>[c.col,c.value]));
    const maskedValues=new Map(masked.sheets[0].cells.map(c=>[c.ref,c.value]));
    for(const c of original.sheets[0].cells){if(c.row===1||typeof c.value!=='string'||e.isBlank(c.value))continue;const h=headers.get(c.col);if(!['ASIN','父ASIN','父AISN','父ASIN别称','内部SKU','店铺'].includes(h))continue;
      const domain=['父ASIN','父AISN','父ASIN别称'].includes(h)?'父ASIN':h,key=JSON.stringify([domain,c.value]),token=maskedValues.get(c.ref);if(domains.has(key)){assert.equal(token,domains.get(key));sharedChecks++;}else domains.set(key,token);
    }
  }
  const upload=(name,bytes)=>({name:path.basename(name),mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from(bytes)});
  await page.locator('[data-mode="restore"]').click();await page.locator('#sourceFile').setInputFiles(workbooks.map(([n,b])=>upload(n,b)));await page.locator('#dictionaryFile').setInputFiles(upload('统一字典.xlsx',zip['批次脱敏字典.xlsx']));await page.locator('#run').click();await page.waitForFunction(()=>!document.getElementById('result').classList.contains('hidden'),{timeout:60000});
  const restoredZip=e.openZip(await getDownload());let checkedCells=0;
  for(const [i,bytes] of Object.values(restoredZip).entries()){
    const original=e.readBook(originals[validIndexes[i]]),recovered=e.readBook(bytes),analysis=e.analyze(original),values=new Map(recovered.sheets[0].cells.map(c=>[c.ref,c.value]));
    for(const c of original.sheets[0].cells){let expected=c.value;const rule=analysis.rules.find(r=>r.col===c.col);if(c.row>1){if(e.isBlank(expected))expected=null;else if(typeof expected==='number'&&!c.date)expected=e.roundTwo(expected);else if(typeof expected==='string'&&rule?.mode==='date'){const date=e.parseDate(expected,original.date1904,true);if(date)expected=date.serial;}else if(typeof expected==='string'&&rule?.type==='数值'&&rule.mode==='keep'&&e.numericText(expected)!==null)expected=e.roundTwo(e.numericText(expected));}assert.equal(values.get(c.ref),expected,`${names[validIndexes[i]]}:${c.ref}`);checkedCells++;}
    await writeFile(path.join(output,`restored-${i+1}.xlsx`),bytes);
  }
  await context.setOffline(false);await page.locator('[data-mode="mask"]').click();await load(inputs);await page.setViewportSize({width:390,height:844});await page.locator('[data-pick-source="1:0:8"]').click();await page.locator('#pickerSearch').fill('父');await page.screenshot({path:path.join(output,'03-mobile-picker.png'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.equal(await page.locator('#fieldPicker').evaluate(n=>n.scrollWidth<=n.clientWidth),true);await page.screenshot({path:path.join(output,'03-mobile-picker.png'),fullPage:true});await page.keyboard.press('Escape');await page.waitForFunction(()=>!document.getElementById('fieldPicker').open);
  await page.locator('#clear').click();assert.equal(await page.locator('#pickerCandidates').innerText(),'');assert.equal(await page.locator('#run').isDisabled(),true);
  for(const [i,input] of inputs.entries())assert.equal(await e.sha256(new Uint8Array(await readFile(input))),hashes[i]);
  assert.deepEqual(errors,[]);assert.ok(network.every(r=>r.method==='GET'&&r.url.startsWith(base)&&r.body===null));
  const summary={date:'2026-10-15',names,sourceHashes:hashes,originalsUnchanged:true,initial,validFiles:validIndexes.map(i=>names[i]),blockedFiles:pureScan.files.filter(f=>f.error).map(f=>({name:f.name,error:f.error})),checkedCells,sharedChecks,dictionaryMappings:dict.mappings.length,pickerFarFieldPassed:true,stableThreeColumnsPassed:true,mobilePassed:true,offlinePassed:true,consoleErrors:errors,network};await writeFile(path.join(output,'validation.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));await context.close();
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
