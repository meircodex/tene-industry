const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSteelDocument } = require('../services/steelDocumentParser');
const workflow = require('../services/intakeWorkflow');
const word = (text, x, top = 220) => ({ text: String(text), x0: x - 2, x1: x + 2, top, bottom: top + 6, page: 1 });
function source() {
  return { text: 'Iron bars SHOP DRAWING bars quantitiy diameter', tokens: [
    word(1, 545), word(1, 282), word(10, 258), word(243, 226), word('1.15', 160),
    word('279.5', 121), word('0.617', 88), word('172.4', 58),
    word(15, 449, 238), word(100, 367, 245),
  ] };
}
test('shop drawing distinguishes serial, bar mark, quantity and drawing labels', () => {
  const parsed = parseSteelDocument(source());
  assert.equal(parsed.parsing_profile.id, 'iron_bars_shop_drawing');
  assert.equal(parsed.metrics.rows_detected, 1);
  assert.equal(parsed.metrics.usable_rows, 1);
  const item = parsed.items[0];
  assert.equal(item.quantity, 243);
  assert.equal(item.diameter, 10);
  assert.equal(item.total_length_mm, 1150);
  assert.equal(item.weight_kg, 172.4);
  assert.deepEqual(item.source_drawing_dimensions.map(d => d.value_cm), [15, 100]);
  assert.equal(item.shape_type, 'unknown');
  assert.deepEqual(item.segments, []);
  assert.ok(workflow.intakeApprovalErrors(parsed).some(error => error.field === 'shape_name'));
});
test('shop drawing source checks reject shifted columns, bad totals and repeated serials', () => {
  for (const mutate of [
    input => { input.tokens.find(w => w.text === '243').x0 = 300; input.tokens.find(w => w.text === '243').x1 = 304; },
    input => { input.tokens.find(w => w.text === '279.5').text = '280.5'; },
    input => { input.tokens.find(w => w.text === '172.4').text = '173.4'; },
    input => { input.tokens.push(...input.tokens.map(w => ({ ...w, top: w.top + 60, bottom: w.bottom + 60 }))); },
  ]) {
    const input = source(); mutate(input);
    const parsed = parseSteelDocument(input);
    assert.equal(parsed.metrics.usable_rows, 0);
    assert.ok(parsed.items.every(item => item.review_notes.length > 0));
  }
});
test('shop drawing straight section preserves cut length without invented bend geometry', () => {
  const input = source();
  input.tokens = input.tokens.filter(w => !['15', '100'].includes(w.text));
  input.tokens.push(word('ברזל ישר', 400, 205), word('115', 367, 245));
  const item = parseSteelDocument(input).items[0];
  assert.equal(item.shape_type, 'straight');
  assert.equal(item.total_length_mm, 1150);
  assert.deepEqual(item.segments, []);
});
test('generic documents cannot opt into shop drawing columns by numeric coincidence', () => {
  const input = source(); input.text = 'Generic list';
  assert.equal(parseSteelDocument(input).items.length, 0);
});

test('shop drawing reads printed customer, project and site without inventing a date', () => {
  const input=source();
  input.tokens.push(word('בית ספר על יסודי, מגרש',490,111),word('801',448,111),word('– כרמי גת (מכרז/חוזה',420,111),word('03/2026 )',450,119),word('י.ד. עשוש תשתיות בע״מ',490,135));
  const parsed=parseSteelDocument(input);
  assert.equal(parsed.customer_name,'י.ד. עשוש תשתיות בע״מ');
  assert.equal(parsed.project_name,'בית ספר על יסודי, מגרש 801 – כרמי גת (מכרז/חוזה 03/2026 )');
  assert.equal(parsed.site_name,'בית ספר על יסודי, מגרש 801 – כרמי גת');
  assert.equal(parsed.source_customer_name,parsed.customer_name);
  assert.equal(parsed.delivery_date,null);
  const emptyHeader=parseSteelDocument(source());
  assert.equal(emptyHeader.customer_name,null);
  assert.equal(emptyHeader.site_name,null);
});

test('closed hoop callouts preserve rectangle dimensions and separate printed closure allowance', () => {
  const input = source();
  input.tokens = [word(1,545),word(1,282),word(10,258),word(38,226),word('3.56',160),word('135.3',121),word('.617',88),word('83.5',58),
    word(34,299,230),word(129,367,230),word(30,299,238),word(34,449,238),word(129,367,246)];
  input.tokens.find(w => w.text === '.617').text = '0.617';
  const parsed = parseSteelDocument(input), item = parsed.items[0];
  assert.equal(parsed.metrics.usable_rows,1);
  assert.equal(item.shape_type,'stirrup');
  assert.equal(item.shape_name,'חישוק סגור');
  assert.deepEqual(item.source_shape_parameters,{width_mm:1290,height_mm:340,closure_allowance_mm:300,end_length_mm:150});
  assert.equal(item.total_length_mm,3560);
  assert.deepEqual(item.segments.map(s=>s.length_mm),[150,340,1290,340,1290,150]);
  assert.equal(item.segments.reduce((sum,s)=>sum+s.length_mm,0),3560);
  // A conflicting allowance must not silently become a hoop.
  input.tokens.find(w => w.text === '30').text='31';
  assert.equal(parseSteelDocument(input).items[0].shape_type,'unknown');
});

test('23 cm closure belongs to both symmetric ends, 11.5 cm per end', () => {
  const input=source();
  input.tokens=[word(1,545),word(1,282),word(8,258),word(27,226),word('1.35',160),word('36.5',121),word('0.395',88),word('14.4',58),
    word(23,299,230),word(42,367,230),word(14,299,238),word(14,449,238),word(42,367,246)];
  const parsed=parseSteelDocument(input),item=parsed.items[0];
  assert.equal(parsed.metrics.usable_rows,1);
  assert.equal(item.source_shape_parameters.closure_allowance_mm,230);
  assert.equal(item.source_shape_parameters.end_length_mm,115);
  assert.deepEqual(item.segments.map(s=>s.length_mm),[115,140,420,140,420,115]);
  assert.equal(item.segments.reduce((sum,s)=>sum+s.length_mm,0),item.total_length_mm);
  assert.equal(item.total_length_mm,1350);
  assert.equal(item.quantity,27);
});
