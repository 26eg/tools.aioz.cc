import { linkFields, type RelationField } from './relations';
export class FieldPicker {
  private sourceId: string | undefined;
  private fields: RelationField[] = [];
  private domains = new Set<string>();
  constructor(private readonly dialog: HTMLDialogElement, private readonly connect: (source: string, target: string) => void) {
    this.get<HTMLInputElement>('pickerSearch').addEventListener('input', () => this.render());
    this.get<HTMLSelectElement>('pickerSheet').addEventListener('change', () => this.render());
    this.get<HTMLButtonElement>('pickerClose').addEventListener('click', () => this.close());
    dialog.addEventListener('close', () => this.release());
    dialog.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close(); } });
  }
  private get<T extends HTMLElement>(id: string): T { return this.dialog.querySelector<T>(`#${id}`)!; }
  open(sourceId: string, fields: RelationField[], domains: Set<string>): void {
    const source = fields.find((f) => f.id === sourceId); if (!source) return;
    this.sourceId = sourceId; this.fields = fields; this.domains = domains;
    this.get('pickerSource').textContent = `${source.fileId}. ${source.fileName} / ${source.sheet} / ${source.letter}「${source.header || '无表头'}」\n示例：${source.examples.join(' / ') || '无非空值'}\n请选择含义相同的目标字段；示例相同仅供核对，不自动关联。`;
    this.get<HTMLInputElement>('pickerSearch').value = '';
    const select = this.get<HTMLSelectElement>('pickerSheet'); select.replaceChildren();
    const all = document.createElement('option'); all.value = ''; all.textContent = '全部工作表（含当前表）'; select.append(all);
    for (const sheet of new Set(fields.filter((f) => f.id !== source.id).map((f) => f.worksheet))) {
      const field = fields.find((f) => f.worksheet === sheet)!; const option = document.createElement('option'); option.value = sheet; option.textContent = `${field.fileId}. ${field.fileName} / ${field.sheet}`; select.append(option);
    }
    this.render(); this.dialog.showModal(); this.get<HTMLInputElement>('pickerSearch').focus();
  }
  close(): void { if (this.dialog.open) this.dialog.close(); this.release(); }
  private release(): void {
    this.sourceId = undefined; this.fields = []; this.domains.clear();
    this.get('pickerSource').textContent = ''; this.get('pickerCandidates').replaceChildren(); this.get<HTMLInputElement>('pickerSearch').value = ''; this.get('pickerSheet').replaceChildren();
  }
  private render(): void {
    const source = this.fields.find((f) => f.id === this.sourceId); if (!source) return;
    const query = this.get<HTMLInputElement>('pickerSearch').value.trim().toLocaleLowerCase(), sheet = this.get<HTMLSelectElement>('pickerSheet').value;
    const candidates = this.fields.filter((f) => f.id !== source.id && (!sheet || f.worksheet === sheet) && (!query || `${f.header} ${f.examples.join(' ')} ${f.fileName}`.toLocaleLowerCase().includes(query)));
    // Rank only visible hints; never infer a semantic link or change the source files.
    const score = (f: RelationField): number => (f.header === source.header ? 100 : 0) + f.examples.filter((value) => source.examples.includes(value)).length * 10;
    candidates.sort((a, b) => score(b) - score(a) || a.fileId.localeCompare(b.fileId, undefined, { numeric: true }) || a.col - b.col);
    const list = this.get('pickerCandidates'); list.replaceChildren();
    this.get('pickerCount').textContent = `${candidates.length} 个候选字段${candidates.length > 100 ? '，显示前 100 个，请输入关键词缩小范围' : ''}`;
    for (const field of candidates.slice(0, 100)) {
      const row = document.createElement('article'); row.className = 'picker-candidate';
      const text = document.createElement('div'), name = document.createElement('strong'), location = document.createElement('p'), examples = document.createElement('p');
      name.textContent = `${field.header || '（无表头）'} · ${field.type}`; location.textContent = `${field.fileId}. ${field.fileName} / ${field.sheet} / ${field.letter}`; examples.textContent = `示例：${field.examples.join(' / ') || '无非空值'}`; text.append(name, location, examples);
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.dataset.pickTarget = field.id;
      let reason: string | undefined;
      try { linkFields(this.fields, source.id, field.id, this.domains); } catch (error) { reason = error instanceof Error ? error.message : '不可关联'; }
      button.textContent = field.domain === source.domain ? '已关联' : reason ? '规则冲突' : '关联此字段'; button.disabled = field.domain === source.domain || Boolean(reason); button.title = reason ?? '关联后原表头不变';
      button.addEventListener('click', () => { const id = this.sourceId; if (!id) return; this.close(); this.connect(id, field.id); });
      row.append(text, button); if (reason) { const note = document.createElement('small'); note.textContent = reason; row.append(note); } list.append(row);
    }
    if (!candidates.length) { const empty = document.createElement('p'); empty.textContent = '未找到匹配字段，请更换关键词或目标工作表。'; list.append(empty); }
  }
}
