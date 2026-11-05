import { type Book, type Cell, type Value, check, readBook, tableWorkbook, columnName, writeCell, StyleBuilder, saveBook, sanitize, sha256, pack, setBatch, getBatch, isolateFirstSheet, isolateSheets, elements } from './ooxml';

export type Mode = 'mask' | 'keep' | 'date';
export interface ColumnRule {
  key: string; sheet: string; col: number; letter: string; header: string; type: string;
  mode: Mode; reason: string; nonEmpty: number; fakeBlanks: number; uncertainDates: number;
  examples: string[]; person: boolean; store: boolean; noExtraDecimals?: boolean;
}
export interface Analysis { rules: ColumnRule[]; rows: number; cells: number; sheets: number; fakeBlanks: number; warnings: string[]; }
export interface Mapping { domain: string; original: string; masked: string; }
export interface Dictionary { version: 1 | 2; extension?: BatchExtension; batch: string; sourceName: string; created: string; mappings: Mapping[]; sheets: { original: string; masked: string }[]; }
export interface BatchFile { id: string; name: string; marker: string; sheets: { original: string; masked: string }[]; }
export interface BatchExtension { revision: number; files: BatchFile[]; aliases: Record<string, string>; policies: Record<string, string>; legacy: { original: string; masked: string }[]; }
export interface MaskOptions { sheets: number[]; batch: string; mappings: Mapping[]; reserved: Set<string>; domains: Record<string, string>; kinds?: Record<string, 'text' | 'person' | 'store'>; }
export interface MaskResult { zip: Uint8Array; filename: string; workbook: Uint8Array; dictionary: Uint8Array; workbookName: string; dictionaryName: string; stats: Stats; sheetMappings?: { original: string; masked: string }[]; }
export interface Stats { masked: number; unique: number; rounded: number; dates: number; blanks: number; uncertainDates: number; metadataParts: number; }
export const TOKEN_SOURCE = '(?:人\\d+|[A-Z]+\\d+.*)';
const blankPattern = /^[\s\u200b-\u200d\u2060\ufeff]*$/u;
export const isBlank = (value: Value): boolean => value === null || (typeof value === 'string' && blankPattern.test(value));
export const normalizeHeader = (value: Value): string => String(value ?? '').normalize('NFKC').trim();
const isPerson = (header: string): boolean => /^销售员.*$/u.test(header) || /^(IPD|GTM)$/i.test(header);
const isDateHeader = (header: string): boolean => /日期|时间|date|time/i.test(header);
const isIdentifier = (header: string): boolean => /asin|aisn|sku|spu|编号|编码|代码|订单号|邮编|电话|手机号|账号|证件|身份证|\bid\b/i.test(header);

