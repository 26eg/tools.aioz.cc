import type { Analysis, ColumnRule, Mode, Stats } from './core';
import type { Request } from './worker';

type ToolMode = 'mask' | 'restore' | 'report';
const element = <T extends HTMLElement>(id: string): T => {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing element: ${id}`);
  return value as T;
};
const sourceInput = element<HTMLInputElement>('sourceFile');
const dictionaryInput = element<HTMLInputElement>('dictionaryFile');
const run = element<HTMLButtonElement>('run');
const status = element<HTMLDivElement>('status');
const download = element<HTMLAnchorElement>('download');
let mode: ToolMode = 'mask', busy = false;
let analysis: Analysis | undefined;
let sourceFile: File | undefined, dictionaryFile: File | undefined;
let worker: Worker, timeout: ReturnType<typeof setTimeout> | undefined, objectUrl: string | undefined;
let revision = 0;
const overrides: Record<string, Mode> = {};
const show = (id: string, visible: boolean): void => { element(id).classList.toggle('hidden', !visible); };
const modes = {
  mask: { title: '选择原始工作簿', description: '读取所有工作表，扫描全列后自动识别数据类型。', action: '分析工作簿', prompt: '点击选择或拖入 XLSX 工作簿', accept: '.xlsx', hint: '单个文件 ≤ 30 MB · 表头位于第 1 行' },
  restore: { title: '恢复工作簿中的原始名称', description: '选择脱敏工作簿与对应字典，自动匹配完整编码。', action: '恢复并生成 XLSX', prompt: '选择需要恢复的 XLSX', accept: '.xlsx', hint: '保留首行表头与完整编码 · 支持排序后的数据' },
  report: { title: '解密分析报告中的名称', description: '恢复正文、属性与图表数据中的名称，导出 HTML。', action: '解密并生成 HTML', prompt: '选择需要解密的 HTML 报告', accept: '.html,.htm', hint: 'UTF-8 编码 · 单个报告 ≤ 20 MB' },
};
function notify(message: string, kind = ''): void { status.textContent = message; status.className = `status ${kind}`; }
function revokeResult(): void {
  if (objectUrl) URL.revokeObjectURL(objectUrl);
  objectUrl = undefined; download.removeAttribute('href'); download.removeAttribute('download'); show('result', false);
}
function sync(): void {
  run.disabled = busy || !sourceFile || (mode !== 'mask' && !dictionaryFile);
  run.textContent = mode === 'mask' && analysis ? '生成脱敏 ZIP' : modes[mode].action;
  sourceInput.disabled = busy; dictionaryInput.disabled = busy;
  document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => { button.disabled = busy; });
  document.querySelectorAll<HTMLSelectElement>('#columns select').forEach((select) => { select.disabled = busy || select.dataset.fixed === 'true'; });
  show('cancel', busy); document.body.classList.toggle('busy', busy);
  element('fileSummary').textContent = [sourceFile, dictionaryFile].filter((file): file is File => Boolean(file)).map((file) => `${file.name} · ${(file.size / 1024).toFixed(1)} KB`).join('\n');
  show('fileSummary', Boolean(sourceFile || dictionaryFile));
}
function finish(): void { busy = false; clearTimeout(timeout); timeout = undefined; sync(); }
function startWorker(): void {
  worker?.terminate();
  const instance = new Worker(new URL('./worker.js?v=1', import.meta.url), { type: 'module' }); worker = instance;
  instance.onerror = () => { if (worker !== instance) return; finish(); analysis = undefined; show('analysis', false); notify('本地处理组件无法运行，请刷新页面或使用新版 Chrome / Edge。', 'error'); sync(); };
  instance.onmessage = (event: MessageEvent<{ type: string; message?: string; text?: string; analysis?: Analysis; bytes?: Uint8Array; filename?: string; stats?: Stats; restored?: number }>) => {
    if (worker !== instance) return;
    const message = event.data;
    if (message.type === 'progress') notify(message.text ?? '正在处理…');
    if (message.type === 'analysis' && message.analysis) {
      analysis = message.analysis; renderAnalysis(); finish();
      element('stepLabel').textContent = '第 2 步 / 核对策略';
      notify('全列扫描完成。请核对下方策略，然后生成脱敏 ZIP。', 'success');
    }
    if (message.type === 'error') { finish(); notify(message.message ?? '处理失败。', 'error'); }
    if (message.type === 'result' && message.bytes && message.filename) {
      finish(); revokeResult();
      const extension = message.filename.split('.').pop();
      const type = extension === 'zip' ? 'application/zip' : extension === 'html' ? 'text/html;charset=utf-8' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(message.bytes)], { type }));
      download.href = objectUrl; download.download = message.filename;
      download.textContent = extension === 'zip' ? '下载脱敏 ZIP（2 个工作簿）' : `下载已解密 ${extension?.toUpperCase()}`;
      const stats = message.stats;
      element('resultSummary').textContent = stats ? `脱敏 ${stats.masked.toLocaleString()} 个单元格 · ${stats.unique.toLocaleString()} 条唯一映射\n转换日期 ${stats.dates} 个 · 舍入数值 ${stats.rounded.toLocaleString()} 个 · 清理假空白 ${stats.blanks} 个${stats.uncertainDates ? `\n保留 ${stats.uncertainDates} 个不明确日期，请核对原列。` : ''}` : `已恢复 ${message.restored?.toLocaleString()} 处编码。${mode === 'restore' ? '日期、两位小数与真空白保持清洗后的状态。' : '报告未在本工具中打开或执行。'}`;
      element('resultNote').textContent = stats ? 'ZIP 内的字典包含原始明文。请解压后分开保管；对外只共享脱敏工作簿。' : '可继续选择另一组文件，或清空当前会话。';
      show('result', true); notify('处理完成，文件已在本地生成。', 'success'); element('stepLabel').textContent = '第 3 步 / 下载结果';
    }
  };
}
function clear(): void {
  const interrupted = busy;
  revision++; finish(); sourceFile = undefined; dictionaryFile = undefined; analysis = undefined;
  sourceInput.value = ''; dictionaryInput.value = ''; Object.keys(overrides).forEach((key) => { delete overrides[key]; });
  element('columns').replaceChildren(); element('warnings').replaceChildren();
  status.textContent = ''; element('analysisSummary').textContent = '';
  revokeResult(); show('analysis', false); show('status', false); element('stepLabel').textContent = '第 1 步 / 选择文件';
  if (interrupted) startWorker(); else worker.postMessage({ action: 'reset' });
  sync();
}
function setMode(next: ToolMode): void {
  if (busy) return;
  clear(); mode = next;
  for (const key of ['mask', 'restore', 'report'] as const) {
    const button = document.querySelector<HTMLButtonElement>(`[data-mode="${key}"]`)!;
    button.classList.toggle('active', key === mode); button.setAttribute('aria-pressed', String(key === mode)); show(`${key}Guide`, key === mode);
  }
  element('modeTitle').textContent = modes[mode].title; element('modeDescription').textContent = modes[mode].description;
  element('sourcePrompt').textContent = modes[mode].prompt; element('sourceHint').textContent = modes[mode].hint;
  element('guideTitle').textContent = mode === 'mask' ? '脱敏规则' : mode === 'restore' ? '恢复规则' : '报告解密规则';
  sourceInput.accept = modes[mode].accept; sourceInput.setAttribute('aria-label', modes[mode].prompt);
  show('dictionaryDrop', mode !== 'mask'); sync();
}
function renderAnalysis(): void {
  if (!analysis) return;
  show('analysis', true);
  element('analysisSummary').textContent = `${analysis.sheets} 张表 · ${analysis.rows.toLocaleString()} 条数据 · ${analysis.rules.length} 列 · ${analysis.fakeBlanks} 个假空白`;
  const tbody = element('columns'); tbody.replaceChildren();
  const focused = element<HTMLInputElement>('focusColumns').checked;
  for (const rule of analysis.rules) {
    if (focused && ['数值', '布尔', '空列'].includes(rule.type) && !rule.uncertainDates) continue;
    const row = document.createElement('tr');
    const append = (text: string): HTMLTableCellElement => { const td = document.createElement('td'); td.textContent = text; row.append(td); return td; };
    append(`${rule.sheet} / ${rule.letter}`); append(rule.header || '（无表头）');
    const type = document.createElement('span'); type.className = 'type'; type.textContent = rule.type; append('').append(type);
    const selector = document.createElement('select'); selector.setAttribute('aria-label', `${rule.sheet} ${rule.letter} ${rule.header} 处理策略`); selector.dataset.key = rule.key;
    for (const [value, label] of [['mask', '脱敏文本'], ['keep', '保留内容'], ['date', '日期清洗']]) { const option = document.createElement('option'); option.value = value!; option.textContent = label!; selector.append(option); }
    selector.value = overrides[rule.key] ?? rule.mode;
    selector.dataset.fixed = String(rule.person || rule.store || rule.mode === 'date' || ['布尔', '空列'].includes(rule.type));
    selector.disabled = selector.dataset.fixed === 'true';
    selector.addEventListener('change', () => { overrides[rule.key] = selector.value as Mode; revokeResult(); });
    append('').append(selector); append(rule.examples.join(' / '));
    append(`${rule.nonEmpty} 非空${rule.fakeBlanks ? ` · ${rule.fakeBlanks} 假空白` : ''}${rule.uncertainDates ? ` · ${rule.uncertainDates} 待检查日期` : ''}`).title = rule.reason;
    tbody.append(row);
  }
  const warnings = element('warnings'); warnings.replaceChildren();
  for (const text of analysis.warnings) { const li = document.createElement('li'); li.textContent = text; warnings.append(li); }
}
function choose(file: File | undefined, dictionary: boolean): void {
  if (busy || !file) return;
  const accepted = dictionary || mode !== 'report' ? /\.xlsx$/i : /\.html?$/i;
  const limit = !dictionary && mode === 'report' ? 20 : 30;
  if (!accepted.test(file.name) || !file.size || file.size > limit * 1024 * 1024) {
    if (dictionary) { dictionaryFile = undefined; dictionaryInput.value = ''; } else { sourceFile = undefined; sourceInput.value = ''; analysis = undefined; show('analysis', false); worker.postMessage({ action: 'reset' }); }
    revokeResult(); sync(); notify(`请选择非空的 ${dictionary || mode !== 'report' ? 'XLSX' : 'HTML'} 文件，大小不超过 ${limit} MB。`, 'error'); return;
  }
  revision++; revokeResult(); show('status', false);
  if (dictionary) dictionaryFile = file;
  else { sourceFile = file; analysis = undefined; show('analysis', false); Object.keys(overrides).forEach((key) => { delete overrides[key]; }); worker.postMessage({ action: 'reset' }); }
  sync();
  if (!dictionary && mode === 'mask') void execute();
}
async function execute(): Promise<void> {
  if (busy || !sourceFile || (mode !== 'mask' && !dictionaryFile)) return;
  const operation = revision;
  busy = true; revokeResult(); sync(); notify('正在本地读取文件…');
  timeout = setTimeout(() => { revision++; worker.terminate(); analysis = undefined; finish(); show('analysis', false); notify('处理超过 120 秒，已停止。请拆分工作簿或减少单元格数量后重试。', 'error'); startWorker(); }, 120000);
  try {
    let request: Request;
    if (mode === 'mask' && analysis) request = { action: 'mask', overrides: { ...overrides } };
    else {
      const bytes = new Uint8Array(await sourceFile.arrayBuffer());
      if (operation !== revision) return;
      if (mode === 'mask') request = { action: 'analyze', bytes, name: sourceFile.name };
      else {
        const dictionary = new Uint8Array(await dictionaryFile!.arrayBuffer());
        if (operation !== revision) return;
        request = { action: mode, bytes, dictionary, name: sourceFile.name };
      }
    }
    const transfers: Transferable[] = [];
    if ('bytes' in request) transfers.push(request.bytes.buffer as ArrayBuffer);
    if ('dictionary' in request) transfers.push(request.dictionary.buffer as ArrayBuffer);
    worker.postMessage(request, transfers);
  } catch (error) { if (operation !== revision) return; finish(); notify(error instanceof Error ? error.message : '读取失败。', 'error'); }
}
sourceInput.addEventListener('change', () => choose(sourceInput.files?.[0], false));
dictionaryInput.addEventListener('change', () => choose(dictionaryInput.files?.[0], true));
for (const [id, dict] of [['sourceDrop', false], ['dictionaryDrop', true]] as const) {
  const drop = element(id);
  for (const name of ['dragover', 'dragenter']) drop.addEventListener(name, (event) => { event.preventDefault(); if (!busy) drop.classList.add('dragover'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('dragover'));
  drop.addEventListener('drop', (event) => { event.preventDefault(); drop.classList.remove('dragover'); if (busy) return; const files = (event as DragEvent).dataTransfer?.files; if (files?.length !== 1) { notify('每个选择区一次只能放入 1 个文件。', 'error'); return; } choose(files[0], dict); });
}
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode as ToolMode)));
element('focusColumns').addEventListener('change', renderAnalysis);
run.addEventListener('click', () => { void execute(); }); element('clear').addEventListener('click', clear);
element('cancel').addEventListener('click', () => { revision++; worker.terminate(); analysis = undefined; finish(); show('analysis', false); startWorker(); notify('处理已取消，可重新选择或分析文件。'); });
window.addEventListener('pagehide', () => {
  worker?.terminate(); clearTimeout(timeout); revokeResult(); sourceFile = undefined; dictionaryFile = undefined; analysis = undefined;
  sourceInput.value = ''; dictionaryInput.value = ''; element('columns').replaceChildren(); element('fileSummary').textContent = ''; status.textContent = '';
});
window.addEventListener('pageshow', (event) => { if (event.persisted) { busy = false; startWorker(); clear(); } });
startWorker(); sync();
