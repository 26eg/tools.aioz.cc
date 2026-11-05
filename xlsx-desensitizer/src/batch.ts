import { associationDocuments, type AssociationMember } from './association-export';
import { analyze, maskWorkbook, readDictionary, writeDictionary, restoreWorkbook, normalizeHeader, isBlank, outputName, type Analysis, type Dictionary, type Mode, type Stats } from './core';
import type { FieldKind } from './relations';
import { check, openZip, parseXml, decode, elements, readBook, pack, encode, MAX_FILE_BYTES } from './ooxml';

// Conservative application budgets, not a guarantee of available browser memory.
export const MAX_BATCH_FILES = 30;
export const MAX_BATCH_BYTES = 150 * 1024 * 1024;
export const MAX_BATCH_MAPPINGS = 100_000;
export const MAX_OUTPUT_BYTES = 150 * 1024 * 1024;
export interface SheetChoice { index: number; name: string; hidden: boolean; }
export interface FileScan { id: string; name: string; sheets: SheetChoice[]; selected: number[]; analysis?: Analysis; error?: string; }
export interface FilePlan { id: string; sheets: number[]; domains: Record<string, string>; overrides: Record<string, Mode>; kinds?: Record<string, FieldKind>; }
export interface BatchPlan { files: FilePlan[]; legacyDomains: Record<string, string>; }
export interface BatchScan { files: FileScan[]; dictionary?: Dictionary; }
const id = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => n.toString(16).padStart(2, '0')).join('').toUpperCase();
export function validateFiles(files: File[]): void {
  check(files.length > 0 && files.length <= MAX_BATCH_FILES, `每批请选择 1–${MAX_BATCH_FILES} 个文件。`);
  check(files.every((f) => f.size > 0 && f.size <= MAX_FILE_BYTES && /\.xlsx$/i.test(f.name)), '请选择非空 XLSX，单文件不超过 50 MiB。');
  check(files.reduce((n, f) => n + f.size, 0) <= MAX_BATCH_BYTES, '批次输入合计超过 150 MiB，请分批并用字典续批。');
}
export function defaultDomain(header: string, unique: string): string {
  if (/^销售员.*$/u.test(header) || /^(IPD|GTM)$/i.test(header)) return '人员共用';
  if (header === '店铺') return '店铺';
  return header ? `字段:${header}` : `独立:${unique}`;
}
export function analyzeSelected(bytes: Uint8Array, selected: number[]): Analysis {
  const book = readBook(bytes, selected);
  return analyze(book, true);
}
export async function scanFiles(files: File[], dictionary?: Uint8Array, progress: (text: string) => void = () => {}): Promise<BatchScan> {
  validateFiles(files);
  const dict = dictionary ? await readDictionary(dictionary) : undefined;
  const scans: FileScan[] = [];
  for (const [i, file] of files.entries()) {
    progress(`预检查 ${i + 1}/${files.length}：${file.name}`);
    const scan: FileScan = { id: String(i + 1), name: file.name, sheets: [], selected: [0] };
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const parts = openZip(bytes);
      check(parts['xl/workbook.xml'], '缺少工作簿信息。');
      scan.sheets = elements(parseXml(decode(parts['xl/workbook.xml']!)), 'sheet').map((s, index) => ({ index, name: s.getAttribute('name') ?? '', hidden: ['hidden', 'veryHidden'].includes(s.getAttribute('state') ?? '') }));
      check(scan.sheets.length > 0, '没有工作表。');
      scan.analysis = analyzeSelected(bytes, [0]);
    } catch (error) { scan.error = error instanceof Error ? error.message : '预检查失败'; }
    scans.push(scan);
  }
  return { files: scans, ...(dict ? { dictionary: dict } : {}) };
}
function upgrade(imported: Dictionary | undefined, legacyDomains: Record<string, string>): Dictionary {
  const dict: Dictionary = imported ? structuredClone(imported) : { version: 2, batch: id(), sourceName: '多文件批次', created: new Date().toISOString(), mappings: [], sheets: [{ original: '工作表1', masked: '工作表1' }] };
  if (dict.version === 1) {
    const domains = new Set(dict.mappings.map((m) => m.domain));
    for (const domain of domains) check(typeof legacyDomains[domain] === 'string' && legacyDomains[domain]!.trim(), `请确认旧字典映射域「${domain}」对应的语义字段。`);
    const seen = new Map<string, string>();
    for (const m of dict.mappings) {
      const target = legacyDomains[m.domain]!.trim();
      check(m.domain !== '人员共用' || target === '人员共用', '旧人员映射必须保留人员共用语义。');
      check(!m.domain.endsWith(':店铺') || target === '店铺', '旧店铺映射必须保留店铺语义。');
      m.domain = target;
      const key = JSON.stringify([target, m.original]);
      check(!seen.has(key), '旧字典多个映射域合并后存在不同编码，请保留独立域或重新建立一致批次。');
      seen.set(key, m.masked);
    }
  }
  dict.extension ??= { revision: 0, files: [], aliases: {}, policies: {}, legacy: imported?.sheets ?? [] };
  dict.version = 2; dict.extension.revision++;
  return dict;
}
export async function maskBatch(files: File[], plan: BatchPlan, imported?: Dictionary, progress: (text: string) => void = () => {}): Promise<{ bytes: Uint8Array; filename: string; stats: Stats }> {
  validateFiles(files);
  check(plan.files.length === files.length, '文件计划数量不匹配。');
  const dict = upgrade(imported, plan.legacyDomains), extension = dict.extension!;
  const reserved = new Set<string>();
  let reservedCharacters = 0;
  const knownTokens = new Set(dict.mappings.map((m) => m.masked));
  // Pass 1 validates every selected sheet and reserves originals before assigning any new token.
  for (const [i, file] of files.entries()) {
    progress(`校验与冲突检查 ${i + 1}/${files.length}：${file.name}`);
    const fp = plan.files[i]!; check(fp.id === String(i + 1), '文件 ID 与计划不匹配。');
    const book = readBook(new Uint8Array(await file.arrayBuffer()), fp.sheets);
    const analysis = analyze(book, true);
    for (const rule of analysis.rules) {
      const kind = fp.kinds?.[rule.key];
      check(kind === undefined || ['text', 'person', 'store'].includes(kind), '字段规则类型无效。');
      check(!rule.person || !kind || kind === 'person', '已识别的人员字段不能更改专用规则。');
      check(!rule.store || !kind || kind === 'store', '已识别的店铺字段不能更改专用规则。');
      if (kind && kind !== 'text') {
        check(rule.type !== '日期' && rule.type !== '布尔', '日期或布尔字段不能使用人员、店铺规则。');
        rule.person = kind === 'person'; rule.store = kind === 'store'; rule.mode = 'mask';
      }
      const domain = fp.domains[rule.key]?.trim();
      check(domain && domain.length <= 200, `请指定 ${file.name}/${rule.sheet}/${rule.letter} 的语义字段。`);
      fp.domains[rule.key] = domain;
      check(!rule.person || domain === '人员共用', '人员列必须使用人员共用语义。');
      check(!rule.store || domain === '店铺', '店铺列必须使用店铺语义。');
      check(rule.person || domain !== '人员共用', '普通列不能加入人员共用语义。');
      check(rule.store || domain !== '店铺', '普通列不能加入店铺语义。');
      const mode = fp.overrides[rule.key] ?? rule.mode;
      const policy = JSON.stringify([mode, rule.person, rule.store]);
      const existing = extension.policies[domain];
      check(!rule.nonEmpty || !existing || existing === policy, `语义字段「${domain}」处理策略冲突，请统一策略或使用独立语义字段。`);
      if (rule.nonEmpty) extension.policies[domain] = policy;
      const header = normalizeHeader(rule.header);
      // Only unambiguous aliases are reused automatically; per-column assignments remain explicit in the UI.
      if (header) { const aliasKey = `header:${header}`; if (!(aliasKey in extension.aliases)) extension.aliases[aliasKey] = domain; else if (extension.aliases[aliasKey] !== domain) extension.aliases[aliasKey] = ''; }
    }
    for (const sheet of book.sheets) for (const cell of sheet.cells) if (typeof cell.value === 'string' && !isBlank(cell.value)) {
      check(!knownTokens.has(cell.value) && !knownTokens.has(cell.value.trim()), '原始文件出现旧字典已有编码，无法安全续批；请确认选择的是原始数据。');
      if (!reserved.has(cell.value)) reservedCharacters += cell.value.length;
      reserved.add(cell.value);
      if (!reserved.has(cell.value.trim())) reservedCharacters += cell.value.trim().length;
      reserved.add(cell.value.trim());
      check(reservedCharacters <= 16_000_000, '批次唯一文本总长度超过保护阈值，请分批处理。');
      check(reserved.size <= 500_000, '批次唯一文本过多，请分批并续用字典。');
    }
  }
  const entries: Record<string, Uint8Array> = {};
  const summaries: unknown[] = [];
  const associations: { domain: string; member: AssociationMember }[] = [];
  const stats: Stats = { masked: 0, unique: 0, rounded: 0, dates: 0, blanks: 0, uncertainDates: 0, metadataParts: 0 };
  let outputBytes = 0;
  for (const [i, file] of files.entries()) {
    progress(`脱敏 ${i + 1}/${files.length}：${file.name}`);
    const fp = plan.files[i]!, marker = id();
    check(marker !== dict.batch && !extension.files.some((f) => f.marker === marker), '批次标记碰撞，请重试。');
    const result = await maskWorkbook(new Uint8Array(await file.arrayBuffer()), file.name, fp.overrides, new Date(), { sheets: fp.sheets, batch: marker, mappings: dict.mappings, reserved, domains: fp.domains, kinds: fp.kinds });
    check(dict.mappings.length <= MAX_BATCH_MAPPINGS, '统一字典超过 100,000 条映射，请减少本批唯一值。');
    const current = { sheets: result.sheetMappings! };
    const fileId = `${extension.revision}-${fp.id}`;
    extension.files.push({ id: fileId, name: file.name, marker, sheets: current.sheets });
    check(extension.files.length <= 1000, '字典累计文件数超过 1000，请新建字典系列。');
    const name = `脱敏工作簿/${fileId}_${result.workbookName}`;
    const exportBook = readBook(new Uint8Array(await file.arrayBuffer()), fp.sheets);
    const exportedAnalysis = analyze(exportBook, true);
    for (const rule of exportedAnalysis.rules) {
      const si = Number(rule.key.split(':')[0]);
      associations.push({ domain: fp.domains[rule.key]!, member: { fileId, outputFile: name, outputSheet: current.sheets[si]!.masked, header: (()=>{const value=exportBook.sheets[si]!.cells.find(c=>c.row===1&&c.col===rule.col)?.value??null;return isBlank(value)?'':String(value);})(), column: rule.letter, mode: fp.overrides[rule.key] ?? (fp.kinds?.[rule.key] && fp.kinds[rule.key] !== 'text' ? 'mask' : rule.mode), kind: fp.kinds?.[rule.key] ?? (rule.person ? 'person' : rule.store ? 'store' : 'text') } });
    }
    entries[name] = result.workbook; outputBytes += result.workbook.length;
    check(outputBytes <= MAX_OUTPUT_BYTES, '输出合计超过 150 MiB，请分批处理。');
    for (const key of Object.keys(stats) as (keyof Stats)[]) if (key !== 'unique') stats[key] += result.stats[key];
    summaries.push({ id: fileId, input: file.name, output: name, selected: current.sheets.map((s) => s.original) });
    const summary = summaries[summaries.length - 1] as Record<string, unknown>;
    const parts = openZip(new Uint8Array(await file.arrayBuffer()));
    summary.excluded = elements(parseXml(decode(parts['xl/workbook.xml']!)), 'sheet').filter((_, index) => !fp.sheets.includes(index)).map((s) => s.getAttribute('name'));
  }
  stats.unique = dict.mappings.length;
  progress('生成统一字典与批次结果…');
  const association = await associationDocuments(associations, { seriesId: dict.batch, revision: extension.revision });
  entries['字段关联说明.md'] = encode(association.markdown);
  entries['字段关联清单.json'] = encode(association.json);
  entries['批次脱敏字典.xlsx'] = await writeDictionary(dict);
  entries['批次处理清单.json'] = encode(JSON.stringify({ version: 2, series: dict.batch, revision: extension.revision, files: summaries }, null, 2));
  check(Object.values(entries).reduce((n, b) => n + b.length, 0) <= MAX_OUTPUT_BYTES, '批次结果超过 150 MiB，请分批。');
  return { bytes: pack(entries), filename: outputName('批次', '已脱密', 'zip'), stats };
}
export async function restoreBatch(files: File[], dictionary: Uint8Array, progress: (text: string) => void = () => {}): Promise<{ bytes: Uint8Array; filename: string; restored: number }> {
  validateFiles(files);
  const entries: Record<string, Uint8Array> = {};
  let restored = 0, size = 0;
  for (const [i, file] of files.entries()) {
    progress(`恢复 ${i + 1}/${files.length}：${file.name}`);
    const result = await restoreWorkbook(new Uint8Array(await file.arrayBuffer()), dictionary, file.name);
    restored += result.restored; size += result.bytes.length;
    check(size <= MAX_OUTPUT_BYTES, '恢复输出超过 150 MiB，请分批。');
    if (files.length === 1) return { ...result };
    entries[`${i + 1}_${result.filename}`] = result.bytes;
  }
  return { bytes: pack(entries), filename: outputName('批次', '已解密', 'zip'), restored };
}
