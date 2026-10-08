const test = require('node:test');
const assert = require('node:assert/strict');
const { planCutting } = require('../public/straight-stock-cutting.js');

test('packs complementary cuts into one 12 metre stock bar', () => {
  const plan = planCutting({
    stockLengthMm: 12000,
    pieces: [
      { itemId: 1, diameter: 12, lengthMm: 7000, quantity: 1 },
      { itemId: 2, diameter: 12, lengthMm: 5000, quantity: 1 },
    ],
  });
  assert.equal(plan.bars.length, 1);
  assert.equal(plan.totalWasteMm, 0);
  assert.equal(plan.exact, true);
});

test('finds a zero-waste two-bar plan', () => {
  const plan = planCutting({
    stockLengthMm: 12000,
    pieces: [
      { itemId: 1, diameter: 10, lengthMm: 7000, quantity: 1 },
      { itemId: 2, diameter: 10, lengthMm: 5000, quantity: 1 },
      { itemId: 3, diameter: 10, lengthMm: 6000, quantity: 2 },
    ],
  });
  assert.equal(plan.bars.length, 2);
  assert.equal(plan.totalWasteMm, 0);
});

test('never mixes diameters in the same stock bar', () => {
  const plan = planCutting({
    stockLengthMm: 12000,
    pieces: [
      { itemId: 1, diameter: 8, lengthMm: 6000, quantity: 1 },
      { itemId: 2, diameter: 12, lengthMm: 6000, quantity: 1 },
    ],
  });
  assert.equal(plan.groups.length, 2);
  assert.equal(plan.bars.length, 2);
  assert.deepEqual(plan.bars.map(bar => bar.diameter), [8, 12]);
});

test('accounts for kerf between adjacent cuts', () => {
  const plan = planCutting({
    stockLengthMm: 12000,
    kerfMm: 4,
    pieces: [{ itemId: 1, diameter: 16, lengthMm: 5000, quantity: 2 }],
  });
  assert.equal(plan.bars.length, 1);
  assert.equal(plan.totalKerfLossMm, 4);
  assert.equal(plan.totalWasteMm, 1996);
});

test('reports pieces longer than the selected stock instead of packing them', () => {
  const plan = planCutting({
    stockLengthMm: 12000,
    pieces: [{ itemId: 1, diameter: 20, lengthMm: 12500, quantity: 3 }],
  });
  assert.equal(plan.pieceCount, 0);
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].quantity, 3);
});

test('chooses one commercial length per diameter by default and minimizes waste', () => {
  const plan = planCutting({
    stockLengthsMm: [6000, 12000],
    pieces: [
      { itemId: 1, diameter: 8, lengthMm: 4000, quantity: 1 },
      { itemId: 2, diameter: 8, lengthMm: 2000, quantity: 1 },
      { itemId: 3, diameter: 12, lengthMm: 7000, quantity: 1 },
    ],
  });
  const d8 = plan.groups.find(group => group.diameter === 8);
  const d12 = plan.groups.find(group => group.diameter === 12);
  assert.deepEqual([...new Set(d8.bins.map(bar => bar.stockLengthMm || d8.stockLengthMm))], [6000]);
  assert.deepEqual([...new Set(d12.bins.map(bar => bar.stockLengthMm || d12.stockLengthMm))], [12000]);
  assert.equal(plan.totalWasteMm, 5000);
});

test('can mix 6 and 12 metre stock only when explicitly allowed and it saves material', () => {
  const pieces = [
    { itemId: 1, diameter: 10, lengthMm: 8000, quantity: 1 },
    { itemId: 2, diameter: 10, lengthMm: 4000, quantity: 2 },
  ];
  const uniform = planCutting({ stockLengthsMm: [6000, 12000], pieces });
  const mixed = planCutting({ stockLengthsMm: [6000, 12000], allowMixedStockLengths: true, pieces });
  assert.equal(uniform.totalWasteMm, 8000);
  assert.equal(mixed.totalWasteMm, 2000);
  assert.deepEqual([...new Set(mixed.bars.map(bar => bar.stockLengthMm))].sort((a, b) => a - b), [6000, 12000]);
});

test('supports a per-diameter stock override when one commercial length is unavailable', () => {
  const plan = planCutting({
    stockLengthsMm: [6000, 12000],
    groupPolicies: {
      8: { stockLengthsMm: [12000], allowMixedStockLengths: false },
      10: { stockLengthsMm: [6000], allowMixedStockLengths: false },
    },
    pieces: [
      { itemId: 1, diameter: 8, lengthMm: 3000, quantity: 2 },
      { itemId: 2, diameter: 10, lengthMm: 3000, quantity: 2 },
    ],
  });
  const d8Bars = plan.bars.filter(bar => bar.diameter === 8);
  const d10Bars = plan.bars.filter(bar => bar.diameter === 10);
  assert.ok(d8Bars.every(bar => bar.stockLengthMm === 12000));
  assert.ok(d10Bars.every(bar => bar.stockLengthMm === 6000));
});
