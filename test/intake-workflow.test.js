const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildIntakeOrderPayload,
  buildOrderImportPreview,
  buildStructuredReviewNotes,
  cleanRecognizedCustomerName,
  isTechnicalRecognitionNote,
  isStraightOcrShape,
  normalizeIntakeItem,
  normalizeOcrSpiralItem,
  normalizeOcrLShapeSegments,
  operationalOrderNote,
  parseManualIntakeText,
  resolveIntakeCustomer,
  withStructuredReviewNotes,
} = require('../services/intakeWorkflow');

test('normalizeIntakeItem builds canonical sides angles quantity and shape', () => {
  const item = normalizeIntakeItem({
    diameter: '12',
    sides: ['300', '600', '300'],
    qty: '4',
    shape: 'U - anchor',
  });

  assert.deepEqual(item.sides, [300, 600, 300]);
  assert.deepEqual(item.angles, [90, 90]);
  assert.equal(item.length, 1200);
  assert.equal(item.qty, 4);
  assert.equal(item.shapeId, 'U - anchor');
});

test('normalizeOcrLShapeSegments infers any missing L leg from total cut length', () => {
  const result = normalizeOcrLShapeSegments({ shape_name: 'L angle' }, [
    { length_mm: 6700, angle_deg: 180 },
  ], 6900);

  assert.equal(result.adjusted, true);
  assert.equal(result.addedLegMm, 200);
  assert.deepEqual(result.segments, [
    { length_mm: 200, angle_deg: 90 },
    { length_mm: 6700, angle_deg: 0 },
  ]);

  const otherLeg = normalizeOcrLShapeSegments({ shape_name: 'L angle' }, [
    { length_mm: 4500, angle_deg: 180 },
  ], 4850);
  assert.equal(otherLeg.addedLegMm, 350);
  assert.deepEqual(otherLeg.segments, [
    { length_mm: 350, angle_deg: 90 },
    { length_mm: 4500, angle_deg: 0 },
  ]);
});

test('OCR shape parameters override a straight label', () => {
  assert.equal(isStraightOcrShape({ shape_type: 'straight', shape_name: 'straight bar' }), true);
  assert.equal(isStraightOcrShape({ shape_name: 'L angle' }), false);

  const result = normalizeOcrLShapeSegments({ shape_type: 'straight', shape_name: 'straight bar' }, [
    { length_mm: 6700, angle_deg: 180 },
  ], 6900);

  assert.equal(result.adjusted, true);
  assert.deepEqual(result.segments, [
    { length_mm: 200, angle_deg: 90 },
    { length_mm: 6700, angle_deg: 0 },
  ]);
});

test('OCR route contract treats total length as cut length and sketch as geometry', () => {
  const route = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'routes', 'intake.js'), 'utf8');
  assert.match(route, /total_length_cm is the total cut length/);
  assert.match(route, /Every visible number has a role based on its visual context/);
  assert.match(route, /two different length sources that must not be merged/);
  assert.match(route, /straight label must never erase visible shape parameters/);
  assert.match(route, /shape side dimensions belong only to the sketch/);
  assert.match(route, /do not silently change the visible shape/);
  assert.doesNotMatch(route, /assigned to the two end legs/);
});

test('normalizeIntakeItem keeps real spiral parameters as first-class item fields', () => {
  const item = normalizeIntakeItem({
    diameter: '8',
    shape_name: 'spiral',
    spiral_diameter_mm: '50',
    spiral_turns: '160',
    quantity: '2',
  });

  assert.deepEqual(item.sides, []);
  assert.deepEqual(item.angles, []);
  assert.equal(item.length, Math.round(Math.PI * 500 * 160));
  assert.equal(item.spiral_diameter_mm, 500);
  assert.equal(item.spiral_turns, 160);
  assert.equal(item.qty, 2);
});

