import assert from 'node:assert/strict';
import {
  buildHeaderEntries,
  buildOutputFilename,
  buildSchemaMapping,
  isReliableAlignment,
  normalizeHeader,
  selectHeaderCandidate,
} from '../xlsx-workbook-merger/core.js';

assert.equal(normalizeHeader('  商品\n  标题  '), '商品 标题');
assert.equal(normalizeHeader('ＡＳＩＮ'), 'asin');
assert.equal(normalizeHeader({ richText: [{ text: '品牌' }, { text: '链接' }] }), '品牌链接');

const master = buildHeaderEntries(['ASIN', 'SKU', '品牌', '品牌']).entries;
assert.deepEqual(master.map((entry) => entry.key), [
  'header:asin:1',
  'header:sku:1',
  'header:品牌:1',
  'header:品牌:2',
]);

const source = buildHeaderEntries(['品牌', 'ASIN', '新增字段', '品牌', 'SKU']).entries;
const mapping = buildSchemaMapping(master, source);
assert.equal(mapping.kind, 'expanded');
assert.equal(mapping.sourceToOutput.get(1), 3);
assert.equal(mapping.sourceToOutput.get(2), 1);
assert.equal(mapping.sourceToOutput.get(4), 4);
assert.equal(mapping.sourceToOutput.get(5), 2);
assert.equal(mapping.addedEntries.length, 1);
assert.equal(mapping.addedEntries[0].outputColumn, 5);
assert.equal(mapping.similarity, 1);
assert.equal(isReliableAlignment(mapping), true);

const reordered = buildSchemaMapping(master, buildHeaderEntries(['品牌', 'ASIN', 'SKU', '品牌']).entries);
assert.equal(reordered.kind, 'reordered');
assert.equal(reordered.similarity, 1);
assert.equal(reordered.sourceToOutput.get(1), 3);
assert.equal(reordered.sourceToOutput.get(4), 4);

const unrelated = buildSchemaMapping(master, buildHeaderEntries(['价格', '库存']).entries);
assert.equal(isReliableAlignment(unrelated), false);

const header = selectHeaderCandidate([
  { rowNumber: 1, values: ['卖家精灵导出'] },
  { rowNumber: 2, values: ['ASIN', 'SKU', '品牌'] },
  { rowNumber: 3, values: ['B012345678', 'S-1', 'Example'] },
]);
assert.equal(header.rowNumber, 2);

const reference = buildHeaderEntries(['ASIN', 'SKU', '品牌']).entries
  .map((entry, index) => ({ ...entry, outputColumn: index + 1 }));
const matchedHeader = selectHeaderCandidate([
  { rowNumber: 1, values: ['报告名称', '2026-08'] },
  { rowNumber: 4, values: ['品牌', 'SKU', 'ASIN'] },
], reference);
assert.equal(matchedHeader.rowNumber, 4);

const filename = buildOutputFilename('Product.xlsx', new Date(2026, 7, 11, 9, 8, 7));
assert.equal(filename, '20260811-090807_Product.xlsx');

console.log('xlsx-workbook-merger core tests passed');
