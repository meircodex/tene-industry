const test=require('node:test'),assert=require('node:assert/strict'),D=require('better-sqlite3');
const {classify,ensureReviews}=require('../services/productionTimingReliability');
function fixture(t){const db=new D(':memory:');db.exec('CREATE TABLE inventory_reservations(item_id INTEGER,material_type TEXT)');ensureReviews(db);t.after(()=>db.close());return db;}
function card(id,minutes=10,type='coil'){return {item_id:id,started_at:'2026-11-15T07:00:00Z',completed_at:'2026-11-15T08:00:00Z',timing_end_source:'scan',measurement_status:'measured',quantity:100,weight_kg:100,unitCutLengthMm:6000,cut_length_mm:600000,net_minutes:minutes,gross_minutes:minutes,meters_per_min:600/minutes,machine_id:1,machine:'MEP',fingerprint:'shape-12-L'};}
function seed(db,cards,type='coil'){for(const c of cards)db.prepare('INSERT INTO inventory_reservations VALUES(?,?)').run(c.item_id,type);classify(db,cards);}
function approve(db,c){db.prepare("INSERT INTO production_timing_reviews(item_id,measurement_key,decision,reason)VALUES(?,?,'include','verified by manager')").run(c.item_id,c.measurement_key);}
test('only approved comparable peers establish a baseline; extreme fast/slow recordings never contaminate it',t=>{
 const db=fixture(t),cards=Array.from({length:8},(_,i)=>card(i+1,i===6?.04:i===7?40:10));seed(db,cards);
 assert.ok(cards.every(c=>!c.included_in_statistics));for(const c of cards.slice(0,5))approve(db,c);classify(db,cards);
 assert.equal(cards[5].reliability_status,'reliable');assert.equal(cards[5].included_in_statistics,true);
 for(const c of cards.slice(6)){assert.equal(c.reliability_status,'review');assert.equal(c.included_in_statistics,false);assert.equal(c.reliability_comparison.approved_peers,5);}
 assert.ok(cards[6].reliability_reasons.some(s=>s.includes('דיווח בדיעבד')));
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