test('OCR spiral normalization keeps bar diameter, spiral diameter and turns separate', () => {
  const spiral = normalizeOcrSpiralItem({
    diameter: 8,
    shape_name: 'spiral',
    shape_description: 'coil drawing \u00d850 cm',
    note: '60 \u05e1\u05d9\u05d1\u05d5\u05d1\u05d9\u05dd',
  });

  assert.equal(spiral.isSpiral, true);
  assert.equal(spiral.spiralDiameterMm, 500);
  assert.equal(spiral.turns, 60);
  assert.equal(spiral.totalLengthMm, Math.round(Math.PI * 500 * 60));

  const item = normalizeIntakeItem({
    diameter: 8,
    shape_name: 'spiral',
    shape_description: 'coil drawing \u00d850 cm',
    note: '60 \u05e1\u05d9\u05d1\u05d5\u05d1\u05d9\u05dd',
    quantity: 1,
  });
  assert.equal(item.diameter, 8);
  assert.equal(item.spiral_diameter_mm, 500);
  assert.equal(item.spiral_turns, 60);
  assert.equal(item.qty, 1);
});

test('OCR spiral normalization prefers explicit source turns over stale parsed turns', () => {
  const spiral = normalizeOcrSpiralItem({
    diameter: 8,
    shape_name: 'spiral',
    spiral_diameter_mm: 50,
    spiral_turns: 160,
    note: 'source row says 60 \u05e1\u05d9\u05d1\u05d5\u05d1\u05d9\u05dd',
  });

  assert.equal(spiral.isSpiral, true);
  assert.equal(spiral.spiralDiameterMm, 500);
  assert.equal(spiral.turns, 60);
  assert.equal(spiral.totalLengthMm, Math.round(Math.PI * 500 * 60));
});

test('buildIntakeOrderPayload resolves customer and calculates total weight', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Fallback',
    delivery_date: '2026-06-03',
    items: [
      { diameter: 10, length: 1000, quantity: 2 },
      { diameter: 12, sides: [300, 300], qty: 1 },
    ],
  }, {
    source: 'phone',
    rawContent: 'fallback@example.com',
    resolveCustomer: () => ({ id: 7, name: 'מאיר', phone: '0501234567', email: 'meir@example.com' }),
    calcWeightPerUnit: (diameter, length) => diameter * length / 100000,
  });

  assert.equal(payload.customer.id, 7);
  assert.equal(payload.customer.name, 'מאיר');
  assert.equal(payload.order.channel, 'phone');
  assert.equal(payload.order.deliveryDate, '2026-06-03');
  assert.equal(payload.pallets[0].items.length, 2);
  assert.equal(payload.order.totalWeight, 10 * 1000 / 100000 * 2 + 12 * 600 / 100000);
});

test('technical OCR notes stay out of operational order notes', () => {
  const technicalNote = 'Cover page shows TASSA supplier order. Row 5 is a closed stirrup; interpreted conservatively. Review required: reported total differs from segment sum.';
  assert.equal(isTechnicalRecognitionNote(technicalNote), true);
  assert.equal(operationalOrderNote(technicalNote), '');

  const shapeReviewNote = 'Visible shape side does not explain total length; shape requires review.';
  assert.equal(isTechnicalRecognitionNote(shapeReviewNote), true);
  assert.equal(operationalOrderNote(shapeReviewNote), '');

  const payload = buildIntakeOrderPayload({
    customer_name: 'לקוח',
    delivery_date: '2026-06-03',
    notes: technicalNote,
    items: [{ diameter: 10, length: 1000, quantity: 1 }],
  }, {
    calcWeightPerUnit: () => 1,
  });

  assert.equal(payload.order.generalNotes, '');
});

