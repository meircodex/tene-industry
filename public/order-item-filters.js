(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.IronBendOrderItemFilters = api;
})(typeof window === 'undefined' ? this : window, function() {
  const completed = new Set(['הושלם', 'הועמס', 'נשלח', 'סופק']);
  const cancelled = item => Boolean(item.cancelled_at) || ['בוטל', 'בוטלה'].includes(item.status);
  const diameterKey = item => Number(item.diameter) > 0 ? String(Number(item.diameter)) : 'unknown';
  let activeOrderId = null;
  let selection = { diameter: '', status: '' };

  function project(items, filters = {}) {
    const diameterItems = items.filter(item => !filters.diameter || diameterKey(item) === filters.diameter);
    const active = diameterItems.filter(item => !cancelled(item));
    const done = active.filter(item => completed.has(item.status)).length;
    const visible = diameterItems.filter(item => {
      if (filters.status === '__done') return !cancelled(item) && completed.has(item.status);
      if (filters.status === '__remaining') return !cancelled(item) && !completed.has(item.status);
      return !filters.status || item.status === filters.status;
    });
    return { visible, total: active.length, done, remaining: active.length - done,
      cancelled: diameterItems.length - active.length };
  }

  function reset() {
    activeOrderId = null;
    selection = { diameter: '', status: '' };
  }

  function mount(root, order) {
    const statusSelect = root.querySelector('#detailItemStatusFilter');
    const diameterSelect = root.querySelector('#detailItemDiameterFilter');
    if (!statusSelect || !diameterSelect) return;
    if (activeOrderId !== order.id) reset();
    activeOrderId = order.id;
    const items = (order.pallets || []).flatMap(pallet => pallet.items || []);
    const addOption = (select, value, label) => {
      const option = root.ownerDocument.createElement('option');
      option.value = value; option.textContent = label; select.appendChild(option);
    };
    statusSelect.replaceChildren(); diameterSelect.replaceChildren();
    addOption(statusSelect, '', 'כל הפריטים');
    addOption(statusSelect, '__remaining', 'טרם הושלם הייצור');
    addOption(statusSelect, '__done', 'הייצור הושלם');
    for (const status of new Set(items.map(item => item.status).filter(Boolean))) addOption(statusSelect, status, status);
    addOption(diameterSelect, '', 'כל הקטרים');
    const diameters = [...new Set(items.map(diameterKey))].sort((a, b) => a === 'unknown' ? 1 : b === 'unknown' ? -1 : Number(a) - Number(b));
    for (const diameter of diameters) addOption(diameterSelect, diameter, diameter === 'unknown' ? 'ללא קוטר' : `Ø${diameter} מ״מ`);
    statusSelect.value = selection.status; diameterSelect.value = selection.diameter;
    if (statusSelect.selectedIndex < 0) statusSelect.value = '';
    if (diameterSelect.selectedIndex < 0) diameterSelect.value = '';
    const update = () => {
      selection = { status: statusSelect.value, diameter: diameterSelect.value };
      const result = project(items, selection);
      const ids = new Set(result.visible.map(item => String(item.id)));
      root.querySelectorAll('[data-order-pallet]').forEach(pallet => {
        let shown = 0;
        pallet.querySelectorAll('.item-row[data-print-card-item-id]').forEach(row => {
          row.hidden = !ids.has(row.dataset.printCardItemId);
          if (!row.hidden) shown++;
        });
        pallet.hidden = shown === 0;
      });
      const scope = selection.diameter ? selection.diameter === 'unknown' ? 'ללא קוטר' : `קוטר ${selection.diameter}` : 'כל הקטרים';
      root.querySelector('#detailItemProductionSummary').textContent = `${scope} · סה״כ פריטים: ${result.total} · הושלמו: ${result.done} · נותרו לייצור: ${result.remaining}${result.cancelled ? ` · בוטלו: ${result.cancelled}` : ''}`;
      root.querySelector('#detailItemFilterCount').textContent = `מוצגים ${result.visible.length} מתוך ${items.length} פריטים בהזמנה`;
      root.querySelector('#detailItemFilterEmpty').hidden = result.visible.length > 0;
      root.querySelector('#detailItemFilterReset').disabled = !selection.status && !selection.diameter;
    };
    statusSelect.addEventListener('change', update);
    diameterSelect.addEventListener('change', update);
    root.querySelector('#detailItemFilterReset').addEventListener('click', () => {
      statusSelect.value = ''; diameterSelect.value = ''; update();
    });
    update();
  }
  return { project, mount, reset };
});
