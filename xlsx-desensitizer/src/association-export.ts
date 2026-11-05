import { sha256 } from './ooxml';
import type { Mode } from './core';
export interface AssociationMember { fileId: string; outputFile: string; outputSheet: string; header: string; column: string; mode: Mode; kind: 'text' | 'person' | 'store'; }
export interface AssociationGroup { groupId: string; name: string; domain: string; members: AssociationMember[]; }
export async function associationDocuments(items: { domain: string; member: AssociationMember }[], context = { seriesId: 'standalone', revision: 1 }): Promise<{ json: string; markdown: string }> {
  const byDomain = new Map<string, AssociationMember[]>();
  for (const { domain, member } of items) { const members = byDomain.get(domain) ?? []; members.push(member); byDomain.set(domain, members); }
  const groups: AssociationGroup[] = [];
  for (const [domain, members] of byDomain) groups.push({ groupId: `group-${(await sha256(JSON.stringify([context.seriesId, domain]))).slice(0,24)}`, name: domain.replace(/^(字段:|组:)/, ''), domain, members });
  const escape = (value: string): string => value.replace(/\|/g,'\\|').replace(/[\r\n]/g,' ');
  const shared = groups.filter((g) => g.members.filter((m) => m.mode === 'mask').length > 1);
  const rows = shared.flatMap((g) => g.members.filter((m) => m.mode === 'mask').map((m) => `| ${escape(g.name)} | ${g.groupId} | ${escape(m.outputFile)} | ${escape(m.outputSheet)} | ${m.column} | ${escape(m.header)} | ${m.kind} |`));
  const markdown = ['# 本批字段关联说明','', `字典系列：${context.seriesId}；本次修订：${context.revision}。不同系列不能仅凭相同组名认定编码一致。`,'', '仅描述本次实际输出的字段关系，不包含原始单元格值、示例或恢复映射。原表头与文件名仍可能包含敏感信息，请在共享前检查。','',
    '## 已配置共用映射的字段','', '| 组名 | 稳定组 ID | 输出文件 | 输出工作表 | 列号 | 原表头 | 规则 |','| --- | --- | --- | --- | --- | --- | --- |',...rows,
    ...(rows.length ? [] : ['本批没有配置多字段共用映射。']), '', '## 给 LLM 的分析约束','',
    '- X1、X2 等为文本标识，数字不表示大小、顺序、排名或相似度；人名使用人序号，店铺保留末三字符。',
    '- 仅在上表明确配置的同组字段间用完整编码精确关联；不要根据共同前缀推断实体类型，不要猜测原始名称。',
    '- 合并前检查各表数据粒度与键唯一性，防止多对多合并重复汇总。',
    '- 保留完整编码供后续恢复；日期、两位小数与真空白按工具清洗规则保留。',
    '- 不要上传批次脱敏字典.xlsx；它包含原始明文。', '', '全部逐列配置（含独立与保留列）见字段关联清单.json；该清单只覆盖本次输出，不代表字典内全部历史文件。',''].join('\n');
  return { json: JSON.stringify({ version: 1, seriesId: context.seriesId, revision: context.revision, scope: 'current-output-only', groups },null,2), markdown };
}
