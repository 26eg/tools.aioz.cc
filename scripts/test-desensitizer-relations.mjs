import assert from 'node:assert/strict';
import test from 'node:test';
import { engine as e } from './load-desensitizer-test.mjs';
const field=(id,header,domain,extra={})=>({id,fileId:id.split(':')[0],worksheet:id.split(':').slice(0,2).join(':'),fileName:id+'.xlsx',key:id.split(':').slice(1).join(':'),sheet:'数据',col:1,letter:'A',header,type:'文本',mode:'mask',reason:'',nonEmpty:1,fakeBlanks:0,uncertainDates:0,examples:[],person:false,store:false,domain,kind:'text',...extra});
test('connecting heterogeneous headers merges the whole mapping group and leaves headers unchanged',()=>{
 const fields=[field('1:0:1','ASIN','字段:ASIN'),field('2:0:1','ASIN','字段:ASIN'),field('3:0:1','商品ASIN','字段:商品ASIN')];const before=structuredClone(fields);
 const changes=e.linkFields(fields,'1:0:1','3:0:1');assert.equal(changes.length,3);assert.ok(changes.every(c=>c.domain==='字段:ASIN'));assert.deepEqual(fields,before);
});
test('detaching one ordinary field preserves the other members mapping group',()=>{
 const f=field('3:0:1','商品ASIN','字段:ASIN');assert.deepEqual(e.detachField(f),{id:f.id,domain:'独立:3:0:1',kind:'text',mode:'mask'});
 assert.throws(()=>e.detachField({...f,store:true,kind:'store'}),/专用共享规则/);
});
test('existing continuation domains cannot be merged, but new fields can join an established domain',()=>{
 const fields=[field('1:0:1','新ASIN','字段:新ASIN'),field('2:0:1','ASIN','字段:ASIN')];
 assert.ok(e.linkFields(fields,fields[0].id,fields[1].id,new Set(['字段:ASIN'])).every(c=>c.domain==='字段:ASIN'));
 assert.throws(()=>e.linkFields(fields,fields[0].id,fields[1].id,new Set(fields.map(f=>f.domain))),/不能直接合并已有编码/);
});
test('store alias connections inherit suffix protection; incompatible person, date and policy links are blocked',()=>{
 const store=field('1:0:1','店铺','店铺',{store:true,kind:'store'}),alias=field('2:0:1','店铺名称','字段:店铺名称');
 assert.ok(e.linkFields([store,alias],store.id,alias.id).every(c=>c.kind==='store'&&c.domain==='店铺'&&c.mode==='mask'));
 assert.throws(()=>e.linkFields([store,{...alias,person:true,kind:'person'}],store.id,alias.id),/不同专用规则/);
 assert.throws(()=>e.linkFields([store,{...alias,type:'日期',mode:'date'}],store.id,alias.id),/日期或布尔/);
 assert.throws(()=>e.linkFields([alias,{...store,store:false,kind:'text',mode:'keep'}],store.id,alias.id),/处理策略不同/);
 assert.ok(e.linkFields([alias,{...store,worksheet:alias.worksheet}],store.id,alias.id).length>0);
});
test('equal headers align across worksheets, additions and repeated headers retain their own rows',()=>{
 const fields=[field('1:0:1','ASIN','a'),field('1:0:2','品牌','b'),field('2:0:1','ASIN','a'),field('2:0:2','新增字段','c'),field('2:0:3','ASIN','d')];
 const r=e.fieldRows(fields);assert.equal(r.positions.get(fields[0].id),r.positions.get(fields[2].id));assert.notEqual(r.positions.get(fields[2].id),r.positions.get(fields[4].id));assert.equal(r.keys.length,4);
});
test('linked store aliases mask consistently and restore with original heterogeneous headers',async()=>{
 const bytes=e.tableWorkbook([{name:'销售',rows:[['店铺'],['店铺甲-US']]},{name:'库存',rows:[['店铺名称'],['店铺甲-US']]}]);
 const file=new File([bytes],'关联.xlsx');const p={files:[{id:'1',sheets:[0,1],domains:{'0:1':'店铺','1:1':'店铺'},overrides:{},kinds:{'0:1':'store','1:1':'store'}}],legacyDomains:{}};
 const result=await e.maskBatch([file],p),zip=e.openZip(result.bytes),workbook=Object.entries(zip).find(([n])=>n.startsWith('脱敏工作簿/'))[1];const book=e.readBook(workbook);
 const cell=(b,i,ref)=>b.sheets[i].cells.find(c=>c.ref===ref).value;
 assert.equal(cell(book,0,'A2'),cell(book,1,'A2'));assert.ok(cell(book,1,'A2').endsWith('-US'));assert.equal(cell(book,1,'A1'),'店铺名称');
 const restored=e.readBook((await e.restoreWorkbook(workbook,zip['批次脱敏字典.xlsx'],'恢复.xlsx')).bytes);assert.equal(cell(restored,1,'A2'),'店铺甲-US');
 const dict=await e.readDictionary(zip['批次脱敏字典.xlsx']);assert.equal(dict.extension.aliases['header:店铺名称'],'店铺');
});
test('backend validates role promotion and does not permit removing fixed store rules',async()=>{
 const file=new File([e.tableWorkbook([{name:'表',rows:[['店铺','日期'],['店铺-US','2024-01-01']]}])],'安全.xlsx');
 const plan={files:[{id:'1',sheets:[0],domains:{'0:1':'店铺','0:2':'店铺'},overrides:{},kinds:{'0:1':'text','0:2':'store'}}],legacyDomains:{}};
 await assert.rejects(()=>e.maskBatch([file],plan),/不能更改专用规则/);plan.files[0].kinds['0:1']='store';await assert.rejects(()=>e.maskBatch([file],plan),/日期或布尔/);
});

