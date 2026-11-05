import { check } from './ooxml';
import type { ColumnRule, Mode } from './core';
export type FieldKind = 'text' | 'person' | 'store';
export interface RelationField extends ColumnRule { id: string; fileId: string; worksheet: string; fileName: string; domain: string; kind: FieldKind; }
export interface RelationChange { id: string; domain: string; kind: FieldKind; mode: Mode; }
export const baseKind = (field: ColumnRule): FieldKind => field.person ? 'person' : field.store ? 'store' : 'text';
export function linkFields(fields: RelationField[], firstId: string, secondId: string, existingDomains: Set<string> = new Set()): RelationChange[] {
  const first = fields.find((f) => f.id === firstId), second = fields.find((f) => f.id === secondId);
  check(first && second && first.id !== second.id, '请选择两个不同的字段。');
  if (first.domain === second.domain) return [];
  check(!(existingDomains.has(first.domain) && existingDomains.has(second.domain)), '续批字典已分别记录这两个字段，不能直接合并已有编码；请沿用原关联或新建批次。');
  const members = fields.filter((f) => f.domain === first.domain || f.domain === second.domain);
  const specialKinds = new Set(members.map((f) => f.kind).filter((k) => k !== 'text'));
  check(specialKinds.size <= 1, '人员与店铺使用不同专用规则，不能关联。');
  const kind = [...specialKinds][0] ?? 'text';
  if (kind !== 'text') check(members.every((f) => f.type !== '日期' && f.type !== '布尔'), '日期或布尔字段不能关联到人员、店铺。');
  else check(members.every((f) => f.mode === first.mode || f.nonEmpty === 0), '处理策略不同，请先统一为脱敏文本、保留内容或日期清洗。');
  const domain = kind === 'person' ? '人员共用' : kind === 'store' ? '店铺' : existingDomains.has(second.domain) ? second.domain : first.domain;
  check(members.every((f) => !existingDomains.has(f.domain) || f.domain === domain), '已有字典编码不能切换到另一套专用规则，请沿用原关联或新建批次。');
  return members.map((f) => ({ id: f.id, domain, kind, mode: kind === 'text' ? first.mode : 'mask' }));
}
export function detachField(field: RelationField): RelationChange {
  check(!field.person && !field.store, '销售员 / IPD / GTM 与店铺字段沿用专用共享规则，不能改为独立域。');
  return { id: field.id, domain: `独立:${field.id}`, kind: 'text', mode: field.mode };
}
// Align equal headers, including repeated occurrences, while keeping absent/new columns explicit.
export function fieldRows(fields: RelationField[]): { keys: string[]; positions: Map<string, string> } {
  const counts = new Map<string, number>(), initial = new Map<string, string>(), order: string[] = [];
  const parent = new Map<string, string>(), worksheets = new Map<string, Set<string>>();
  for (const f of fields) {
    const header = f.header || '（无表头）', counter = JSON.stringify([f.worksheet, header]);
    const occurrence = (counts.get(counter) ?? 0) + 1; counts.set(counter, occurrence);
    const key = JSON.stringify([header, occurrence]); initial.set(f.id, key);
    if (!parent.has(key)) { parent.set(key, key); order.push(key); worksheets.set(key, new Set()); }
    worksheets.get(key)!.add(f.worksheet);
  }
  const root = (key: string): string => { const p = parent.get(key)!; if (p === key) return key; const result = root(p); parent.set(key, result); return result; };
  const groups = new Map<string, string[]>();
  for (const f of fields) { const keys = groups.get(f.domain) ?? []; keys.push(initial.get(f.id)!); groups.set(f.domain, keys); }
  for (const keys of groups.values()) for (let i = 1; i < keys.length; i++) {
    let a = root(keys[0]!), b = root(keys[i]!); if (a === b) continue;
    // Never collapse two different columns of the same worksheet into one card position.
    if ([...worksheets.get(a)!].some((sheet) => worksheets.get(b)!.has(sheet))) continue;
    if (order.indexOf(a) > order.indexOf(b)) [a, b] = [b, a];
    parent.set(b, a); for (const sheet of worksheets.get(b)!) worksheets.get(a)!.add(sheet);
  }
  return { keys: order.filter((key) => root(key) === key), positions: new Map(fields.map((f) => [f.id, root(initial.get(f.id)!)])) };
}

// Assign only the explicitly selected columns, not every member of their previous groups.
export function assignFields(fields: RelationField[], ids: string[], domain: string, existingDomains = new Set<string>()): RelationChange[] {
  check(domain.trim() && domain.length <= 200 && ids.length > 0 && new Set(ids).size === ids.length, '请选择字段与有效映射组。');
  const target = fields.find((f) => f.domain === domain);
  const kind: FieldKind = target?.kind ?? 'text';
  return ids.map((id) => {
    const field = fields.find((f) => f.id === id); check(field, '字段已失效，请重新选择。');
    check(field.mode === 'mask' && (!target || target.mode === 'mask'), '仅脱敏文本字段可以加入映射组，请先调整处理策略。');
    check(!existingDomains.has(field.domain) || field.domain === domain, '该字段已有续批编码，不能改组，请新建批次或沿用原组。');
    check(!field.person || domain === '人员共用', '人员字段必须保留专用组。');
    check(!field.store || domain === '店铺', '店铺字段必须保留专用组。');
    check(kind === 'text' || !['日期','布尔'].includes(field.type), '日期、布尔字段不能加入专用组。');
    return { id, domain, kind, mode: 'mask' };
  });
}
