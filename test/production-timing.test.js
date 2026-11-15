'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const Database = require('better-sqlite3');
const { ensureCoreSchema } = require('../db/coreSchema');
const { deductIntervals, shapeProfile, reportProductionTiming } = require('../services/productionTiming');

function createDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  ensureCoreSchema(db);
  return db;
}

function seedBase(db) {
  db.prepare("INSERT INTO orders (id,order_num) VALUES (1,'TIME-001'),(2,'TIME-002')").run();
  db.prepare('INSERT INTO pallets (id,order_id,pallet_num) VALUES (1,1,1),(2,2,1)').run();
  db.prepare("INSERT INTO machines (id,name,label) VALUES (1,'A','A')").run();
}

function seedItem(db, values = {}) {
  const snapshot = values.snapshot || null;
  db.prepare(`
    INSERT INTO items
      (id,pallet_id,order_id,shape_id,shape_name,diameter,total_length_mm,quantity,produced_qty,total_weight,actual_weight_kg,status,machine,segments,shape_snapshot_json,started_at,completed_at)
    VALUES (@id,@pallet_id,@order_id,@shape_id,@shape_name,@diameter,@total_length_mm,@quantity,@produced_qty,@total_weight,@actual_weight_kg,'הושלם',@machine,@segments,@shape_snapshot_json,@started_at,@completed_at)
  `).run({
    id: values.id,
    pallet_id: values.pallet_id || 1,
    order_id: values.order_id || 1,
    shape_id: values.shape_id || 's2',
    shape_name: values.shape_name || 'L',
    diameter: values.diameter || 12,
    total_length_mm: values.total_length_mm || 1000,
    quantity: values.quantity || 10,
    produced_qty: values.produced_qty ?? values.quantity ?? 10,
    total_weight: values.total_weight || 10,
    actual_weight_kg: values.actual_weight_kg ?? null,
    machine: values.machine || 'A',
    segments: values.segments || JSON.stringify([{ length_mm: 800, angle_deg: 90 }, { length_mm: 200 }]),
    shape_snapshot_json: snapshot ? JSON.stringify(snapshot) : null,
    started_at: values.started_at || null,
    completed_at: values.completed_at,
  });
}

test('production timing deducts only the actual lunch overlap and avoids double-deducting documented stops', () => {
  const start = new Date('2026-08-13T08:50:00.000Z'); // 11:50 in Israel
  const end = new Date('2026-08-13T10:00:00.000Z');   // 13:00 in Israel
  const result = deductIntervals(start, end, [
    { start: new Date('2026-08-13T09:10:00.000Z'), end: new Date('2026-08-13T09:50:00.000Z') }, // 12:10–12:50
  ]);
  assert.equal(result.lunchMinutes, 45);
  assert.equal(result.documentedStopMinutes, 5);
  assert.equal(result.deductedMinutes, 50);
});

test('production timing keeps the complete canonical geometry in its recipe fingerprint', () => {
  const first = shapeProfile({
    shape_id: 's2', shape_name: 'L', diameter: 12, total_length_mm: 1000,
    segments: JSON.stringify([{ length_mm: 800, angle_deg: 90 }, { length_mm: 200 }]),
  });
  const second = shapeProfile({
    shape_id: 's2', shape_name: 'L', diameter: 12, total_length_mm: 1000,
    segments: JSON.stringify([{ length_mm: 800, angle_deg: 135 }, { length_mm: 200 }]),
  });
  assert.equal(first.bendCount, 1);
  assert.deepEqual(first.bendAngles, [90]);
  assert.notEqual(first.fingerprint, second.fingerprint);
});