test('linked aliases align on the same row without collapsing repeated personnel columns',()=>{
 const fields=[field('1:0:1','ASIN','字段:ASIN'),field('1:0:2','销售员','人员共用',{person:true,kind:'person'}),field('1:0:3','IPD','人员共用',{person:true,kind:'person'}),field('2:0:1','商品ASIN','字段:ASIN'),field('2:0:2','IPD','人员共用',{person:true,kind:'person'})];
 const r=e.fieldRows(fields);assert.equal(r.positions.get(fields[0].id),r.positions.get(fields[3].id));assert.notEqual(r.positions.get(fields[1].id),r.positions.get(fields[2].id));
 for(const worksheet of new Set(fields.map(f=>f.worksheet))){const members=fields.filter(f=>f.worksheet===worksheet);assert.equal(new Set(members.map(f=>r.positions.get(f.id))).size,members.length);}
});

test('existing ordinary dictionary tokens cannot be silently converted into store suffix tokens',()=>{
 const store=field('1:0:1','店铺','店铺',{store:true,kind:'store'}),alias=field('2:0:1','店铺名称','字段:店铺名称');
 assert.throws(()=>e.linkFields([store,alias],store.id,alias.id,new Set(['字段:店铺名称'])),/不能切换到另一套专用规则/);
});
test('different fields within the same worksheet can explicitly share a mapping group',()=>{
 const a=field('1:0:1','ASIN','字段:ASIN'),b=field('1:0:2','商品编号','字段:商品编号');const changes=e.linkFields([a,b],a.id,b.id);assert.equal(changes.length,2);assert.ok(changes.every(c=>c.domain==='字段:ASIN'));const rows=e.fieldRows([a,{...b,domain:a.domain}]);assert.notEqual(rows.positions.get(a.id),rows.positions.get(b.id));
});
test('batch assignment moves only selected fields and refuses invalid changes atomically',()=>{
 const a=field('1:0:1','ASIN','字段:ASIN'),b=field('1:0:2','别名','字段:别名'),c=field('2:0:1','别名','字段:别名');const all=[a,b,c],snapshot=structuredClone(all);const changes=e.assignFields(all,[b.id],a.domain);assert.equal(changes.length,1);assert.equal(changes[0].id,b.id);assert.deepEqual(all,snapshot);
 assert.throws(()=>e.assignFields(all,[b.id],a.domain,new Set([b.domain])),/已有续批编码/);assert.throws(()=>e.assignFields([a,{...b,store:true,kind:'store'}],[a.id,b.id],a.domain),/店铺字段/);assert.deepEqual(all,snapshot);
});
test('association documents expose exact output column membership without original values or examples',async()=>{
 const member=(file,header,column)=>({fileId:file,outputFile:file+'.xlsx',outputSheet:'工作表1',header,column,mode:'mask',kind:'text'});
 const doc=await e.associationDocuments([{domain:'字段:ASIN',member:member('a','ASIN','A')},{domain:'字段:ASIN',member:member('a','商品编号','B')},{domain:'字段:ASIN',member:member('b','商品ASIN','F')}]);const parsed=JSON.parse(doc.json);assert.equal(parsed.groups[0].members.length,3);assert.match(doc.markdown,/a.xlsx/);assert.match(doc.markdown,/商品ASIN/);assert.equal(parsed.scope,'current-output-only');assert.ok(!doc.json.includes('original'));assert.ok(!doc.json.includes('examples'));
 const next=await e.associationDocuments([{domain:'字段:ASIN',member:member('c','ASIN','Z')}]);assert.equal(JSON.parse(next.json).groups[0].groupId,parsed.groups[0].groupId);
});
test('stable exported group IDs are namespaced by dictionary series and persist across its revisions',async()=>{
 const items=[{domain:'字段:ASIN',member:{fileId:'a',outputFile:'a.xlsx',outputSheet:'工作表1',header:'ASIN',column:'A',mode:'mask',kind:'text'}}];
 const first=JSON.parse((await e.associationDocuments(items,{seriesId:'A',revision:1})).json),continued=JSON.parse((await e.associationDocuments(items,{seriesId:'A',revision:2})).json),other=JSON.parse((await e.associationDocuments(items,{seriesId:'B',revision:1})).json);assert.equal(first.groups[0].groupId,continued.groups[0].groupId);assert.notEqual(first.groups[0].groupId,other.groups[0].groupId);
});
