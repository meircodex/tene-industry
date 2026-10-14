const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const ordersHtml = fs.readFileSync(path.join(root, 'public', 'orders.html'), 'utf8');
const productionCards = require('../services/productionCards');
const printPage = require('../services/productionCardPrintPage');
const { calculatePileCage } = require('../modules/steel-rebar/pile-cage-engine');
const industry = require('../constants');

function tryParseJSON(value, fallback) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function cageInput(overrides = {}) {
  return {
    shapeId: 'round-pile-600x12000',
    roundPileCage: true,
    pileDiameterMm: 600,
    pileLengthMm: 12000,
    longitudinalBars: {
      totalBars: 10,
      defaultDiameterMm: 20,
      defaultLengthMm: 12000,
      layoutMode: 'alternating',
      pattern: [
        { repeat: 1, type: 'straight', lengthMm: 12000 },
        { repeat: 1, type: 'L', lengthMm: 12000, bendLengthMm: 200 },
      ],
    },
    spiral: {
      barDiameterMm: 8,
      outerDiameterMm: 480,
      pitchMode: 'zones',
      zones: [
        { name: 'A', lengthMm: 3000, pitchMm: 150 },
        { name: 'B', lengthMm: 2000, noWrap: true },
        { name: 'C', lengthMm: 7000, pitchMm: 200 },
      ],
    },
    hoops: {
      enabled: true,
      hoopBarDiameterMm: 18,
      outerDiameterMm: 420,
      spacingMode: 'byQuantity',
      quantity: 5,
      firstHoopOffsetMm: 1500,
      spacingMm: 300,
    },
    ...overrides,
  };
}

function pileSnapshot(overrides = {}) {
  return calculatePileCage(cageInput(overrides));
}

function pileItem(snapshot = pileSnapshot(), id = 501, quantity = 1) {
  return {
    id,
    diameter: 20,
    quantity,
    total_length_mm: 12000,
    total_weight: Number(snapshot.calculated?.totalWeightKg || 0) * quantity,
    pallet_num: 1,
    material_grade: 'B500B',
    card_weights: [],
    shape_snapshot_json: JSON.stringify(snapshot),
  };
}

function dynamicPrintCards(items) {
  const html = printPage.renderPrintCardsPage({
    order: { id: 77, order_num: 'PC-77', customer_name: 'Test', status: 'approved' },
    pallets: [{ id: 1, pallet_num: 1 }],
    allItems: items,
    printDate: '01-08-2026',
    delivDate: '02-08-2026',
    cards: productionCards,
    industry,
    tryParseJSON,
  });
  const inline = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)]
    .map(match => match[1]).find(script => script.includes('Server data'));
  const grids = [];
  const cardsGrid = {
    set innerHTML(value) { this._html = value; grids.length = 0; },
    get innerHTML() { return this._html || ''; },
    appendChild(page) { this.pages = (this.pages || []).concat(page); },
    querySelectorAll(selector) { return selector === '.cards-grid' ? grids : []; },
  };
  const document = {
    getElementById(id) { return id === 'cardsGrid' ? cardsGrid : null; },
    createElement() {
      return {
        children: [],
        appendChild(child) { this.children.push(child); if (child && child.isGrid) grids.push(child); },
        set innerHTML(value) { this.html = value; this.firstElementChild = { html: value }; },
        get innerHTML() { return this.html || ''; },
      };
    },
  };
  const originalCreateElement = document.createElement;
  document.createElement = function(tag) {
    const element = originalCreateElement(tag);
    if (tag === 'div') {
      const append = element.appendChild;
      element.appendChild = function(child) { append.call(this, child); if (this.children.length === 1 && child && !child.html) this.isGrid = false; };
    }
    return element;
  };
  const context = { document, console: { error() {} }, setTimeout() {}, window: {}, fetch() {}, IronBendProductionCardFace: require('../public/production-card-face') };
  const executable = inline.replace(/\/\/ Init: render fixed production cards and QR codes\.[\s\S]*$/, '');
  vm.runInNewContext(executable, context);
  const originalAppend = cardsGrid.appendChild.bind(cardsGrid);
  cardsGrid.appendChild = function(page) {
    const grid = page.children && page.children[0];
    if (grid) { grid.isGrid = true; grids.push(grid); }
    originalAppend(page);
  };
  context.generateCards();
  return grids.flatMap(grid => grid.children.map(card => card.html));
}