export function roundTwo(value: number): number {
  check(Number.isFinite(value), '无法舍入非有限数值。');
  const [coefficient = '0', exponent = '0'] = Math.abs(value).toString().toLowerCase().split('e');
  const [integer = '0', fractional = ''] = coefficient.split('.');
  const places = fractional.length - Number(exponent);
  if (places <= 2) return value;
  const divisor = 10n ** BigInt(places - 2);
  const rounded = (BigInt(integer + fractional) + divisor / 2n) / divisor;
  const result = Number(`${value < 0 ? '-' : ''}${rounded}e-2`);
  return result === 0 ? 0 : result;
}
export function numericText(value: string): number | null {
  const text = value.trim();
  if (!/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const significant = text.replace(/[eE].*$/, '').replace(/[^\d]/g, '').replace(/^0+/, '');
  if (significant.length > 15) return null;
  const number = Number(text);
  return Number.isFinite(number) && !(number === 0 && /[1-9]/.test(text.split(/[eE]/)[0]!)) ? number : null;
}
export function parseDate(value: string, date1904 = false, compact = false): { serial: number; format: string } | null {
  let text = value.trim();
  if (compact && /^\d{8}$/.test(text)) text = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6)}`;
  text = text.replace(/年/g, '-').replace(/月/g, '-').replace(/日/g, '');
  const match = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?$/.exec(text);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[3]), day = Number(match[4]);
  const hour = Number(match[5] ?? 0), minute = Number(match[6] ?? 0), second = Number(match[7] ?? 0);
  const millis = Number((match[8] ?? '').padEnd(3, '0'));
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const stamp = Date.UTC(year, month - 1, day, hour, minute, second, millis);
  const date = new Date(stamp);
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 31);
  if (stamp < base) return null;
  const serial = (stamp - base) / 86400000 + (!date1904 && stamp >= Date.UTC(1900, 2, 1) ? 1 : 0);
  return { serial, format: match[5] ? (match[8] ? 'yyyy-mm-dd hh:mm:ss.000' : 'yyyy-mm-dd hh:mm:ss') : 'yyyy-mm-dd' };
}

export function analyze(book: Book, all = false): Analysis {
  const rules: ColumnRule[] = [];
  const warnings: string[] = [];
  let rows = 0, fakeBlanks = 0, totalCells = 0;
  const totalWorkbookSheets = elements(book.workbook, 'sheet').length;
  if (!all && totalWorkbookSheets > 1) {
    warnings.push(`检测到工作簿包含 ${totalWorkbookSheets} 个工作表，默认仅处理第 1 个工作表「${book.sheets[0]?.name ?? '工作表1'}」。`);
  }
  const targetSheets = all ? book.sheets : book.sheets.slice(0, 1);
  for (const [si, sheet] of targetSheets.entries()) {
    totalCells += sheet.cells.length;
    if (!sheet.maxRow) continue;
    const nonempty = sheet.cells.filter((cell) => !isBlank(cell.value));
    const first = Math.min(...nonempty.slice(0, 16384).map((cell) => cell.row));
    check(first === 1, `工作表「${sheet.name}」的表头不在第 1 行，请先移除标题/空行后重新选择文件。`);
    const headers = new Map(sheet.cells.filter((cell) => cell.row === 1).map((cell) => [cell.col, normalizeHeader(cell.value)]));
    const groups = new Map<number, Cell[]>();
    const dataRows = new Set<number>();
    for (const cell of sheet.cells) {
      if (cell.row <= 1) continue;
      const group = groups.get(cell.col) ?? []; group.push(cell); groups.set(cell.col, group);
      if (!isBlank(cell.value)) dataRows.add(cell.row);
    }
    rows += dataRows.size;
    for (let col = 1; col <= sheet.maxCol; col++) {
      const values = groups.get(col) ?? [];
      const header = headers.get(col) ?? '';
      let datePlaceholders = 0;
      let texts = 0, numbers = 0, dates = 0, bools = 0, blanks = 0, count = 0, uncertain = 0;
      let positiveCount = 0, nonNegativeCount = 0, integerCount = 0, numericCount = 0;
      const examples: string[] = [];
      const person = isPerson(header), store = header === '店铺';
      const identifier = isIdentifier(header) || person || store;
      for (const cell of values) {
        const value = cell.value;
        if (isBlank(value)) { if (typeof value === 'string') blanks++; continue; }
        count++;
        if (examples.length < 3 && !examples.includes(String(value))) examples.push(String(value).slice(0, 70));
        if (cell.date) { dates++; continue; }
        let num: number | null = null;
        if (typeof value === 'number') {
          numbers++;
          num = value;
        } else if (typeof value === 'boolean') {
          bools++;
        } else if (typeof value === 'string' && !identifier && parseDate(value, book.date1904, isDateHeader(header))) {
          dates++;
        } else if (typeof value === 'string' && !identifier && /^0001-01-01$/.test(value.trim())) {
          datePlaceholders++;
        } else if (typeof value === 'string' && !identifier && !isDateHeader(header) && numericText(value) !== null) {
          numbers++;
          num = numericText(value);
        } else {
          texts++;
          if (isDateHeader(header) && typeof value === 'string') uncertain++;
        }
        if (num !== null) {
          numericCount++;
          if (num > 0) positiveCount++;
          if (num >= 0) nonNegativeCount++;
          if (Number.isInteger(num)) integerCount++;
        }
      }
      const allPositive = numericCount > 0 && positiveCount === numericCount;
      const allNonNegative = numericCount > 0 && nonNegativeCount === numericCount;
      const allIntegers = numericCount > 0 && integerCount === numericCount;
      const noExtraDecimals = numericCount > 0 && (allPositive || (allNonNegative && allIntegers) || allIntegers);
      let type: string, mode: Mode, reason: string;
      if (isDateHeader(header) || (dates > 0 && dates + datePlaceholders === count)) { type = '日期'; mode = 'date'; uncertain += datePlaceholders; reason = '日期列不脱敏；只转换明确有效的文本日期，超范围占位日期原样保留并提示'; }
      else if (person || store) { type = person ? '人名' : '店铺'; mode = 'mask'; reason = person ? '销售员* / IPD / GTM 共用「人1、人2…」' : '完整原值去重，保留列号与末尾 3 个字符'; }
      else if (!count) { type = '空列'; mode = 'keep'; reason = '空白不参与脱敏'; }
      else if (numbers === count) { type = '数值'; mode = 'keep'; reason = noExtraDecimals ? '全列均为正数/整数，不额外添加 2 位小数' : '数值不脱敏，底层数值四舍五入到 2 位'; }
      else if (bools === count) { type = '布尔'; mode = 'keep'; reason = '保留布尔值'; }
      else { type = texts === count ? (identifier ? '标识文本' : '文本') : '混合'; mode = 'mask'; reason = identifier ? '按文本标识处理，脱敏为友好短编码' : '替换非空文本，数值与真实日期保持各自规则'; }
      if (!header && count) warnings.push(`${sheet.name}!${columnName(col)} 无表头，默认对非空文本脱敏。`);
      if (uncertain) warnings.push(`${sheet.name}!${columnName(col)} 有 ${uncertain} 个不明确或无效的文本日期，将保留原样。`);
      fakeBlanks += blanks;
      rules.push({ key: `${si}:${col}`, sheet: sheet.name, col, letter: columnName(col), header, type, mode, reason, nonEmpty: count, fakeBlanks: blanks, uncertainDates: uncertain, examples, person, store, noExtraDecimals });
    }
  }
  check(rows > 0, '工作簿只有表头或空白，没有可处理的数据行。');
  return { rules, rows, cells: totalCells, sheets: targetSheets.length, fakeBlanks, warnings };
}
export function timestamp(date = new Date()): string {
  const pad = (value: number, length = 2): string => String(value).padStart(length, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`;
}
export function outputName(original: string, action: string, extension: string, stamp = timestamp()): string {
  const stem = original.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || '工作簿';
  return `${stem}_${action}_${stamp}.${extension}`;
}

