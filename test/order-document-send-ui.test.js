'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('one order document toolbar replaces nested language/send dialogs',()=>{
 const orders=read('public/orders.html'),loader=read('public/order-print.html');
 const prints=orders.match(/const prints = (`[\s\S]*?`);/)[1];
 assert.equal((prints.match(/data-document-language/g)||[]).length,1);
 for(const action of ['print','download','send'])assert.match(prints,new RegExp('data-document-action="'+action+'"'));
 assert.doesNotMatch(orders,/function openA4PrintDialog|chooseA4DocumentLanguage|id="sendFileOverlay"|function openSendFile/);
 assert.match(loader,/workspace_embed/);assert.match(loader,/ironbend-order-document-ready/);
 assert.match(read('public/orders-document-view.js'),/target.click\(\)/);
});
test('embedded card view retains real sheet selection and original print/export handlers',()=>{
 const cards=read('services/productionCards.js'),page=read('services/productionCardPrintPage.js');
 assert.match(cards,/class="pc-pick"/);assert.match(cards,/data-picked="1"/);
 assert.match(page,/function togglePickedCard\(/);assert.match(page,/function refreshPickedCards\(/);
 assert.match(page,/\.prod-card\[data-picked="0"\]\{display:none!important;\}/);
 assert.match(page,/IronBendDocExport.download/);assert.match(page,/IronBendDocExport.send/);
});

test('production card description wraps within the enlarged-shape layout', () => {
  const printPage = read('services/productionCardPrintPage.js');

  assert.match(read('public/production-card-face.js'), /class="pc-print-customer"/);
  assert.match(printPage, /IronBendProductionCardFace\.render/);
  assert.match(printPage, /\.pc-print-customer\{[^}]*font-size:11\.5px[^}]*font-weight:900/);
  assert.match(printPage, /\.pc-print-ref\{[^}]*min-height:9mm[^}]*font-size:11px[^}]*white-space:normal[^}]*overflow:visible[^}]*overflow-wrap:anywhere/);
  assert.doesNotMatch(printPage, /\.pc-print-ref\{[^}]*text-overflow:ellipsis/);
  assert.match(printPage, /grid-template-rows:8mm 9mm minmax\(0,1fr\) 8mm/);
});
