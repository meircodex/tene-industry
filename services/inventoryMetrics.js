'use strict';
const {kg,materialOnHand}=require('./materialBalance');

// Read-only reporting. Counter history is diagnostic, never actual production.
const utcTime=value=>Date.parse(/[zZ]$|[+-]\d\d:\d\d$/.test(String(value))?value:String(value).replace(' ','T')+'Z');
function buildInventoryMetrics(db) {
  const lots=db.prepare('SELECT * FROM raw_material').all();
  const stocked=lots.filter(l=>l.active===1 && (l.verification_status||'approved')==='approved' && materialOnHand(l)>0.0005);
  const completionPolicy=require('./inventoryItemCompletion').policy(db);
  const baseline=completionPolicy?db.prepare('SELECT id,counted_at,created_at FROM inventory_stocktakes WHERE id=?').get(completionPolicy.stocktake_id):db.prepare('SELECT id,counted_at,created_at FROM inventory_stocktakes ORDER BY julianday(created_at) DESC,id DESC LIMIT 1').get()||null;
  const historicalUsed=kg(lots.reduce((n,l)=>n+Number(l.weight_used||0),0));
  const gaps={legacy_active_reservations:db.prepare("SELECT COUNT(*) n FROM inventory_reservations r JOIN orders o ON o.id=r.order_id WHERE r.status='active' AND COALESCE(r.consumption_mode,'legacy')='legacy' AND o.status NOT IN ('בוטל','cancelled','canceled')").get().n,
    historical_consumed_without_usage:db.prepare("SELECT COUNT(*) n FROM inventory_reservations r WHERE r.status='consumed' AND NOT EXISTS(SELECT 1 FROM raw_material_usage u WHERE u.order_id=r.order_id AND (u.item_id=r.item_id OR (u.item_id IS NULL AND r.item_id IS NULL)))").get().n};
  const result={generated_at:new Date().toISOString(),stocked_lots:stocked.length,stocked_diameters:new Set(stocked.map(l=>Number(l.diameter))).size,baseline,
    recorded_net_kg:null,verified_consumption_kg:null,status:'no_baseline',issues:[],gaps,historical_used_counter_kg:historicalUsed};
  if(!baseline)return result;
  const since=baseline.created_at;
  const legacy=db.prepare('SELECT * FROM raw_material_usage WHERE julianday(used_at)>=julianday(?)').all(since);
  const events=db.prepare(`SELECT e.event_type,e.approved_at,l.raw_material_id,l.consumed_kg FROM material_consumption_events_v2 e JOIN material_consumption_event_lines_v2 l ON l.consumption_event_id=e.id WHERE julianday(e.approved_at)>=julianday(?)`).all(since);
  const byLot=new Map();
  const add=(id,value)=>byLot.set(id,kg((byLot.get(id)||0)+Number(value)));
  for(const row of legacy)add(row.raw_material_id,row.weight_used);
  for(const row of events)add(row.raw_material_id,(row.event_type==='reversal'?-1:1)*row.consumed_kg);
  const knownPolicies=new Set(['production_completion','item_completion_reconciliation']);
  result.recorded_net_kg=kg(legacy.filter(r=>knownPolicies.has(r.allocation_policy)).reduce((n,r)=>n+Number(r.weight_used),0)+events.reduce((n,r)=>n+(r.event_type==='reversal'?-1:1)*Number(r.consumed_kg),0));
  if(gaps.legacy_active_reservations)result.issues.push('legacy_orders_not_covered');
  if(legacy.some(r=>!knownPolicies.has(r.allocation_policy)))result.issues.push('unverified_legacy_movements');
  const snapshots=new Map();
  for(const row of db.prepare('SELECT raw_material_id,before_snapshot_json FROM inventory_stocktake_lines WHERE stocktake_id=?').all(baseline.id)) {
    try { const s=JSON.parse(row.before_snapshot_json); if(!s.lot || !Number.isFinite(Number(s.lot.weight_used)))throw Error(); snapshots.set(row.raw_material_id,Number(s.lot.weight_used)); }
    catch(_){result.issues.push('invalid_count_snapshot');}
  }
  for(const lot of lots) {
    const atBaseline=snapshots.get(lot.id);
    if(atBaseline===undefined && (!Number.isFinite(utcTime(lot.created_at)) || utcTime(lot.created_at)<=utcTime(since))) {result.issues.push('partial_count_baseline');continue;}
    if(Math.abs(kg(Number(lot.weight_used||0)-(atBaseline??0))-(byLot.get(lot.id)||0))>0.01)result.issues.push('counter_ledger_mismatch');
  }
  if([...byLot.keys()].some(id=>!lots.some(l=>l.id===id)))result.issues.push('orphaned_movements');
  result.issues=[...new Set(result.issues)];
  result.status=result.issues.length?'needs_reconciliation':'recorded_only';
  // Even a reconciled journal proves recorded movements, not unreported shop-floor use.
  return result;
}
function inventoryMetrics(db){return db.transaction(()=>buildInventoryMetrics(db))();}
module.exports={inventoryMetrics};
