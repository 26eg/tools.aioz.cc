import assert from 'node:assert/strict';
import test from 'node:test';
import { engine as e } from './load-desensitizer-test.mjs';
const fixture = (tables, name = '数据.xlsx') => new File([e.tableWorkbook(tables)], name);
const table = (rows, name = '源表') => ({ name, rows });
const get = (bytes, ref, si = 0) => e.readBook(bytes).sheets[si].cells.find(c => c.ref === ref)?.value;
const unzip = (result) => e.openZip(result.bytes);
const outputs = (zip) => Object.entries(zip).filter(([n]) => n.startsWith('脱敏工作簿/'));
async function planFor(files, selected, imported) {
  const scan = await e.scanFiles(files);
  const plan = { files: [], legacyDomains: {} };
  for (const [i, f] of scan.files.entries()) {
    const sheets = selected?.[i] ?? [0];
    const a = e.analyzeSelected(new Uint8Array(await files[i].arrayBuffer()), sheets);
    plan.files.push({ id: f.id, sheets, overrides: {}, domains: Object.fromEntries(a.rules.map(r => [r.key, e.defaultDomain(r.header, `${f.id}:${r.key}`)])) });
  }
  if (imported?.version === 1) for (const d of new Set(imported.mappings.map(m => m.domain))) plan.legacyDomains[d] = d === '人员共用' ? d : e.defaultDomain(d.replace(/^[A-Z]+:/, ''), d);
  return plan;
}
const a = fixture([table([['ASIN','品牌','销售员','店铺','金额','日期','空白'],['B012345678','品牌甲','张三','店铺-US',-1.005,'2024-02-29',' \u200b'],['B012345678','品牌乙','李四','另一店-US',2.675,'03/04/2024','']])], '同名.xlsx');
const b = fixture([table([['品牌','商品ASIN'],['品牌甲','B012345678'],['品牌丙','B999999999']])], '同名.xlsx');
const files = [a,b];
const plan = await planFor(files); plan.files[1].domains['0:2'] = '字段:ASIN';
const result = await e.maskBatch(files, plan); const zip = unzip(result); const masked = outputs(zip); const dict = await e.readDictionary(zip['批次脱敏字典.xlsx']);
test('heterogeneous headers and moved columns preserve exact ASIN joins and group counts', () => {
  assert.equal(get(masked[0][1],'A2'),get(masked[1][1],'B2'));
  assert.equal(get(masked[0][1],'A2'),get(masked[0][1],'A3'));
  const countJoin = (left,right) => left.reduce((n,v) => n + right.filter(x=>x===v).length,0);
  assert.equal(countJoin(['B012345678','B012345678'],['B012345678','B999999999']), countJoin([get(masked[0][1],'A2'),get(masked[0][1],'A3')],[get(masked[1][1],'B2'),get(masked[1][1],'B3')]));
  assert.notEqual(masked[0][0],masked[1][0]); assert.equal(dict.version,2); assert.equal(dict.extension.files.length,2);
});
test('shared dictionary restores each original sheet name and preserves cleanup', async () => {
  for (const [i,[name,bytes]] of masked.entries()) {
    const restored=await e.restoreWorkbook(bytes,zip['批次脱敏字典.xlsx'],name); assert.equal(e.readBook(restored.bytes).sheets[0].name,'源表');
    assert.equal(get(restored.bytes, i===0?'A2':'B2'),'B012345678');
    if(i===0){assert.equal(get(restored.bytes,'E2'),-1.01);assert.equal(get(restored.bytes,'G2'),null);assert.equal(get(restored.bytes,'F3'),'03/04/2024');}
  }
});
test('same literal in different semantic fields remains independent, exact whitespace preserved', async () => {
  const f=fixture([table([['ASIN','SKU'],['同值','同值'],['同值 ','同值']])]); const r=await e.maskBatch([f],await planFor([f]));const z=unzip(r),w=outputs(z)[0][1];
  assert.notEqual(get(w,'A2'),get(w,'B2'));assert.notEqual(get(w,'A2'),get(w,'A3'));
});
test('continuation preserves tokens, appends new values and latest dictionary restores earlier batches', async () => {
  const c=fixture([table([['ASIN'],['B012345678'],['新ASIN']],'第三批表')]);const before=JSON.stringify(dict);
  const next=unzip(await e.maskBatch([c],await planFor([c]),dict));const d=await e.readDictionary(next['批次脱敏字典.xlsx']);
  assert.equal(get(outputs(next)[0][1],'A2'),get(masked[0][1],'A2'));assert.equal(d.extension.revision,2);assert.equal(JSON.stringify(dict),before);
  assert.ok(d.mappings.some(m=>m.original==='新ASIN'));assert.equal(d.extension.files.length,3);
  for(const [name,bytes] of masked) assert.equal(get((await e.restoreWorkbook(bytes,next['批次脱敏字典.xlsx'],name)).bytes,'A2'),name.startsWith('脱敏工作簿/1-1')?'B012345678':'品牌甲');
  const third=unzip(await e.maskBatch([c],await planFor([c]),d));assert.equal((await e.readDictionary(third['批次脱敏字典.xlsx'])).extension.revision,3);
});
test('selecting non-first and multiple sheets excludes unselected sheets and restores correct names', async () => {
  const f=fixture([table([['ASIN'],['排除秘密']],'不选表'),table([['ASIN'],['B012345678']],'库存表'),table([['ASIN'],['B012345678']],'销量表')]);
  const z=unzip(await e.maskBatch([f],await planFor([f],[[1,2]])));const w=outputs(z)[0][1];assert.equal(e.readBook(w).sheets.length,2);assert.equal(get(w,'A2',0),get(w,'A2',1));
  assert.ok(!Object.values(e.openZip(w)).some(bytes=>e.decode(bytes).includes('排除秘密')));
  const restored=await e.restoreWorkbook(w,z['批次脱敏字典.xlsx'],'恢复.xlsx');assert.deepEqual(e.readBook(restored.bytes).sheets.map(s=>s.name),['库存表','销量表']);
  assert.deepEqual(JSON.parse(e.decode(z['批次处理清单.json'])).files[0].excluded,['不选表']);
});
test('formula in an unselected sheet does not prevent selected-sheet processing', async () => {
  const source=e.tableWorkbook([table([['ASIN'],['可处理']],'选表'),table([['数值'],[1]],'公式表')]);const parts=e.openZip(source);parts['xl/worksheets/sheet2.xml']=e.encode(e.decode(parts['xl/worksheets/sheet2.xml']).replace('<v>1</v>','<f>1+1</f><v>1</v>'));const f=new File([e.pack(parts)],'公式.xlsx');
  await e.maskBatch([f],await planFor([f],[[0]]));assert.throws(()=>e.analyzeSelected(e.pack(parts),[1]),/包含 f/);
});
test('empty, duplicate and out-of-range worksheet selections fail closed', () => {
  const bytes=e.tableWorkbook([table([['ASIN'],['秘密']])]);for(const selected of [[],[0,0],[2],[-1]])assert.throws(()=>e.analyzeSelected(bytes,selected),/选择无效/);
});
test('legacy dictionary can be upgraded explicitly and latest dictionary restores legacy files', async () => {
  const old=await e.maskWorkbook(new Uint8Array(await a.arrayBuffer()),'旧.xlsx');const d=await e.readDictionary(old.dictionary);const p=await planFor([a],undefined,d);const next=unzip(await e.maskBatch([a],p,d));
  assert.equal(get(outputs(next)[0][1],'A2'),get(old.workbook,'A2'));assert.equal(get((await e.restoreWorkbook(old.workbook,next['批次脱敏字典.xlsx'],'旧.xlsx')).bytes,'A2'),'B012345678');
  await assert.rejects(()=>e.maskBatch([a],{...p,legacyDomains:{}},d),/请确认旧字典/);
});
test('merging conflicting legacy domains is rejected without mutating the dictionary', async () => {
  const f=fixture([table([['ASIN','商品ASIN'],['同值','同值']])]);const old=await e.maskWorkbook(new Uint8Array(await f.arrayBuffer()),'旧.xlsx');const d=await e.readDictionary(old.dictionary),before=JSON.stringify(d);const p=await planFor([f],undefined,d);for(const key of Object.keys(p.legacyDomains))p.legacyDomains[key]='字段:ASIN';
  await assert.rejects(()=>e.maskBatch([f],p,d),/合并后存在不同编码/);assert.equal(JSON.stringify(d),before);
});
test('existing token colliding with raw continuation data is rejected', async () => {
  const f=fixture([table([['ASIN'],[dict.mappings[0].masked]])]);await assert.rejects(async()=>e.maskBatch([f],await planFor([f]),dict),/已有编码/);
});
test('conflicting policies and reserved semantics are rejected', async () => {
  const p=structuredClone(plan);p.files[1].overrides['0:2']='keep';await assert.rejects(()=>e.maskBatch(files,p),/策略冲突/);
  p.files[1].overrides={};p.files[1].domains['0:2']='人员共用';await assert.rejects(()=>e.maskBatch(files,p),/普通列不能/);
});
test('wrong series, missing markers and corrupt v2 dictionaries are rejected', async () => {
  const other=unzip(await e.maskBatch([a],await planFor([a])));
  await assert.rejects(()=>e.restoreWorkbook(masked[0][1],other['批次脱敏字典.xlsx'],'错.xlsx'),/批次不匹配/);
  const parts=e.openZip(masked[0][1]);parts['docProps/custom.xml']=e.encode(e.decode(parts['docProps/custom.xml']).replace(/<property[^>]*name="AIOZBatch"[^>]*>[\s\S]*?<\/property>/, ''));
  await assert.rejects(()=>e.restoreWorkbook(e.pack(parts),zip['批次脱敏字典.xlsx'],'无标记.xlsx'),/需要文件批次标记/);
  const changed=structuredClone(dict);changed.extension.files[0].name='篡改';const bad=await e.writeDictionary(changed);const bz=e.openZip(bad);bz['xl/worksheets/sheet4.xml']=e.encode(e.decode(bz['xl/worksheets/sheet4.xml']).replace('篡改','篡改2'));await assert.rejects(()=>e.readDictionary(e.pack(bz)),/完整性/);
});
test('numeric-only sheets restore when the dictionary also contains earlier text mappings', async () => {
  const f=fixture([table([['金额'],[-1.005]],'数值表')]);const z=unzip(await e.maskBatch([f],await planFor([f]),dict));const restored=await e.restoreWorkbook(outputs(z)[0][1],z['批次脱敏字典.xlsx'],'数值.xlsx');assert.equal(get(restored.bytes,'A2'),-1.01);assert.equal(e.readBook(restored.bytes).sheets[0].name,'数值表');
});
test('batch dictionary restores HTML report values safely', async () => {
  const m=dict.mappings.find(m=>m.domain==='字段:ASIN');const r=await e.restoreReport(`<html><body>${m.masked}<script type="application/json">["${m.masked}"]</script></body></html>`,zip['批次脱敏字典.xlsx'],'报告.html');assert.ok(r.text.includes('B012345678'));assert.equal(r.restored,2);
});
test('batch file count and total bytes limits reject before reading', () => {
  assert.throws(()=>e.validateFiles(Array(31).fill(a)),/1–30/);assert.throws(()=>e.validateFiles([{name:'大.xlsx',size:51*1024*1024}]),/单文件/);assert.throws(()=>e.validateFiles(Array(4).fill({name:'大.xlsx',size:40*1024*1024})),/合计/);
});

