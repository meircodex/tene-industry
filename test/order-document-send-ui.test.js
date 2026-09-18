'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('each order document has a neighbouring PDF send action with email and WhatsApp handoff', () => {
  const orders = read('public/orders.html');
  const printLoader = read('public/order-print.html');
  const route = read('routes/orders.js');

  for (const documentKey of ['print-cards', 'delivery-certificate']) {
    assert.match(orders, new RegExp(`openSendFile\\(event,\\$\\{o\\.id\\},'${documentKey}'\\)`));
  }
  assert.match(orders, /openA4PrintDialog\(\$\{o\.id\},'send'\)/);
  assert.match(orders, /id="sendFileOverlay"/);
  assert.match(orders, /openPdfForSending\(\)/);
  assert.match(orders, /openWhatsAppForSending\(\)/);
  assert.match(orders, /openEmailForSending\(\)/);
  assert.match(orders, /שמירה כ‑PDF/);
  assert.match(orders, /autoPrint: true/);
  assert.match(printLoader, /const autoPrint = params\.get\('auto_print'\) === '1';/);
  assert.match(printLoader, /window\.setTimeout\(function\(\)\{window\.print\(\);\},350\)/);
  assert.match(route, /c\.email as customer_email/);
});

test('production cards open on the visible card sheet instead of an empty picker dialog', () => {
  const orders = read('public/orders.html');
  const printPage = read('services/productionCardPrintPage.js');
  const cards = read('services/productionCards.js');

  assert.match(
    orders,
    /class="print-btn cards" href="\/order-print\.html\?id=\$\{o\.id\}&kind=print-cards" target="_blank"/,
    'the production-card action should open the real card sheet directly'
  );
  assert.doesNotMatch(
    orders,
    /class="print-btn cards"[^>]*openProductionCardPrintDialog\(\$\{o\.id\}\)/,
    'the visible action must not send operators to the placeholder picker'
  );
  assert.match(cards, /class="pc-pick"/);
  assert.match(cards, /data-picked="1"/);
  assert.match(printPage, /function togglePickedCard\(/);
  assert.match(printPage, /function refreshPickedCards\(/);
  assert.match(printPage, /\.prod-card\[data-picked="0"\]\{display:none!important;\}/);
});

// Exercise the real rendered button handlers without opening external messaging apps.
function loadDocumentSending() {
  const html = read('public/orders.html');
  const nodes = new Map();
  const opened = [];
  const copied = [];
  function element() {
    const classes = new Set();
    return {
      style: {}, children: [], textContent: '', value: '',
      set innerHTML(value) { this.markup = value; this.children = []; },
      get innerHTML() { return this.markup || ''; },
      classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name) },
      append(...children) { this.children.push(...children); },
      setAttribute() {}, focus() {},
    };
  }
  for (const id of ['sendFileOverlay', 'sendFileDocument', 'sendFileOrderMeta', 'sendFilePhone', 'sendFileEmail', 'sendFileStatus']) {
    nodes.set(id, element());
  }
  const order = { id: 41, order_num: 'TEST-41', customer_name: 'לקוח בדיקה', customer_phone: '972500000000', customer_email: 'test@example.invalid' };
  const context = vm.createContext({
    URLSearchParams, order,
    document: {
      createElement: element,
      getElementById: id => nodes.get(id),
      body: { appendChild(node) { nodes.set(node.id, node); } },
    },
    window: { open: (...args) => opened.push(args), location: { href: '' } },
    navigator: { clipboard: { writeText: async value => copied.push(value) } },
    closePrintDialog: id => nodes.delete(id),
    alert: message => assert.fail(message),
    event: { stopPropagation() {} },
  });
  const configStart = html.indexOf('const PRINT_DOCUMENTS =');
  const configEnd = html.indexOf('const STATUS_CONTRACT', configStart);
  const functionsStart = html.indexOf('function openA4PrintDialog(');
  const functionsEnd = html.indexOf('function requestCorrectionReason(', functionsStart);
  const prints = html.match(/const prints = (`[\s\S]*?`);/);
  assert.ok(configStart >= 0 && configEnd > configStart && functionsStart >= 0 && functionsEnd > functionsStart && prints);
  vm.runInContext(`let currentDetailOrder = order, allOrders = [], currentSendFile = null;
    ${html.slice(configStart, configEnd)}
    ${html.slice(functionsStart, functionsEnd)}
    const o = order;
    globalThis.printButtons = ${prints[1]};`, context);
  const click = (markup, handlerPattern) => {
    const handler = [...markup.matchAll(/onclick="([^"]+)"/g)].map(match => match[1]).find(value => handlerPattern.test(value));
    assert.ok(handler, `Missing button: ${handlerPattern}`);
    return vm.runInContext(handler, context);
  };
  return { context, nodes, opened, copied, click, run: code => vm.runInContext(code, context) };
}

