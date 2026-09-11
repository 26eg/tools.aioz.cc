import { DOMParser, XMLSerializer, type Document, type Element, type Node } from '@xmldom/xmldom';
import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

export const MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
export const DOC_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_EXPANDED_BYTES = 100 * 1024 * 1024;
export const MAX_CELLS = 500_000;
export type Parts = Record<string, Uint8Array>;
export type Value = string | number | boolean | null;
export type XmlDocument = Document;
export type XmlElement = Element;

export function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
export const encode = strToU8;
export const decode = strFromU8;
export const xml = (node: Node): string => new XMLSerializer().serializeToString(node);
export function parseXml(source: string): Document {
  check(!/<!DOCTYPE|<!ENTITY/i.test(source), '不支持含 DTD / ENTITY 的 XML。');
  return new DOMParser({ onError: () => { throw new Error('XML 格式损坏。'); } }).parseFromString(source, 'application/xml');
}
export function elements(node: Document | Element, name: string, namespace = MAIN): Element[] {
  return Array.from(node.getElementsByTagNameNS(namespace, name));
}
export function child(node: Element, name: string): Element | undefined {
  return Array.from(node.childNodes).find((item): item is Element => item.nodeType === 1 && (item as Element).localName === name);
}
export function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;').replace(/\r/g, '&#13;');
}
// Excel's ST_Xstring escape sequence is separate from XML entity escaping.
export function excelDecode(value: string): string {
  return value.replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}
export function excelEncode(value: string): string {
  return value.replace(/_x[0-9a-f]{4}_/gi, (match) => `_x005F_${match.slice(1)}`)
    .replace(/[\u0000-\u0008\u000b-\u001f\ufffe\uffff]/g, (match) => `_x${match.charCodeAt(0).toString(16).padStart(4, '0')}_`);
}
export function columnName(number: number): string {
  let name = '';
  while (number > 0) { number--; name = String.fromCharCode(65 + number % 26) + name; number = Math.floor(number / 26); }
  return name;
}
export function address(ref: string): { row: number; col: number } {
  const match = /^([A-Z]{1,3})([1-9]\d{0,6})$/.exec(ref);
  check(match, '发现无效的单元格地址。');
  const col = [...match[1]!].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0);
  const row = Number(match[2]);
  check(col <= 16384 && row <= 1048576, '单元格地址超出 Excel 范围。');
  return { row, col };
}
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
export function openZip(bytes: Uint8Array): Parts {
  check(bytes.length >= 22 && bytes.length <= MAX_FILE_BYTES, '请选择有效 XLSX，单个文件不得超过 30 MB。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  for (; end >= Math.max(0, bytes.length - 65557); end--) {
    if (view.getUint32(end, true) === 0x06054b50 && end + 22 + view.getUint16(end + 20, true) === bytes.length) break;
  }
  check(end >= 0 && view.getUint32(end, true) === 0x06054b50, '文件不是有效的 XLSX ZIP 容器（不支持密码保护文件）。');
  const count = view.getUint16(end + 10, true);
  check(count > 0 && count <= 2048 && view.getUint16(end + 4, true) === 0 && view.getUint16(end + 6, true) === 0 && view.getUint16(end + 8, true) === count, '不支持分卷、ZIP64 或超过 2048 个部件的工作簿。');
  let offset = view.getUint32(end + 16, true);
  check(offset + view.getUint32(end + 12, true) === end, 'ZIP 目录损坏。');
  const entries = new Map<string, { size: number; crc: number }>();
  let expanded = 0;
  for (let index = 0; index < count; index++) {
    check(offset + 46 <= end && view.getUint32(offset, true) === 0x02014b50, 'ZIP 部件目录损坏。');
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 24, true);
    const nameSize = view.getUint16(offset + 28, true);
    const extraSize = view.getUint16(offset + 30, true);
    const commentSize = view.getUint16(offset + 32, true);
    check(!(flags & 1) && (method === 0 || method === 8), '不支持加密或特殊压缩的工作簿。');
    check(offset + 46 + nameSize + extraSize + commentSize <= end, 'ZIP 文件名损坏。');
    const name = decode(bytes.subarray(offset + 46, offset + 46 + nameSize));
    check(name && !name.startsWith('/') && !name.includes('\\') && !name.split('/').includes('..') && !name.includes('\0') && !entries.has(name), 'ZIP 包含重复或不安全的部件名称。');
    expanded += size;
    check(expanded <= MAX_EXPANDED_BYTES, '工作簿解压后超过 100 MB，请拆分后处理。');
    entries.set(name, { size, crc: view.getUint32(offset + 16, true) });
    offset += 46 + nameSize + extraSize + commentSize;
  }
  check(offset === end, 'ZIP 目录长度不一致。');
  const parts = unzipSync(bytes, { filter: (entry) => {
    const expected = entries.get(entry.name);
    check(expected && entry.originalSize === expected.size, 'ZIP 声明的部件大小不一致。');
    return true;
  } });
  check(Object.keys(parts).length === entries.size, 'ZIP 部件数量不一致。');
  for (const [name, info] of entries) {
    const data = parts[name];
    check(data && data.length === info.size && crc32(data) === info.crc, '文件 CRC 校验失败，请重新导出。');
    if (name.endsWith('/')) delete parts[name];
  }
  return parts;
}
export function pack(parts: Parts): Uint8Array { return zipSync(parts, { level: 6 }); }
export async function sha256(value: string | Uint8Array): Promise<string> {
  const bytes = typeof value === 'string' ? encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes)))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface Cell { node: Element; ref: string; row: number; col: number; value: Value; style: number; date: boolean; }
