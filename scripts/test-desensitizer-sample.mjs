import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { engine as e } from './load-desensitizer-test.mjs';

const input = path.resolve(process.argv[2] ?? '../../本地项目/工作簿脱敏与恢复/测试数据/原始样本/日利润报表-2026-09.xlsx');
const output = path.resolve(process.argv[3] ?? `../../本地项目/工作簿脱敏与恢复/测试结果/单文件回归-${e.timestamp()}`);
const bytes = new Uint8Array(await readFile(input));
const sourceHash = await e.sha256(bytes);
const source = e.readBook(bytes);
const analysis = e.analyze(source);
const started = performance.now();
const result = await e.maskWorkbook(bytes, path.basename(input));
const maskMs = Math.round(performance.now() - started);
const dictionary = await e.readDictionary(result.dictionary);
const restored = await e.restoreWorkbook(result.workbook, result.dictionary, result.workbookName);
const maskedBook = e.readBook(result.workbook);
const restoredBook = e.readBook(restored.bytes);
let checkedCells = 0;
for (const [si, sheet] of source.sheets.entries()) {
  assert.equal(maskedBook.sheets[si].cells.length, sheet.cells.length);
  assert.equal(restoredBook.sheets[si].name, sheet.name);
  const actual = new Map(restoredBook.sheets[si].cells.map((cell) => [cell.ref, cell]));
  for (const cell of sheet.cells) {
    const recovered = actual.get(cell.ref);
    assert.ok(recovered, `Missing ${cell.ref}`);
    if (cell.row === 1) assert.equal(recovered.value, cell.value);
    else if (e.isBlank(cell.value)) assert.equal(recovered.value, null);
    else if (cell.date || typeof cell.value !== 'string') assert.equal(recovered.value, typeof cell.value === 'number' && !cell.date ? e.roundTwo(cell.value) : cell.value);
    else {
      const rule = analysis.rules.find((rule) => rule.key === `${si}:${cell.col}`);
      if (rule.mode === 'date' && e.parseDate(cell.value, source.date1904, true)) assert.equal(recovered.value, e.parseDate(cell.value, source.date1904, true).serial);
      else if (rule.type === '数值' && e.numericText(cell.value) !== null) assert.equal(recovered.value, e.roundTwo(e.numericText(cell.value)));
      else assert.equal(recovered.value, cell.value, `Mismatch at ${cell.ref}`);
    }
    checkedCells++;
  }
}
assert.equal(new Set(dictionary.mappings.map((item) => item.masked)).size, dictionary.mappings.length);
assert.equal(e.openZip(result.zip)[result.workbookName].length, result.workbook.length);
assert.ok(!e.openZip(result.workbook)['xl/sharedStrings.xml']);
const selected = dictionary.mappings.slice(0, 8);
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><title>脱敏报告测试</title></head><body><h1>本地恢复测试报告</h1><ul>${selected.map((item) => `<li>${e.escapeXml(item.masked)}</li>`).join('')}</ul><script type="application/json" id="data">${JSON.stringify(selected.map((item) => ({ name: item.masked, amount: 1.23 })))}</script><script>window.reportNames=${JSON.stringify(selected.map((item) => item.masked))};</script></body></html>`;
const report = await e.restoreReport(html, result.dictionary, '分析报告测试.html');
assert.equal(report.restored, selected.length * 3);
await mkdir(output, { recursive: true });
for (const [name, content] of [
  [result.filename, result.zip], [result.workbookName, result.workbook], [result.dictionaryName, result.dictionary],
  [restored.filename, restored.bytes], ['分析报告测试.html', html], [report.filename, report.text],
]) await writeFile(path.join(output, name), content);
assert.equal(await e.sha256(new Uint8Array(await readFile(input))), sourceHash, 'Source fixture was changed');
const summary = {
  source: input, sourceSha256: sourceHash, output, sourceRows: analysis.rows, columns: analysis.rules.length,
  columnModes: { [source.sheets[0].name]: Object.fromEntries(analysis.rules.map(rule => [rule.letter, rule.mode])) },
  cellsChecked: checkedCells, maskMs, stats: result.stats, restoredCells: restored.restored, reportReplacements: report.restored,
  types: Object.fromEntries([...new Set(analysis.rules.map((r) => r.type))].map((type) => [type, analysis.rules.filter((r) => r.type === type).length])),
  warnings: analysis.warnings,
  files: { zip: result.filename, workbook: result.workbookName, dictionary: result.dictionaryName, restored: restored.filename, html: '分析报告测试.html', restoredHtml: report.filename },
};
await writeFile(path.join(output, '验证结果.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
