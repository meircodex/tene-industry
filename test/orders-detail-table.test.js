'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const table=require('../public/orders-detail-table');
const entries=[
  {id:1,values:{line:'1',name:'קורה',shape:'חישוק',diameter:'Ø8',length:'175 ס״מ',quantity:'27',weight:'19',production:'27/27',status:'הושלם'},percent:100,tone:'is-done',visualHtml:'<svg></svg>',cardHtml:'<div id="order-item-1"></div>'},
  {id:2,values:{line:'2',name:'עמוד',shape:'חישוק',diameter:'Ø12',length:'320 ס״מ',quantity:'50',weight:'144',production:'0/50',status:'ממתין'},percent:0,tone:'is-wait',visualHtml:'<svg></svg>',cardHtml:'<div id="order-item-2"></div>'},
  {id:3,values:{line:'3',name:'קורה',shape:'מוט ישר',diameter:'Ø12',length:'600 ס״מ',quantity:'50',weight:'267',production:'20/50',status:'בייצור'},percent:40,tone:'is-prod',visualHtml:'<svg></svg>',cardHtml:'<div id="order-item-3"></div>'},
];
test('column selection combines alternatives within a column and intersects all columns without changing production facts',()=>{
 const before=JSON.stringify(entries);
 assert.deepEqual(table.project(entries,{diameter:['Ø8','Ø12'],name:['קורה']}).map(e=>e.id),[1,3]);
 assert.deepEqual(table.project(entries,{diameter:['Ø12'],status:['ממתין','בייצור'],shape:['חישוק']}).map(e=>e.id),[2]);
 for(const [key]of table.columns)assert.deepEqual(table.project(entries,{[key]:[entries[1].values[key]]}).map(e=>e.id),entries.filter(e=>e.values[key]===entries[1].values[key]).map(e=>e.id));
 assert.equal(table.project(entries,{diameter:[]}).length,3);assert.deepEqual(table.project(entries,{diameter:['Ø40']}),[]);
 assert.equal(JSON.stringify(entries),before);
});
test('all headers filter; rows and canonical drawings are immediately visible, expanded editors retain their unique identity',()=>{
 const html=table.render(entries,'3 פריטים · 430 ק״ג');
 assert.equal((html.match(/data-detail-filter=/g)||[]).length,9);
 assert.equal((html.match(/data-detail-main=/g)||[]).length,3);
 assert.equal((html.match(/data-detail-expanded="\d+" hidden/g)||[]).length,3);
 assert.equal((html.match(/<svg>/g)||[]).length,3);
 assert.equal((html.match(/id="order-item-2"/g)||[]).length,1);
 assert.match(html,/20\/50/);assert.match(html,/3 פריטים · 430 ק״ג/);
 assert.deepEqual(table.options(entries,'diameter'),['Ø8','Ø12']);
});
test('untrusted names, source numbers, statuses and warnings remain text in headings, cells and attributes',()=>{
 const item={...entries[0],warning:'"><img src=x onerror=evil()>',values:{...entries[0].values,line:'<script>evil()</script>',name:'<img src=x onerror=evil()>',status:'" onmouseover="evil()'}};
 const html=table.render([item],'<script>summary</script>');
 assert.doesNotMatch(html,/<script|<img|title=""/);assert.match(html,/&lt;img/);assert.match(html,/&lt;script/);
});

test('dimension labels reach 11 screen pixels at the thumbnail scale without shrinking larger labels',()=>{
 const font=table.shapeLabelFontSize(600,240,136,48,18);
 assert.equal(font,55);assert.equal(font*Math.min(136/600,48/240),11);
 assert.equal(table.shapeLabelFontSize(600,240,136,48,72),72);
 assert.equal(table.shapeLabelFontSize(600,240,0,48,18),null);
 assert.equal(table.shapeLabelFontSize(0,240,136,48,18),null);
});
test('original order sections and safe undo remain, with only the approved item table replacing the old item cards list',()=>{
 const html=require('node:fs').readFileSync(require('node:path').join(__dirname,'../public/orders.html'),'utf8');
 assert.match(html,/return hero \+ prints \+ commercialSummaryHtml\(o\) \+ orderActions \+ itemsSec \+ pkgSec/);
 assert.match(html,/id="detailStatusUndo"/);assert.match(html,/async function undoOrderStatus/);
 assert.doesNotMatch(html,/orders-document-view|detailToolsDialog|order-detail-fold|order-document-toolbar/);
 assert.match(html,/IronBendOrderDetailTable.mount/);
});