export interface Sheet { name: string; path: string; node: Element; document: Document; cells: Cell[]; maxRow: number; maxCol: number; }
export interface Book { parts: Parts; workbook: Document; styles: Document; sheets: Sheet[]; date1904: boolean; }
const standardPart = /^(?:\[Content_Types\]\.xml|_rels\/\.rels|docProps\/[A-Za-z0-9_-]+\.xml|xl\/workbook\.xml|xl\/_rels\/workbook\.xml\.rels|xl\/styles\.xml|xl\/sharedStrings\.xml|xl\/theme\/theme\d+\.xml|xl\/worksheets\/sheet\d+\.xml|xl\/worksheets\/_rels\/sheet\d+\.xml\.rels|xl\/persons\/person\.xml)$/;
const emptyStyles = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

export function readBook(bytes: Uint8Array): Book {
  const parts = openZip(bytes);
  for (const path of Object.keys(parts)) check(standardPart.test(path), `暂不支持部件 ${path}。请先导出为仅含数据与单元格格式的 XLSX。`);
  for (const path of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) check(parts[path], `工作簿缺少 ${path}。`);
  const workbook = parseXml(decode(parts['xl/workbook.xml']!));
  check(workbook.documentElement?.namespaceURI === MAIN, '只支持标准 XLSX 工作簿。');
  const relationships = parseXml(decode(parts['xl/_rels/workbook.xml.rels']!));
  const rels = new Map(elements(relationships, 'Relationship', REL).map((rel) => [rel.getAttribute('Id'), rel]));
  const strings = parts['xl/sharedStrings.xml'] ? elements(parseXml(decode(parts['xl/sharedStrings.xml'])), 'si').map((si) => textRuns(si)) : [];
  const styles = parseXml(parts['xl/styles.xml'] ? decode(parts['xl/styles.xml']) : emptyStyles);
  const formats = new Map(elements(styles, 'numFmt').map((item) => [Number(item.getAttribute('numFmtId')), item.getAttribute('formatCode') ?? '']));
  const xfs = elements(styles, 'cellXfs')[0];
  check(xfs, '工作簿缺少有效的 cellXfs 样式。');
  const styleDates = Array.from(xfs.childNodes).filter((node): node is Element => node.nodeType === 1).map((node) => {
    const id = Number(node.getAttribute('numFmtId') ?? '0');
    const format = (formats.get(id) ?? '').replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
    return (id >= 14 && id <= 22) || (id >= 27 && id <= 36) || (id >= 45 && id <= 47) || (id >= 50 && id <= 58) || /[ydhms]/i.test(format);
  });
  const sheets: Sheet[] = [];
  let total = 0;
  for (const node of elements(workbook, 'sheet')) {
    const name = node.getAttribute('name') ?? '';
    check(name.length > 0 && name.length <= 31 && !/[\\/*?:\[\]]/.test(name), '工作表名称无效。');
    const rel = rels.get(node.getAttributeNS(DOC_REL, 'id'));
    check(rel && !rel.getAttribute('TargetMode'), '工作表关系无效。');
    const target = rel.getAttribute('Target') ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    check(/^xl\/worksheets\/sheet\d+\.xml$/.test(path) && parts[path] && !sheets.some((sheet) => sheet.path === path || sheet.name === name), '工作表路径或名称重复、缺失或无效。');
    const document = parseXml(decode(parts[path]!));
    check(document.documentElement?.namespaceURI === MAIN, '工作表 XML 命名空间无效。');
    for (const tag of ['f', 'mergeCell', 'dataValidation', 'conditionalFormatting', 'hyperlink', 'sheetProtection']) {
      check(!elements(document, tag).length, `工作表「${name}」包含 ${tag}（公式、合并、验证、条件格式、链接或保护），请先导出为值表。`);
    }
    const seen = new Set<string>();
    const cells: Cell[] = [];
    let maxRow = 0, maxCol = 0;
    for (const cell of elements(document, 'c')) {
      check(++total <= MAX_CELLS, '工作簿超过 500,000 个已存储单元格，请拆分后处理。');
      const ref = cell.getAttribute('r') ?? '';
      const position = address(ref);
      check(!seen.has(ref), '工作表存在重复单元格。'); seen.add(ref);
      const style = Number(cell.getAttribute('s') ?? '0');
      check(Number.isSafeInteger(style) && style >= 0 && style < styleDates.length, '单元格样式引用无效。');
      const raw = child(cell, 'v')?.textContent ?? '';
      const type = cell.getAttribute('t') ?? 'n';
      let value: Value;
      if (type === 's') { check(/^\d+$/.test(raw) && strings[Number(raw)] !== undefined, '共享字符串引用无效。'); value = strings[Number(raw)]!; }
      else if (type === 'inlineStr') value = child(cell, 'is') ? textRuns(child(cell, 'is')!) : '';
      else if (type === 'str' || type === 'd') value = excelDecode(raw);
      else if (type === 'b') { check(raw === '0' || raw === '1', '布尔值无效。'); value = raw === '1'; }
      else if (type === 'e') { check(/^#(?:NULL!|DIV\/0!|VALUE!|REF!|NAME\?|NUM!|N\/A|GETTING_DATA|SPILL!|CALC!|BUSY!|CONNECT!|BLOCKED!|UNKNOWN!|FIELD!)$/.test(raw), '单元格包含无效的 Excel 错误值。'); value = raw; }
      else { check(type === 'n', `不支持单元格类型 ${type}。`); value = raw === '' ? null : Number(raw); check(value === null || Number.isFinite(value), '发现无效的数值。'); }
      check(value === null || typeof value !== 'string' || value.length <= 32767, '单元格文本超过 Excel 32767 字符限制。');
      cells.push({ node: cell, ref, ...position, value, style, date: styleDates[style]! || type === 'd' });
      if (value !== null) { maxRow = Math.max(maxRow, position.row); maxCol = Math.max(maxCol, position.col); }
    }
    sheets.push({ name, path, node, document, cells, maxRow, maxCol });
  }
  check(sheets.length > 0, '工作簿没有工作表。');
  const referenced = new Set(sheets.map((sheet) => sheet.path));
  check(Object.keys(parts).filter((path) => /^xl\/worksheets\/sheet\d+\.xml$/.test(path)).every((path) => referenced.has(path)), '工作簿包含未引用的工作表，无法保证脱敏完整。');
  const date1904 = ['1', 'true'].includes(elements(workbook, 'workbookPr')[0]?.getAttribute('date1904') ?? '');
  return { parts, workbook, styles, sheets, date1904 };
}
function textRuns(element: Element): string {
  return excelDecode(elements(element, 't').filter((t) => t.parentNode?.nodeName !== 'rPh').map((t) => t.textContent ?? '').join(''));
}
export function writeCell(cell: Cell, value: Value, style?: number): void {
  const node = cell.node;
  while (node.firstChild) node.removeChild(node.firstChild);
  node.removeAttribute('t');
  if (style !== undefined) { node.setAttribute('s', String(style)); cell.style = style; }
  const doc = node.ownerDocument!;
  if (typeof value === 'string') {
    node.setAttribute('t', 'inlineStr');
    const is = doc.createElementNS(MAIN, 'is');
    const t = doc.createElementNS(MAIN, 't'); t.setAttribute('xml:space', 'preserve');
    t.appendChild(doc.createTextNode(excelEncode(value))); is.appendChild(t); node.appendChild(is);
  } else if (value !== null) {
    if (typeof value === 'boolean') node.setAttribute('t', 'b');
    const v = doc.createElementNS(MAIN, 'v'); v.appendChild(doc.createTextNode(typeof value === 'boolean' ? (value ? '1' : '0') : String(value))); node.appendChild(v);
  }
  cell.value = value;
}

export class StyleBuilder {
  private readonly cache = new Map<string, number>();
  constructor(private readonly styles: Document) {}
  numericFormat(base: number): string {
    const xfs = elements(this.styles, 'cellXfs')[0]!;
    const entries = Array.from(xfs.childNodes).filter((node): node is Element => node.nodeType === 1);
    const id = Number(entries[base]?.getAttribute('numFmtId') ?? 0);
    const custom = elements(this.styles, 'numFmt').find((item) => Number(item.getAttribute('numFmtId')) === id)?.getAttribute('formatCode') ?? '';
    if (id === 9 || id === 10 || /(?<!\\)%/.test(custom.replace(/"[^"]*"/g, ''))) return '0.00%';
    const currency = custom.match(/[$€£¥₹]/)?.[0];
    if (currency) return `"${currency}"#,##0.00`;
    return '0.00';
  }
  format(base: number, code: string): number {
    const key = `${base}:${code}`;
    const cached = this.cache.get(key); if (cached !== undefined) return cached;
    const xfs = elements(this.styles, 'cellXfs')[0]!;
    const entries = Array.from(xfs.childNodes).filter((node): node is Element => node.nodeType === 1);
    let formats = elements(this.styles, 'numFmts')[0];
    if (!formats) { formats = this.styles.createElementNS(MAIN, 'numFmts'); this.styles.documentElement!.insertBefore(formats, this.styles.documentElement!.firstChild); }
    const found = elements(formats, 'numFmt').find((item) => item.getAttribute('formatCode') === code);
    const id = found ? Number(found.getAttribute('numFmtId')) : Math.max(163, ...elements(formats, 'numFmt').map((item) => Number(item.getAttribute('numFmtId')))) + 1;
    if (!found) { const item = this.styles.createElementNS(MAIN, 'numFmt'); item.setAttribute('numFmtId', String(id)); item.setAttribute('formatCode', code); formats.appendChild(item); formats.setAttribute('count', String(elements(formats, 'numFmt').length)); }
    const item = entries[base]!.cloneNode(true) as Element;
    item.setAttribute('numFmtId', String(id)); item.setAttribute('applyNumberFormat', '1');
    xfs.appendChild(item); xfs.setAttribute('count', String(entries.length + 1));
    this.cache.set(key, entries.length); return entries.length;
  }
}

export function saveBook(book: Book): Uint8Array {
  book.parts['xl/workbook.xml'] = encode(xml(book.workbook));
  book.parts['xl/styles.xml'] = encode(xml(book.styles));
  for (const sheet of book.sheets) book.parts[sheet.path] = encode(xml(sheet.document));
  return packXlsx(book.parts);
}
function packXlsx(parts: Parts): Uint8Array {
  check(Object.values(parts).reduce((sum, bytes) => sum + bytes.length, 0) <= MAX_EXPANDED_BYTES, '生成的 XLSX 展开后超过 100 MB，请拆分源文件后重试，以保证结果可恢复。');
  const bytes = pack(parts);
  check(bytes.length <= MAX_FILE_BYTES, '生成的 XLSX 超过 30 MB，请拆分后重试，以保证结果可恢复。');
  return bytes;
}
export function sanitize(book: Book): number {
  const removed = new Set(Object.keys(book.parts).filter((path) => /^(docProps\/|xl\/persons\/|xl\/sharedStrings\.xml$|xl\/worksheets\/_rels\/)/.test(path)));
  for (const path of removed) delete book.parts[path];
  for (const path of ['_rels/.rels', 'xl/_rels/workbook.xml.rels']) {
    const doc = parseXml(decode(book.parts[path]!));
    for (const rel of elements(doc, 'Relationship', REL)) {
      const type = rel.getAttribute('Type') ?? '';
      if (/properties|person|sharedStrings/i.test(type)) rel.parentNode!.removeChild(rel);
      else check(!rel.getAttribute('TargetMode'), '不支持外部工作簿关系。');
    }
    book.parts[path] = encode(xml(doc));
  }
  const content = parseXml(decode(book.parts['[Content_Types].xml']!));
  for (const item of elements(content, 'Override', 'http://schemas.openxmlformats.org/package/2006/content-types')) {
    if (removed.has((item.getAttribute('PartName') ?? '').replace(/^\//, ''))) item.parentNode!.removeChild(item);
  }
  book.parts['[Content_Types].xml'] = encode(xml(content));
  for (const tag of ['definedNames', 'extLst', 'fileSharing', 'webPublishing']) {
    for (const node of elements(book.workbook, tag)) node.parentNode!.removeChild(node);
  }
  for (const sheet of book.sheets) {
    for (const tag of ['headerFooter', 'extLst', 'sheetPr']) {
      for (const node of elements(sheet.document, tag)) {
        if (tag === 'sheetPr') { node.removeAttribute('codeName'); continue; }
        node.parentNode!.removeChild(node);
      }
    }
  }
  return removed.size;
}

export function setBatch(book: Book, batch: string): void {
  book.parts['docProps/custom.xml'] = encode(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="AIOZBatch"><vt:lpwstr>${escapeXml(batch)}</vt:lpwstr></property></Properties>`);
  const rels = parseXml(decode(book.parts['_rels/.rels']!));
  const rel = rels.createElementNS(REL, 'Relationship');
  rel.setAttribute('Id', 'aiozBatch'); rel.setAttribute('Type', `${DOC_REL}/custom-properties`); rel.setAttribute('Target', 'docProps/custom.xml');
  rels.documentElement!.appendChild(rel); book.parts['_rels/.rels'] = encode(xml(rels));
  const types = parseXml(decode(book.parts['[Content_Types].xml']!));
  const item = types.createElementNS('http://schemas.openxmlformats.org/package/2006/content-types', 'Override');
  item.setAttribute('PartName', '/docProps/custom.xml'); item.setAttribute('ContentType', 'application/vnd.openxmlformats-officedocument.custom-properties+xml');
  types.documentElement!.appendChild(item); book.parts['[Content_Types].xml'] = encode(xml(types));
}
export function getBatch(book: Book): string | null {
  const bytes = book.parts['docProps/custom.xml'];
  if (!bytes) return null;
  const doc = parseXml(decode(bytes));
  const properties = elements(doc, 'property', 'http://schemas.openxmlformats.org/officeDocument/2006/custom-properties').filter((item) => item.getAttribute('name') === 'AIOZBatch');
  check(properties.length <= 1, '工作簿批次标记重复。');
  return properties[0]?.textContent ?? null;
}

export function tableWorkbook(tables: { name: string; rows: Value[][] }[]): Uint8Array {
  check(tables.reduce((sum, table) => sum + table.rows.reduce((cells, row) => cells + row.length, 0), 0) <= MAX_CELLS, '字典映射数量过多，请拆分源工作簿后处理，以保证字典可读回。');
  const parts: Parts = {};
  parts['[Content_Types].xml'] = encode(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${tables.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}</Types>`);
  parts['_rels/.rels'] = encode(`<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="${DOC_REL}/officeDocument" Target="xl/workbook.xml"/></Relationships>`);
  parts['xl/workbook.xml'] = encode(`<workbook xmlns="${MAIN}" xmlns:r="${DOC_REL}"><sheets>${tables.map((table, i) => `<sheet name="${escapeXml(table.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`);
  parts['xl/_rels/workbook.xml.rels'] = encode(`<Relationships xmlns="${REL}">${tables.map((_, i) => `<Relationship Id="rId${i + 1}" Type="${DOC_REL}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="styles" Type="${DOC_REL}/styles" Target="styles.xml"/></Relationships>`);
  parts['xl/styles.xml'] = encode(emptyStyles);
  for (const [i, table] of tables.entries()) {
    check(table.rows.length <= 1048576, '字典超过 Excel 行数限制。');
    const width = Math.max(1, ...table.rows.slice(0, 2).map((row) => row.length));
    const rows = table.rows.map((row, r) => `<row r="${r + 1}">${row.map((value, c) => {
      const ref = `${columnName(c + 1)}${r + 1}`;
      if (typeof value === 'string') { check(value.length <= 32767, '字典单元格文本过长。'); return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(excelEncode(value))}</t></is></c>`; }
      return value === null ? `<c r="${ref}"/>` : `<c r="${ref}"${typeof value === 'boolean' ? ' t="b"' : ''}><v>${typeof value === 'boolean' ? Number(value) : value}</v></c>`;
    }).join('')}</row>`).join('');
    parts[`xl/worksheets/sheet${i + 1}.xml`] = encode(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${MAIN}"><dimension ref="A1:${columnName(width)}${Math.max(1, table.rows.length)}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="${width}" width="28" customWidth="1"/></cols><sheetData>${rows}</sheetData><autoFilter ref="A1:${columnName(width)}${Math.max(1, table.rows.length)}"/></worksheet>`);
  }
  return packXlsx(parts);
}
