(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.IronBendOrderDetailTable=api;
})(typeof window==='undefined'?this:window,function(){
  'use strict';
  const columns=[['line','פריט'],['name','שם פריט'],['shape','צורה'],['diameter','קוטר'],['length','אורך ס״מ'],['quantity','כמות'],['weight','משקל ק״ג'],['production','ייצור'],['status','מצב']];
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const keyValue=(entry,key)=>String(entry.values[key]??'—');
  const originalLabelFonts=new WeakMap();
  function shapeLabelFontSize(viewWidth,viewHeight,width,height,original){
    if(![viewWidth,viewHeight,width,height,original].every(value=>Number.isFinite(value)&&value>0))return null;
    const scale=Math.min(width/viewWidth,height/viewHeight);
    return Math.max(original,11/scale);
  }
  function sizeShapeLabels(root){
    root.querySelectorAll('.detail-line-preview svg').forEach(svg=>{
      const box=svg.viewBox?.baseVal,rect=svg.getBoundingClientRect();
      if(!box||!rect.width||!rect.height)return;
      svg.querySelectorAll('text').forEach(label=>{
        if(!originalLabelFonts.has(label))originalLabelFonts.set(label,parseFloat(root.ownerDocument.defaultView.getComputedStyle(label).fontSize));
        const font=shapeLabelFontSize(box.width,box.height,rect.width,rect.height,originalLabelFonts.get(label));
        if(font)label.style.setProperty('font-size',font+'px','important');
      });
    });
  }
  function project(entries,filters={}){
    return entries.filter(entry=>columns.every(([key])=>!Array.isArray(filters[key])||!filters[key].length||filters[key].includes(keyValue(entry,key))));
  }
  const collator=new Intl.Collator('he',{numeric:true,sensitivity:'base'});
  function sort(entries,state){
    if(!state)return [...entries];
    const key=state.key,direction=state.direction==='desc'?-1:1;
    return entries.map((entry,index)=>({entry,index})).sort((a,b)=>{
      const value=e=>e.sortValues?.[key]??e.values[key];
      const av=value(a.entry),bv=value(b.entry);
      const missing=v=>v==null||v===''||v==='—'||typeof v==='number'&&!Number.isFinite(v);
      if(missing(av)||missing(bv))return Number(missing(av))-Number(missing(bv))||a.index-b.index;
      const compared=typeof av==='number'&&typeof bv==='number'?av-bv:collator.compare(String(av),String(bv));
      return direction*compared||a.index-b.index;
    }).map(row=>row.entry);
  }
  function options(entries,key){return [...new Set(entries.map(e=>keyValue(e,key)))];}
  function render(entries,summary=''){
    const headings=columns.map(([key,label])=>`<th scope="col" data-detail-heading="${key}" aria-sort="none"><div class="detail-column-heading"><button type="button" data-detail-sort="${key}">${label}<span data-sort-indicator aria-hidden="true"></span></button><button type="button" data-detail-filter="${key}" aria-label="סינון לפי ${label}" aria-haspopup="dialog" aria-expanded="false">⌄</button></div></th>`).join('');
    const rows=entries.map(e=>`<tr class="detail-table-row" data-detail-main="${Number(e.id)}" style="--item-production-fill:${Math.max(0,Math.min(100,Number(e.percent)||0))}%">
      <td><button type="button" class="detail-line-toggle" data-detail-toggle="${Number(e.id)}" aria-expanded="false" aria-controls="detail-expanded-${Number(e.id)}" aria-label="פרטי פריט ${escape(e.values.line)}"><span aria-hidden="true">‹</span>${escape(e.values.line)}</button></td>
      <td>${escape(e.values.name)}${e.warning?` <span class="detail-table-warning" title="${escape(e.warning)}" aria-label="${escape(e.warning)}">⚠</span>`:''}</td>
      <td class="detail-line-preview" title="${escape(e.values.shape)}">${e.visualHtml}</td>
      <td class="detail-table-number">${escape(e.values.diameter)}</td><td class="detail-table-number">${escape(e.values.length)}</td>
      <td class="detail-table-number">${escape(e.values.quantity)}</td><td class="detail-table-number">${escape(e.values.weight)}</td>
      <td class="detail-table-number">${escape(e.values.production)}</td><td><span class="detail-table-status ${escape(e.tone)}">${escape(e.values.status)}</span></td>
      </tr><tr class="detail-expanded-row" id="detail-expanded-${Number(e.id)}" data-detail-expanded="${Number(e.id)}" hidden><td colspan="9">${e.cardHtml}</td></tr>`).join('');
    return `<div class="detail-visible-table"><table aria-label="פריטי ההזמנה"><thead><tr>${headings}</tr></thead><tbody>${rows||'<tr><td colspan="9">אין פריטים בהזמנה</td></tr>'}</tbody></table></div><div class="detail-table-footer"><strong>${escape(summary)}</strong><span data-detail-visible-count aria-live="polite"></span><button type="button" class="btn-sm" data-detail-clear-all hidden>נקה סינון</button></div>`;
  }
  let orderId=null,sortState=null,filters={},expanded=null,cleanup=null,menu=null,anchor=null;
  function closeMenu(){if(anchor)anchor.setAttribute('aria-expanded','false');menu?.remove();menu=null;anchor=null;}
  function reset(){cleanup?.();cleanup=null;closeMenu();orderId=null;sortState=null;filters={};expanded=null;}
  function mount(root,entries,id){
    cleanup?.();cleanup=null;closeMenu();
    if(Number(orderId)!==Number(id)){filters={};expanded=null;sortState=null;}
    orderId=Number(id);
    const apply=()=>{
      const visible=project(entries,filters),ids=new Set(visible.map(e=>String(e.id)));
      const mainRows=new Map(Array.from(root.querySelectorAll('[data-detail-main]'),row=>[row.dataset.detailMain,row]));
      const expandedRows=new Map(Array.from(root.querySelectorAll('[data-detail-expanded]'),row=>[row.dataset.detailExpanded,row]));
      sort(entries,sortState).forEach(entry=>{const row=mainRows.get(String(entry.id));if(row){const body=row.parentNode;body.appendChild(row);const detail=expandedRows.get(String(entry.id));if(detail)body.appendChild(detail);}});
      root.querySelectorAll('[data-detail-heading]').forEach(th=>{
        const active=sortState?.key===th.dataset.detailHeading;
        th.setAttribute('aria-sort',active?(sortState.direction==='asc'?'ascending':'descending'):'none');
        th.querySelector('[data-sort-indicator]').textContent=active?(sortState.direction==='asc'?'↑':'↓'):'';
      });
      root.querySelectorAll('[data-detail-main]').forEach(row=>{
        const show=ids.has(row.dataset.detailMain);row.hidden=!show;
        const button=row.querySelector('[data-detail-toggle]');button?.setAttribute('aria-expanded',String(show&&expanded===row.dataset.detailMain));
      });
      root.querySelectorAll('[data-detail-expanded]').forEach(row=>row.hidden=!ids.has(row.dataset.detailExpanded)||expanded!==row.dataset.detailExpanded);
      root.querySelectorAll('[data-detail-filter]').forEach(button=>{
        button.classList.toggle('has-filter',Boolean(filters[button.dataset.detailFilter]?.length));
      });
      const count=root.querySelector('[data-detail-visible-count]');if(count)count.textContent=`${visible.length} מתוך ${entries.length} פריטים`;
      const clear=root.querySelector('[data-detail-clear-all]');if(clear)clear.hidden=!Object.values(filters).some(v=>v.length);
      sizeShapeLabels(root);
    };
    const outside=event=>{if(menu&&!menu.contains(event.target)&&!anchor?.contains(event.target))closeMenu();};
    const keydown=event=>{if(event.key==='Escape'&&menu){event.preventDefault();event.stopPropagation();const button=anchor;closeMenu();button?.focus();}};
    const click=event=>{
      const sortButton=event.target.closest('[data-detail-sort]');
      if(sortButton){const key=sortButton.dataset.detailSort;sortState={key,direction:sortState?.key===key&&sortState.direction==='asc'?'desc':'asc'};closeMenu();apply();return;}
      const head=event.target.closest('[data-detail-filter]');
      if(head){
        if(anchor===head){closeMenu();return;}
        closeMenu();anchor=head;head.setAttribute('aria-expanded','true');
        const key=head.dataset.detailFilter,label=columns.find(c=>c[0]===key)[1];
        menu=root.ownerDocument.createElement('div');menu.className='detail-column-popover';menu.setAttribute('role','dialog');menu.setAttribute('aria-label','סינון לפי '+label);
        menu.innerHTML=`<button type="button" class="detail-filter-clear">הצג הכול</button>`+options(entries,key).map(value=>`<label><input type="checkbox" value="${escape(value)}"${filters[key]?.includes(value)?' checked':''}>${escape(value)}</label>`).join('');
        root.ownerDocument.body.appendChild(menu);
        const rect=head.getBoundingClientRect(),view=root.ownerDocument.defaultView;
        menu.style.left=Math.max(8,Math.min(rect.left,view.innerWidth-228))+'px';
        menu.style.top=Math.max(8,Math.min(rect.bottom+4,view.innerHeight-Math.min(300,menu.scrollHeight)-8))+'px';
        menu.addEventListener('change',()=>{filters[key]=Array.from(menu.querySelectorAll('input:checked')).map(c=>c.value);apply();});
        menu.querySelector('.detail-filter-clear').addEventListener('click',()=>{delete filters[key];menu.querySelectorAll('input').forEach(c=>c.checked=false);apply();});
        menu.querySelector('button').focus();return;
      }
      if(event.target.closest('[data-detail-clear-all]')){filters={};closeMenu();apply();return;}
      const row=event.target.closest('[data-detail-main]');
      if(!row||event.target.closest('a,input,select,textarea')||event.target.closest('button:not([data-detail-toggle])'))return;
      closeMenu();expanded=expanded===row.dataset.detailMain?null:row.dataset.detailMain;apply();
    };
    root.addEventListener('click',click);root.ownerDocument.addEventListener('click',outside);root.ownerDocument.addEventListener('keydown',keydown,true);
    const view=root.ownerDocument.defaultView,resize=()=>{closeMenu();sizeShapeLabels(root);};view.addEventListener('resize',resize);
    cleanup=()=>{root.removeEventListener('click',click);root.ownerDocument.removeEventListener('click',outside);root.ownerDocument.removeEventListener('keydown',keydown,true);view.removeEventListener('resize',resize);};
    apply();
  }
  return {columns,escape,project,sort,options,render,mount,reset,shapeLabelFontSize};
});
