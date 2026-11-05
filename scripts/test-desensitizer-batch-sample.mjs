import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { engine as e } from './load-desensitizer-test.mjs';
const home=path.resolve('../../本地项目/工作簿脱敏与恢复');
const input=path.join(home,'测试数据/原始样本/日利润报表-2026-09.xlsx');
const output=path.join(home,'测试结果',`多文件回归-${e.timestamp()}`);await mkdir(output,{recursive:true});
const source=new Uint8Array(await readFile(input)), hash=await e.sha256(source);
const expectedLegacy=await e.maskWorkbook(source,path.basename(input));
const modified=e.readBook(source);
const asinHeaders=modified.sheets[0].cells.filter(c=>c.row===1 && typeof c.value==='string' && /^ASIN$/i.test(c.value));assert.equal(asinHeaders.length,1);
e.writeCell(asinHeaders[0],'商品ASIN');modified.sheets[0].node.setAttribute('name','库存参考表');
const second=e.saveBook(modified);await writeFile(path.join(output,'异名表头源.xlsx'),second);
const files=[new File([source],'销售.xlsx'),new File([second],'库存.xlsx')];
const scan=await e.scanFiles(files);
const plan={files:scan.files.map(f=>({id:f.id,sheets:[0],overrides:{},domains:Object.fromEntries(f.analysis.rules.map(r=>[r.key,e.defaultDomain(r.header==='商品ASIN'?'ASIN':r.header,`${f.id}:${r.key}`)]))})),legacyDomains:{}};
const start=performance.now();const result=await e.maskBatch(files,plan);const elapsedMs=Math.round(performance.now()-start);
const zip=e.openZip(result.bytes),dictionary=await e.readDictionary(zip['批次脱敏字典.xlsx']);
const outputs=Object.entries(zip).filter(([n])=>n.startsWith('脱敏工作簿/'));assert.equal(outputs.length,2);
const ref=asinHeaders[0].col;
const values=outputs.map(([,bytes])=>e.readBook(bytes).sheets[0].cells.filter(c=>c.col===ref&&c.row>1).map(c=>c.value));assert.deepEqual(values[0],values[1]);
assert.equal(dictionary.mappings.length,expectedLegacy.stats.unique);assert.equal(result.stats.masked,expectedLegacy.stats.masked*2);
const checks=[];
for(const [i,[name,bytes]] of outputs.entries()){
 const restored=await e.restoreWorkbook(bytes,zip['批次脱敏字典.xlsx'],name);
 const original=i===0?input:path.join(output,'异名表头源.xlsx');
 const workbook=`${i+1}-脱敏.xlsx`,recovered=`${i+1}-恢复.xlsx`;
 await writeFile(path.join(output,workbook),bytes);await writeFile(path.join(output,recovered),restored.bytes);
 checks.push({source:original,masked:workbook,restored:recovered});
}
await writeFile(path.join(output,'批次脱敏字典.xlsx'),zip['批次脱敏字典.xlsx']);await writeFile(path.join(output,'批次结果.zip'),result.bytes);
assert.equal(await e.sha256(new Uint8Array(await readFile(input))),hash);
const performanceCases=[];
for(const rows of [1000,10000]){
 const data=[['ASIN','SKU','销售员','金额'],...Array.from({length:rows},(_,i)=>[`B${String(i%5000).padStart(9,'0')}`,`SKU${i}`,'人员'+(i%25),-1.005-i/1000])];
 const fixture=e.tableWorkbook([{name:'性能样本',rows:data}]);const ff=[new File([fixture],'样本1.xlsx'),new File([fixture],'样本2.xlsx')];const ss=await e.scanFiles(ff);const pp={files:ss.files.map(f=>({id:f.id,sheets:[0],domains:Object.fromEntries(f.analysis.rules.map(r=>[r.key,e.defaultDomain(r.header,`${f.id}:${r.key}`)])),overrides:{}})),legacyDomains:{}};
 const t=performance.now(),rr=await e.maskBatch(ff,pp);performanceCases.push({files:2,rowsPerFile:rows,storedCells:2*(rows+1)*4,inputBytes:fixture.length*2,outputBytes:rr.bytes.length,mappings:rr.stats.unique,elapsedMs:Math.round(performance.now()-t),nodeProcessPeakRssKiB:process.resourceUsage().maxRSS});
}
const summary={source:input,sourceSha256:hash,sourceUnchanged:true,files:checks,stats:result.stats,elapsedMs,dictionary:'批次脱敏字典.xlsx',sharedAsinVerified:true,performanceCases,environment:{node:process.version,platform:process.platform,arch:process.arch,cpu:os.cpus()[0]?.model,ramGiB:Math.round(os.totalmem()/1024**3)},output};
await writeFile(path.join(output,'多文件验证结果.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary,null,2));
