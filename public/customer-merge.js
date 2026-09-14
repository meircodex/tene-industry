'use strict';

let customerMergeState = null;
let customerMergeGeneration = 0;
const mergeElement = id => document.getElementById(id);
const mergeEscape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const mergeTaxId = value => String(value || '').replace(/[ \t\r\n\u00a0\u200e\u200f-]/g, '');

function mergeStatus(text, error = false) {
  const node = mergeElement('customerMergeStatus');
  node.textContent = text;
  node.style.color = error ? 'var(--danger)' : 'var(--text)';
}

function invalidateCustomerMergePreview() {
  if (!customerMergeState || customerMergeState.busy) return;
  customerMergeState.revision++;
  customerMergeState.preview = null;
  mergeElement('customerMergePreview').innerHTML = '';
  mergeElement('customerMergeApproval').hidden = true;
  mergeElement('customerMergeAcknowledge').checked = false;
  mergeElement('customerMergeConfirmTaxId').value = '';
  mergeElement('customerMergeConfirm').disabled = true;
  mergeElement('customerMergePreviewBtn').disabled = !customerMergeState.sourceId;
}

function invalidateCustomerMergeSelection() {
  if (!customerMergeState || customerMergeState.busy) return;
  customerMergeState.sourceId = null;
  mergeElement('customerMergeResults').innerHTML = '';
  invalidateCustomerMergePreview();
}

async function openCustomerMerge(targetId, sourceId = null, taxId = '') {
  if (!isSystemAdmin() || customerMergeState?.busy) return;
  const generation = ++customerMergeGeneration;
  customerMergeState = { targetId: Number(targetId), sourceId: sourceId ? Number(sourceId) : null, revision: 0, busy: false, preview: null };
  const dialog = mergeElement('customerMergeDialog');
  if (!dialog.open) dialog.showModal();
  mergeElement('customerMergeTarget').textContent = 'טוען את הכרטיס הראשי...';
  mergeElement('customerMergeResults').innerHTML = '';
  invalidateCustomerMergePreview();
  mergeStatus('');
  try {
    const response = await fetch('/api/customers/' + Number(targetId));
    const customer = await response.json();
    if (generation !== customerMergeGeneration) return;
    if (!response.ok) throw new Error(customer.error || 'לא ניתן לטעון את הכרטיס');
    customerMergeState.targetId = Number(customer.id);
    customerMergeState.target = customer;
    mergeElement('customerMergeTarget').innerHTML = '<strong>הכרטיס שיישאר: ' + mergeEscape(customer.name) + ' · #' + Number(customer.id) + '</strong><div>ח.פ: ' + mergeEscape(customer.tax_id || 'חסר') + '</div>';
    mergeElement('customerMergeTaxId').value = taxId || customer.tax_id || '';
    mergeElement('customerMergeSearch').value = customer.name || '';
    if (customerMergeState.sourceId) await previewCustomerMerge();
    else await searchCustomerMerge();
  } catch (error) { if (generation === customerMergeGeneration) mergeStatus(error.message || 'שגיאה בטעינה', true); }
}

function closeCustomerMerge() {
  if (customerMergeState?.busy) return;
  customerMergeGeneration++;
  customerMergeState = null;
  mergeElement('customerMergeDialog').close();
}

async function searchCustomerMerge() {
  if (!customerMergeState || customerMergeState.busy) return;
  invalidateCustomerMergeSelection();
  const state = customerMergeState, revision = state.revision;
  const query = mergeElement('customerMergeSearch').value.trim();
  if (!query) { mergeStatus('יש להזין ח.פ, שם או מספר לקוח לחיפוש.'); return; }
  mergeStatus('מחפש כרטיסים...');
  try {
    const response = await fetch('/api/customers?q=' + encodeURIComponent(query) + '&limit=20');
    const rows = await response.json();
    if (customerMergeState !== state || state.revision !== revision) return;
    if (!response.ok || !Array.isArray(rows)) throw new Error(rows.error || 'חיפוש הלקוחות נכשל');
    const candidates = rows.filter(row => Number(row.id) !== state.targetId);
    mergeElement('customerMergeResults').innerHTML = candidates.map(row => '<button type="button" class="btn-action" onclick="selectCustomerMergeSource(' + Number(row.id) + ')">' + mergeEscape(row.name) + ' · #' + Number(row.id) + ' · ' + mergeEscape(row.tax_id ? 'ח.פ ' + row.tax_id : 'ח.פ חסר') + '</button>').join('');
    mergeStatus(candidates.length ? 'בחר את הכרטיס שיעבור לארכיון לאחר העברת הנתונים.' : 'לא נמצאו כרטיסים נוספים. אפשר לחפש לפי שם אחר, טלפון או מספר לקוח.');
  } catch (error) { if (customerMergeState === state && state.revision === revision) mergeStatus(error.message, true); }
}

function selectCustomerMergeSource(id) {
  if (!customerMergeState || customerMergeState.busy) return;
  customerMergeState.sourceId = Number(id);
  invalidateCustomerMergePreview();
  return previewCustomerMerge();
}

