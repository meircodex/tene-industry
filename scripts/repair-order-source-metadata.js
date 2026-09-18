'use strict';

const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');

const ORDER_NUM = 'HZ-2026-084';
const SOURCE_ROWS = new Map([
  [6,1], [11,2], [16,3], [21,4], [26,5], [31,6], [36,7], [41,8], [46,9], [51,10],
  [56,11], [61,12], [66,13], [71,14], [76,15], [81,16], [86,17], [91,18], [96,19], [102,20],
  [107,21], [112,22], [117,23], [122,24], [127,25], [132,26], [137,27], [142,28], [147,29], [152,30],
  [157,31], [162,32], [167,33], [172,34], [177,35], [182,36], [187,37], [192,38], [197,39], [202,40],
  [207,43], [212,44], [217,45], [222,46], [227,47], [232,48], [237,49], [242,50], [247,51], [252,52],
  [257,53], [262,54], [267,55], [272,56], [277,57], [282,58], [287,59], [292,60], [297,61], [302,62],
  [307,63], [312,64], [317,65], [322,66], [327,67], [332,68], [337,69], [342,70], [347,71], [351,75],
  [356,76], [361,77], [366,78], [371,79], [376,80], [381,81], [386,82], [391,83], [396,84], [401,85],
  [407,86], [412,87], [417,86], [422,87], [427,88], [432,89], [437,90], [442,91], [447,92], [452,93],
  [457,94], [462,95], [467,96], [472,97], [477,99], [482,100], [487,101], [492,102], [497,103], [502,104],
  [507,105], [512,106], [517,107], [522,108], [527,109],
]);

function sourceRowFromNote(note) {
  const match = String(note || '').match(/מקור:\s*שורה\s*(\d+)\s*בקובץ/);
  return match ? Number(match[1]) : null;
}

const dbPath = process.env.DB_PATH || 'ironbend.db';
const apply = process.argv.includes('--apply');
const db = new Database(dbPath);

try {
  ensureCoreSchema(db);
  const order = db.prepare('SELECT id, order_num, status FROM orders WHERE order_num=?').get(ORDER_NUM);
  if (!order) throw new Error(`${ORDER_NUM} was not found`);
  if (!['ממתינה לאישור', 'ממתינה לאישור לקוח'].includes(String(order.status || ''))) {
    throw new Error(`${ORDER_NUM} is no longer pending approval (status: ${order.status || 'empty'})`);
  }

  const items = db.prepare(`
    SELECT id, note, struct_element
    FROM items
    WHERE order_id=?
    ORDER BY id
  `).all(order.id);
  if (items.length !== SOURCE_ROWS.size) {
    throw new Error(`expected ${SOURCE_ROWS.size} items, found ${items.length}`);
  }

  const prepared = items.map((item, index) => {
    const sourceRow = sourceRowFromNote(item.note);
    const sourceItemNumber = SOURCE_ROWS.get(sourceRow);
    if (!sourceItemNumber) throw new Error(`item ${item.id} has no recognized source row in its note`);
    const correctedElement = sourceRow === 407
      ? 'טיפוס E 1217/913/60 / חישוק חיצוני Φ8@20'
      : sourceRow === 412
        ? 'טיפוס E 1217/913/60 / חישוק פנימי 2Φ8@20'
        : null;
    // These two workbook rows have a blank item name.  Keep their reviewed
    // names deterministic even if an earlier import guessed the wrong ring.
    const element = correctedElement || String(item.struct_element || '').trim();
    if (!element) throw new Error(`item ${item.id}, source row ${sourceRow}, has no element name`);
    return { id: item.id, sourceRow, sourceItemNumber: String(sourceItemNumber), sortOrder: index + 1, element };
  });

  console.log(JSON.stringify({
    mode: apply ? 'apply' : 'dry-run',
    order: ORDER_NUM,
    items: prepared.length,
    first: prepared[0],
    last: prepared[prepared.length - 1],
  }, null, 2));

  if (apply) {
    const update = db.prepare(`
      UPDATE items
      SET source_item_number=?, source_row_number=?, sort_order=?, struct_element=?
      WHERE id=? AND order_id=?
    `);
    const repair = db.transaction(() => {
      for (const item of prepared) {
        const result = update.run(item.sourceItemNumber, item.sourceRow, item.sortOrder, item.element, item.id, order.id);
        if (result.changes !== 1) throw new Error(`failed to update item ${item.id}`);
      }
    });
    repair();
    console.log(`updated ${prepared.length} items for ${ORDER_NUM}`);
  }
} finally {
  db.close();
}
