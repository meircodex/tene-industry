const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { parseSteelDocument, reconstructTassaRows } = require('../services/steelDocumentParser');

function loadOrder105Fixture() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'order105-tassa-pdf-words.json'), 'utf8'));
}

test('steel document parser reconstructs the uploaded order105 PDF benchmark rows', () => {
  const fixture = loadOrder105Fixture();
  const parsed = parseSteelDocument({
    pages: fixture.pages,
    fileName: 'order105.pdf',
  });

  assert.equal(parsed.parser_version, 'steel-document-parser-v1');
  assert.equal(parsed.parsing_profile.id, 'tassa_easybar_bending_schedule');
  assert.equal(parsed.document_type, 'cutting_bending_sheet');
  assert.ok(parsed.metrics.rows_detected >= fixture.expected_rows_min);
  assert.ok(parsed.metrics.usable_rows >= 30);
  assert.equal(parsed.items.length, 37);

  const row1 = parsed.items.find(item => item.item_number === '1');
  assert.equal(row1.diameter, 8);
  assert.equal(row1.quantity, 51);
  assert.equal(row1.total_length_cm, 690);
  assert.equal(row1.weight_kg, 139);
  assert.equal(row1.total_length_mm, 6900);
  assert.deepEqual(row1.segments.map(segment => ({ length_cm: segment.length_cm, length_mm: segment.length_mm, angle_deg: segment.angle_deg })), [
    { length_cm: 20, length_mm: 200, angle_deg: 90 },
    { length_cm: 670, length_mm: 6700, angle_deg: 0 },
  ]);
  assert.equal(row1.source_ref.page, 1);
  assert.ok(row1.fields.quantity.source_bbox);
  assert.ok(row1.fields.shape.source_bbox);
});

test('steel document parser maps drawing value 20 to shape context, not quantity', () => {
  const fixture = loadOrder105Fixture();
  const parsed = parseSteelDocument({ pages: fixture.pages, fileName: 'order105.pdf' });
  const row10 = parsed.items.find(item => item.item_number === '10');

  assert.equal(row10.diameter, 8);
  assert.equal(row10.quantity, 51);
  assert.equal(row10.total_length_cm, 1070);
  assert.equal(row10.total_length_mm, 10700);
  assert.deepEqual(row10.segments.map(segment => ({ length_cm: segment.length_cm, length_mm: segment.length_mm, angle_deg: segment.angle_deg })), [
    { length_cm: 20, length_mm: 200, angle_deg: 90 },
    { length_cm: 1050, length_mm: 10500, angle_deg: 0 },
  ]);
  assert.notEqual(row10.quantity, 20);
});

test('steel document parser keeps low confidence fields as structured review notes', () => {
  const parsed = parseSteelDocument({
    tokens: [
      { text: '1', page: 1, x0: 575, x1: 582, top: 150, bottom: 160 },
      { text: '450', page: 1, x0: 350, x1: 370, top: 150, bottom: 160 },
      { text: '4.70', page: 1, x0: 160, x1: 180, top: 150, bottom: 160 },
    ],
  });

  assert.equal(parsed.items.length, 1);
  assert.equal(parsed.items[0].review_status, 'needs_review');
  const fields = parsed.items[0].review_notes.map(note => note.field);
  assert.ok(fields.includes('diameter'));
  assert.ok(fields.includes('quantity'));
  assert.ok(fields.includes('shape'));
  assert.ok(parsed.items[0].review_notes.every(note => note.code));
});

test('steel document parser reconstructs rows by coordinates, not OCR token order', () => {
  const tokens = [
    { text: '670', page: 1, x0: 351, x1: 371, top: 144, bottom: 154 },
    { text: '51', page: 1, x0: 225, x1: 235, top: 144, bottom: 154 },
    { text: '1', page: 1, x0: 578, x1: 582, top: 144, bottom: 154 },
    { text: '8.0', page: 1, x0: 249, x1: 260, top: 144, bottom: 154 },
    { text: '6.90', page: 1, x0: 161, x1: 181, top: 144, bottom: 154 },
    { text: '139.00', page: 1, x0: 32, x1: 61, top: 144, bottom: 154 },
    { text: '20', page: 1, x0: 308, x1: 320, top: 144, bottom: 154 },
  ];
  const rows = reconstructTassaRows(tokens);
  const parsed = parseSteelDocument({ tokens });

  assert.equal(rows.length, 1);
  assert.equal(parsed.items[0].item_number, '1');
  assert.equal(parsed.items[0].quantity, 51);
  assert.equal(parsed.items[0].diameter, 8);
  assert.equal(parsed.items[0].total_length_cm, 690);
});

test('current Easybar layout keeps its distinct bands and labels below the numeric row', () => {
  const word = (text, x, top = 180) => ({ text, page: 1, x0: x, x1: x + 8, top, bottom: top + 8 });
  const parsed = parseSteelDocument({ tokens: [
    word('1', 550), word('8', 302), word('51', 270), word('6.90', 218),
    word('139', 120), word('20', 320), word('670', 370, 194),
    word('999', 370, 168), // previous drawing row must not leak in
  ] });
  assert.equal(parsed.items.length, 1);
  const item = parsed.items[0];
  assert.equal(item.diameter, 8);
  assert.equal(item.quantity, 51);
  assert.equal(item.total_length_mm, 6900);
  assert.deepEqual(item.segments.map(s => s.length_mm), [200, 6700]);
});

test('each page selects its own layout without mixing quantity with drawing dimensions', () => {
  const word = (text, x, page, top) => ({ text, page, x0: x, x1: x + 8, top, bottom: top + 8 });
  const parsed = parseSteelDocument({ tokens: [
    word('1', 578, 1, 144), word('8.0', 249, 1, 144), word('51', 225, 1, 144),
    word('6.90', 161, 1, 144), word('139', 32, 1, 144), word('20', 308, 1, 144), word('670', 351, 1, 144),
    word('2', 550, 2, 180), word('12', 302, 2, 180), word('17', 270, 2, 180),
    word('5.00', 218, 2, 180), word('75', 120, 2, 180), word('500', 370, 2, 194),
  ] });
  assert.deepEqual(parsed.items.map(item => [item.item_number, item.diameter, item.quantity, item.total_length_mm]),
    [['1', 8, 51, 6900], ['2', 12, 17, 5000]]);
});