test('exact snapshot identity alone identifies a round pile cage', () => {
  assert.equal(productionCards.isRoundPileCageItem(pileItem()), true);
  for (const snapshot of [
    { family: 'piles', shapeType: 'other_pile_shape', data: {} },
    { family: 'piles', data: { label: 'pile cage כלונס' } },
    { family: 'rebar', shapeType: 'round_pile_cage', data: {} },
  ]) assert.equal(productionCards.isRoundPileCageItem(pileItem(snapshot)), false);
});

test('complete cage renders a dedicated schedule-aware monochrome SVG', () => {
  const svg = productionCards.shapeSvgForProductionCard(pileItem(), [{ length_mm: 12000, angle_deg: 0 }]);
  assert.match(svg, /aria-label="PILE CAGE"/);
  assert.match(svg, /L 1,200 cm/);
  assert.match(svg, /10 × Ø20/);
  assert.match(svg, /Ø8/);
  assert.match(svg, /5 × Ø18/);
  assert.match(svg, /data-no-wrap="1"/);
  assert.match(svg, /<circle/);
  assert.match(svg, /<path/);
  assert.doesNotMatch(svg, /#2563eb|#c9621a|#9a4b10/i);
  assert.equal(productionCards.itemHumanTitle(pileItem()), 'PILE CAGE');
});

test('assembly visuals show the saved bend orientation while the L component stays canonical', () => {
  const input = cageInput();
  input.longitudinalBars.defaultBendOrientationDeg = 135.5;
  const snapshot = calculatePileCage(input);
  const item = pileItem(snapshot);
  const svg = productionCards.shapeSvgForProductionCard(item, []);
  const cards = dynamicPrintCards([item]);
  const assembly = cards.find(card => card.includes('pile-cage-assembly-card'));
  const bent = cards.find(card => card.includes('longitudinal_l_bar'));

  assert.equal((svg.match(/data-pile-bend-orientation="135\.5"/g) || []).length, 5);
  assert.match(svg, /data-bend-orientation-reference="radial_inward"/);
  assert.match(svg, /↻135\.5°/);
  assert.match(assembly, /data-pile-bend-orientation="135\.5"/);
  assert.match(assembly, /↻135\.5°/);
  assert.match(bent, /data-component-type="longitudinal_l_bar"/);
  assert.doesNotMatch(bent, /data-pile-bend-orientation|↻135\.5°/);
});

test('partial cage snapshot never fabricates reinforcement values or uses generic bar fallback', () => {
  const snapshot = { family: 'piles', shapeType: 'round_pile_cage', data: { general: { pileDiameterMm: 600, pileLengthMm: 12000 }, longitudinalBars: {}, spiral: {}, hoops: {} } };
  const svg = productionCards.shapeSvgForProductionCard(pileItem(snapshot), []);
  assert.match(svg, /aria-label="PILE CAGE"/);
  assert.doesNotMatch(svg, /10 × Ø20|Ø8 @ 15cm|5 × Ø18|data-shape-kind="generic-bar"/);
  assert.match(svg, /—/);
});

test('order surfaces require exact identity and retain the dedicated visual path', () => {
  assert.match(indexHtml, /snapshot\?\.family === 'piles' && snapshot\?\.shapeType === 'round_pile_cage'/);
  assert.match(ordersHtml, /snapshot\.family === 'piles' && snapshot\.shapeType === 'round_pile_cage'/);
  assert.match(indexHtml, /if \(isRoundPileCageItem\(item\)\) return roundPileCagePreviewSvg/);
  assert.match(ordersHtml, /pile-cage-detail-visual/);
  assert.match(ordersHtml, /pile-cage-badge">PILE CAGE/);
});

test('canonical pile snapshot expands to four material cards plus one real assembly card', () => {
  const snapshot = pileSnapshot();
  const cards = printPage._test.fallbackPileProductionCards(pileItem(snapshot), snapshot);
  assert.deepEqual(cards.map(card => card.componentType), [
    'longitudinal_straight_bar',
    'longitudinal_l_bar',
    'spiral_consolidated',
    'hoop_ring',
    'pile_assembly',
  ]);
  assert.equal(cards.filter(card => card.cardType === 'pile_component').length, 4);
  assert.equal(cards.filter(card => card.cardType === 'pile_assembly').length, 1);
  assert.deepEqual(cards.map(card => card.quantity), [5, 5, 1, 5, 1]);
  assert.deepEqual(cards.map(card => card.unitLengthMm), [12000, 12200, 82177.1, 1319, 12000]);
  assert.deepEqual(cards.map(card => card.totalLengthMm), [60000, 61000, 82177.1, 6595, 12000]);
  assert.deepEqual(cards.map(card => card.weightKg), [148.2, 150.67, 32.46, 13.19, 344.52]);
  assert.equal(cards[4].weightKg, Number(cards.slice(0, 4).reduce((sum, card) => sum + card.weightKg, 0).toFixed(3)));
  assert.equal(cards[4].scanCodeSuffix, 'ASSEMBLY');
});

test('dynamic print renders exactly five QR/status cards with canonical component visuals', () => {
  const cards = dynamicPrintCards([pileItem()]);
  assert.equal(cards.length, 5);
  const assembly = cards.find(card => card.includes('pile-cage-assembly-card'));
  assert.match(assembly, /aria-label="PILE CAGE"/);
  assert.match(assembly, /L = 1200 cm/);
  assert.match(assembly, /CAGES 1/);
  assert.doesNotMatch(assembly, /UNIT 1200 cm|TOTAL 1200 cm/);
  assert.match(assembly, /ASSEMBLY/);
  assert.match(assembly, /data-assembly-component-summary="4"/);
  assert.match(assembly, /STRAIGHT 5 × Ø20 מ״מ · 6,000 ס״מ/);
  assert.match(assembly, /L-BAR 5 × Ø20 מ״מ · 6,100 ס״מ/);
  assert.match(assembly, /SPIRAL 1 × Ø8 מ״מ · 8,217\.71 ס״מ/);
  assert.match(assembly, /RINGS 5 × Ø18 מ״מ · 659\.5 ס״מ/);
  assert.match(assembly, /STEEL 20,977\.21 cm/);
  assert.doesNotMatch(assembly, /data-shape-kind="generic-bar"/);

  const straight = cards.find(card => card.includes('longitudinal_straight_bar'));
  const bent = cards.find(card => card.includes('longitudinal_l_bar'));
  const spiral = cards.find(card => card.includes('spiral_consolidated'));
  const hoop = cards.find(card => card.includes('hoop_ring'));
  assert.match(straight, /PCS 5/); assert.match(straight, /L = 6000 cm/); assert.doesNotMatch(straight, /UNIT 1200 cm|TOTAL 6000 cm/);
  assert.match(straight, /data-component-type="longitudinal_straight_bar"/);
  assert.match(bent, /PCS 5/); assert.match(bent, /L = 6100 cm/); assert.doesNotMatch(bent, /UNIT 1220 cm|TOTAL 6100 cm/);
  assert.match(bent, /data-component-type="longitudinal_l_bar"/); assert.match(bent, /<polyline|<path/);
  assert.match(spiral, /data-shape-kind="pile-spiral-component"/); assert.match(spiral, /AXIS 1,200 cm/); assert.match(spiral, /CUT 8,217\.71 cm/); assert.match(spiral, /C5,236\.91 cm/); assert.match(spiral, /NO WRAP/);
  assert.match(spiral, /L = 8217\.71 cm/); assert.doesNotMatch(spiral, /UNIT 8217\.71 cm|TOTAL 8217\.71 cm/);
  assert.match(hoop, /data-shape-kind="pile-hoop-component"/); assert.match(hoop, /PCS 5/); assert.match(hoop, /L = 659\.5 cm/); assert.doesNotMatch(hoop, /UNIT 131\.9 cm|TOTAL 659\.5 cm/); assert.match(hoop, /data-spiral-diameter-mm="420"/); assert.match(hoop, /Ø 42 ס״מ/);
  for (const card of cards) {
    assert.match(card, /data-worker-card-code=/);
    assert.doesNotMatch(card, /#2563eb|#c9621a|#9a4b10/i);
  }
});

test('historical snapshot with five authoritative hoop positions prints PCS 5 without a fallback quantity', () => {
  const historical = pileSnapshot();
  delete historical.data.hoops.quantity;
  historical.data.hoops.positionsMm = [1500, 1800, 2100, 2400, 2700];
  const cards = printPage._test.fallbackPileProductionCards(pileItem(historical), historical);
  assert.equal(cards.length, 5);
  const hoop = cards.find(card => card.componentType === 'hoop_ring');
  assert.equal(hoop.quantity, 5);
  assert.deepEqual(hoop.source.positionsMm, historical.data.hoops.positionsMm);
  const printed = dynamicPrintCards([pileItem(historical)]).find(card => card.includes('hoop_ring'));
  assert.match(printed, /PCS 5/);
});

test('spiral segment names are escaped before they enter production SVG text', () => {
  const snapshot = pileSnapshot({
    spiral: {
      barDiameterMm: 8,
      outerDiameterMm: 480,
      pitchMode: 'zones',
      zones: [{ name: '<img onerror=alert(1)>', lengthMm: 3000, pitchMm: 150 }, { name: 'B', lengthMm: 2000, noWrap: true }, { name: 'C', lengthMm: 7000, pitchMm: 200 }],
    },
  });
  const card = snapshot.productionCards.find(entry => entry.componentType === 'spiral_consolidated');
  const svg = printPage._test.pileComponentShapeSvg(card, card.unitLengthMm, 'escape-test');
  assert.doesNotMatch(svg, /<img/i);
  assert.match(svg, /&lt;img onerror=alert\(1\)&gt;/);
});

test('multiple cages keep scoped SVG identifiers and another pile family stays generic', () => {
  const cards = dynamicPrintCards([pileItem(pileSnapshot(), 501), pileItem(pileSnapshot(), 502)]);
  assert.equal(cards.length, 10);
  assert.equal(cards.filter(card => card.includes('pile-cage-assembly-card')).length, 2);
  const hoopCards = cards.filter(card => card.includes('hoop_ring'));
  const ids = hoopCards.flatMap(card => [...card.matchAll(/<svg[\s\S]*?<\/svg>/g)]
    .flatMap(svg => [...svg[0].matchAll(/\sid="([^"]+)"/g)].map(match => match[1])));
  assert.deepEqual(ids, [], 'pile hoop visuals are marker-free so repeated print/display SVGs cannot collide');

  const otherPile = pileItem({ family: 'piles', shapeType: 'square_pile_cage', data: {} }, 503);
  const otherCards = dynamicPrintCards([otherPile]);
  assert.equal(otherCards.length, 1);
  assert.doesNotMatch(otherCards[0], /כלוב זיון לכלונס עגול|PILE CAGE|pile-cage-assembly-card/);
});

test('invalid canonical cage is fail-closed and never creates an assembly QR', () => {
  const invalid = pileSnapshot({ hoops: { enabled: true, hoopBarDiameterMm: 18, outerDiameterMm: 420 } });
  assert.equal(invalid.validation.ok, false);
  assert.ok(invalid.validation.errorCodes.includes('missing_hoop_quantity'));
  assert.deepEqual(printPage._test.fallbackPileProductionCards(pileItem(invalid), invalid), []);
  assert.deepEqual(printPage._test.expandPileCageProductionItems([pileItem(invalid)], tryParseJSON), []);
});
