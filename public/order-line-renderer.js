'use strict';

// Canonical order-line DOM shared by the factory and customer editors. Each
// caller supplies already-formatted values and its existing callback strings.
(function (root) {
  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[ch]));
  }
  function render(options) {
    const o = options || {};
    const hasShape = Boolean(o.hasShape);
    const classes = `order-line-row${hasShape ? '' : ' no-shape-yet'}${o.isPileCage ? ' line-round-pile-cage' : ''}`;
    const shapeTag = o.isPileCage ? ' data-shape-kind="round_pile_cage"' : '';
    const emptyDash = '<span class="line-val-empty">—</span>';
    const lengthCell = hasShape && o.unitLengthCm > 0 ? `<b>${esc(Number(o.unitLengthCm).toLocaleString('he-IL'))}</b>` : emptyDash;
    const totalLengthCell = hasShape ? esc(o.totalLength) : emptyDash;
    const weightCell = hasShape ? esc(o.weight) : emptyDash;
    return `<article class="${classes}" id="item-row-${esc(o.id)}" data-item-id="${esc(o.id)}"${shapeTag}>
      <div class="line-index">${esc(o.lineLabel)}</div>
      <input class="line-element" type="text" value="${esc(o.elementName)}" placeholder="קורה / קומה / ציר" aria-label="אלמנט" onchange="${o.updateElementCall}">
      <button type="button" class="line-shape" onclick="${o.openCall}" title="פתח עורך צורה"><span class="line-shape-sketch">${o.shapeSketch || ''}</span>${o.isPileCage ? '<span class="line-pile-cage-tag">PILE CAGE</span>' : ''}</button>
      <select class="line-diameter-select" onchange="${o.updateDiamCall}" aria-label="קוטר"><option value="" disabled>Ø</option>${o.diameterOptions || ''}</select>
      <input class="line-qty" type="number" min="1" step="1" value="${esc(o.qty)}" inputmode="numeric" aria-label="כמות" onfocus="this.select()" oninput="this.value=this.value.replace(/[^0-9]/g,'')" onchange="${o.updateQtyCall}" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur()}" >
      <div class="line-length desktop-only-cell">${lengthCell}</div><div class="line-total-length desktop-only-cell">${totalLengthCell}</div><div class="line-weight">${weightCell}</div>
      <button type="button" class="line-delete" onclick="${o.deleteCall}" title="מחק פריט" aria-label="מחק פריט">&times;</button>
      <div class="line-mobile-meta"><span>${o.isPileCage ? 'PILE CAGE' : esc(o.elementName || 'ללא אלמנט')}</span><span>Ø${esc(Number(o.diameter).toLocaleString('he-IL', { maximumFractionDigits: 1 }))}</span><span>${hasShape ? esc(o.totalLength) : '—'}</span><span>${hasShape ? esc(o.weight) : '—'}</span></div>
    </article>`;
  }
  root.IronBendOrderLineRenderer = { render };
})(typeof window === 'undefined' ? globalThis : window);