for (const language of ['he', 'th']) {
  test(`A4 ${language} send button preserves order and language through PDF, email, WhatsApp and filename`, async () => {
    const client = loadDocumentSending();
    client.click(client.context.printButtons, /openA4PrintDialog\(41,'send'\)/);
    const dialog = client.nodes.get('a4PrintDialog');
    assert.match(dialog.innerHTML, /שליחת קובץ A4/);
    client.click(dialog.innerHTML, new RegExp(`'${language}', 'send'`));
    assert.equal(client.nodes.has('a4PrintDialog'), false);
    assert.equal(client.opened.length, 0, 'choosing a send language must not open the print-only flow');
    assert.equal(client.nodes.get('sendFileOverlay').classList.contains('show'), true);
    assert.equal(client.nodes.get('sendFileOrderMeta').textContent, 'הזמנה TEST-41');
    const label = language === 'th' ? 'הזמנה A4 – תאילנדית' : 'הזמנה A4';
    const filename = language === 'th' ? 'הזמנה-תאילנדית-TEST-41.pdf' : 'הזמנה-TEST-41.pdf';
    assert.equal(client.nodes.get('sendFileDocument').children[0].textContent, label);
    assert.equal(client.run('sendDocumentFileName()'), filename);

    client.run('openPdfForSending()');
    const pdfUrl = new URL(client.opened[0][0], 'http://localhost');
    assert.equal(pdfUrl.pathname, '/order-print.html');
    assert.equal(pdfUrl.searchParams.get('id'), '41');
    assert.equal(pdfUrl.searchParams.get('kind'), 'print-a4');
    assert.equal(pdfUrl.searchParams.get('lang'), language === 'th' ? 'th' : null);
    assert.equal(pdfUrl.searchParams.get('auto_print'), '1');
    assert.deepEqual(client.opened[0].slice(1), ['_blank', 'noopener']);

    client.run('openWhatsAppForSending()');
    const whatsappUrl = new URL(client.opened[1][0]);
    assert.equal(whatsappUrl.origin, 'https://wa.me');
    assert.equal(whatsappUrl.pathname, '/972500000000');
    assert.equal(whatsappUrl.searchParams.get('text'), `שלום, מצורף קובץ PDF: ${label} עבור הזמנה TEST-41.`);

    client.run('openEmailForSending()');
    const emailUrl = new URL(client.context.window.location.href);
    assert.equal(emailUrl.protocol, 'mailto:');
    assert.equal(decodeURIComponent(emailUrl.pathname), 'test@example.invalid');
    assert.equal(emailUrl.searchParams.get('subject'), `${label} – הזמנה TEST-41`);
    assert.equal(emailUrl.searchParams.get('body'), whatsappUrl.searchParams.get('text'));
    await client.run('copyDocumentName()');
    assert.deepEqual(client.copied, [filename]);
  });

  test(`A4 ${language} printing still opens the selected language without a send dialog`, () => {
    const client = loadDocumentSending();
    client.click(client.context.printButtons, /^openA4PrintDialog\(41\)$/);
    client.click(client.nodes.get('a4PrintDialog').innerHTML, new RegExp(`'${language}', 'print'`));
    const url = new URL(client.opened[0][0], 'http://localhost');
    assert.equal(url.searchParams.get('id'), '41');
    assert.equal(url.searchParams.get('kind'), 'print-a4');
    assert.equal(url.searchParams.get('lang'), language === 'th' ? 'th' : null);
    assert.equal(client.nodes.has('a4PrintDialog'), false);
    assert.equal(client.nodes.get('sendFileOverlay').classList.contains('show'), false);
  });
}

test('cancelling A4 send language selection does not open a document or send panel', () => {
  const client = loadDocumentSending();
  client.click(client.context.printButtons, /openA4PrintDialog\(41,'send'\)/);
  client.click(client.nodes.get('a4PrintDialog').innerHTML, /closePrintDialog/);
  assert.equal(client.nodes.has('a4PrintDialog'), false);
  assert.equal(client.opened.length, 0);
  assert.equal(client.nodes.get('sendFileOverlay').classList.contains('show'), false);
});

test('changing the A4 send language replaces the previous document selection', () => {
  const client = loadDocumentSending();
  for (const language of ['th', 'he']) {
    client.click(client.context.printButtons, /openA4PrintDialog\(41,'send'\)/);
    client.click(client.nodes.get('a4PrintDialog').innerHTML, new RegExp(`'${language}', 'send'`));
    client.run('openPdfForSending()');
    const url = new URL(client.opened.at(-1)[0], 'http://localhost');
    assert.equal(url.searchParams.get('lang'), language === 'th' ? 'th' : null);
  }
  assert.equal(client.run('sendDocumentFileName()'), 'הזמנה-TEST-41.pdf');
});
