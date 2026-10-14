'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../public/orders.html'), 'utf8');
const start = html.indexOf('function issuedDeliveryDocumentsHtml(');
const end = html.indexOf('function buildDetailHTML(', start);
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const context = vm.createContext({escHtml: escape});
vm.runInContext(html.slice(start, end), context);

test('saved certificate links use note_id only, never create or select a new shipment', () => {
  const order = {id:94};
  const progress = {certificates:[{id:7,note_num:'CERT-long-uuid',issued_at:'2026-10-14 17:22:00'},{id:8,note_num:'DN-8',issued_at:'2026-10-13'},{id:'not-an-id'}]};
  const before = JSON.stringify({order,progress});
  const output = context.issuedDeliveryDocumentsHtml(order,progress);
  assert.match(output,/תעודה 7 · 14\.10\.2026/);
  assert.match(output,/DN-8 · 13\.10\.2026/);
  assert.doesNotMatch(output,/CERT-long-uuid|not-an-id|certificate_mode|issue_key|item_status|onclick/);
  const links = [...output.matchAll(/href="([^"]+)"/g)].map(match => new URL(match[1],'https://example.invalid'));
  assert.equal(links.length,2);
  for (const url of links) {
    assert.equal(url.pathname,'/order-print.html');
    assert.equal(url.searchParams.get('id'),'94');
    assert.equal(url.searchParams.get('kind'),'delivery-certificate');
    assert.ok(['7','8'].includes(url.searchParams.get('note_id')));
  }
  assert.equal(JSON.stringify({order,progress}),before);
});

test('missing historical originals are explicit, not fabricated from current statuses', () => {
  assert.match(context.issuedDeliveryDocumentsHtml({id:94},{certificates:[]}),/טרם נשמרו תעודות מקור/);
  const output = context.issuedDeliveryDocumentsHtml({id:94},{certificates:[],shipped_unit_count:5,history_needs_review:true});
  assert.match(output,/אין לשחזר תעודה מהסטטוס בלבד/);
  assert.match(output,/הפקת מקור חסומה/);
  assert.doesNotMatch(output,/href=/);
});

test('untrusted document and order labels are escaped', () => {
  assert.doesNotMatch(context.issuedDeliveryDocumentsHtml({id:94},{certificates:[{id:8,note_num:'<img onerror="evil">',issued_at:'<script>'}]}),/<img|<script>/);
  const output = context.orderHeroInfoHtml({channel:'טלפון',delivery_address:'<script>bad</script>',struct_element:'קורה',struct_floor:'1',sheet_num:'2'},'הערת נהג');
  assert.match(output,/קורה/);
  assert.match(output,/הערת נהג/);
  assert.match(output,/&lt;script&gt;/);
  assert.doesNotMatch(output,/<script>/);
});

test('issued history occupies sixth print-grid cell and order information is inside top hero', () => {
  const body = html.slice(end);
  const prints = body.match(/const prints = (`[\s\S]*?`);/)[1];
  assert.equal((prints.match(/class="print-action-pair"/g)||[]).length,5);
  assert.match(prints,/issuedDeliveryDocumentsHtml\(o, deliveryProgress\)/);
  assert.match(prints,/📄 גיליון הזמנה/);
  assert.doesNotMatch(prints,/הדפסת A4/);
  assert.ok(body.indexOf('orderHeroInfoHtml(o, driverNotes)') < body.indexOf('const prints'));
  assert.doesNotMatch(body,/hero \+ prints \+ info/);
  // All inline scripts must still parse after editing nested template literals.
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
