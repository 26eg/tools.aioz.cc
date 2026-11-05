import assert from 'node:assert/strict';
import test from 'node:test';
import { engine as e } from './load-desensitizer-test.mjs';
const fixture = (rows, name = '原数据') => e.tableWorkbook([{ name, rows }]);
const value = (bytes, ref, sheet = 0) => e.readBook(bytes).sheets[sheet].cells.find((cell) => cell.ref === ref)?.value ?? null;
const now = new Date('2026-09-11T02:03:04.005Z');
const source = fixture([
  ['销售员', '销售员1', '销售员*', 'IPD', 'GTM', '店铺', '品牌', '类别', '金额', '日期', 'ASIN', '空白', '原日期'],
  ['张三', '张三', '李四', '李四', '张三', '同名店-US', '同名', '同名', 1.005, '2024-02-29', '001234', ' \u200b\u00a0', '2024/3/2'],
  ['李四', '张三', '张三', '李四', '张三', '另一店-US', '其他', '其他', -1.005, '03/04/2024', '999999999999999999', '', '2024-02-30'],
  ['张三 ', '张三', '李四', '张三', '张三', '店', '同名', '同名', 123.456, '2024-12-31 23:59:59', '123456', null, ''],
]);
const masked = await e.maskWorkbook(source, '示例.xlsx', {}, now);
const dict = await e.readDictionary(masked.dictionary);