export async function maskWorkbook(bytes: Uint8Array, sourceName: string, overrides: Record<string, Mode> = {}, now = new Date(), options?: MaskOptions): Promise<MaskResult> {
  const book = readBook(bytes, options?.sheets ?? true);
  if (options) isolateSheets(book, book.sheets.map((s) => s.name)); else isolateFirstSheet(book);
  check(!getBatch(book), '工作簿已有脱敏批次标记，请使用原始文件，避免重复脱敏。');
  const analysis = analyze(book, Boolean(options));
  for (const rule of analysis.rules) {
    const kind = options?.kinds?.[rule.key];
    if (kind && kind !== 'text') {
      check(!(rule.person && kind !== 'person') && !(rule.store && kind !== 'store') && rule.mode !== 'date' && rule.type !== '布尔', '专用字段规则冲突。');
      rule.person = kind === 'person'; rule.store = kind === 'store'; rule.mode = 'mask'; rule.type = rule.person ? '人名' : '店铺';
    }
  }
  const ruleMap = new Map(analysis.rules.map((rule) => [rule.key, rule]));
  for (const [key, mode] of Object.entries(overrides)) {
    const rule = ruleMap.get(key);
    check(rule && ['mask', 'keep', 'date'].includes(mode), '列策略无效，请重新分析文件。');
    check(!(rule.mode === 'date' && mode !== 'date'), '日期列不允许脱敏。');
    check(!((rule.person || rule.store) && mode !== 'mask'), '人名和店铺列必须遵循专用脱敏规则。');
    rule.mode = mode;
  }
  const batch = options?.batch ?? Array.from(crypto.getRandomValues(new Uint8Array(8))).map((n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
  const mappings: Mapping[] = options?.mappings ?? [];

  const originalStrings = options?.reserved ?? new Set<string>();
  for (const sheet of book.sheets) for (const cell of sheet.cells) {
    if (typeof cell.value === 'string') {
      originalStrings.add(cell.value);
      originalStrings.add(cell.value.trim());
    }
  }

  const uniqueTokens = new Set<string>(mappings.map((m) => m.masked));
  const personMap = new Map<string, string>();
  let personSeq = 1;
  const colSeq = new Map<number, number>();
  const domains = new Map<string, Map<string, string>>();
  for (const m of mappings) { const values = domains.get(m.domain) ?? new Map<string, string>(); values.set(m.original, m.masked); domains.set(m.domain, values); if (m.domain === '人员共用') personMap.set(m.original, m.masked); }

  const stats: Stats = { masked: 0, unique: 0, rounded: 0, dates: 0, blanks: 0, uncertainDates: 0, metadataParts: 0 };
  const styles = new StyleBuilder(book.styles);
  const sheetNames = book.sheets.map((sheet, i) => ({ original: sheet.name, masked: `工作表${i + 1}` }));
  for (const [si, sheet] of book.sheets.entries()) {
    sheet.node.setAttribute('name', sheetNames[si]!.masked);
    for (const cell of sheet.cells) {
      const original = cell.value;
      if (cell.row === 1) {
        if (typeof original === 'string') {
          if (isBlank(original)) { writeCell(cell, null); stats.blanks++; }
          else writeCell(cell, original);
        }
        continue;
      }
      const rule = ruleMap.get(`${si}:${cell.col}`);
      if (isBlank(original)) { if (typeof original === 'string') { writeCell(cell, null); stats.blanks++; } continue; }
      check(rule, '数据列缺少识别策略。');
      if (['e', 'd'].includes(cell.node.getAttribute('t') ?? '')) continue;
      if (cell.date && typeof original === 'number') continue;
      if (typeof original === 'boolean') continue;
      if (rule.mode === 'date') {
        if (typeof original === 'string') {
          const parsed = parseDate(original, book.date1904, true);
          if (parsed) { writeCell(cell, parsed.serial, styles.format(cell.style, parsed.format)); stats.dates++; }
          else { writeCell(cell, original); stats.uncertainDates++; }
        }
        continue;
      }
      if (typeof original === 'number') {
        const rounded = roundTwo(original);
        if (rounded !== original) {
          const fmt = styles.numericFormat(cell.style);
          if (rule?.noExtraDecimals && fmt === '0.00') {
            writeCell(cell, rounded);
          } else {
            writeCell(cell, rounded, styles.format(cell.style, fmt));
          }
          stats.rounded++;
        }
        continue;
      }
      check(typeof original === 'string', '未识别的单元格类型。');
      if (cell.date) { const parsed = parseDate(original, book.date1904); if (parsed) { writeCell(cell, parsed.serial, styles.format(cell.style, parsed.format)); stats.dates++; } else writeCell(cell, original); continue; }
      if (rule.type === '数值' && rule.mode === 'keep') {
        const number = numericText(original);
        if (number !== null) {
          const rounded = roundTwo(number);
          const fmt = styles.numericFormat(cell.style);
          if (rule?.noExtraDecimals && fmt === '0.00') {
            writeCell(cell, rounded);
          } else {
            writeCell(cell, rounded, styles.format(cell.style, fmt));
          }
          if (number !== rounded) stats.rounded++;
          continue;
        }
      }
      if (rule.mode === 'keep') { writeCell(cell, original); continue; }

      const domain = rule.person ? '人员共用' : options?.domains[rule.key] ?? `${rule.letter}:${rule.header}`;
      let values = domains.get(domain);
      if (!values) { values = new Map(); domains.set(domain, values); }
      let token = values.get(original);
      if (!token) {
        if (rule.person) {
          token = personMap.get(original);
          if (!token) {
            while (true) {
              const candidate = `人${personSeq++}`;
              if (!originalStrings.has(candidate) && !uniqueTokens.has(candidate)) {
                token = candidate;
                break;
              }
            }
            personMap.set(original, token);
          }
        } else if (rule.store) {
          let seq = colSeq.get(rule.col) ?? 1;
          const suffix = [...original].slice(-3).join('');
          const prefix = options ? 'S' : rule.letter;
          let candidate = `${prefix}${seq}${suffix}`;
          while (originalStrings.has(candidate) || uniqueTokens.has(candidate)) {
            seq++;
            candidate = `${prefix}${seq}${suffix}`;
          }
          colSeq.set(rule.col, seq + 1);
          token = candidate;
        } else {
          let seq = colSeq.get(rule.col) ?? 1;
          const prefix = options ? 'X' : rule.letter;
          let candidate = `${prefix}${seq}`;
          while (originalStrings.has(candidate) || uniqueTokens.has(candidate)) {
            seq++;
            candidate = `${prefix}${seq}`;
          }
          colSeq.set(rule.col, seq + 1);
          token = candidate;
        }
        values.set(original, token);
        uniqueTokens.add(token);
        if (options) check(mappings.length < 100_000, '统一字典超过 100,000 条映射。');
        mappings.push({ domain, original, masked: token });
      }
      writeCell(cell, token);
      stats.masked++;
    }
  }
  stats.unique = mappings.length;
  stats.metadataParts = sanitize(book);
  setBatch(book, batch);
  const workbook = saveBook(book);
  const dictionary: Dictionary = { version: 1, batch, sourceName, created: now.toISOString(), mappings, sheets: sheetNames };
  const dictBytes = options ? new Uint8Array() : await writeDictionary(dictionary);
  const stamp = timestamp(now);
  const workbookName = outputName(sourceName, '已脱密', 'xlsx', stamp);
  const dictionaryName = outputName(sourceName, '脱密字典', 'xlsx', stamp);
  const zip = options ? new Uint8Array() : pack({ [workbookName]: workbook, [dictionaryName]: dictBytes });
  return { zip, filename: outputName(sourceName, '已脱密', 'zip', stamp), workbook, dictionary: dictBytes, workbookName, dictionaryName, stats, sheetMappings: sheetNames };
}

const mappingHeaders = ['映射域', '原始值', '脱敏值'];
const sheetHeaders = ['原工作表名', '脱敏工作表名'];
const canonical = (dict: Dictionary): string => JSON.stringify(dict);
export async function writeDictionary(dict: Dictionary): Promise<Uint8Array> {
  const tables: { name: string; rows: Value[][] }[] = [
    { name: '字典信息', rows: [
      ['字段', '值'], ['格式', 'AIOZ-REVERSIBLE-DICTIONARY'], ['版本', dict.version], ['批次', dict.batch],
      ['源文件名', dict.sourceName], ['创建时间', dict.created], ['完整性SHA256', await sha256(canonical(dict))],
      ['恢复范围', '仅恢复名称和工作表名；保留已清洗日期、两位小数与真空白'],
      ['保管提示', '字典包含原始明文，请与脱敏工作簿分开保管；不要对外共享整个 ZIP'],
    ] },
    { name: '映射字典', rows: [mappingHeaders, ...dict.mappings.map((item) => [item.domain, item.original, item.masked])] },
    { name: '工作表对应', rows: [sheetHeaders, ...dict.sheets.map((item) => [item.original, item.masked])] },
  ];
  if (dict.version === 2) {
    const text = JSON.stringify(dict.extension);
    const chunks: Value[][] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 16000, text.length);
      const last = text.charCodeAt(end - 1);
      if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
      chunks.push([chunks.length, text.slice(start, end)]); start = end;
    }
    tables.push({ name: '批次扩展', rows: [['序号', 'JSON分段'], ...chunks] });
  }
  return tableWorkbook(tables);
}
function table(book: Book, name: string, headers: string[]): Value[][] {
  const sheet = book.sheets.find((sheet) => sheet.name === name);
  check(sheet && sheet.maxCol === headers.length && sheet.maxRow > 0, `字典工作表「${name}」缺失或结构不正确。`);
  check(sheet.maxRow <= sheet.cells.length + 1, '字典存在异常稀疏行，请使用原始导出的字典。');
  const rows = Array.from({ length: sheet.maxRow }, () => Array<Value>(headers.length).fill(null));
  for (const cell of sheet.cells) rows[cell.row - 1]![cell.col - 1] = cell.value;
  check(headers.every((name, i) => rows[0]![i] === name), `字典工作表「${name}」表头不正确。`);
  return rows.slice(1);
}
export async function readDictionary(bytes: Uint8Array): Promise<Dictionary> {
  const book = readBook(bytes);
  check(book.sheets.length === 3 || book.sheets.length === 4, '字典工作表数量不正确。');
  const metadata = table(book, '字典信息', ['字段', '值']);
  check(new Set(metadata.map((row) => row[0])).size === metadata.length, '字典元数据重复。');
  const meta = new Map(metadata.map((row) => [String(row[0]), row[1]]));
  check(meta.get('格式') === 'AIOZ-REVERSIBLE-DICTIONARY' && [1, 2].includes(Number(meta.get('版本'))), '文件不是受支持的 AIOZ 脱敏字典（版本 1 / 2）。');
  const batch = meta.get('批次'), sourceName = meta.get('源文件名'), created = meta.get('创建时间');
  check(typeof batch === 'string' && /^[0-9A-F]{16}$/.test(batch) && typeof sourceName === 'string' && typeof created === 'string', '字典元数据无效。');
  const seenTokens = new Set<string>(), seenOriginals = new Set<string>();
  const mappings: Mapping[] = table(book, '映射字典', mappingHeaders).map((row) => {
    const [domain, original, masked] = row;
    check(typeof domain === 'string' && typeof original === 'string' && typeof masked === 'string' && !isBlank(original) && !isBlank(masked), '字典包含空白或非文本映射。');
    check(!seenTokens.has(masked) && !seenOriginals.has(JSON.stringify([domain, original])), '字典存在重复或冲突映射。');
    seenTokens.add(masked); seenOriginals.add(JSON.stringify([domain, original]));
    return { domain, original, masked };
  });
  const sheets = table(book, '工作表对应', sheetHeaders).map((row) => {
    const [original, masked] = row;
    check(typeof original === 'string' && original.length > 0 && original.length <= 31 && !/[\\/*?:\[\]]/.test(original) && typeof masked === 'string', '工作表名称映射无效。');
    return { original, masked };
  });
  check(sheets.length > 0 && new Set(sheets.map((s) => s.original)).size === sheets.length && new Set(sheets.map((s) => s.masked)).size === sheets.length, '工作表映射为空或存在重复。');
  const version = meta.get('版本') as 1 | 2;
  check(book.sheets.length === (version === 1 ? 3 : 4), '字典版本与结构不匹配。');
  let extension: BatchExtension | undefined;
  if (version === 2) {
    const rows = table(book, '批次扩展', ['序号', 'JSON分段']);
    check(rows.every((r, i) => r[0] === i && typeof r[1] === 'string'), '批次扩展分段无效。');
    extension = JSON.parse(rows.map((r) => r[1]).join('')) as BatchExtension;
    check(extension && Number.isSafeInteger(extension.revision) && extension.revision > 0 && Array.isArray(extension.files) && Array.isArray(extension.legacy) && extension.aliases && extension.policies, '批次扩展无效。');
    const validSheets = (value: unknown, allowEmpty = false): boolean => Array.isArray(value) && (allowEmpty || value.length > 0) && value.every((s: unknown) => {
      if (!s || typeof s !== 'object') return false;
      const row = s as { original?: unknown; masked?: unknown };
      return typeof row.original === 'string' && row.original.length > 0 && row.original.length <= 31 && !/[\\/*?:\[\]]/.test(row.original) && typeof row.masked === 'string' && /^工作表[1-9]\d*$/.test(row.masked);
    }) && new Set(value.map((s: { original: string }) => s.original.toLowerCase())).size === value.length && new Set(value.map((s: { masked: string }) => s.masked)).size === value.length;
    const validRecord = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every((v) => typeof v === 'string' && v.length <= 1000);
    check(validRecord(extension.aliases) && validRecord(extension.policies) && validSheets(extension.legacy, true), '字典语义字段或历史表名映射无效。');
    for (const policy of Object.values(extension.policies)) { const value: unknown = JSON.parse(policy); check(Array.isArray(value) && value.length === 3 && ['mask', 'keep', 'date'].includes(value[0]) && typeof value[1] === 'boolean' && typeof value[2] === 'boolean', '字典字段策略无效。'); }
    check(extension.files.length <= 1000 && extension.files.every((f) => f && typeof f.id === 'string' && typeof f.name === 'string' && /^[0-9A-F]{16}$/.test(f.marker) && f.marker !== batch && validSheets(f.sheets)), '文件工作表映射无效。');
    check(new Set(extension.files.map((f) => f.marker)).size === extension.files.length && new Set(extension.files.map((f) => f.id)).size === extension.files.length, '文件标记或 ID 重复。');
    check(mappings.length <= 100_000, '批次字典超过 100,000 条映射。');
  }
  const dict: Dictionary = { version, batch, sourceName, created, mappings, sheets, ...(extension ? { extension } : {}) };
  check(await sha256(canonical(dict)) === meta.get('完整性SHA256'), '字典完整性校验失败，内容可能被修改或损坏。请使用当次导出的原始字典。');
  return dict;
}

function buildTokenRegex(token: string): string {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (token.startsWith('人')) {
    return `(?<![a-zA-Z0-9_\\u4e00-\\u9fa5])${escaped}(?![a-zA-Z0-9_\\u4e00-\\u9fa5])`;
  }
  return `(?<![a-zA-Z0-9_])${escaped}(?![a-zA-Z0-9_])`;
}

export function createReplacer(dict: Dictionary): {
  replace: (text: string) => string;
  matched: () => number;
  hasTokens: (text: string) => boolean;
} {
  const sortedMappings = [...dict.mappings].sort((a, b) => b.masked.length - a.masked.length);
  const mapping = new Map(sortedMappings.map((item) => [item.masked, item]));
  let matches = 0;
  if (sortedMappings.length === 0) {
    return {
      matched: () => 0,
      hasTokens: () => false,
      replace: (text: string) => text,
    };
  }
  const pattern = sortedMappings.map((item) => buildTokenRegex(item.masked)).join('|');
  const regex = new RegExp(pattern, 'gu');

  // Batch/continued dictionaries may legitimately reuse a numeric prefix with different suffixes.
  const storesByPrefix = new Map<string, string[]>();
  for (const item of dict.mappings.filter((m) => m.domain.endsWith(':店铺') || m.domain === '店铺')) {
    const suffix = [...item.original].slice(-3).join('');
    const prefix = item.masked.slice(0, item.masked.length - suffix.length);
    const tokens = storesByPrefix.get(prefix) ?? []; tokens.push(item.masked); storesByPrefix.set(prefix, tokens);
  }
  const storeRules = [...storesByPrefix].map(([prefix, tokens]) => ({
    prefixRegex: new RegExp(buildTokenRegex(prefix).replace('(?![a-zA-Z0-9_])', '(?![a-zA-Z0-9])'), 'gu'),
    tokens,
  }));

  return {
    matched: () => matches,
    hasTokens: (text: string) => new RegExp(pattern, 'u').test(text),
    replace: (text: string): string => {
      for (const { prefixRegex, tokens } of storeRules) {
        for (const match of text.matchAll(prefixRegex)) {
          const valid = tokens.some((token) => text.startsWith(token, match.index) && !/[a-zA-Z0-9_]/.test(text.charAt(match.index + token.length)));
          check(valid, '脱敏编码或店铺末尾字符已被修改，无法可靠恢复。');
        }
      }
      return text.replace(regex, (match) => {
        const item = mapping.get(match);
        if (item) {
          matches++;
          return item.original;
        }
        return match;
      });
    },
  };
}

export async function restoreWorkbook(bytes: Uint8Array, dictionaryBytes: Uint8Array, sourceName: string, now = new Date()): Promise<{ bytes: Uint8Array; filename: string; restored: number }> {
  const dict = await readDictionary(dictionaryBytes);
  const book = readBook(bytes);
  const batch = getBatch(book);
  const file = dict.extension?.files.find((f) => f.marker === batch);
  check(batch === null || batch === dict.batch || file, '工作簿与字典的批次不匹配。');
  if (dict.version === 2 && batch === null) check(false, '批次字典恢复需要文件批次标记，请使用工具导出的工作簿。');
  const mapping = new Map(dict.mappings.map((item) => [item.masked, item.original]));
  const storeRules = dict.mappings
    .filter((m) => m.domain.endsWith(':店铺') || m.domain === '店铺')
    .map((m) => {
      const suffix = [...m.original].slice(-3).join('');
      const prefix = m.masked.slice(0, m.masked.length - suffix.length);
      return { prefix, masked: m.masked, original: m.original };
    });
  const replacer = createReplacer(dict);
  let restored = 0;
  for (const sheet of book.sheets) {
    for (const cell of sheet.cells) {
      if (typeof cell.value !== 'string' || ['e', 'd'].includes(cell.node.getAttribute('t') ?? '')) continue;
      if (cell.row === 1) continue;
      const original = mapping.get(cell.value);
      if (original !== undefined) {
        writeCell(cell, original);
        restored++;
      } else {
        for (const sr of storeRules) {
          if (cell.value.startsWith(sr.prefix) && cell.value !== sr.masked) {
            check(false, '脱敏编码或店铺末尾字符已被修改，无法可靠恢复。');
          }
        }
        if (cell.value && replacer.hasTokens(cell.value)) {
          check(false, '工作簿脱敏值必须完整匹配，检测到拼接或改动的单元格。');
        }
        if (/^(?:人\d+|[A-Z]{1,3}\d+.*)$/.test(cell.value)) {
          check(false, '发现未知脱敏编码；字典不匹配或内容混用了其他批次。');
        }
      }
    }
  }
  check(restored > 0 || Boolean(file) || (dict.mappings.length === 0 && batch === dict.batch), '工作簿中未找到此字典对应的脱敏值，请检查文件是否匹配。');
  const names = new Map((file?.sheets ?? (dict.extension ? dict.extension.legacy : dict.sheets)).map((sheet) => [sheet.masked, sheet.original]));
  const finalNames = book.sheets.map((sheet) => names.get(sheet.name) ?? sheet.name);
  check(new Set(finalNames.map((name) => name.toLowerCase())).size === finalNames.length, '恢复后的工作表名称冲突，请先调整新增工作表名称。');
  book.sheets.forEach((sheet, index) => sheet.node.setAttribute('name', finalNames[index]!));
  for (const sheet of book.sheets) for (const cell of sheet.cells) if (typeof cell.value === 'string' && cell.node.getAttribute('t') === 's') writeCell(cell, cell.value);
  sanitize(book);
  return { bytes: saveBook(book), filename: outputName(sourceName, '已解密', 'xlsx', timestamp(now)), restored };
}
