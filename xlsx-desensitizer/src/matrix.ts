import type { RelationField } from './relations';
import type { BoardColumn } from './board';
interface Actions { add: (domain?: string, sheet?: string) => void; move: (ids: string[], domain: string) => void; detach: (ids: string[]) => void; strategy: (id: string, mode: 'mask'|'keep'|'date') => void; }
export class MappingMatrix {
  private selected = new Set<string>();
  private expanded = new Set<string>();
  constructor(private root: HTMLElement, private actions: Actions) {}
  setBusy(busy: boolean): void { this.root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(e=>{e.disabled=busy||e.dataset.matrixFixed==='true';}); }
  resetSelection(): void { this.selected.clear(); }
  reset(): void { this.selected.clear(); this.expanded.clear(); this.root.replaceChildren(); }
  render(all: RelationField[], columns: BoardColumn[], busy: boolean, query: string): void {
    const processing = busy; busy = false;
    this.selected = new Set([...this.selected].filter((id) => all.some((f) => f.id === id)));
    this.root.replaceChildren();
    const groups = new Map<string,RelationField[]>(); for (const f of all) { const list = groups.get(f.domain) ?? []; list.push(f); groups.set(f.domain,list); }
    const shared = [...groups].filter(([,members])=>members.filter(f=>f.mode==='mask').length>1).map(([domain])=>domain);
    const toolbar = document.createElement('div'); toolbar.className = 'matrix-actions';
    const button = (label: string, handler: ()=>void, disabled = busy): HTMLButtonElement => { const b=document.createElement('button'); b.type='button'; b.className='secondary'; b.textContent=label;b.disabled=disabled;b.addEventListener('click',handler);return b; };
    toolbar.append(button('＋ 新建映射组',()=>this.actions.add()));
    const view=document.createElement('select'); view.setAttribute('aria-label','矩阵字段范围');
    const prior=this.root.dataset.scope ?? 'shared';
    for(const [value,label] of [['shared','共用映射组'],['independent','独立文本字段'],['kept','日期 / 数值 / 保留列'],['all','全部字段']]){const o=document.createElement('option');o.value=value!;o.textContent=label!;view.append(o);}view.value=prior;view.disabled=busy;
    view.addEventListener('change',()=>{this.root.dataset.scope=view.value;this.render(all,columns,busy,query);});toolbar.append(view);
    const count=document.createElement('span');count.textContent=`已选 ${this.selected.size} 个字段`;toolbar.append(count);
    const target=document.createElement('select');target.setAttribute('aria-label','批量移入映射组');const blank=document.createElement('option');blank.value='';blank.textContent='选择目标映射组';target.append(blank);
    for(const [domain,members] of groups)if(members.some(f=>f.mode==='mask')){const o=document.createElement('option');o.value=domain;o.textContent=domain.replace(/^(字段:|组:)/,'');target.append(o);}target.disabled=busy;toolbar.append(target);
    toolbar.append(button('移入所选组',()=>{if(target.value)this.actions.move([...this.selected],target.value);},busy||!this.selected.size));
    toolbar.append(button('改为独立映射',()=>this.actions.detach([...this.selected]),busy||!this.selected.size));
    toolbar.append(button('展开全部详情',()=>{for(const d of groups.keys())this.expanded.add(d);this.render(all,columns,busy,query);}));
    toolbar.append(button('折叠全部详情',()=>{this.expanded.clear();this.render(all,columns,busy,query);}));this.root.append(toolbar);
    const wrap=document.createElement('div');wrap.className='matrix-scroll';const table=document.createElement('table');table.className='mapping-matrix';const head=document.createElement('thead'),tr=document.createElement('tr');
    const title=document.createElement('th');title.textContent='映射组 / 处理范围';tr.append(title);
    for(const c of columns){const th=document.createElement('th');th.textContent=`${c.fileId}. ${c.fileName}\n${c.sheet}`;th.title=c.error??'';tr.append(th);}head.append(tr);table.append(head);const body=document.createElement('tbody');
    const terms=query.trim().toLocaleLowerCase().split(/[|｜]/).map(s=>s.trim()).filter(Boolean);let visible=0;
    for(const [domain,members] of groups){const isShared=shared.includes(domain),masked=members.some(f=>f.mode==='mask');if(prior==='shared'&&!isShared||prior==='independent'&&(!masked||isShared)||prior==='kept'&&masked)continue;
      if(terms.length&&!members.some(f=>terms.some(t=>`${f.header} ${domain}`.toLocaleLowerCase().includes(t))))continue;
      visible++;const row=document.createElement('tr');row.dataset.matrixGroup=domain;
      const group=document.createElement('th');group.scope='row';const name=document.createElement('strong');name.textContent=`${isShared?'G'+(shared.indexOf(domain)+1):masked?'独立':'保留'} · ${domain.replace(/^(字段:|组:)/,'')}`;group.append(name);
      const summary=document.createElement('p');summary.textContent=`${members.length} 个字段 · ${new Set(members.map(f=>f.worksheet)).size} 张表`;group.append(summary);
      const eligible=members.filter(f=>f.mode==='mask'&&!f.person&&!f.store);
      if(eligible.length){const label=document.createElement('label'),selectAll=document.createElement('input');selectAll.type='checkbox';selectAll.checked=eligible.every(f=>this.selected.has(f.id));selectAll.indeterminate=!selectAll.checked&&eligible.some(f=>this.selected.has(f.id));selectAll.addEventListener('change',()=>{for(const f of eligible){if(selectAll.checked)this.selected.add(f.id);else this.selected.delete(f.id);}this.render(all,columns,busy,query);});label.append(selectAll,document.createTextNode('选择本组'));label.className='matrix-select-group';group.append(label);}
      group.append(button('添加字段',()=>this.actions.add(domain),busy||!masked));group.append(button(this.expanded.has(domain)?'收起详情':'展开详情',()=>{if(this.expanded.has(domain))this.expanded.delete(domain);else this.expanded.add(domain);this.render(all,columns,busy,query);}));row.append(group);
      for(const c of columns){const cell=document.createElement('td');cell.dataset.matrixSheet=c.worksheet;const fields=members.filter(f=>f.worksheet===c.worksheet);
        if(c.error){const error=document.createElement('p');error.className='file-error';error.textContent=c.error;cell.append(error);}
        else if(!fields.length){const empty=document.createElement('span');empty.className='matrix-empty';empty.textContent='—';cell.append(empty);}
        for(const f of fields){const chip=document.createElement('div');chip.className='matrix-field';chip.dataset.matrixField=f.id;const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=this.selected.has(f.id);check.disabled=busy||f.person||f.store||f.mode!=='mask';check.dataset.matrixSelect=f.id;
          check.addEventListener('change',()=>{if(check.checked)this.selected.add(f.id);else this.selected.delete(f.id);this.render(all,columns,busy,query);});const caption=document.createElement('span');caption.textContent=`${f.header||'无表头'} · ${f.letter}`;label.append(check,caption);chip.append(label);
          if(this.expanded.has(domain)){const details=document.createElement('p');details.textContent=`${f.type} · ${f.nonEmpty} 非空 · ${f.fakeBlanks} 假空白${f.uncertainDates?` · ${f.uncertainDates} 待检查日期`:''}\n示例：${f.examples.join(' / ')}`;chip.append(details);
            const strategy=document.createElement('select');strategy.setAttribute('aria-label',`${f.fileName} ${f.header} 处理策略`);for(const [v,l]of[['mask','脱敏文本'],['keep','保留内容'],['date','日期清洗']]){const o=document.createElement('option');o.value=v!;o.textContent=l!;strategy.append(o);}strategy.value=f.mode;strategy.disabled=busy||f.kind!=='text'||f.type==='日期'||['布尔','空列'].includes(f.type);strategy.addEventListener('change',()=>this.actions.strategy(f.id,strategy.value as 'mask'|'keep'|'date'));chip.append(strategy);
          }cell.append(chip);
        }
        if(!c.error&&masked)cell.append(button('＋ 添加',()=>this.actions.add(domain,c.worksheet)));row.append(cell);
      }body.append(row);
    }
    table.append(body);wrap.append(table);this.root.append(wrap);if(!visible){const p=document.createElement('p');p.className='matrix-empty-state';p.textContent='当前没有匹配的字段。可以切换范围或新建映射组；未展示字段仍会按原配置处理。';this.root.append(p);}
    this.root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,button').forEach(e=>{ e.dataset.matrixFixed=String(e.disabled); }); this.setBusy(processing);
  }
}