test('production timing reports net time, cut metres, rates and coil loading without inventing incomplete timing', () => {
  const db = createDb();
  try {
    seedBase(db);
    seedItem(db, {
      id: 1, started_at: '2026-08-13T05:00:00.000Z', completed_at: '2026-08-13T09:30:00.000Z',
      actual_weight_kg: 12,
    });
    seedItem(db, {
      id: 2, pallet_id: 2, order_id: 2, started_at: '2026-08-13T10:15:00.000Z', completed_at: '2026-08-13T11:15:00.000Z',
      actual_weight_kg: 8,
    });
    seedItem(db, {
      id: 3, pallet_id: 2, order_id: 2, completed_at: '2026-08-13T12:00:00.000Z',
      actual_weight_kg: 7,
    });
    // Breakdown during card 1: 10 minutes. Coil loading occurs between cards,
    // partly during the fixed lunch break and partly after it.
    db.prepare(`INSERT INTO machine_stops (machine_id,reason_code,started_at,ended_at,duration_min) VALUES
      (1,'BREAKDOWN','2026-08-13T06:00:00.000Z','2026-08-13T06:10:00.000Z',10),
      (1,'COIL_LOAD','2026-08-13T09:40:00.000Z','2026-08-13T09:55:00.000Z',15)
    `).run();

    const report = reportProductionTiming(db, { fromDate: '2026-08-13', toDate: '2026-08-13' });
    const card1 = report.cards.find(card => card.item_id === 1);
    assert.equal(card1.measurement_status, 'measured');
    assert.equal(card1.gross_minutes, 270);
    assert.equal(card1.lunch_minutes, 30);
    assert.equal(card1.documented_stop_minutes, 10);
    assert.equal(card1.net_minutes, 230);
    assert.equal(card1.cut_length_mm, 10000);
    assert.equal(card1.total_bends, 10);
    assert.equal(card1.meters_per_min, 0.0435);
    assert.equal(card1.kg_per_min, 0.0522);
    assert.equal(card1.weight_source, 'measured');

    const missing = report.cards.find(card => card.item_id === 3);
    assert.equal(missing.measurement_status, 'missing_start');
    assert.equal(missing.net_minutes, null);
    assert.equal(missing.meters_per_min, null);

    assert.equal(report.transitions.length, 1);
    const transition = report.transitions[0];
    assert.equal(transition.previous_item_id, 1);
    assert.equal(transition.item_id, 2);
    assert.equal(transition.gross_gap_minutes, 45);
    assert.equal(transition.lunch_minutes, 15);
    assert.equal(transition.documented_stop_minutes, 10);
    assert.equal(transition.coil_load_minutes, 15);
    assert.equal(transition.transition_minutes, 20);

    const machine = report.machines.find(row => row.machine === 'A');
    assert.equal(machine.measured_cards, 2);
    assert.equal(machine.unmeasured_cards, 1);
    assert.equal(machine.coil_load_minutes, 15);
    assert.equal(machine.transition_minutes, 20);
    assert.ok(machine.meters_per_min > 0);
    assert.ok(machine.kg_per_min > 0);

    const order = report.orders.find(row => row.order_num === 'TIME-001');
    assert.equal(order.measured_cards, 1);
    assert.equal(order.unmeasured_cards, 0);
    assert.equal(order.net_minutes, 230);
    assert.equal(order.cut_length_mm, 10000);
    assert.equal(order.weight_kg, 12);
    assert.deepEqual(order.profiles, ['L · Ø12 מ״מ']);

    const dailyDiameter = report.daily_diameters.find(row => row.date === '2026-08-13' && row.diameter_mm === 12);
    assert.ok(dailyDiameter);
    assert.equal(dailyDiameter.completed_cards, 3);
    assert.equal(dailyDiameter.measured_cards, 2);
    assert.equal(dailyDiameter.unmeasured_cards, 1);
    assert.equal(dailyDiameter.quantity, 30);
    assert.equal(dailyDiameter.cut_length_mm, 30000);
    assert.equal(dailyDiameter.weight_kg, 27);
    assert.equal(dailyDiameter.measured_weight_kg, 27);
    assert.equal(dailyDiameter.estimated_weight_kg, 0);
    assert.equal(dailyDiameter.net_minutes, 290);
    assert.equal(dailyDiameter.measured_cut_length_mm, 20000);
    assert.equal(dailyDiameter.timed_weight_kg, 20);
    assert.equal(dailyDiameter.meters_per_min, 0.069);
    assert.equal(dailyDiameter.kg_per_min, 0.069);
    assert.equal(dailyDiameter.coil_load_minutes, 15);
    assert.equal(dailyDiameter.weight_source, 'measured');
  } finally {
    db.close();
  }
});

test('production timing subtracts lunch separately on every Israel calendar day', () => {
  const db = createDb();
  try {
    seedBase(db);
    seedItem(db, {
      id: 1,
      // 11:50 on 13/8 Israel through 12:50 on 14/8 Israel.
      started_at: '2026-08-13T08:50:00.000Z',
      completed_at: '2026-08-14T09:50:00.000Z',
      actual_weight_kg: 10,
    });
    const report = reportProductionTiming(db, { fromDate: '2026-08-14', toDate: '2026-08-14', workingDays:[0,1,2,3,4,5] });
    const card = report.cards[0];
    assert.equal(card.lunch_minutes, 90);
    assert.equal(card.gross_minutes, 1500);
    assert.equal(card.outside_work_minutes, 780);
    assert.equal(card.net_minutes, 630);
  } finally {
    db.close();
  }
});

