import { MappingMatrix } from './matrix';
import { GroupPicker } from './group-picker';
import type { Mode, Stats, Dictionary } from './core';
import { defaultDomain, MAX_BATCH_FILES, MAX_BATCH_BYTES, type BatchScan, type BatchPlan, type FileScan, type FilePlan } from './batch';
import { FieldPicker } from './field-picker';
import { FieldBoard } from './board';
import { baseKind, linkFields, detachField, assignFields, type RelationField, type RelationChange } from './relations';
import type { Request } from './worker';
type ToolMode = 'mask' | 'restore' | 'report';
const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id); if (!value) throw new Error(`Missing element: ${id}`); return value as T;
};
const sourceInput = element<HTMLInputElement>('sourceFile'), dictionaryInput = element<HTMLInputElement>('dictionaryFile');
const run = element<HTMLButtonElement>('run'), status = element('status'), download = element<HTMLAnchorElement>('download');
const show = (id: string, visible: boolean): void => { element(id).classList.toggle('hidden', !visible); };
let matrixView = true;
let selectedDomain: string | undefined;
let mode: ToolMode = 'mask', busy = false, revision = 0;
let files: File[] = [], dictionaryFile: File | undefined, scan: BatchScan | undefined;
let worker: Worker, timeout: ReturnType<typeof setTimeout> | undefined, objectUrl: string | undefined;
const plans = new Map<string, FilePlan>();
const legacyDomains: Record<string, string> = {};
function notify(text: string, kind = ''): void { element('dockStatus').textContent=text; status.textContent = text; status.className = `status ${kind}`; }
function revokeResult(): void { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = undefined; download.removeAttribute('href'); download.removeAttribute('download'); show('result', false); const dock=element<HTMLAnchorElement>('dockDownload'); dock.removeAttribute('href');dock.removeAttribute('download');show('dockDownload',false);show('dockRun',true); }
function sync(): void {
  run.disabled = busy || !files.length || (mode !== 'mask' && !dictionaryFile) || (mode === 'mask' && Boolean(scan?.files.some((f) => f.error || !f.analysis)));
  run.textContent = mode === 'mask' ? scan ? '生成批次脱敏 ZIP' : '分析工作簿' : mode === 'restore' ? '恢复并生成文件' : '解密并生成 HTML';
  sourceInput.disabled = busy; dictionaryInput.disabled = busy;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => { b.disabled = busy; });
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('#analysis input, #analysis select, #analysis button, #sheetChoices input').forEach((e) => { if(e.closest('#matrixRoot'))return; e.disabled = busy || e.dataset.fixed === 'true'; });
  matrix.setBusy(busy); element<HTMLButtonElement>('dockRun').disabled=run.disabled; element('dockRun').textContent=run.textContent; show('dockCancel',busy);
  show('cancel', busy); document.body.classList.toggle('busy', busy);
  element('fileSummary').textContent = [...files, ...(dictionaryFile ? [dictionaryFile] : [])].map((f) => `${f.name} · ${(f.size / 1024).toFixed(1)} KiB`).join('\n');
  show('fileSummary', Boolean(files.length || dictionaryFile));
}
function finish(): void { busy = false; clearTimeout(timeout); sync(); }
function armTimeout(): void {
  clearTimeout(timeout);
  timeout = setTimeout(() => { revision++; startWorker(); scan = undefined; finish(); show('analysis', false); notify('当前阶段超过 300 秒，已停止。请减少单批数据量后重新分析。', 'error'); }, 300000);
}
function startWorker(): void {
  worker?.terminate(); const instance = new Worker(new URL('./worker.js?v=7', import.meta.url), { type: 'module' }); worker = instance;
  instance.onerror = () => { if (worker !== instance) return; revision++; scan = undefined; finish(); show('analysis', false); notify('本地处理组件运行失败，请减少数据量或刷新页面重试。', 'error'); };
  instance.onmessage = (event: MessageEvent<{ type: string; text?: string; message?: string; scan?: BatchScan; file?: FileScan; bytes?: Uint8Array; filename?: string; stats?: Stats; restored?: number }>) => {
    if (worker !== instance) return;
    const m = event.data;
    if (m.type === 'progress') { notify(m.text ?? '正在处理…'); armTimeout(); }
    if (m.type === 'analysis' && m.scan) { scan = m.scan; plans.clear(); initializeLegacy(scan.dictionary); renderAll(); finish(); notify(scan.files.some((f) => f.error) ? '部分文件预检查失败，请查看提示并调整工作表或重新选择文件。' : '全列扫描完成。请选择工作表并核对语义字段；未选工作表不进入输出。', scan.files.some((f) => f.error) ? 'error' : 'success'); }
    if (m.type === 'selection' && m.file && scan) { const i = scan.files.findIndex((f) => f.id === m.file!.id); if (i >= 0) { scan.files[i] = m.file; plans.delete(m.file.id); } renderAll(); finish(); notify(m.file.error ?? '工作表选择已更新，未选表不进入输出。请重新核对该文件字段配置。', m.file.error ? 'error' : 'success'); }
    if (m.type === 'error') { finish(); revokeResult(); notify(m.message ?? '处理失败。', 'error'); }
    if (m.type === 'result' && m.bytes && m.filename) {
      finish(); revokeResult();
      const extension = m.filename.split('.').pop(); objectUrl = URL.createObjectURL(new Blob([new Uint8Array(m.bytes)], { type: extension === 'zip' ? 'application/zip' : extension === 'html' ? 'text/html;charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
      download.href = objectUrl; download.download = m.filename; const dock=element<HTMLAnchorElement>('dockDownload');dock.href=objectUrl;dock.download=m.filename;dock.textContent=`下载 ${extension==='zip'?'ZIP':extension?.toUpperCase()} · ${(m.bytes.length/1024/1024).toFixed(2)} MiB`;show('dockDownload',true);show('dockRun',false); download.textContent = extension === 'zip' ? '下载批次 ZIP' : `下载 ${extension?.toUpperCase()}`;
      element('resultSummary').textContent = m.stats ? `脱敏 ${m.stats.masked.toLocaleString()} 个单元格 · 完整字典 ${m.stats.unique.toLocaleString()} 条映射\n转换日期 ${m.stats.dates} 个 · 舍入数值 ${m.stats.rounded} 个 · 清理假空白 ${m.stats.blanks} 个 · 保留歧义日期 ${m.stats.uncertainDates} 个` : `已恢复 ${m.restored ?? 0} 处编码。日期、两位小数与真空白保持清洗后的状态。`;
      element('resultNote').textContent = m.stats ? 'ZIP 包含原始明文字典。给 LLM 只发送脱敏工作簿、字段关联说明.md 和字段关联清单.json；完整字典单独保存用于恢复和续批，不要对外发送整个 ZIP。' : '结果已在本地生成。';
      show('result', true); notify('处理完成，文件已在本地生成。', 'success');
    }
  };
}
function initializeLegacy(dict?: Dictionary): void {
  for (const key of Object.keys(legacyDomains)) delete legacyDomains[key];
  if (dict?.version === 1) for (const domain of new Set(dict.mappings.map((m) => m.domain))) {
    const header = domain.replace(/^[A-Z]+:/, ''); legacyDomains[domain] = domain === '人员共用' ? domain : defaultDomain(header, domain);
  }
}
function getPlan(file: FileScan): FilePlan {
  let plan = plans.get(file.id);
  if (!plan) {
    plan = { id: file.id, sheets: [...file.selected], domains: {}, overrides: {}, kinds: {} };
    const counts = new Map<string, number>(); for (const rule of file.analysis?.rules ?? []) counts.set(`${rule.sheet}:${rule.header}`, (counts.get(`${rule.sheet}:${rule.header}`) ?? 0) + 1);
    for (const rule of file.analysis?.rules ?? []) {
      const unique = `${file.id}:${rule.key}`;
      const alias = scan?.dictionary?.extension?.aliases[`header:${rule.header}`];
      plan.domains[rule.key] = rule.person ? '人员共用' : rule.store ? '店铺' : counts.get(`${rule.sheet}:${rule.header}`)! > 1 ? `独立:${unique}` : alias || defaultDomain(rule.header, unique);
      plan.kinds![rule.key] = plan.domains[rule.key] === '店铺' ? 'store' : plan.domains[rule.key] === '人员共用' ? 'person' : baseKind(rule);
      if (plan.kinds![rule.key] !== 'text') plan.overrides[rule.key] = 'mask';
      const savedPolicy = scan?.dictionary?.extension?.policies[plan.domains[rule.key]!];
      if (savedPolicy && !rule.person && !rule.store && rule.mode !== 'date' && !['布尔', '空列'].includes(rule.type)) {
        const saved = JSON.parse(savedPolicy) as unknown[];
        if (saved[0] === 'mask' || saved[0] === 'keep') plan.overrides[rule.key] = saved[0];
      }
    }
    plans.set(file.id, plan);
  }
  return plan;
}
function renderAll(): void {
  if (!scan) return;
  show('analysis', true); show('sheetChoices', true);
  const choices = element('sheetChoices'); choices.replaceChildren();
  let rows = 0, columns = 0, blanks = 0, sheets = 0;
  const warnings = element('warnings'); warnings.replaceChildren();
  for (const file of scan.files) {
    const section = document.createElement('fieldset'), legend = document.createElement('legend'); legend.textContent = `${file.id}. ${file.name}`; section.append(legend);
    for (const sheet of file.sheets) {
      const label = document.createElement('label'), box = document.createElement('input'); box.type = 'checkbox'; box.checked = file.selected.includes(sheet.index); box.dataset.file = file.id; box.dataset.sheet = String(sheet.index);
      label.append(box, document.createTextNode(`${sheet.name}${sheet.hidden ? '（隐藏表）' : ''}`)); section.append(label);
      box.addEventListener('change', () => {
        revokeResult(); const selected = Array.from(section.querySelectorAll<HTMLInputElement>('input:checked')).map((b) => Number(b.dataset.sheet));
        busy = true; sync(); armTimeout(); worker.postMessage({ action: 'select', id: file.id, sheets: selected } satisfies Request);
      });
    }
    const note = document.createElement('p'); note.className = 'scope-note'; note.textContent = `不进入输出：${file.sheets.filter((s) => !file.selected.includes(s.index)).map((s) => s.name).join('、') || '无'}`; section.append(note); choices.append(section);
    if (file.error) { const inline = document.createElement('p'); inline.className = 'file-error'; inline.textContent = file.error; section.append(inline); const li = document.createElement('li'); li.textContent = `${file.name}：${file.error}`; warnings.append(li); }
    if (file.analysis) { rows += file.analysis.rows; columns += file.analysis.rules.length; blanks += file.analysis.fakeBlanks; sheets += file.analysis.sheets; for (const w of file.analysis.warnings) { const li = document.createElement('li'); li.textContent = `${file.name}：${w}`; warnings.append(li); } }
  }
  element('analysisSummary').textContent = `${scan.files.length} 个文件（${scan.files.filter((f) => !f.error).length} 可用 / ${scan.files.filter((f) => f.error).length} 阻断） · ${sheets} 张表 · ${rows.toLocaleString()} 条数据 · ${columns} 列 · ${blanks} 个假空白`;
  const legacy = element('legacyDomains'); legacy.replaceChildren();
  if (scan.dictionary?.version === 1) {
    const note = document.createElement('p'); note.textContent = '旧版字典升级：请确认每个旧映射域对应的语义字段。不同编码合并冲突会停止处理。'; legacy.append(note);
    for (const [domain, target] of Object.entries(legacyDomains)) {
      const label = document.createElement('label'), input = document.createElement('input'); label.append(document.createTextNode(`${domain} → `)); input.value = target; input.dataset.legacy = domain; input.dataset.fixed = String(domain === '人员共用' || domain.endsWith(':店铺')); input.disabled = input.dataset.fixed === 'true';
      input.addEventListener('input', () => { legacyDomains[domain] = input.value; revokeResult(); }); label.append(input); legacy.append(label);
    }
  }
  renderColumns(); sync();
}
function relationFields(): RelationField[] {
  return (scan?.files ?? []).flatMap((file) => {
    const plan = getPlan(file);
    return (file.analysis?.rules ?? []).map((rule) => ({ ...rule, id: `${file.id}:${rule.key}`, fileId: file.id, fileName: file.name, worksheet: `${file.id}:${rule.key.split(':')[0]}`, domain: plan.domains[rule.key]!, kind: plan.kinds?.[rule.key] ?? baseKind(rule), mode: plan.overrides[rule.key] ?? rule.mode }));
  });
}
function applyRelations(changes: RelationChange[]): void {
  const fields = new Map(relationFields().map((field) => [field.id, field]));
  for (const change of changes) {
    const field = fields.get(change.id);
    if (!field) continue;
    const plan = plans.get(field.fileId)!;
    plan.domains[field.key] = change.domain; (plan.kinds ??= {})[field.key] = change.kind; plan.overrides[field.key] = change.mode;
  }
  revokeResult(); renderColumns(); sync();
}
function connectFields(a: string, b: string): void {
    if (busy) return;
    try {
      const fields = relationFields(), existing = new Set(scan?.dictionary?.mappings.map((m) => scan?.dictionary?.version === 1 ? legacyDomains[m.domain] ?? m.domain : m.domain));
      const changes = linkFields(fields, a, b, existing); applyRelations(changes);
      element('relationStatus').textContent = changes.length ? '已关联：相同原值将使用同一编码。表头保持原样。' : '这两个字段已共用映射。';
    } catch (error) { element('relationStatus').textContent = error instanceof Error ? error.message : '无法关联字段。'; }
  }
function existingDomains(): Set<string> { return new Set(scan?.dictionary?.mappings.map(m=>scan?.dictionary?.version===1?legacyDomains[m.domain]??m.domain:m.domain)); }
const bulkPicker = new GroupPicker(element<HTMLDialogElement>('groupPicker'), (changes)=>{matrix.resetSelection();applyRelations(changes);element('relationStatus').textContent=`已更新 ${changes.length} 个字段，未选成员保持原组。`;});
const picker = new FieldPicker(element<HTMLDialogElement>('fieldPicker'), connectFields);
const board = new FieldBoard(element('columns'), element('relationStatus'), {
  focus: (domain) => { selectedDomain = domain; element<HTMLInputElement>('fieldSearch').value = ''; renderColumns(); sync(); },
  pick: (id) => { if (!busy) picker.open(id, relationFields(), new Set(scan?.dictionary?.mappings.map((m) => scan?.dictionary?.version === 1 ? legacyDomains[m.domain] ?? m.domain : m.domain))); },
  link: connectFields,
  detach: (id) => {
    if (busy) return;
    try { const field = relationFields().find((f) => f.id === id); if (!field) return; applyRelations([detachField(field)]); element('relationStatus').textContent = `「${field.header || field.letter}」已改为独立映射。`; }
    catch (error) { element('relationStatus').textContent = error instanceof Error ? error.message : '无法解除关联。'; }
  },
  strategy: (id, mode) => {
    if (busy) return;
    const fields = relationFields(), field = fields.find((f) => f.id === id); if (!field) return;
    const members = fields.filter((f) => f.domain === field.domain);
    if (members.some((f) => f.kind !== 'text' || f.type === '日期' || ['布尔', '空列'].includes(f.type))) { element('relationStatus').textContent = '关联组包含固定规则字段，请先解除普通字段关联再调整策略。'; renderColumns(); return; }
    applyRelations(members.map((f) => ({ id: f.id, domain: f.domain, kind: f.kind, mode })));
    element('relationStatus').textContent = `已同步更新 ${members.length} 个关联字段的处理策略。`;
  },
});
const matrix = new MappingMatrix(element('matrixRoot'), {
  add: (domain, sheet) => { if(!busy)bulkPicker.open(relationFields(),existingDomains(),domain,sheet); },
  move: (ids, domain) => { try { const changes=assignFields(relationFields(),ids,domain,existingDomains());matrix.resetSelection();applyRelations(changes);element('relationStatus').textContent=`已移动 ${changes.length} 个字段。`; } catch(e){element('relationStatus').textContent=e instanceof Error?e.message:'无法移组';} },
  detach: (ids) => {try{const fields=relationFields();const changes=ids.map(id=>{const f=fields.find(f=>f.id===id);if(!f)throw new Error('字段已失效');return detachField(f);});matrix.resetSelection();applyRelations(changes);}catch(e){element('relationStatus').textContent=e instanceof Error?e.message:'无法拆组';}},
  strategy: (id, mode) => {const fields=relationFields(),field=fields.find(f=>f.id===id);if(!field)return;const members=fields.filter(f=>f.domain===field.domain);if(members.some(f=>f.kind!=='text'||f.type==='日期'||['布尔','空列'].includes(f.type))){element('relationStatus').textContent='该组有固定规则，不能更改策略。';return;}applyRelations(members.map(f=>({id:f.id,domain:f.domain,kind:f.kind,mode})));}
});
function renderGroups(all: RelationField[]): void {
  const list = element('groupList'); list.replaceChildren();
  const domains = [...new Set(all.filter((f) => f.mode === 'mask').map((f) => f.domain))].filter((domain) => all.filter((f) => f.domain === domain).length > 1);
  domains.forEach((domain, index) => {
    const members = all.filter((f) => f.domain === domain), row = document.createElement('div'); row.className = 'mapping-group'; row.dataset.groupTone = String(index % 6);
    const focus = document.createElement('button'); focus.type = 'button'; focus.className = 'group-badge'; focus.textContent = `G${index + 1} · ${domain.replace(/^字段:/, '')} · ${members.length} 字段`; focus.dataset.groupDomain = domain;
    focus.addEventListener('click', () => { selectedDomain = domain; element<HTMLInputElement>('fieldSearch').value = ''; renderColumns(); sync(); }); row.append(focus);
    const text = document.createElement('span'); text.textContent = members.map((f) => `${f.fileId}/${f.sheet} · ${f.header || '无表头'}(${f.letter})`).join('  ↔  '); text.title = members.map((f) => `${f.fileName}/${f.sheet}/${f.header}`).join('\n'); row.append(text); list.append(row);
  });
  if (!domains.length) list.textContent = '当前没有共用映射组。可通过“选择对应字段”关联同表或跨表字段。';
  show('showAllGroups', Boolean(selectedDomain));
}
function renderColumns(): void {
  const focused = element<HTMLInputElement>('focusColumns').checked, query = element<HTMLInputElement>('fieldSearch').value.trim().toLocaleLowerCase();
  const terms = query.split(/[|｜]/).map((term) => term.trim()).filter(Boolean);
  const allFields = relationFields(); renderGroups(allFields);
  const fields = allFields.filter((rule) => (!selectedDomain || rule.domain === selectedDomain) && (!focused || rule.kind !== 'text' || !['数值', '布尔', '空列'].includes(rule.type) || rule.uncertainDates) && (!terms.length || terms.some((term) => `${rule.header} ${rule.domain}`.toLocaleLowerCase().includes(term))));
  const columns = (scan?.files ?? []).flatMap((file) => {
    const selected = [...file.selected].sort((a, b) => a - b);
    return (selected.length ? selected : [-1]).map((index, si) => ({ worksheet: index < 0 ? `${file.id}:error` : `${file.id}:${si}`, fileId: file.id, fileName: file.name, sheet: file.sheets[index]?.name ?? '未选工作表', ...(file.error ? { error: file.error } : {}) }));
  });
  board.render(fields, busy, columns, relationFields()); matrix.render(allFields,columns,busy,query);
  show('legacyFocusLabel',!matrixView);show('matrixRoot',matrixView);show('legacyBoard',!matrixView);show('mappingGroups',!matrixView);show('legacyGroupControls',!matrixView);element('viewMatrix').setAttribute('aria-pressed',String(matrixView));element('viewSheets').setAttribute('aria-pressed',String(!matrixView));
}

function clear(): void {
  element('dockStatus').textContent='选择文件后，在矩阵中核对字段分组。';
  bulkPicker.close(); matrix.reset(); picker.close(); selectedDomain = undefined;
  revision++; if (busy) startWorker(); else worker.postMessage({ action: 'reset' } satisfies Request); finish(); files = []; dictionaryFile = undefined; scan = undefined; plans.clear(); selectedDomain = undefined; initializeLegacy(); element<HTMLInputElement>('fieldSearch').value = ''; element('relationStatus').textContent = ''; sourceInput.value = ''; dictionaryInput.value = ''; board.reset(); element('sheetChoices').replaceChildren(); element('legacyDomains').replaceChildren(); element('warnings').replaceChildren(); element('analysisSummary').textContent = ''; revokeResult(); show('analysis', false); show('sheetChoices', false); show('status', false); sync();
}
function setMode(next: ToolMode): void {
  if (busy) return; clear(); mode = next; sourceInput.multiple = next !== 'report'; sourceInput.accept = next === 'report' ? '.html,.htm' : '.xlsx';
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => { const active = b.dataset.mode === mode; b.classList.toggle('active', active); b.setAttribute('aria-pressed', String(active)); });
  for (const key of ['mask', 'restore', 'report']) show(`${key}Guide`, key === mode);
  element('modeTitle').textContent = next === 'mask' ? '选择原始工作簿' : next === 'restore' ? '批量恢复原始名称' : '解密分析报告';
  element('modeDescription').textContent = next === 'mask' ? '多文件共享语义字段映射；可导入旧字典续批。' : '选择文件与对应的完整字典，结果在本地生成。';
  element('sourcePrompt').textContent = next === 'report' ? '选择一个 HTML 报告' : '点击多选或拖入多个 XLSX';
  element('sourceHint').textContent = next === 'report' ? 'UTF-8 · 单文件 ≤ 20 MiB' : '每批 ≤ 30 个 · 单文件 ≤ 50 MiB · 合计 ≤ 150 MiB'; sync();
}
async function choose(selected: File[], dictionary: boolean): Promise<void> {
  if (busy || !selected.length) return;
  const limit = dictionary || mode !== 'report' ? 50 : 20;
  if ((dictionary || mode === 'report') && selected.length !== 1) { notify('此选择区只接受一个文件。', 'error'); return; }
  if (selected.some((f) => !f.size || f.size > limit * 1024 * 1024 || !(dictionary || mode !== 'report' ? /\.xlsx$/i : /\.html?$/i).test(f.name)) || (!dictionary && (selected.length > MAX_BATCH_FILES || selected.reduce((n, f) => n + f.size, 0) > MAX_BATCH_BYTES))) {
    revokeResult(); notify('文件类型或大小无效：XLSX 单文件 ≤ 50 MiB，每批 ≤ 30 个、合计 ≤ 150 MiB；HTML ≤ 20 MiB。', 'error'); return;
  }
  revision++; revokeResult(); scan = undefined; selectedDomain = undefined; plans.clear(); show('analysis', false); show('sheetChoices', false); worker.postMessage({ action: 'reset' } satisfies Request);
  if (dictionary) dictionaryFile = selected[0]; else files = selected;
  sync(); if (mode === 'mask' && files.length) await execute();
}
async function execute(): Promise<void> {
  if (busy || !files.length || (mode !== 'mask' && !dictionaryFile)) return;
  const operation = revision; busy = true; revokeResult(); sync(); notify('正在本地读取文件…'); armTimeout();
  try {
    let request: Request;
    if (mode === 'mask' && scan) {
      const plan: BatchPlan = { files: scan.files.map(getPlan), legacyDomains: { ...legacyDomains } };
      request = { action: 'mask', plan };
    } else {
      const dictionary = dictionaryFile ? new Uint8Array(await dictionaryFile.arrayBuffer()) : undefined;
      if (operation !== revision) return;
      if (mode === 'mask') request = { action: 'analyze', files, ...(dictionary ? { dictionary } : {}) };
      else if (mode === 'restore') request = { action: 'restore', files, dictionary: dictionary! };
      else request = { action: 'report', bytes: new Uint8Array(await files[0]!.arrayBuffer()), dictionary: dictionary!, name: files[0]!.name };
    }
    if (operation !== revision) return;
    const transfer: Transferable[] = []; if ('dictionary' in request && request.dictionary) transfer.push(request.dictionary.buffer as ArrayBuffer); if ('bytes' in request) transfer.push(request.bytes.buffer as ArrayBuffer);
    worker.postMessage(request, transfer);
  } catch (error) { if (operation !== revision) return; finish(); notify(error instanceof Error ? error.message : '读取失败。', 'error'); }
}
sourceInput.addEventListener('change', () => { void choose(Array.from(sourceInput.files ?? []), false); });
dictionaryInput.addEventListener('change', () => { void choose(Array.from(dictionaryInput.files ?? []), true); });
for (const [id, dict] of [['sourceDrop', false], ['dictionaryDrop', true]] as const) {
  const drop = element(id); for (const name of ['dragover', 'dragenter']) drop.addEventListener(name, (e) => { e.preventDefault(); if (!busy) drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover')); drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('dragover'); void choose(Array.from((e as DragEvent).dataTransfer?.files ?? []), dict); });
}
element('dockRun').addEventListener('click',()=>{void execute();});element('dockCancel').addEventListener('click',()=>element<HTMLButtonElement>('cancel').click());
element('viewMatrix').addEventListener('click',()=>{matrixView=true;renderColumns();sync();});element('viewSheets').addEventListener('click',()=>{matrixView=false;renderColumns();sync();});
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode as ToolMode)));
element('showAllGroups').addEventListener('click', () => { selectedDomain = undefined; renderColumns(); sync(); }); element('showConnections').addEventListener('change', () => board.refreshLines());
element('focusColumns').addEventListener('change', () => { renderColumns(); sync(); }); element('fieldSearch').addEventListener('input', () => { renderColumns(); sync(); }); run.addEventListener('click', () => { void execute(); }); element('clear').addEventListener('click', clear);
element('cancel').addEventListener('click', () => { revision++; startWorker(); scan = undefined; finish(); show('analysis', false); show('sheetChoices', false); notify('处理已取消，请重新分析文件。'); });
window.addEventListener('pagehide', () => { bulkPicker.close();matrix.reset();picker.close(); revision++; worker.terminate(); clearTimeout(timeout); revokeResult(); files = []; dictionaryFile = undefined; scan = undefined; plans.clear(); initializeLegacy(); board.reset(); element('sheetChoices').replaceChildren(); element('legacyDomains').replaceChildren(); sourceInput.value = ''; dictionaryInput.value = ''; element('fileSummary').textContent = ''; status.textContent = ''; });
window.addEventListener('pageshow', (e) => { if (e.persisted) { busy = false; clear(); } });
startWorker(); setMode('mask');