test('recognized customer name rejects contact-only email or phone values', () => {
  assert.equal(cleanRecognizedCustomerName('avidanfelzen@gmail.com'), '');
  assert.equal(cleanRecognizedCustomerName('0549811353'), '');
  assert.equal(cleanRecognizedCustomerName('לקוח ארזי הטנא'), 'לקוח ארזי הטנא');

  const payload = buildIntakeOrderPayload({
    customer_name: 'avidanfelzen@gmail.com',
    customer_phone: '0549811353',
    items: [{ diameter: 10, length: 1000, quantity: 1 }],
  }, {
    calcWeightPerUnit: () => 1,
  });

  assert.equal(payload.customer.name, 'Unidentified customer');
  assert.equal(payload.customer.phone, '0549811353');
});

test('parseManualIntakeText delegates whatsapp and manual parsing', () => {
  const whatsapp = parseManualIntakeText({
    text: 'hello',
    source: 'whatsapp',
    parseWhatsAppMessage: value => ({ channel: 'wa', value }),
    parseOCRText: () => ({ channel: 'ocr' }),
  });
  const manual = parseManualIntakeText({
    text: 'hello',
    source: 'phone',
    parseWhatsAppMessage: () => ({ channel: 'wa' }),
    parseOCRText: value => ({ channel: 'ocr', value }),
  });

  assert.equal(whatsapp.channel, 'wa');
  assert.equal(whatsapp.source, 'whatsapp');
  assert.equal(manual.channel, 'ocr');
  assert.equal(manual.source, 'phone');
});

test('resolveIntakeCustomer ranks customer candidates and removes duplicates', () => {
  const customer = { id: 9, name: 'לקוח א', phone: '0501234567', email: 'a@example.com', priority_id: 'C9' };
  const match = resolveIntakeCustomer({
    customer_phone: '050-1234567',
    customer_email: 'a@example.com',
    customer_name: 'לקוח א',
  }, '', {
    byPhone: () => customer,
    byEmail: () => customer,
    byName: () => customer,
  });

  assert.equal(match.customer.id, 9);
  assert.equal(match.customer.match_type, 'phone');
  assert.equal(match.needs_customer_review, false);
  assert.equal(match.candidates.length, 1);
});

test('resolveIntakeCustomer extracts email and phone from raw content when parsed data is partial', () => {
  const match = resolveIntakeCustomer({}, 'call 972501234567 or send to raw@example.com', {
    byPhone: phone => phone === '0501234567' ? { id: 3, name: 'טלפון', phone, email: null } : null,
    byEmail: email => ({ id: 4, name: 'מייל', phone: null, email }),
  });

  assert.equal(match.input.phone, '0501234567');
  assert.equal(match.input.email, 'raw@example.com');
  assert.equal(match.customer.id, 3);
});


test('uncertain intake fields create structured review notes', () => {
  const parsed = withStructuredReviewNotes({
    customer_name: '',
    delivery_date: '',
    notes: 'customer unclear and delivery date unclear',
    items: [{
      diameter: 5,
      quantity: 0,
      shape_name: '',
      note: 'diameter unclear, shape unclear, dimensions unclear',
    }],
  }, { sourceIdentity: null });

  const orderFields = parsed.review_notes
    .filter(note => note.scope === 'order')
    .map(note => note.field);
  const itemFields = parsed.items[0].review_notes.map(note => note.field);

  assert.ok(orderFields.includes('customer'));
  assert.ok(orderFields.includes('site_project'));
  assert.ok(orderFields.includes('delivery_date'));
  assert.ok(orderFields.includes('source_identity'));
  assert.ok(itemFields.includes('quantity'));
  assert.ok(itemFields.includes('diameter'));
  assert.ok(itemFields.includes('shape'));
  assert.ok(itemFields.includes('dimensions'));
  assert.equal(parsed.review_notes.every(note => typeof note === 'object' && note.field && note.code), true);
});

test('buildStructuredReviewNotes keeps old confident intake data usable without source identity', () => {
  const notes = buildStructuredReviewNotes({
    customer_name: 'Customer A',
    delivery_date: '2026-06-03',
    delivery_address: 'Site A',
    items: [{ diameter: 10, length: 1000, quantity: 2, shape_name: 'straight' }],
  });

  assert.deepEqual(notes.map(note => note.field), ['source_identity']);
});

