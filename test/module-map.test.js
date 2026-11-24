'use strict';

const assert = require('node:assert/strict');
const { readdirSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { createModuleMapService } = require('../services/moduleMap');

const routesDir = path.join(__dirname, '..', 'routes');
const orders = { file: 'routes/orders.js', factory: require('../routes/orders') };
const logistics = { file: 'routes/logistics.js', factory: require('../routes/logistics') };
const production = { file: 'routes/production.js', factory: require('../routes/production') };

test('מפת המודולים דורשת פונקציה לקבלת נתוני אירועים', () => {
  assert.throws(() => createModuleMapService(), {
    message: 'services/moduleMap missing dependency: getEventStats',
  });
});

test('מפת המודולים ממיינת מניפסטים, מדלגת על נתיב ללא מניפסט ומנרמלת קישורים', () => {
  const logisticsWithStringLinks = {
    ...logistics,
    factory: {
      manifest: {
        ...logistics.factory.manifest,
        consumes: ['order_status', { table: 'deliveries' }],
        produces: ['delivery_depart', { event: 'delivery_confirm' }],
      },
    },
  };
  const map = createModuleMapService({
    routeModules: [orders, { file: production.file, factory() {} }, logisticsWithStringLinks],
    getEventStats: () => [],
  });

  const manifests = map.manifests();
  assert.deepEqual(manifests.map(({ id }) => id), ['logistics', 'orders']);
  assert.deepEqual(manifests[0], {
    id: 'logistics',
    label: 'משלוחים',
    file: logistics.file,
    consumes: [{ event: 'order_status' }, { table: 'deliveries' }],
    produces: [{ event: 'delivery_depart' }, { event: 'delivery_confirm' }],
  });
});

test('מפת המודולים יוצרת זרימה לכל צרכן ויעד ריק לאירוע ללא צרכנים', () => {
  const map = createModuleMapService({
    routeModules: [production, orders, logistics],
    getEventStats: () => [],
  });

  const { flows } = map.snapshot();
  assert.deepEqual(
    flows.filter(({ from, event }) => from === 'orders' && event === 'order_status').map(({ to }) => to),
    ['logistics', 'production'],
  );
  assert.deepEqual(flows.filter(({ from, event }) => from === 'logistics' && event === 'delivery_depart'), [
    { from: 'logistics', event: 'delivery_depart', count: 0, lastSeen: null, status: 'never_seen', to: null },
  ]);
});

test('מפת המודולים קובעת את מצב הזרימה לפי שעון קבוע', (t) => {
  const now = Date.parse('2026-11-24T10:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now });

  const events = [
    { type: 'order_status', count: 2, lastSeen: '2026-11-23T10:00:00.000Z' },
    { type: 'order_updated', count: 1, lastSeen: '2026-11-23T09:59:59.999Z' },
    { type: 'order_deleted', count: 1, lastSeen: 'invalid' },
  ];
  const map = createModuleMapService({ routeModules: [orders], getEventStats: () => events });

  const { generatedAt, flows } = map.snapshot();
  assert.equal(generatedAt, '2026-11-24T10:00:00.000Z');
  const flowsByEvent = new Map(flows.map(({ event, count, lastSeen, status }) => [event, { count, lastSeen, status }]));
  assert.deepEqual(flowsByEvent.get('new_order'), { count: 0, lastSeen: null, status: 'never_seen' });
  assert.deepEqual(flowsByEvent.get('order_status'), { count: 2, lastSeen: events[0].lastSeen, status: 'active' });
  assert.deepEqual(flowsByEvent.get('order_updated'), { count: 1, lastSeen: events[1].lastSeen, status: 'stale' });
  assert.deepEqual(flowsByEvent.get('order_deleted'), { count: 1, lastSeen: 'invalid', status: 'unknown' });
});

test('מזהי המניפסטים המוצהרים בקובצי הנתיבים ייחודיים', () => {
  const files = readdirSync(routesDir, { withFileTypes: true });
  const fileById = new Map();

  for (const file of files) {
    if (!file.isFile() || !file.name.endsWith('.js')) continue;
    const id = require(path.join(routesDir, file.name)).manifest?.id;
    if (id === undefined) continue;

    assert.ok(!fileById.has(id), `מזהה מניפסט כפול ${id} בקבצים ${fileById.get(id)} ו-${file.name}`);
    fileById.set(id, file.name);
  }
});