test('selected-sheet reader rejects orphan sheet parts and duplicate workbook names', () => {
  const bytes=e.tableWorkbook([table([['ASIN'],['秘密']],'唯一表')]);const parts=e.openZip(bytes);parts['xl/worksheets/sheet9.xml']=parts['xl/worksheets/sheet1.xml'];assert.throws(()=>e.analyzeSelected(e.pack(parts),[0]),/未引用/);
  delete parts['xl/worksheets/sheet9.xml'];parts['xl/workbook.xml']=e.encode(e.decode(parts['xl/workbook.xml']).replace('</sheets>','<sheet name="唯一表" sheetId="9" r:id="rId1"/></sheets>'));assert.throws(()=>e.analyzeSelected(e.pack(parts),[0]),/名称无效或重复/);
});
test('hidden sheet selection exports a visible accessible worksheet and restores its name', async () => {
  const parts=e.openZip(e.tableWorkbook([table([['ASIN'],['不选']],'首页'),table([['ASIN'],['秘密']],'隐藏表')]));
  parts['xl/workbook.xml']=e.encode(e.decode(parts['xl/workbook.xml']).replace('name="隐藏表"','name="隐藏表" state="hidden"'));
  const f=new File([e.pack(parts)],'隐藏.xlsx');assert.equal((await e.scanFiles([f])).files[0].sheets[1].hidden,true);
  const z=unzip(await e.maskBatch([f],await planFor([f],[[1]])));const w=outputs(z)[0][1];assert.notEqual(e.readBook(w).sheets[0].node.getAttribute('state'),'hidden');
  assert.equal(e.readBook((await e.restoreWorkbook(w,z['批次脱敏字典.xlsx'],'恢复.xlsx')).bytes).sheets[0].name,'隐藏表');
});
test('v2 metadata chunks preserve non-BMP characters across segment boundaries', async () => {
  const d=structuredClone(dict);for(let i=0;i<1500;i++)d.extension.aliases[`header:${i}😀`]='字段:😀';
  const roundTrip=await e.readDictionary(await e.writeDictionary(d));assert.deepEqual(roundTrip,d);
});
test('empty columns do not conflict with a previously established mask policy', async () => {
  const f=fixture([table([['ASIN','金额'],[null,-1.005]])]);await e.maskBatch([f],await planFor([f]),dict);
});
test('external workbook links fail closed with an actionable explanation', async () => {
  const bytes=e.tableWorkbook([{name:'数据',rows:[['ASIN'],['B012345678']]}]),parts=e.openZip(bytes);parts['xl/externalLinks/externalLink1.xml']=e.encode('<externalLink/>');
  const file=new File([e.pack(parts)],'含外链.xlsx'),scan=await e.scanFiles([file]);assert.match(scan.files[0].error,/外部工作簿链接/);assert.match(scan.files[0].error,/公式转换为值/);assert.equal(scan.files[0].analysis,undefined);
});
test('year-one sentinel does not turn a valid date column into a masking domain',async()=>{
 const source=e.tableWorkbook([{name:'库存',rows:[['DDP3-库龄快照'],['2026-10-11'],['0001-01-01'],['2026-10-09']]}]);const analysis=e.analyze(e.readBook(source));assert.equal(analysis.rules[0].mode,'date');assert.equal(analysis.rules[0].uncertainDates,1);
 const result=await e.maskWorkbook(source,'库存.xlsx');assert.equal(e.readBook(result.workbook).sheets[0].cells.find(c=>c.ref==='A3').value,'0001-01-01');assert.equal((await e.readDictionary(result.dictionary)).mappings.length,0);assert.equal(result.stats.dates,2);
 const only=e.tableWorkbook([{name:'编号',rows:[['普通字段'],['0001-01-01']]}]);assert.equal(e.analyze(e.readBook(only)).rules[0].mode,'mask');
 const identifiers=e.tableWorkbook([{name:'标识',rows:[['ASIN'],['2026-10-11'],['0001-01-01']]}]);assert.equal(e.analyze(e.readBook(identifiers)).rules[0].mode,'mask');
});