test('missing weighing uses theoretical mass and untimed completed work stays in totals, never in pace',()=>{
 const db=createDb();try{
  seedBase(db);
  seedItem(db,{id:1,started_at:'2026-11-15T06:00:00Z',completed_at:'2026-11-15T07:00:00Z',total_weight:120});
  seedItem(db,{id:2,completed_at:'2026-11-15T08:00:00Z',total_weight:240});
  const report=reportProductionTiming(db,{fromDate:'2026-11-15',toDate:'2026-11-15'});
  assert.equal(report.cards.find(x=>x.item_id===1).weight_source,'theoretical');
  assert.equal(report.cards.find(x=>x.item_id===1).weight_kg,120);
  assert.equal(report.daily_diameters[0].estimated_weight_kg,360);
  for(const row of [report.machines[0],report.orders[0]]){
   assert.equal(row.weight_kg,360);assert.equal(row.cut_length_mm,20000);
   assert.equal(row.kg_per_min,2);assert.equal(row.meters_per_min,0.1667);
   assert.equal(row.measured_cards,1);assert.equal(row.unmeasured_cards,1);
  }
 }finally{db.close();}
});

test('work clock excludes closing hours, partial boundary overlaps, weekends when configured, and overlapping stops',()=>{
 const check=(start,end,stops=[],calendar)=>deductIntervals(new Date(start),new Date(end),stops,calendar);
 // Israel winter: 17:00 Sunday through 08:00 Monday = 900 elapsed, 120 work minutes.
 assert.equal(check('2026-11-15T15:00:00Z','2026-11-16T06:00:00Z').outsideWorkMinutes,780);
 assert.equal(check('2026-11-15T15:00:00Z','2026-11-16T06:00:00Z').deductedMinutes,780);
 assert.equal(check('2026-11-15T04:30:00Z','2026-11-15T05:30:00Z').outsideWorkMinutes,30);
 assert.equal(check('2026-11-15T16:30:00Z','2026-11-15T22:00:00Z').deductedMinutes,330);
 // No overlap is deducted twice when a documented stop crosses closing time.
 const stop={start:new Date('2026-11-15T15:30:00Z'),end:new Date('2026-11-16T05:30:00Z')};
 const result=check('2026-11-15T15:00:00Z','2026-11-16T06:00:00Z',[stop,stop]);
 assert.equal(result.documentedStopMinutes,60);assert.equal(result.deductedMinutes,840);
 const weekend=check('2026-11-13T15:00:00Z','2026-11-15T06:00:00Z',[],{workingDays:[0,1,2,3,4,5]});
 assert.equal(weekend.deductedMinutes,2280); // Friday after 14:00 and all Saturday are closed.
 // Summer opening follows Israel local time (07:00 = 04:00 UTC).
 assert.equal(check('2026-08-13T03:30:00Z','2026-08-13T04:30:00Z').outsideWorkMinutes,30);
});

test('Friday is closed without production scans, opens 07–14 with scan evidence, and Saturday stays closed',()=>{
 const db=createDb();try{
  seedBase(db);seedItem(db,{id:1,started_at:'2026-11-12T15:00:00Z',completed_at:'2026-11-15T06:00:00Z'});
  const report=()=>reportProductionTiming(db,{fromDate:'2026-11-15',toDate:'2026-11-15'});
  assert.equal(report().cards[0].net_minutes,120);
  db.prepare("INSERT INTO scan_log(item_id,action,scanned_at)VALUES(1,'start','2026-11-13 06:00:00')").run();
  assert.equal(report().cards[0].net_minutes,495);
  assert.equal(report().cards[0].lunch_minutes,45);
 }finally{db.close();}
});

test('opening a Friday card is not production evidence; an explicit scanned start is, without rewriting history',()=>{
 const db=createDb();try{
  seedBase(db);seedItem(db,{id:1,started_at:'2026-11-12T15:00:00Z',completed_at:'2026-11-15T06:00:00Z'});
  db.exec('CREATE TABLE worker_card_activity(action TEXT,details_json TEXT,occurred_at TEXT)');
  const report=()=>reportProductionTiming(db,{fromDate:'2026-11-15',toDate:'2026-11-15'});
  db.prepare("INSERT INTO worker_card_activity VALUES('opened','{}','2026-11-13 06:00:00')").run();
  assert.equal(report().cards[0].net_minutes,120);
  db.prepare("INSERT INTO worker_card_activity VALUES('status_changed',?,'2026-11-13 06:01:00')").run(JSON.stringify({to_status:'בייצור',correction:false}));
  const before=db.prepare('SELECT * FROM items').all();
  assert.equal(report().cards[0].net_minutes,495);
  assert.deepEqual(db.prepare('SELECT * FROM items').all(),before);
 }finally{db.close();}
});
