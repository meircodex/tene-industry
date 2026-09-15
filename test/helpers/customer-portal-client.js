'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const shapes = require('../../modules/steel-rebar/shapes');

// Execute the real portal script and editor calculations, with a minimal DOM.
// HTTP tests below use its actual serialized quote/submit bodies.
function loadPortalClient() {
  const elements = new Map();
  const timers = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      value: '', innerHTML: '', textContent: '', disabled: false, dataset: {}, style: {},
      classList: { add() {}, remove() {}, toggle() {} },
      setAttribute() {}, removeAttribute() {}, addEventListener() {},
    });
    return elements.get(id);
  };
  const context = vm.createContext({
    console, URLSearchParams, URL, AbortController, FormData, Blob,
    location: { search: '', href: 'http://portal.test/customer.html' },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    document: { getElementById: element, querySelectorAll() { return []; }, body: element('body') },
    window: { scrollTo() {}, IronBendSteelRebarShapes: shapes },
    IronBendSteelRebarShapes: shapes,
    setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimeout() {},
    fetch: async () => { throw new Error('unexpected HTTP call'); },
  });
  const root = path.resolve(__dirname, '../..');
  for (const file of ['services/shapeSnapshot.js', 'public/rebar-weights.js', 'public/display-units.js', 'public/shape-editor.js', 'public/order-line-renderer.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  const html = fs.readFileSync(path.join(root, 'public/customer.html'), 'utf8');
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error('Expected the customer portal application script');
  vm.runInContext(scripts[0][1], context, { filename: 'customer.html' });
  const run = code => vm.runInContext(code, context);
  const json = code => JSON.parse(run(`JSON.stringify(${code})`));
  function select(shape, quantity = 20, elementName = 'קורה 1') {
    context.testShape = shape;
    context.testQuantity = quantity;
    context.testElementName = elementName;
    run(`
      if (!orderItems.length) addItem();
      portalShapeEditor = { current: JSON.parse(JSON.stringify(testShape)) };
      portalShapeTargetId = orderItems[0].id;
      portalShapeSelected({
        ...buildShapeDataContractV2(testShape),
        orderItemQuantity: testQuantity,
        structElement: testElementName,
      });
    `);
    return json('portalOrderItemPayload(orderItems[0])');
  }
  return { context, elements, element, timers, run, json, select };
}

module.exports = { loadPortalClient };
