import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import { parse as parseJavaScript, tokenizer, type Node as JsNode, type Literal, type TemplateLiteral } from 'acorn';
import { check } from './ooxml';
import { readDictionary, createReplacer, outputName, timestamp, type Dictionary } from './core';

interface Edit { start: number; end: number; value: string; }
const htmlEscape = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const jsString = (value: string): string => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
function applyEdits(source: string, edits: Edit[]): string {
  const sorted = edits.sort((a, b) => b.start - a.start);
  let result = source, previous = source.length;
  for (const edit of sorted) {
    check(edit.end <= previous && edit.start <= edit.end, '报告包含重叠的替换位置，已停止处理。');
    result = result.slice(0, edit.start) + edit.value + result.slice(edit.end); previous = edit.start;
  }
  return result;
}

export function restoreReportText(source: string, dict: Dictionary): { text: string; restored: number } {
  check(source.length > 0 && source.length <= 20 * 1024 * 1024, 'HTML 报告必须非空且不超过 20 MB。');
  check(!source.includes('\u0000'), 'HTML 包含无效空字符或不支持的编码，请另存为 UTF-8。');
  const document = parseHtml(source, { sourceCodeLocationInfo: true });
  const replacer = createReplacer(dict);
  const edits: Edit[] = [];
  const javascript = (code: string, module = false, json = false): string => {
    if (json) {
      try { JSON.parse(code); } catch { throw new Error('报告中的 JSON 数据无效，无法安全解密。'); }
      // Edit string source ranges only. Re-serializing JSON would corrupt large numbers.
      const tokens = [...tokenizer(code, { ecmaVersion: 'latest' })];
      const changes: Edit[] = [];
      const keys: Set<string>[] = [];
      for (const [index, token] of tokens.entries()) {
        if (token.type.label === '{') keys.push(new Set());
        else if (token.type.label === '}') keys.pop();
        else if (token.type.label === 'string') {
          const value: string = JSON.parse(code.slice(token.start, token.end));
          const restored = replacer.replace(value);
          if (tokens[index + 1]?.type.label === ':') {
            const current = keys[keys.length - 1];
            check(current && !current.has(restored), '报告 JSON 的字段名重复或恢复后发生冲突。');
            current.add(restored);
          }
          if (restored !== value) changes.push({ start: token.start, end: token.end, value: jsString(restored) });
        }
      }
      return applyEdits(code, changes);
    }
    let ast: JsNode;
    try { ast = parseJavaScript(code, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', allowReturnOutsideFunction: true }); }
    catch { check(!replacer.hasTokens(code), '报告含无法解析的脚本编码，请将名称数据放入有效 JSON 或普通 JS 字符串。'); return code; }
    const changes: Edit[] = [];
    const stack: JsNode[] = [ast];
    while (stack.length) {
      const node = stack.pop()!;
      if (node.type === 'Literal' && typeof (node as Literal).value === 'string') {
        const value = (node as Literal).value as string;
        const replaced = replacer.replace(value);
        if (value !== replaced) changes.push({ start: node.start, end: node.end, value: jsString(replaced) });
      } else if (node.type === 'TemplateLiteral') {
        const template = node as TemplateLiteral;
        for (const quasi of template.quasis) {
          const value = quasi.value.cooked;
          if (value == null) continue;
          const replaced = replacer.replace(value);
          if (replaced !== value) {
            check(template.expressions.length === 0, '含变量插值的模板字符串暂不支持解密；请将名称写入普通字符串或 JSON。');
            changes.push({ start: template.start, end: template.end, value: jsString(replaced) });
          }
        }
        continue;
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const item of value) { if (item && typeof item === 'object' && 'type' in item) stack.push(item as JsNode); }
        else if (value && typeof value === 'object' && 'type' in value) stack.push(value as JsNode);
      }
    }
    const result = applyEdits(code, changes);
    if (changes.length) {
      try { parseJavaScript(result, { ecmaVersion: 'latest', sourceType: module ? 'module' : 'script', allowReturnOutsideFunction: true }); }
      catch { throw new Error('名称替换后脚本语法不兼容，请将名称放入普通字符串或 JSON 数据。'); }
    }
    // Code/regex/comment occurrences are intentionally not edited as JavaScript strings.
    check(!replacer.hasTokens(result), '脚本中仍有非字符串形式的脱敏编码，无法完整解密。');
    return result;
  };
  const stack: DefaultTreeAdapterMap['node'][] = [document];
  while (stack.length) {
    const node = stack.pop()!;
    if ('tagName' in node) {
      const location = node.sourceCodeLocation;
      for (const attribute of node.attrs) {
        let restored: string;
        if (/^on/i.test(attribute.name)) restored = javascript(attribute.value);
        else restored = replacer.replace(attribute.value);
        if (restored === attribute.value) continue;
        check(!/^(href|src|srcset|action|formaction|srcdoc|style|integrity)$/i.test(attribute.name), '报告的 URL / CSS / 嵌套 HTML 属性中存在编码，请先改为普通文本或 data 属性。');
        const name = attribute.prefix ? `${attribute.prefix}:${attribute.name}` : attribute.name;
        const at = location?.attrs?.[name];
        check(at, '无法定位报告属性。');
        edits.push({ start: at.startOffset, end: at.endOffset, value: `${name}="${htmlEscape(restored)}"` });
      }
      if (node.tagName === 'meta') {
        const charset = node.attrs.find((item) => item.name === 'charset');
        if (charset && !/^utf-?8$/i.test(charset.value)) throw new Error('报告声明的编码不是 UTF-8，请先另存为 UTF-8 HTML。');
        const content = node.attrs.find((item) => item.name === 'content')?.value ?? '';
        if (/charset\s*=/i.test(content)) check(/charset\s*=\s*utf-?8(?:\s|;|$)/i.test(content), '报告编码不是 UTF-8，请先另存为 UTF-8 HTML。');
      }
      if (node.tagName === 'script') {
        const type = node.attrs.find((item) => item.name === 'type')?.value.toLowerCase() ?? '';
        const textNode = node.childNodes.find((item) => item.nodeName === '#text');
        if (textNode && 'value' in textNode && textNode.sourceCodeLocation) {
          const code = textNode.value;
          const isJson = /json/.test(type) || type === 'importmap' || type === 'speculationrules';
          const supported = isJson || ['', 'module', 'text/javascript', 'application/javascript'].includes(type);
          if (!supported) { check(!replacer.hasTokens(code), '不支持此报告脚本数据格式。'); continue; }
          const restored = javascript(code, type === 'module', isJson);
          if (restored !== code) edits.push({ start: textNode.sourceCodeLocation.startOffset, end: textNode.sourceCodeLocation.endOffset, value: restored });
        }
        continue;
      }
      if (node.tagName === 'style') {
        check(!node.childNodes.some((item) => 'value' in item && replacer.hasTokens(item.value)), 'CSS 中含脱敏名称，暂不支持自动恢复。');
        continue;
      }
      if (node.tagName === 'template' && 'content' in node) stack.push(node.content);
    }
    if (node.nodeName === '#text' && 'value' in node && node.sourceCodeLocation) {
      const restored = replacer.replace(node.value);
      if (restored !== node.value) edits.push({ start: node.sourceCodeLocation.startOffset, end: node.sourceCodeLocation.endOffset, value: htmlEscape(restored) });
    }
    if ('childNodes' in node) stack.push(...node.childNodes);
  }
  check(replacer.matched() > 0, '报告中未找到字典对应的编码，或名称已被截断 / 改写。');
  const result = applyEdits(source, edits);
  check(!replacer.hasTokens(result), '报告中仍有未恢复的编码（例如注释或跨标签文本），未生成部分解密文件。');
  return { text: result, restored: replacer.matched() };
}
export async function restoreReport(source: string, dictionaryBytes: Uint8Array, sourceName: string, now = new Date()): Promise<{ text: string; filename: string; restored: number }> {
  const result = restoreReportText(source, await readDictionary(dictionaryBytes));
  return { ...result, filename: outputName(sourceName, '已解密', 'html', timestamp(now)) };
}
