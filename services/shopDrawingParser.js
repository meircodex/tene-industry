// The compact digital SHOP DRAWING export has its own column geometry.
// Numbers come only from the serial baseline, never from drawing labels.
const DIAMETERS = new Set([6, 8, 10, 12, 14, 16, 18, 20, 22, 25, 28, 32, 36, 40]);
const numeric = value => /^\d[\d,]*(?:\.\d+)?$/.test(String(value)) ? Number(String(value).replace(/,/g, '')) : null;
const center = word => (Number(word.x0) + Number(word.x1)) / 2;
const inBand = (word, lo, hi) => center(word) > lo && center(word) < hi;
function isShopDrawing({ text = '', tokens = [] } = {}) {
  const content = `${text} ${tokens.map(word => word.text).join(' ')}`;
  return /SHOP\s+DRAWING/i.test(content) && /Iron\s+bars/i.test(content)
    && /diameter/i.test(content) && /quantit[iy]+/i.test(content);
}
function sourceBox(words) {
  return { x0: Math.min(...words.map(w => w.x0)), y0: Math.min(...words.map(w => w.top)),
    x1: Math.max(...words.map(w => w.x1)), y1: Math.max(...words.map(w => w.bottom)) };
}
function parseShopDrawing(tokens) {
  const items = [], pages = new Map();
  for (const word of tokens) {
    if (!pages.has(word.page)) pages.set(word.page, []);
    pages.get(word.page).push(word);
  }
  for (const [page, words] of pages) {
    const marks = words.filter(w => inBand(w, 535, 560) && w.top > 180 && w.top < 620 && /^\d+$/.test(w.text)).sort((a, b) => a.top - b.top);
    const straightSection = /רשי\s+לזרב|ברזל\s+ישר/.test(words.map(w => w.text).join(' '));
    marks.forEach((mark, index) => {
      const baseline = words.filter(w => Math.abs(w.top - mark.top) < 1);
      const cell = (lo, hi) => {
        const found = baseline.filter(w => inBand(w, lo, hi) && numeric(w.text) !== null);
        return found.length === 1 ? { value: numeric(found[0].text), word: found[0] } : { value: null, word: null };
      };
      const serial = Number(mark.text), diameter = cell(250, 267), quantity = cell(213, 243), length = cell(150, 171);
      const weight = cell(45, 76), total = cell(108, 139), rate = cell(78, 105), barMark = cell(275, 288);
      const bottom = marks[index + 1] ? marks[index + 1].top - 2 : Math.min(mark.top + 60, 620);
      const region = words.filter(w => w.top >= mark.top - 1 && w.top < bottom);
      const dimensionWords = region.filter(w => inBand(w, 290, 455) && numeric(w.text) !== null);
      const dimensions = dimensionWords
        .map(w => ({ value_cm: numeric(w.text), source_page: page, source_bbox: sourceBox([w]) }));
      // This export denotes a closed hoop with a small corner closure symbol.
      // Its five callouts are two widths, two heights and one printed closure
      // allowance. Keep that allowance separate; never turn it into a side.
      const left = dimensionWords.filter(w => inBand(w, 290, 315)).map(w => numeric(w.text));
      const middle = dimensionWords.filter(w => inBand(w, 330, 430)).map(w => numeric(w.text));
      const right = dimensionWords.filter(w => inBand(w, 440, 455)).map(w => numeric(w.text));
      const allowance = length.value * 100 - 2 * (middle[0] || 0) - 2 * (right[0] || 0);
      const hoop = dimensions.length === 5 && left.length === 2 && middle.length === 2 && right.length === 1
        && middle[0] === middle[1] && allowance > 0
        && ((left[0] === right[0] && Math.abs(left[1] - allowance) < 0.01)
          || (left[1] === right[0] && Math.abs(left[0] - allowance) < 0.01));
      const description = region.filter(w => inBand(w, 455, 533)).map(w => w.text).join(' ');
      const errors = [];
      if (barMark.value !== serial) errors.push('bar_mark_conflict');
      if (!DIAMETERS.has(diameter.value)) errors.push('invalid_diameter');
      if (!Number.isSafeInteger(quantity.value) || quantity.value <= 0) errors.push('invalid_quantity');
      if (!(length.value > 0)) errors.push('invalid_length');
      if (!(total.value > 0) || Math.abs(total.value - quantity.value * length.value) > 0.051) errors.push('total_length_conflict');
      if (!(rate.value > 0) || !(weight.value > 0) || Math.abs(weight.value - rate.value * quantity.value * length.value) > 0.051) errors.push('source_weight_conflict');
      const straight = straightSection && dimensions.length === 1 && length.value > 0 && Math.abs(dimensions[0].value_cm - length.value * 100) < 0.01;
      if (!straight) errors.push('drawing_path_requires_review');
      const reviewNotes = errors.map(code => ({ scope: 'item', field: code === 'drawing_path_requires_review' ? 'shape' : 'source_table', code, severity: 'review',
        message: code === 'drawing_path_requires_review' ? 'יש לאמת צורת כיפוף, סדר צלעות, זוויות וסגירה מול שרטוט המקור לפני אישור.' : `Printed shop-drawing table requires review: ${code}`,
        source: 'shop_drawing_parser', item_index: items.length }));
      const field = (entry, scale = 1) => ({ value: entry.value === null ? null : Math.round(entry.value * scale * 1000) / 1000,
        confidence: entry.word ? 0.98 : 0.2, source_page: page, source_bbox: entry.word ? sourceBox([entry.word]) : null });
      const mm = length.value ? Math.round(length.value * 1000) : null;
      const cm = length.value ? Math.round(length.value * 100000) / 1000 : null;
      items.push({ original_row_number: mark.text, item_number: mark.text, element_name: description,
        diameter: diameter.value, quantity: quantity.value, qty: quantity.value,
        total_length_mm: mm, length_mm: mm, length: mm, total_length_cm: cm, unit_length_cm: cm,
        row_total_length_m: total.value, weight_kg: weight.value, source_kg_per_m: rate.value,
        shape_name: straight ? 'straight bar' : hoop ? 'חישוק סגור' : 'unknown', shape_type: straight ? 'straight' : hoop ? 'stirrup' : 'unknown', segments: [],
        shape_description: straight ? 'straight bar' : hoop ? `חישוק סגור ${middle[0]}×${right[0]} ס״מ; תוספת סגירה ${Math.round(allowance * 1000) / 1000} ס״מ` : 'כיפוף — יש לבדוק מול שרטוט המקור',
        ...(hoop ? { source_shape_parameters: { width_mm: middle[0] * 10, height_mm: right[0] * 10, closure_allowance_mm: Math.round(allowance * 10) } } : {}),
        source_drawing_dimensions: dimensions, review_status: 'needs_review', confidence: straight ? 0.98 : 0.4,
        uncertain_fields: reviewNotes.map(note => note.field), review_notes: reviewNotes,
        fields: { item_number: field({ value: serial, word: mark }), diameter: field(diameter), quantity: field(quantity), total_length_cm: field(length, 100), weight_kg: field(weight) },
        source_ref: { page, bbox: sourceBox(region), row_text: region.map(w => w.text).join(' ') },
        source_numeric_checks_passed: errors.every(code => code === 'drawing_path_requires_review') });
    });
  }
  if (!items.every((item, index) => Number(item.item_number) === index + 1)) for (const item of items) {
    item.source_numeric_checks_passed = false;
    item.review_notes.push({ scope: 'item', field: 'item_number', code: 'non_contiguous_serials', severity: 'review',
      message: 'Shop-drawing serial numbers are duplicated, missing or out of order.', source: 'shop_drawing_parser' });
  }
  return { items, row_reconstruction: items.map((item, index) => ({ index, ...item.source_ref })) };
}
module.exports = { isShopDrawing, parseShopDrawing };