test('buildIntakeOrderPayload maps OCR element name and description to order item fields', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Customer A',
    items: [{
      diameter: 12,
      length: 1000,
      quantity: 1,
      shape_name: 'straight',
      element_name: 'Wall element 103',
      shape_description: 'starter bars for wall',
    }],
  }, { calcWeightPerUnit: () => 1 });

  const item = payload.pallets[0].items[0];
  assert.equal(item.structElement, 'Wall element 103');
  assert.equal(item.struct_element, 'Wall element 103');
  assert.equal(item.note, 'starter bars for wall');
});

test('buildIntakeOrderPayload maps location aliases to struct element, not note', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Customer A',
    items: [{
      diameter: 12,
      length: 1000,
      quantity: 1,
      shape_name: 'straight',
      location: 'Beam A7',
      note: 'call before delivery',
    }],
  }, { calcWeightPerUnit: () => 1 });

  const item = payload.pallets[0].items[0];
  assert.equal(item.struct_element, 'Beam A7');
  assert.equal(item.structElement, 'Beam A7');
  assert.equal(item.note, 'call before delivery');
});

test('spreadsheet import maps Hebrew and English element columns to struct_element', () => {
  const hebrew = Buffer.from('customer_name,מיקום,diameter,quantity,length\nCustomer A,תקרה קומה 3,12,10,1200\n', 'utf8');
  const english = Buffer.from('customer_name,location,diameter,quantity,length\nCustomer B,Beam A7,16,4,2500\n', 'utf8');

  const hebrewPreview = buildOrderImportPreview(hebrew);
  const englishPreview = buildOrderImportPreview(english);

  const hebrewItem = hebrewPreview.orders[0].payload.pallets[0].items[0];
  const englishItem = englishPreview.orders[0].payload.pallets[0].items[0];
  assert.equal(hebrewItem.struct_element, 'תקרה קומה 3');
  assert.equal(hebrewItem.note, '');
  assert.equal(englishItem.struct_element, 'Beam A7');
  assert.equal(englishItem.note, '');
});

test('buildIntakeOrderPayload carries item review notes into draft order payload', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Customer A',
    delivery_date: '2026-06-03',
    delivery_address: 'Site A',
    source_identity: { source_system: 'ocr', external_id: 'doc-1' },
    items: [{
      diameter: 10,
      length: 1000,
      quantity: 2,
      shape_name: 'straight',
      note: 'quantity unclear',
    }],
  }, {
    calcWeightPerUnit: () => 1,
  });

  const itemNotes = payload.pallets[0].items[0].reviewNotes;
  assert.equal(Array.isArray(itemNotes), true);
  assert.ok(itemNotes.some(note => note.field === 'quantity' && note.scope === 'item'));
  assert.equal(payload.order.reviewNotes.some(note => note.field === 'quantity' && note.scope === 'item'), true);
});


test('buildIntakeOrderPayload adds full Shape V2 snapshot to OCR approval items', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Customer A',
    delivery_date: '2026-06-03',
    delivery_address: 'Site A',
    items: [{
      diameter: 12,
      segments: [
        { length_mm: 300, angle_deg: 90 },
        { length_mm: 600, angle_deg: 90 },
        { length_mm: 300, angle_deg: 0 },
      ],
      total_length_mm: 1200,
      quantity: 4,
      shape_name: 'U bar from OCR',
      note: 'manager checked OCR row',
    }],
  }, { calcWeightPerUnit: () => 1 });

  const item = payload.pallets[0].items[0];
  const snapshot = item.shapeSnapshot;
  assert.equal(item.qty, 4);
  assert.equal(snapshot.contractVersion, 2);
  assert.equal(snapshot.shapeVersion, 1);
  assert.equal(snapshot.shapeType, 'u_bar');
  assert.equal(snapshot.family, 'bars');
  assert.deepEqual(snapshot.data.sides, [300, 600, 300]);
  assert.deepEqual(snapshot.data.angles, [90, 90]);
  assert.equal(snapshot.data.diameter, 12);
  assert.equal(snapshot.calculated.totalLengthMm, 1200);
  assert.equal(snapshot.calculated.bendCount, 2);
  assert.equal(snapshot.machineOutput.generic.segments.length, 3);
  assert.ok(snapshot.machineOutput.machineProfiles.MEP);
  assert.ok(snapshot.machineOutput.machineProfiles.PEDAX);
  assert.ok(snapshot.machineOutput.machineProfiles.SCHNELL);
  assert.equal(snapshot.validation.valid, true);
  assert.equal(Object.hasOwn(snapshot, 'quantity'), false);
});

