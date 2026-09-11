import { analyze, maskWorkbook, restoreWorkbook, type Mode } from './core';
import { check, readBook, MAX_FILE_BYTES } from './ooxml';
import { restoreReport } from './report';

export type Request =
  | { action: 'reset' }
  | { action: 'analyze'; bytes: Uint8Array; name: string }
  | { action: 'mask'; overrides: Record<string, Mode> }
  | { action: 'restore'; bytes: Uint8Array; dictionary: Uint8Array; name: string }
  | { action: 'report'; bytes: Uint8Array; dictionary: Uint8Array; name: string };
let source: { bytes: Uint8Array; name: string } | undefined;
self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const request = event.data;
    if (request.action === 'reset') { source = undefined; return; }
    if ('bytes' in request) check(request.bytes instanceof Uint8Array && request.bytes.length <= MAX_FILE_BYTES, '文件类型或大小无效。');
    self.postMessage({ type: 'progress', text: '正在浏览器内存中读取与校验文件…' });
    if (request.action === 'analyze') {
      source = undefined;
      const analysis = analyze(readBook(request.bytes, true));
      source = { bytes: request.bytes, name: request.name };
      self.postMessage({ type: 'analysis', analysis });
    } else if (request.action === 'mask') {
      check(source, '请重新选择并分析工作簿。');
      self.postMessage({ type: 'progress', text: '正在脱敏、清洗并生成工作簿和字典 ZIP…' });
      const result = await maskWorkbook(source.bytes, source.name, request.overrides);
      self.postMessage({ type: 'result', bytes: result.zip, filename: result.filename, stats: result.stats }, { transfer: [result.zip.buffer as ArrayBuffer] });
    } else if (request.action === 'restore') {
      const result = await restoreWorkbook(request.bytes, request.dictionary, request.name);
      self.postMessage({ type: 'result', ...result }, { transfer: [result.bytes.buffer as ArrayBuffer] });
    } else if (request.action === 'report') {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(request.bytes);
      const result = await restoreReport(text, request.dictionary, request.name);
      const bytes = new TextEncoder().encode(result.text);
      self.postMessage({ type: 'result', bytes, filename: result.filename, restored: result.restored }, { transfer: [bytes.buffer as ArrayBuffer] });
    } else throw new Error('未知操作。');
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : '文件处理失败。' });
  }
};
self.postMessage({ type: 'ready' });