async function previewCustomerMerge() {
  if (!customerMergeState?.sourceId || customerMergeState.busy) return;
  invalidateCustomerMergePreview();
  const state = customerMergeState, revision = state.revision;
  mergeStatus('בודק נתונים וקשרים לפני האיחוד...');
  try {
    const response = await fetch('/api/customers/merge/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId: state.targetId, sourceId: state.sourceId, taxId: mergeElement('customerMergeTaxId').value }) });
    const data = await response.json();
    if (customerMergeState !== state || state.revision !== revision) return;
    if (!response.ok) throw new Error(data.error || 'לא ניתן להכין איחוד');
    state.preview = data;
    mergeElement('customerMergePreview').innerHTML =
      '<h4>לאחד את ' + mergeEscape(data.source.name) + ' (#' + Number(data.source.id) + ') לתוך ' + mergeEscape(data.target.name) + ' (#' + Number(data.target.id) + ')?</h4>' +
      '<p>הח.פ המאוחד: <b dir="ltr">' + mergeEscape(data.taxId) + '</b></p>' +
      '<button type="button" class="btn-action" onclick="swapCustomerMergeTarget()">החלף את הכרטיס שיישאר</button>' +
      '<p>האיחוד מתייחס לנתונים השמורים. שינויים שלא נשמרו בחלון העריכה לא יוחלו.</p>' +
      (data.counts.length ? '<table style="width:100%;text-align:right;margin:12px 0"><thead><tr><th>נתונים</th><th>בכרטיס הישן</th><th>בכרטיס הראשי</th></tr></thead><tbody>' + data.counts.map(row => '<tr><td>' + mergeEscape(row.label) + '</td><td>' + Number(row.source) + '</td><td>' + Number(row.target) + '</td></tr>').join('') + '</tbody></table>' : '<p>אין נתונים מקושרים להעברה בכרטיס הישן.</p>') +
      '<p><strong>משתמשי פורטל פעילים שיושהו לבדיקה: ' + Number(data.activePortalUsersToSuspend) + '</strong></p>' +
      '<ul>' + data.warnings.map(text => '<li>' + mergeEscape(text) + '</li>').join('') + '</ul>' +
      (data.blockers.length ? '<div style="color:var(--danger)"><strong>האיחוד חסום עד להסדרת הנושאים הבאים:</strong><ul>' + data.blockers.map(text => '<li>' + mergeEscape(text) + '</li>').join('') + '</ul></div>' : '');
    mergeElement('customerMergeApproval').hidden = !data.canMerge;
    mergeStatus(data.canMerge ? 'עדיין לא שונו נתונים. לאיחוד יש לסמן אישור ולהקליד את הח.פ.' : 'לא בוצע שינוי. לאחר הסדרת הסתירות ניתן לטעון תצוגה מקדימה חדשה.', !data.canMerge);
    updateCustomerMergeConfirmation();
  } catch (error) { if (customerMergeState === state && state.revision === revision) mergeStatus(error.message || 'שגיאה בבדיקה', true); }
}

function swapCustomerMergeTarget() {
  if (!customerMergeState?.preview || customerMergeState.busy) return;
  const { source, target, taxId } = customerMergeState.preview;
  return openCustomerMerge(source.id, target.id, taxId);
}

function updateCustomerMergeConfirmation() {
  const state = customerMergeState;
  mergeElement('customerMergeConfirm').disabled = !state?.preview?.canMerge || !state.preview.token || state.busy || !mergeElement('customerMergeAcknowledge').checked || mergeTaxId(mergeElement('customerMergeConfirmTaxId').value) !== state.preview.taxId;
}

async function confirmCustomerMerge() {
  updateCustomerMergeConfirmation();
  if (mergeElement('customerMergeConfirm').disabled) return;
  const state = customerMergeState;
  state.busy = true;
  const controls = Array.from(mergeElement('customerMergeDialog').querySelectorAll('button,input'));
  controls.forEach(node => { node.disabled = true; });
  mergeStatus('מכין גיבוי ומבצע איחוד. נא לא לסגור את החלון...');
  let succeeded = false;
  try {
    const response = await fetch('/api/customers/merge/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: state.preview.token, acknowledge: true, confirmTaxId: mergeElement('customerMergeConfirmTaxId').value }) });
    const data = await response.json();
    if (!response.ok) throw Object.assign(new Error(data.error || 'האיחוד לא הושלם'), { code: data.code });
    succeeded = true;
    state.busy = false;
    closeCustomerMerge();
    closeModal();
    window.showToast?.('האיחוד הושלם. הכרטיס הישן נשמר בארכיון ונוצר גיבוי.');
    mergeElement('searchInput').value = data.taxId;
    await loadList(data.taxId);
    await selectCustomer(Number(data.targetId));
  } catch (error) {
    if (succeeded) { window.showToast?.('האיחוד הושלם. יש לרענן את רשימת הלקוחות.', true); return; }
    mergeStatus(error.message || 'שגיאת חיבור. יש לרענן ולבדוק את הכרטיס הראשי לפני פעולה נוספת.', true);
    // Keep the signed request for network retries; the server makes it idempotent.
    if (['stale_merge_preview', 'invalid_merge_preview'].includes(error.code)) state.preview = null;
  } finally {
    state.busy = false;
    controls.forEach(node => { node.disabled = false; });
    updateCustomerMergeConfirmation();
    if (!customerMergeState) mergeElement('customerMergeConfirm').disabled = true;
  }
}

mergeElement('customerMergeDialog').addEventListener('cancel', event => {
  if (customerMergeState?.busy) event.preventDefault();
  else { customerMergeGeneration++; customerMergeState = null; }
});
