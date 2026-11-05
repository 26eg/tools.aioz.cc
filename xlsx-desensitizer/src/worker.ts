import { check, MAX_FILE_BYTES } from './ooxml';
import { restoreReport } from './report';
import { scanFiles, analyzeSelected, maskBatch, restoreBatch, type BatchScan, type BatchPlan } from './batch';
export type Request =
  | { action: 'reset' }
  | { action: 'analyze'; files: File[]; dictionary?: Uint8Array }
  | { action: 'select'; id: string; sheets: number[] }
  | { action: 'mask'; plan: BatchPlan }
  | { action: 'restore'; files: File[]; dictionary: Uint8Array }
  | { action: 'report'; bytes: Uint8Array; dictionary: Uint8Array; name: string };
let source: { files: File[]; scan: BatchScan } | undefined;
let running = false;
const progress = (text: string): void => self.postMessage({ type: 'progress', text });
self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  if (request.action === 'reset') { source = undefined; return; }
  if (running) { self.postMessage({ type: 'error', message: '已有处理任务，请先取消。' }); return; }
  running = true;
  try {
    if ('dictionary' in request && request.dictionary) check(request.dictionary instanceof Uint8Array && request.dictionary.length <= MAX_FILE_BYTES, '字典大小无效。');
    if (request.action === 'analyze') {
      source = undefined;
      const scan = await scanFiles(request.files, request.dictionary, progress);
      source = { files: request.files, scan };
      self.postMessage({ type: 'analysis', scan });
    } else if (request.action === 'select') {
      check(source, '请重新分析文件。');
      const index = source.scan.files.findIndex((f) => f.id === request.id);
      check(index >= 0, '文件 ID 无效。');
      progress(`分析选择的工作表：${source.files[index]!.name}`);
      const scan = source.scan.files[index]!;
      scan.selected = request.sheets;
      try { scan.analysis = analyzeSelected(new Uint8Array(await source.files[index]!.arrayBuffer()), request.sheets); delete scan.error; }
      catch (error) { delete scan.analysis; scan.error = error instanceof Error ? error.message : '工作表分析失败'; }
      self.postMessage({ type: 'selection', file: scan });
    } else if (request.action === 'mask') {
      check(source, '请重新分析文件。');
      const result = await maskBatch(source.files, request.plan, source.scan.dictionary, progress);
      self.postMessage({ type: 'result', ...result }, { transfer: [result.bytes.buffer as ArrayBuffer] });
    } else if (request.action === 'restore') {
      const result = await restoreBatch(request.files, request.dictionary, progress);
      self.postMessage({ type: 'result', ...result }, { transfer: [result.bytes.buffer as ArrayBuffer] });
    } else if (request.action === 'report') {
      check(request.bytes instanceof Uint8Array && request.bytes.length > 0 && request.bytes.length <= 20 * 1024 * 1024, 'HTML 大小无效。');
      const result = await restoreReport(new TextDecoder('utf-8', { fatal: true }).decode(request.bytes), request.dictionary, request.name);
      const bytes = new TextEncoder().encode(result.text);
      self.postMessage({ type: 'result', bytes, filename: result.filename, restored: result.restored }, { transfer: [bytes.buffer as ArrayBuffer] });
    }
  } catch (error) { self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '文件处理失败。' }); }
  finally { running = false; }
};
self.postMessage({ type: 'ready' });