test('positive and negative decimal ties round away from zero without binary floating point errors', () => {
  for (const [input, expected] of [[1.005, 1.01], [-1.005, -1.01], [2.675, 2.68], [-2.675, -2.68], [0.0049, 0], [-0.005, -.01], [9.999, 10], [1e-8, 0], [1e21, 1e21], [12, 12]]) assert.equal(e.roundTwo(input), expected);
  assert.throws(() => e.roundTwo(Infinity));
});
test('fake blanks include invisible whitespace but not zero, false, NULL or N/A', () => {
  for (const input of [null, '', ' ', '\t\r\n\u200b\u2060\ufeff', '\u00a0']) assert.equal(e.isBlank(input), true);
  for (const input of [0, false, 'NULL', 'N/A', '0', ' \u200b名']) assert.equal(e.isBlank(input), false);
});
test('date parsing rejects ambiguous, impossible and out-of-range dates; handles both Excel epochs', () => {
  assert.equal(e.parseDate('1900-01-01').serial, 1);
  assert.equal(e.parseDate('1900-02-28').serial, 59);
  assert.equal(e.parseDate('1900-03-01').serial, 61);
  assert.equal(e.parseDate('1904-01-01', true).serial, 0);
  assert.equal(e.parseDate('2024-02-29').serial, 45351);
  assert.equal(e.parseDate('2024年2月29日').serial, 45351);
  assert.equal(e.parseDate('20240229', false, true).serial, 45351);
  for (const input of ['2024-02-30', '1900-02-29', '02/03/2024', '2024/02-29', '2024-13-01', '2024-01-01 24:00', '2024-01-01T12:00Z', '20240229']) assert.equal(e.parseDate(input), null, input);
});
test('numeric text detection protects leading zeros, long identifiers and locale ambiguity', () => {
  for (const input of ['00123', '1234567890123456', '1,234.56', '1.234,56', '2024-03-01', '0x10']) assert.equal(e.numericText(input), null);
  assert.equal(e.numericText('12.345'), 12.345); assert.equal(e.numericText('-1e-4'), -0.0001);
});
test('all rows are scanned: a late text outlier cannot be misclassified as a numeric column', () => {
  const rows = [['金额'], ...Array.from({ length: 120 }, (_, i) => [i]), ['秘密名称']];
  const analysis = e.analyze(e.readBook(fixture(rows)));
  assert.equal(analysis.rules[0].type, '混合'); assert.equal(analysis.rules[0].mode, 'mask'); assert.equal(analysis.rows, 121);
});
test('first-row headers, no-data files, bad cell references and unsupported workbook objects fail closed', async () => {
  assert.throws(() => e.analyze(e.readBook(fixture([['名称']]))), /没有可处理/);
  assert.throws(() => e.analyze(e.readBook(fixture([[], ['名称'], ['值']]))), /第 1 行/);
  for (const ref of ['XFE1', 'A0', 'A1048577', 'AAAA1', 'A-1']) assert.throws(() => e.address(ref));
  const parts = e.openZip(source);
  parts['xl/worksheets/sheet1.xml'] = e.encode(e.decode(parts['xl/worksheets/sheet1.xml']).replace('<v>1.005</v>', '<f>1+1</f><v>2</v>'));
  assert.throws(() => e.readBook(e.pack(parts)), /包含 f/);
  parts['xl/pivotCache/pivotCacheRecords1.xml'] = e.encode('<cache/>');
  assert.throws(() => e.readBook(e.pack(parts)), /不支持部件/);
  assert.throws(() => e.parseXml('<!DOCTYPE a [<!ENTITY a "secret">]><a>&a;</a>'), /DTD/);
  assert.throws(() => e.parseXml('<a><b></a>'), /XML/);
});
test('ZIP rejects oversized declared contents, bad CRC, invalid formats and duplicate paths before processing', () => {
  assert.throws(() => e.openZip(new Uint8Array(50)), /有效/);
  const zip = fixture([['名称'], ['测试']]);
  const modified = new Uint8Array(zip); const v = new DataView(modified.buffer);
  let p = 0; while (v.getUint32(p, true) !== 0x02014b50) p++;
  v.setUint32(p + 24, e.MAX_EXPANDED_BYTES + 1, true);
  assert.throws(() => e.openZip(modified), /250 MB/);
  const badCrc = new Uint8Array(zip); new DataView(badCrc.buffer).setUint32(p + 16, 0, true);
  assert.throws(() => e.openZip(badCrc), /CRC/);
});
test('all salesperson-prefixed columns, IPD and GTM share one exact-value dictionary', () => {
  const names = dict.mappings.filter((m) => m.domain === '人员共用');
  assert.equal(names.length, 3);
  assert.equal(value(masked.workbook, 'A2'), '人1');
  assert.equal(value(masked.workbook, 'A2'), value(masked.workbook, 'B2'));
  assert.equal(value(masked.workbook, 'A2'), value(masked.workbook, 'E3'));
  assert.notEqual(value(masked.workbook, 'A4'), value(masked.workbook, 'A2'));
});
test('other columns have globally unique tokens even when their original values match', () => {
  assert.notEqual(value(masked.workbook, 'G2'), value(masked.workbook, 'H2'));
  assert.equal(value(masked.workbook, 'G2'), value(masked.workbook, 'G4'));
  assert.equal(new Set(dict.mappings.map((m) => m.masked)).size, dict.mappings.length);
});
test('store uses the full name as key, retains last three code points, and distinguishes shared suffixes', async () => {
  assert.match(value(masked.workbook, 'F2'), /-US$/);
  assert.match(value(masked.workbook, 'F3'), /-US$/);
  assert.notEqual(value(masked.workbook, 'F2'), value(masked.workbook, 'F3'));
  assert.match(value(masked.workbook, 'F4'), /店$/);
  const result = await e.maskWorkbook(fixture([['店铺'], ['商店😀🇺X'], ['商店😀🇺X']]), '店.xlsx');
  assert.equal(value(result.workbook, 'A2'), value(result.workbook, 'A3'));
  assert.equal([...value(result.workbook, 'A2')].slice(-3).join(''), '😀🇺X');
});
test('anonymization actually changes numeric precision, emits numeric dates and true blank cells', () => {
  assert.equal(value(masked.workbook, 'I2'), 1.01); assert.equal(value(masked.workbook, 'I3'), -1.01);
  assert.equal(value(masked.workbook, 'J2'), 45351);
  assert.equal(value(masked.workbook, 'J3'), '03/04/2024');
  assert.equal(value(masked.workbook, 'L2'), null);
  assert.equal(value(masked.workbook, 'M3'), '2024-02-30');
  const text = e.decode(e.openZip(masked.workbook)['xl/worksheets/sheet1.xml']);
  assert.match(text, /<c r="L2"\s*\/>/);
  assert.equal(masked.stats.blanks, 3); assert.equal(masked.stats.uncertainDates, 2);
});
test('numeric-looking text identifiers and formula-looking original strings round-trip as text', async () => {
  const restored = await e.restoreWorkbook(masked.workbook, masked.dictionary, '待恢复.xlsx');
  assert.equal(value(restored.bytes, 'K2'), '001234');
  assert.equal(value(restored.bytes, 'K3'), '999999999999999999');
  const special = '=HYPERLINK("https://example.invalid","危险")';
  const result = await e.maskWorkbook(fixture([['名称'], [special]]), '公式样文本.xlsx');
  const recovered = await e.restoreWorkbook(result.workbook, result.dictionary, 'r.xlsx');
  assert.equal(value(recovered.bytes, 'A2'), special);
  assert.equal(e.elements(e.readBook(recovered.bytes).sheets[0].document, 'f').length, 0);
});
test('restoration preserves cleaned numbers, typed dates and true blanks, restores sheet names', async () => {
  const result = await e.restoreWorkbook(masked.workbook, masked.dictionary, '待恢复.xlsx', now);
  assert.equal(value(result.bytes, 'A2'), '张三');
  assert.equal(value(result.bytes, 'I2'), 1.01); assert.equal(value(result.bytes, 'J2'), 45351); assert.equal(value(result.bytes, 'L2'), null);
  assert.equal(e.readBook(result.bytes).sheets[0].name, '原数据');
  assert.match(result.filename, /^待恢复_已解密_\d{8}-\d{6}-\d{3}\.xlsx$/);
});
test('sorting and filtering rows do not affect name restoration', async () => {
  const rows = [['品牌'], [value(masked.workbook, 'G4')], [value(masked.workbook, 'G3')]];
  const result = await e.restoreWorkbook(fixture(rows, '筛选结果'), masked.dictionary, '部分.xlsx');
  assert.equal(value(result.bytes, 'A2'), '同名'); assert.equal(value(result.bytes, 'A3'), '其他');
});
test('incorrect, truncated, mixed-batch and tampered dictionaries are rejected', async () => {
  const other = await e.maskWorkbook(fixture([['姓名'], ['其他人']]), '另一次.xlsx');
  await assert.rejects(e.restoreWorkbook(masked.workbook, other.dictionary, 'r.xlsx'), /批次/);
  const mixed = fixture([['名称'], [value(other.workbook, 'A2')], [value(masked.workbook, 'A2')]]);
  await assert.rejects(e.restoreWorkbook(mixed, masked.dictionary, 'r.xlsx'), /未知脱敏编码/);
  const partial = fixture([['名称'], [value(masked.workbook, 'A2') + '-残缺']]);
  await assert.rejects(e.restoreWorkbook(partial, masked.dictionary, 'r.xlsx'), /必须完整匹配/);
  const dictBook = e.readBook(masked.dictionary);
  e.writeCell(dictBook.sheets[1].cells.find((c) => c.ref === 'B2'), '篡改');
  await assert.rejects(e.readDictionary(e.saveBook(dictBook)), /完整性/);
  await assert.rejects(e.readDictionary(source), /字典/);
});
test('a store suffix modification is detected during restore', async () => {
  const result = fixture([['店铺'], [value(masked.workbook, 'F2').replace(/-US$/, '-UK')]]);
  await assert.rejects(e.restoreWorkbook(result, masked.dictionary, 'r.xlsx'), /末尾字符/);
});
test('duplicate masking is refused and every run has a distinct batch', async () => {
  await assert.rejects(e.maskWorkbook(masked.workbook, '再次.xlsx'), /已有脱敏批次/);
  const again = await e.maskWorkbook(source, '同一原件.xlsx');
  const againDict = await e.readDictionary(again.dictionary);
  assert.notEqual(againDict.batch, dict.batch);
  assert.equal(value(again.workbook, 'A2'), '人1');
});
test('ZIP has exactly two correctly named workbooks', () => {
  const parts = e.openZip(masked.zip);
  assert.deepEqual(Object.keys(parts).sort(), [masked.workbookName, masked.dictionaryName].sort());
  assert.match(masked.filename, /^示例_已脱密_\d{8}-\d{6}-\d{3}\.zip$/);
  assert.match(masked.dictionaryName, /_脱密字典_/);
});
test('multiple worksheets only process the 1st worksheet, and output has only 1 sheet', async () => {
  const multi = e.tableWorkbook([{ name: '甲', rows: [['销售员', '品牌'], ['甲人', '同品牌']] }, { name: '乙', rows: [['IPD', '品牌'], ['乙人', '同品牌']] }]);
  const result = await e.maskWorkbook(multi, '多表.xlsx');
  const outBook = e.readBook(result.workbook);
  assert.equal(outBook.sheets.length, 1);
  assert.equal(outBook.sheets[0].name, '工作表1');
  assert.equal(value(result.workbook, 'A2'), '人1');
  assert.equal(value(result.workbook, 'B2'), 'B1');
  const restored = await e.restoreWorkbook(result.workbook, result.dictionary, '多表.xlsx');
  assert.equal(e.readBook(restored.bytes).sheets[0].name, '甲');
});
test('anti-collision avoids tokens already present in original sheet text', async () => {
  const colTest = fixture([['名称', '销售员'], ['A1', '人1'], ['新值', '张三']]);
  const result = await e.maskWorkbook(colTest, '防碰撞.xlsx');
  assert.equal(value(result.workbook, 'A2'), 'A2');
  assert.equal(value(result.workbook, 'A3'), 'A3');
  assert.equal(value(result.workbook, 'B2'), '人2');
  assert.equal(value(result.workbook, 'B3'), '人3');
  const restored = await e.restoreWorkbook(result.workbook, result.dictionary, '防碰撞.xlsx');
  assert.equal(value(restored.bytes, 'A2'), 'A1');
  assert.equal(value(restored.bytes, 'A3'), '新值');
  assert.equal(value(restored.bytes, 'B2'), '人1');
  assert.equal(value(restored.bytes, 'B3'), '张三');
});
test('numeric-only workbooks remain restorable with the batch marker; dates cannot be overridden to mask', async () => {
  const result = await e.maskWorkbook(fixture([['金额', '日期'], [1.005, '2024-02-29']]), '数值.xlsx');
  assert.equal(result.stats.unique, 0);
  const restored = await e.restoreWorkbook(result.workbook, result.dictionary, '数值.xlsx');
  assert.equal(value(restored.bytes, 'A2'), 1.01);
  await assert.rejects(e.maskWorkbook(source, 'source.xlsx', { '0:10': 'mask' }), /日期列/);
  await assert.rejects(e.maskWorkbook(source, 'source.xlsx', { '0:1': 'keep' }), /专用/);
});
test('literal Excel escape sequences and CRLF survive dictionary export/import', async () => {
  const original = '_x0041_\r\n<&>\u0001';
  const input = fixture([['名称'], [original]]);
  assert.equal(value(input, 'A2'), original);
  const result = await e.maskWorkbook(input, 'r.xlsx');
  const restored = await e.restoreWorkbook(result.workbook, result.dictionary, 'r.xlsx');
  assert.equal(value(restored.bytes, 'A2'), original);
});
const dangerous = '张"三\' & <script>alert(1)</script> ` ${secret} \\ \u2028';
const htmlFixture = await e.maskWorkbook(fixture([['姓名', '店铺'], [dangerous, '店铺<&>']]), 'HTML.xlsx');
const htmlDict = await e.readDictionary(htmlFixture.dictionary);
const nameToken = value(htmlFixture.workbook, 'A2');
const storeToken = value(htmlFixture.workbook, 'B2');
test('HTML text and attributes are escaped; JS and JSON literals are context-safe and source structure stays intact', () => {
  const source = `<!doctype html><html><head><meta charset="UTF-8"></head><body><h1 title="${nameToken}">${nameToken}</h1><script>const name='${nameToken}'; const untouched = 1 + 2;</script><script type="application/json">{"${nameToken}":"${nameToken}"}</script></body></html>`;
  const result = e.restoreReportText(source, htmlDict);
  assert.equal(result.restored, 5);
  assert.match(result.text, /&lt;script&gt;/);
  assert.match(result.text, /\\u003cscript\\u003e/);
  assert.match(result.text, /const untouched = 1 \+ 2;/);
  assert.equal((result.text.match(/<script(?:\s|>)/g) ?? []).length, 2);
  assert.doesNotMatch(result.text, new RegExp(e.TOKEN_SOURCE));
});
test('report restores HTML-entity store suffixes and Unicode-escaped JS values', () => {
  const escapedStore = storeToken.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const unicodeToken = nameToken.replace(/^A/, '\\u0041');
  const result = e.restoreReportText(`<p>${escapedStore}</p><script>window.name = "${unicodeToken}";</script>`, htmlDict);
  assert.equal(result.restored, 2); assert.match(result.text, /店铺&lt;&amp;&gt;/);
});
test('HTML template content is restored without executing scripts; plain template strings are supported', () => {
  const result = e.restoreReportText(`<template><b>${nameToken}</b></template><script>const name=\`${nameToken}\`;</script>`, htmlDict);
  assert.equal(result.restored, 2);
  assert.equal(globalThis.secret, undefined);
});
test('reports refuse unknown dictionaries, truncated names, unsafe contexts, invalid JS and unsupported encodings', () => {
  for (const html of [
    `<p>${nameToken.slice(0, -1)}</p>`, `<p>没有编码</p>`, `<script>const name = '${nameToken}'; invalid !!!</script>`,
    `<style>.${nameToken}{color:red}</style>`, `<p>${nameToken}</p><!--${nameToken}-->`,
    `<a href="/${nameToken}">链接</a>`, `<script type="application/json">{"x": ${nameToken}}</script>`,
    `<meta charset="GBK"><p>${nameToken}</p>`, `<script>const name = \`${nameToken}\${count}\`;</script>`,
  ]) assert.throws(() => e.restoreReportText(html, htmlDict));
  assert.throws(() => e.restoreReportText(`<p>${nameToken}</p>`, dict), /未找到字典对应的编码|未知脱敏编码/);
});
test('HTML JSON replacement preserves original numeric literals and whitespace exactly', () => {
  const result = e.restoreReportText(`<script type="application/json">{ "name": "${nameToken}", "id": 9007199254740993123, "amount": 0.123456789123456789, "large": 1e309 }</script>`, htmlDict);
  assert.match(result.text, /"id": 9007199254740993123, "amount": 0\.123456789123456789, "large": 1e309/);
  assert.equal(result.restored, 1);
});
test('tagged templates that would become invalid JavaScript are rejected', () => {
  assert.throws(() => e.restoreReportText(`<script>const name = String.raw\`${nameToken}\`;</script>`, htmlDict), /语法不兼容/);
});
test('native Excel ISO date cells and errors preserve their types through both operations', async () => {
  const parts = e.openZip(fixture([['名称', '原生日期', '错误'], ['测试', 'placeholder', 'error']]));
  parts['xl/worksheets/sheet1.xml'] = e.encode(e.decode(parts['xl/worksheets/sheet1.xml']).replace(/<c r="B2".*?<\/c>/, '<c r="B2" t="d"><v>2024-02-29T00:00:00Z</v></c>').replace(/<c r="C2".*?<\/c>/, '<c r="C2" t="e"><v>#N/A</v></c>'));
  const result = await e.maskWorkbook(e.pack(parts), '日期.xlsx');
  const restored = await e.restoreWorkbook(result.workbook, result.dictionary, '日期.xlsx');
  for (const bytes of [result.workbook, restored.bytes]) {
    const cells = e.readBook(bytes).sheets[0].cells;
    assert.equal(cells.find((cell) => cell.ref === 'B2').node.getAttribute('t'), 'd');
    assert.equal(cells.find((cell) => cell.ref === 'C2').node.getAttribute('t'), 'e');
  }
});
test('percent number formatting remains percent after rounding the underlying numeric value', async () => {
  const book = e.readBook(fixture([['比例'], [0.1372165138]]));
  const cell = book.sheets[0].cells.find((cell) => cell.ref === 'A2');
  const styles = new e.StyleBuilder(book.styles);
  e.writeCell(cell, cell.value, styles.format(cell.style, '0.0000%'));
  const result = await e.maskWorkbook(e.saveBook(book), '百分比.xlsx');
  const output = e.readBook(result.workbook);
  assert.equal(output.sheets[0].cells.find((cell) => cell.ref === 'A2').value, 0.14);
  assert.ok(e.xml(output.styles).includes('formatCode="0.00%"'));
});
test('a numeric-text column can be explicitly masked without masking actual numeric cells', async () => {
  const result = await e.maskWorkbook(fixture([['客户'], ['1234'], [5678]]), '客户.xlsx', { '0:1': 'mask' });
  assert.match(value(result.workbook, 'A2'), new RegExp(e.TOKEN_SOURCE));
  assert.equal(value(result.workbook, 'A3'), 5678);
  const restored = await e.restoreWorkbook(result.workbook, result.dictionary, '客户.xlsx');
  assert.equal(value(restored.bytes, 'A2'), '1234');
});
test('auxiliary parts like drawings, comments, printerSettings, calcChain are accepted and safely stripped', async () => {
  const parts = e.openZip(fixture([['姓名', '店铺'], ['张三', '测试店-US']]));
  parts['xl/drawings/drawing1.xml'] = e.encode('<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>');
  parts['xl/drawings/_rels/drawing1.xml.rels'] = e.encode('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>');
  parts['xl/printerSettings/printerSettings1.bin'] = new Uint8Array([1, 2, 3, 4]);
  parts['xl/comments1.xml'] = e.encode('<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
  parts['xl/calcChain.xml'] = e.encode('<calcChain xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>');
  // Inject drawing reference into sheet1.xml
  const sheetXml = e.decode(parts['xl/worksheets/sheet1.xml']).replace('</worksheet>', '<drawing r:id="rIdDrawing1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/><legacyDrawing r:id="rIdLegacy1" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/></worksheet>');
  parts['xl/worksheets/sheet1.xml'] = e.encode(sheetXml);
  const rawXlsx = e.pack(parts);
  // readBook should not throw:
  const book = e.readBook(rawXlsx);
  assert.ok(book.sheets.length > 0);
  // maskWorkbook should succeed:
  const masked = await e.maskWorkbook(rawXlsx, '含控件测试.xlsx');
  const outParts = e.openZip(masked.workbook);
  assert.ok(!outParts['xl/drawings/drawing1.xml']);
  assert.ok(!outParts['xl/drawings/_rels/drawing1.xml.rels']);
  assert.ok(!outParts['xl/printerSettings/printerSettings1.bin']);
  assert.ok(!outParts['xl/comments1.xml']);
  assert.ok(!outParts['xl/calcChain.xml']);
  // References should be cleaned up from sheet xml:
  const outSheetXml = e.decode(outParts['xl/worksheets/sheet1.xml']);
  assert.ok(!outSheetXml.includes('<drawing'));
  assert.ok(!outSheetXml.includes('<legacyDrawing'));
  // And restore works:
  const restored = await e.restoreWorkbook(masked.workbook, masked.dictionary, '含控件测试.xlsx');
  assert.equal(value(restored.bytes, 'A2'), '张三');
});
test('columns where all numbers are positive or integers do not have extra 2 decimals forced', async () => {
  const input = fixture([
    ['销量', '数量', '金额'],
    ['10', 5, 1.005],
    ['25', 12, -1.005],
  ]);
  const result = await e.maskWorkbook(input, '正数测试.xlsx');
  assert.equal(value(result.workbook, 'A2'), 10);
  assert.equal(value(result.workbook, 'A3'), 25);
  assert.equal(value(result.workbook, 'B2'), 5);
  assert.equal(value(result.workbook, 'B3'), 12);
  assert.equal(value(result.workbook, 'C2'), 1.01);
  assert.equal(value(result.workbook, 'C3'), -1.01);
});
const sharedPrefixStores = {
  version: 1, batch: '1234567890ABCDEF', sourceName: '旧报告.xlsx', created: now.toISOString(),
  mappings: [{domain:'A:店铺',original:'甲店-US',masked:'S1-US'},{domain:'店铺',original:'乙店-UK',masked:'S1-UK'},{domain:'店铺',original:'丙店<&>',masked:'S2<&>'}],
  sheets: [{original:'原表',masked:'工作表1'}],
};
test('report restoration accepts every full store code sharing a numeric prefix',async()=>{
  for(const dictionary of [sharedPrefixStores,await e.readDictionary(await e.writeDictionary(sharedPrefixStores))]) {
    const result=e.restoreReportText('<p>S1-US / S1-UK</p><script>const shop="S1-UK";</script><script type="application/json">{"shop":"S1-US","site":"US"}</script>',dictionary);
    assert.equal(result.restored,4);assert.ok(result.text.includes('甲店-US'));assert.ok(result.text.includes('乙店-UK'));assert.ok(result.text.includes('"site":"US"'));
  }
});
test('shared-prefix validation still rejects truncated, changed, expanded and split store codes',()=>{
  for(const source of ['<p>S1</p>','<p>S1-DE</p>','<p>S1_US</p>','<p>S1-USX</p>','<p>S1-US / S1-DE</p>','<span>S1</span><span>-US</span>']) assert.throws(()=>e.restoreReportText(source,sharedPrefixStores),/脱敏编码或店铺末尾字符/);
});
test('store suffix validation remains context safe for HTML entities and old dictionary XLSX restoration',async()=>{
 const report=e.restoreReportText('<p>S2&lt;&amp;&gt;</p>',sharedPrefixStores);assert.equal(report.restored,1);assert.ok(report.text.includes('丙店&lt;&amp;&gt;'));
 const bytes=fixture([['店铺','站点'],['S1-US','US'],['S1-UK','UK']]);const restored=await e.restoreWorkbook(bytes,await e.writeDictionary(sharedPrefixStores),'旧结果.xlsx');assert.equal(value(restored.bytes,'A2'),'甲店-US');assert.equal(value(restored.bytes,'A3'),'乙店-UK');assert.equal(value(restored.bytes,'B2'),'US');
});
test('a real multi-file v2 dictionary restores shared-prefix shops without changing existing tokens',async()=>{
 const files=['甲店-US','乙店-UK'].map((shop,i)=>new File([fixture([['店铺'],[shop]])],`文件${i}.xlsx`));
 const plan={files:files.map((_,i)=>({id:String(i+1),sheets:[0],domains:{'0:1':'店铺'},overrides:{}})),legacyDomains:{}};
 const batch=await e.maskBatch(files,plan),zip=e.openZip(batch.bytes),dictionary=await e.readDictionary(zip['批次脱敏字典.xlsx']);assert.equal(dictionary.version,2);assert.deepEqual(dictionary.mappings.map(m=>m.masked),['S1-US','S1-UK']);const restored=await e.restoreReport('<p>S1-US</p><p>S1-UK</p>',zip['批次脱敏字典.xlsx'],'报告.html');assert.equal(restored.restored,2);assert.match(restored.text,/甲店-US/);assert.match(restored.text,/乙店-UK/);
});