test('buildIntakeOrderPayload maps external OCR shape code through snapshot mapper', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Customer A',
    delivery_date: '2026-06-03',
    delivery_address: 'Site A',
    items: [{
      sourceSystem: 'TASSA',
      externalShapeCode: '103',
      diameter: 8,
      width: 950,
      height: 150,
      hookLength: 100,
      quantity: 4,
      shape_name: 'OCR coded stirrup',
    }],
  }, { calcWeightPerUnit: () => 1 });

  const item = payload.pallets[0].items[0];
  assert.equal(item.qty, 4);
  assert.equal(item.shape_review_status, 'ready');
  assert.equal(item.requires_shape_edit, false);
  assert.equal(item.shapeSnapshot.shapeType, 'closed_stirrup');
  assert.equal(item.shapeSnapshot.internalShapeCode, 'closed_stirrup_rect_hook');
  assert.equal(item.shapeSnapshot.calculated.totalLengthMm, 2400);
});

test('buildIntakeOrderPayload keeps legacy behavior without external shape code', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Customer A',
    items: [{
      diameter: 12,
      segments: [
        { length_mm: 300, angle_deg: 90 },
        { length_mm: 600, angle_deg: 0 },
      ],
      total_length_mm: 900,
      quantity: 2,
      shape_name: 'L shape',
    }],
  }, { calcWeightPerUnit: () => 1 });

  const item = payload.pallets[0].items[0];
  assert.equal(item.shapeSnapshot.shapeType, 'l_bar');
  assert.deepEqual(item.shapeSnapshot.data.sides, [300, 600]);
});

test('buildIntakeOrderPayload does not fallback to straight bar for unknown external code', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Customer A',
    items: [{
      sourceSystem: 'TASSA',
      externalShapeCode: '999',
      diameter: 8,
      length: 1000,
      quantity: 1,
      shape_name: 'unknown external shape',
    }],
  }, { calcWeightPerUnit: () => 1 });

  const item = payload.pallets[0].items[0];
  assert.equal(item.shapeSnapshot, undefined);
  assert.equal(item.requires_shape_edit, true);
  assert.equal(item.shape_review_status, 'requires_shape_edit');
  assert.equal(item.shape_review_reason, 'unmapped_external_shape_code');
  assert.ok(item.reviewNotes.some(note => note.code === 'unmapped_external_shape_code'));
});

test('buildIntakeOrderPayload does not fallback to straight bar for mapped external code without engine', () => {
  const payload = buildIntakeOrderPayload({
    customer_name: 'Customer A',
    items: [{
      sourceSystem: 'TASSA',
      externalShapeCode: '225',
      diameter: 8,
      width: 950,
      length: 1000,
      quantity: 1,
      shape_name: 'rounded end',
    }],
  }, { calcWeightPerUnit: () => 1 });

  const item = payload.pallets[0].items[0];
  assert.equal(item.shapeSnapshot, undefined);
  assert.equal(item.requires_shape_edit, true);
  assert.equal(item.shape_review_status, 'requires_shape_edit');
  assert.equal(item.shape_review_reason, 'shape_engine_not_available');
});
