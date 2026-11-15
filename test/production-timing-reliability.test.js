const test=require('node:test'),assert=require('node:assert/strict'),D=require('better-sqlite3');
const {classify,ensureReviews}=require('../services/productionTimingReliability');
function fixture(t){const db=new D(':memory:');db.exec('CREATE TABLE inventory_reservations(item_id INTEGER,material_type TEXT)');ensureReviews(db);t.after(()=>db.close());return db;}
function card(id,minutes=20,type='coil'){return {item_id:id,started_at:'2026-11-15T07:00:00Z',completed_at:'2026-11-15T08:00:00Z',timing_end_source:'scan',measurement_status:'measured',quantity:100,weight_kg:100,unitCutLengthMm:6000,cut_length_mm:600000,net_minutes:minutes,gross_minutes:minutes,meters_per_min:600/minutes,machine_id:1,machine:'MEP',fingerprint:'shape-12-L'};}
function seed(db,cards,type='coil'){for(const c of cards)db.prepare('INSERT INTO inventory_reservations VALUES(?,?)').run(c.item_id,type);classify(db,cards);}
function approve(db,c){db.prepare("INSERT INTO production_timing_reviews(item_id,measurement_key,decision,reason)VALUES(?,?,'include','verified by manager')").run(c.item_id,c.measurement_key);}
test('plausible throughput is reliable without peers, short and extreme recordings stay excluded',t=>{
 const db=fixture(t),normal=card(1,20),upper=card(2,10),fast=card(3,.04),slow=card(4,4500),short={...card(5,.5),cut_length_mm:10000,meters_per_min:20};
 seed(db,[normal,upper,fast,slow,short]);
 for(const c of [normal,upper])assert.equal(c.included_in_statistics,true);
 for(const c of [fast,slow,short])assert.equal(c.included_in_statistics,false);
 assert.ok(fast.reliability_reasons.some(s=>s.includes('60 מטר')));assert.ok(short.reliability_reasons.some(s=>s.includes('פחות מדקה')));
});

test('coil <=1 metre/minute requires review, lifts have a distinct manager policy, missing data is unreliable',t=>{
 const db=fixture(t),slow=card(1,600),lift=card(2),missing={...card(3),measurement_status:'missing_start',net_minutes:null,measurement_reason:'missing scan'};
 seed(db,[slow,missing]);seed(db,[lift],'straight');classify(db,[slow,lift,missing]);
 assert.equal(slow.reliability_status,'review');assert.ok(slow.reliability_reasons.some(x=>x.includes('מטר לדקה')));
 assert.equal(lift.reliability_status,'review');assert.ok(lift.reliability_reasons.some(x=>x.includes('ליפטים')));
 assert.equal(missing.reliability_status,'unreliable');assert.ok(!missing.included_in_statistics);
});
test('manager decisions are tied to a measurement snapshot, including geometry, quantity and deducted time',t=>{
 const db=fixture(t),c=card(1);seed(db,[c]);approve(db,c);classify(db,[c]);assert.equal(c.included_in_statistics,true);
 c.quantity=101;classify(db,[c]);assert.equal(c.review_stale,true);assert.equal(c.included_in_statistics,false);
 c.quantity=100;c.geometry_revision='changed full geometry snapshot';classify(db,[c]);assert.equal(c.included_in_statistics,false);
 c.geometry_revision=undefined;classify(db,[c]);db.prepare("UPDATE production_timing_reviews SET decision='exclude'").run();classify(db,[c]);assert.equal(c.reliability_status,'unreliable');assert.equal(c.included_in_statistics,false);
});

test('all four reported reasonable cards are accepted without prior approvals',t=>{
 const db=fixture(t),cards=[[1874,12.2833,27.4],[1873,31.6333,10.87],[1872,3.2167,18.31],[1871,22.85,7.14]].map(([id,time,pace])=>({...card(id,time),meters_per_min:pace}));
 seed(db,cards);assert.ok(cards.every(c=>c.included_in_statistics));
});
test('capacity boundaries need no strand documentation, and an old approval cannot permit impossible throughput',t=>{
 const db=fixture(t),cards=[card(1,20),card(2,10),card(3,9.99),card(4,600),card(5,599)];seed(db,cards);
 assert.deepEqual(cards.map(c=>c.included_in_statistics),[true,true,false,false,true]);
 approve(db,cards[2]);classify(db,cards);assert.equal(cards[2].reliability_status,'unreliable');assert.ok(!cards[2].included_in_statistics);
});

test('realistic sub-minute work is held for review, and review approval remains attached to the original measurement',t=>{
 const db=fixture(t),c={...card(1,.5),quantity:1,unitCutLengthMm:10000,cut_length_mm:10000,meters_per_min:20};seed(db,[c]);
 assert.equal(c.reliability_status,'review');assert.equal(c.included_in_statistics,false);approve(db,c);classify(db,[c]);assert.equal(c.included_in_statistics,true);
});
