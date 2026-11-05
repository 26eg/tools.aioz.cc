import { fieldRows, type RelationField } from './relations';
import type { Mode } from './core';
export interface BoardColumn { worksheet: string; fileId: string; fileName: string; sheet: string; error?: string; }
interface Callbacks { focus: (domain: string) => void; pick: (id: string) => void; link: (a: string, b: string) => void; detach: (id: string) => void; strategy: (id: string, mode: Mode) => void; }
const NS = 'http://www.w3.org/2000/svg';
export class FieldBoard {
  private fields: RelationField[] = [];
  private pending: string | undefined;
  private drag: { id: string; pointer: number; x: number; y: number; moved: boolean; originX: number; originY: number } | undefined;
  private svg: SVGSVGElement | undefined;
  private frame = 0;
  private readonly observer: ResizeObserver;
  constructor(private readonly root: HTMLElement, private readonly message: HTMLElement, private readonly callbacks: Callbacks) {
    this.observer = new ResizeObserver(() => this.schedule()); this.observer.observe(root);
    window.addEventListener('resize', () => this.schedule());
    root.addEventListener('pointerdown', (event) => {
      const port = (event.target as Element).closest<HTMLButtonElement>('[data-port]');
      if (!port || port.disabled || event.button !== 0) return;
      event.preventDefault(); root.setPointerCapture(event.pointerId);
      this.drag = { id: port.dataset.field!, pointer: event.pointerId, x: event.clientX, y: event.clientY, moved: false, originX: event.clientX, originY: event.clientY }; this.schedule();
    });
    root.addEventListener('pointermove', (event) => {
      if (!this.drag || event.pointerId !== this.drag.pointer) return;
      this.drag.x = event.clientX; this.drag.y = event.clientY;
      this.drag.moved ||= Math.hypot(event.clientX - this.drag.originX, event.clientY - this.drag.originY) > 5; this.schedule();
    });
    root.addEventListener('pointerup', (event) => {
      const drag = this.drag; if (!drag || event.pointerId !== drag.pointer) return;
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLButtonElement>('[data-port]');
      this.drag = undefined; if (root.hasPointerCapture(event.pointerId)) root.releasePointerCapture(event.pointerId);
      if (target && !target.disabled && target.dataset.field !== drag.id) { this.pending = undefined; this.callbacks.link(drag.id, target.dataset.field!); }
      else if (!drag.moved && target && !target.disabled) this.choosePort(drag.id);
      this.schedule();
    });
    root.addEventListener('pointercancel', () => { this.drag = undefined; this.schedule(); });
    root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { this.pending = undefined; this.drag = undefined; this.message.textContent = '已取消连线。'; this.schedule(); } });
  }
  reset(): void { this.fields = []; this.pending = undefined; this.drag = undefined; this.root.replaceChildren(); this.svg = undefined; }
  render(fields: RelationField[], busy: boolean, columns: BoardColumn[] = [], allFields = fields): void {
    this.fields = fields; this.root.replaceChildren();
    if (!fields.some((f) => f.id === this.pending)) this.pending = undefined;
    const sheets = columns.length ? columns.map((c) => c.worksheet) : [...new Set(fields.map((f) => f.worksheet))], rows = fieldRows(fields);
    this.root.style.gridTemplateColumns = `repeat(${Math.max(1, sheets.length)}, minmax(300px, 1fr))`;
    this.root.style.minWidth = `${Math.max(1, sheets.length) * 340}px`;
    const groups = new Map<string, number>(); for (const f of allFields) groups.set(f.domain, (groups.get(f.domain) ?? 0) + 1);
    for (const [index, sheet] of sheets.entries()) {
      const first: BoardColumn = columns.find((c) => c.worksheet === sheet) ?? fields.find((f) => f.worksheet === sheet)!;
      const heading = document.createElement('div'); heading.className = 'sheet-heading'; heading.style.gridColumn = String(index + 1); heading.style.gridRow = '1';
      const title = document.createElement('strong'); title.textContent = `${first.fileId}. ${first.fileName}`;
      const subtitle = document.createElement('span'); subtitle.textContent = first.error ? `${first.sheet} · 预检查未通过` : `${first.sheet} · 显示 ${fields.filter((f) => f.worksheet === sheet).length} / ${allFields.filter((f) => f.worksheet === sheet).length} 个字段`; heading.append(title, subtitle); this.root.append(heading);
      if (first.error || !fields.some((f) => f.worksheet === sheet)) { const note = document.createElement('article'); note.className = first.error ? 'field-empty field-error' : 'field-empty'; note.style.gridColumn = String(index + 1); note.style.gridRow = `2 / span ${Math.max(1, rows.keys.length)}`; note.textContent = first.error || '该工作表没有符合当前筛选条件的字段'; this.root.append(note); continue; }
      for (const [rowIndex, rowKey] of rows.keys.entries()) {
        const field = fields.find((f) => f.worksheet === sheet && rows.positions.get(f.id) === rowKey);
        const card = document.createElement('article'); card.style.gridColumn = String(index + 1); card.style.gridRow = String(rowIndex + 2);
        if (!field) { card.className = 'field-empty'; const header = (JSON.parse(rowKey) as [string, number])[0]; card.textContent = allFields.some((f) => f.worksheet === sheet && f.header === header) ? '该字段被当前筛选隐藏' : '此表无该字段'; this.root.append(card); continue; }
        card.className = 'field-card'; card.dataset.fieldCard = field.id; card.dataset.domain = field.domain;
        const heading = document.createElement('div'); heading.className = 'field-title';
        const name = document.createElement('strong'); name.textContent = field.header || '（无表头）';
        const type = document.createElement('span'); type.className = 'type'; type.textContent = field.kind === 'store' ? '店铺 · 保留末3字' : field.kind === 'person' ? '人员共用' : field.type;
        heading.append(name, type); card.append(heading);
        const tools = document.createElement('div'); tools.className = 'field-tools';
        const col = document.createElement('span'); col.textContent = field.letter;
        const select = document.createElement('select'); select.dataset.key = field.id; select.setAttribute('aria-label', `${field.fileName} ${field.sheet} ${field.letter} 处理策略`);
        for (const [value, label] of [['mask', '脱敏文本'], ['keep', '保留内容'], ['date', '日期清洗']]) { const option = document.createElement('option'); option.value = value!; option.textContent = label!; select.append(option); }
        select.value = field.mode; select.dataset.fixed = String(field.kind !== 'text' || field.type === '日期' || ['布尔', '空列'].includes(field.type)); select.disabled = busy || select.dataset.fixed === 'true';
        select.addEventListener('change', () => this.callbacks.strategy(field.id, select.value as Mode)); tools.append(col, select); card.append(tools);
        const sample = document.createElement('p'); sample.className = 'field-sample'; sample.textContent = `示例：${field.examples.join(' / ') || '无非空值'}`; sample.title = field.examples.join(' / '); card.append(sample);
        const checks = document.createElement('p'); checks.className = 'field-check'; checks.textContent = `${field.nonEmpty} 非空 · ${field.fakeBlanks} 假空白${field.uncertainDates ? ` · ${field.uncertainDates} 待检查日期` : ''}`; checks.title = field.reason; card.append(checks);
        const association = document.createElement('div'); association.className = 'field-association';
        const domains = [...new Set(allFields.filter((f) => f.mode === 'mask' && allFields.filter((x) => x.domain === f.domain).length > 1).map((f) => f.domain))];
        const groupIndex = domains.indexOf(field.domain);
        const badge = document.createElement('button'); badge.type = 'button'; badge.className = 'group-badge'; badge.textContent = groupIndex >= 0 ? `G${groupIndex + 1} · ${field.domain.replace(/^字段:/, '')} · ${groups.get(field.domain)} 字段` : field.mode === 'mask' ? '独立映射' : '不参与脱敏映射'; badge.title = field.domain; badge.disabled = busy || groupIndex < 0; badge.dataset.fixed = String(groupIndex < 0); badge.addEventListener('click', () => this.callbacks.focus(field.domain)); association.append(badge); if (groupIndex >= 0) card.dataset.groupTone = String(groupIndex % 6);
        const pick = document.createElement('button'); pick.type = 'button'; pick.className = 'pick-field'; pick.textContent = '选择对应字段'; pick.dataset.pickSource = field.id; pick.disabled = busy; pick.addEventListener('click', () => this.callbacks.pick(field.id)); association.append(pick);
        if (!field.person && !field.store && (groups.get(field.domain)! > 1 || field.kind !== 'text')) {
          const detach = document.createElement('button'); detach.type = 'button'; detach.className = 'unlink'; detach.textContent = '独立处理'; detach.dataset.detach = field.id; detach.disabled = busy; detach.addEventListener('click', () => this.callbacks.detach(field.id)); association.append(detach);
        }
        if (field.person || field.store) association.title = '已识别的人员与店铺保留专用共享规则，可连接其他同义文本字段。'; card.append(association);
        for (const side of ['left', 'right']) {
          const port = document.createElement('button'); port.type = 'button'; port.className = `field-port ${side}`; port.dataset.port = side; port.dataset.field = field.id; port.disabled = busy;
          port.setAttribute('aria-label', `关联 ${field.fileName} ${field.sheet} ${field.header || field.letter}`); port.title = '拖动到其他表的字段圆点，或依次点击两个圆点';
          port.addEventListener('click', (event) => { if (event.detail === 0) this.choosePort(field.id); }); card.append(port);
        }
        this.root.append(card);
      }
    }
    this.svg = document.createElementNS(NS, 'svg'); this.svg.classList.add('relation-lines'); this.svg.setAttribute('aria-label', '字段关联连线'); this.root.append(this.svg);
    if (!fields.length) { const empty = document.createElement('p'); empty.textContent = '没有符合筛选条件的字段。'; this.root.append(empty); }
    this.schedule();
  }
  refreshLines(): void { this.schedule(); }
  private choosePort(id: string): void {
    if (this.pending && this.pending !== id) { const first = this.pending; this.pending = undefined; this.callbacks.link(first, id); }
    else { this.pending = this.pending === id ? undefined : id; const field = this.fields.find((f) => f.id === id); this.message.textContent = this.pending ? `已选「${field?.header || field?.letter}」，请点击另一张表的对应字段圆点；Esc 取消。` : '已取消连线。'; }
    this.schedule();
  }
  private schedule(): void { if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); }); }
  private draw(): void {
    if (!this.svg || !this.root.isConnected) return;
    this.root.classList.toggle('connections-visible', Boolean((document.getElementById('showConnections') as HTMLInputElement | null)?.checked));
    this.svg.replaceChildren(); if (!document.getElementById('showConnections') || !(document.getElementById('showConnections') as HTMLInputElement).checked) return; this.svg.setAttribute('width', String(this.root.scrollWidth)); this.svg.setAttribute('height', String(this.root.scrollHeight));
    this.root.querySelectorAll<HTMLElement>('[data-field-card]').forEach((card) => card.classList.toggle('link-pending', card.dataset.fieldCard === this.pending || card.dataset.fieldCard === this.drag?.id));
    const root = this.root.getBoundingClientRect();
    const ports = new Map(Array.from(this.root.querySelectorAll<HTMLButtonElement>('[data-port]')).map((p) => [`${p.dataset.field}:${p.dataset.port}`, p.getBoundingClientRect()]));
    const port = (id: string, side: string): DOMRect | undefined => ports.get(`${id}:${side}`);
    const path = (x1: number, y1: number, x2: number, y2: number, draft = false): SVGPathElement => {
      const line = document.createElementNS(NS, 'path'), bend = Math.max(25, Math.abs(x2 - x1) * .45);
      line.setAttribute('d', `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`); if (draft) line.classList.add('draft'); this.svg!.append(line); return line;
    };
    const groups = new Map<string, RelationField[]>(); for (const f of this.fields) { const list = groups.get(f.domain) ?? []; list.push(f); groups.set(f.domain, list); }
    const seen = new Set<string>();
    for (const group of groups.values()) for (const field of group) {
      const other = [...group].reverse().find((g) => g.worksheet !== field.worksheet && g.header === field.header && this.fields.indexOf(g) < this.fields.indexOf(field)) ?? [...group].reverse().find((g) => g.worksheet !== field.worksheet && this.fields.indexOf(g) < this.fields.indexOf(field));
      if (!other) continue;
      const edge = [other.id, field.id].sort().join('|'); if (seen.has(edge)) continue; seen.add(edge);
      const a = port(other.id, 'right'), b = port(field.id, 'left'); if (!a || !b) continue;
      const line = path(a.x + a.width / 2 - root.x, a.y + a.height / 2 - root.y, b.x + b.width / 2 - root.x, b.y + b.height / 2 - root.y);
      line.setAttribute('aria-hidden', 'true');
      if (!field.person && !field.store) {
        const hit = line.cloneNode() as SVGPathElement; hit.removeAttribute('aria-hidden'); hit.classList.add('relation-hit'); hit.dataset.linkFrom = other.id; hit.dataset.linkTo = field.id; this.svg.append(hit);
        hit.setAttribute('tabindex', '0'); hit.setAttribute('role', 'button'); hit.setAttribute('aria-label', `解除 ${field.fileName} ${field.sheet} ${field.header} 的关联`);
        const unlink = (): void => this.callbacks.detach(field.id); hit.addEventListener('click', unlink); hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); unlink(); } });
      }
    }
    if (this.drag) { const a = port(this.drag.id, 'right'); if (a) path(a.x + a.width / 2 - root.x, a.y + a.height / 2 - root.y, this.drag.x - root.x, this.drag.y - root.y, true); }
  }
}
