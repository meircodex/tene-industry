'use strict';

const crypto = require('node:crypto');
const { kg, materialOnHand } = require('./materialBalance');
const fail = code => { throw Object.assign(new Error(code), { code, statusCode: 409 }); };
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function normalize(input) {
  const countedAt = String(input.counted_at || '');
  // An explicit offset avoids interpreting the user's local time as server time.
  if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(countedAt) || !Number.isFinite(Date.parse(countedAt)) || Date.parse(countedAt) > Date.now() + 60000) fail('invalid_counted_at');
  const reason = String(input.reason || '').trim();
  if (!reason || !Array.isArray(input.lines) || !input.lines.length || input.lines.length > 1000) fail('stocktake_reason_and_lines_required');
  const seen = new Set();
  const lines = input.lines.map(line => {
    const id = Number(line.raw_material_id);
    if (!Number.isSafeInteger(id) || id <= 0 || seen.has(id)) fail('invalid_stocktake_lot');
    seen.add(id);
    if (line.counted_kg === null || line.counted_kg === '' || typeof line.counted_kg === 'boolean') fail('invalid_counted_kg');
    const amount = Number(line.counted_kg);
    if (!Number.isFinite(amount) || amount < 0 || Math.abs(amount) > 1e9) fail('invalid_counted_kg');
    const hasNet=Object.hasOwn(line,'post_count_net_kg') && line.post_count_net_kg!==null && line.post_count_net_kg!=='';
    const net=hasNet?Number(line.post_count_net_kg):0;
    if(!Number.isFinite(net)||Math.abs(net)>1e9||amount+net<0)fail('invalid_post_count_movement');
    return { raw_material_id: id, counted_kg: kg(amount),post_count_net_kg:kg(net),reconciliation_note:String(line.reconciliation_note||'').trim(),post_count_reconciled:hasNet&&line.post_count_reconciled===true };
  }).sort((a,b) => a.raw_material_id-b.raw_material_id);
  return { counted_at: new Date(countedAt).toISOString(), reason, lines };
}

function previewStocktake(db, input) {
  const normalized = normalize(input);
  const lines = normalized.lines.map(line => {
    const lot = db.prepare('SELECT * FROM raw_material WHERE id=? AND active=1').get(line.raw_material_id);
    if (!lot || String(lot.verification_status || 'approved') !== 'approved') fail('approved_stocktake_lot_required');
    if(db.prepare('SELECT id FROM raw_material WHERE id=? AND julianday(created_at)>julianday(?)').get(lot.id,normalized.counted_at))fail('lot_created_after_count_cutoff');
    // Snapshot current counters; historical counts also need a reconciled net movement.
    const snapshot = { lot, latest_usage: db.prepare('SELECT MAX(id) AS id FROM raw_material_usage WHERE raw_material_id=?').get(lot.id).id,
      latest_count: db.prepare('SELECT MAX(id) AS id FROM inventory_stocktake_lines WHERE raw_material_id=?').get(lot.id).id };
    return { ...line, expected_kg: materialOnHand(lot), target_kg:kg(line.counted_kg+line.post_count_net_kg),adjustment_kg: kg(line.counted_kg+line.post_count_net_kg-materialOnHand(lot)), snapshot, snapshot_token: hash(snapshot) };
  });
  return { ...normalized, lines, preview_token: hash({ ...normalized, lines: lines.map(l => l.snapshot_token) }) };
}

function approveStocktake(db, input) {
  const normalized = normalize(input);
  const key = String(input.idempotency_key || '').trim();
  const actor = Number(input.actor_id);
  if (!key || !Number.isSafeInteger(actor) || actor <= 0 || !input.preview_token) fail('stocktake_approval_required');
  const fingerprint = hash({ ...normalized, preview_token: input.preview_token, actor_id: actor });
  return db.transaction(() => {
    const replay = db.prepare('SELECT * FROM inventory_stocktakes WHERE idempotency_key=?').get(key);
    if (replay) { if (replay.payload_fingerprint !== fingerprint) fail('idempotency_key_conflict'); return getStocktake(db,replay.id); }
    const preview = previewStocktake(db,normalized);
    if (preview.preview_token !== input.preview_token) fail('stocktake_preview_stale');
    // Earlier observations require an explicit, audited reconciliation of later flows.
    const historical=Date.now()-Date.parse(normalized.counted_at)>5*60*1000;
    for(const line of preview.lines) {
      const laterUsage=db.prepare('SELECT id FROM raw_material_usage WHERE raw_material_id=? AND julianday(used_at)>julianday(?) LIMIT 1').get(line.raw_material_id,normalized.counted_at);
      const laterV2=db.prepare('SELECT e.id FROM material_consumption_events_v2 e JOIN material_consumption_event_lines_v2 l ON l.consumption_event_id=e.id WHERE l.raw_material_id=? AND julianday(e.approved_at)>julianday(?) LIMIT 1').get(line.raw_material_id,normalized.counted_at);
      if((historical||laterUsage||laterV2) && (!line.post_count_reconciled||!line.reconciliation_note))fail('historical_count_requires_reconciliation');
    }
    const result = db.prepare('INSERT INTO inventory_stocktakes(idempotency_key,payload_fingerprint,counted_at,reason,actor_id) VALUES(?,?,?,?,?)')
      .run(key,fingerprint,normalized.counted_at,normalized.reason,actor);
    for (const line of preview.lines) {
      db.prepare('INSERT INTO inventory_stocktake_lines(stocktake_id,raw_material_id,expected_kg,counted_kg,adjustment_kg,before_snapshot_json,post_count_net_kg,reconciliation_note) VALUES(?,?,?,?,?,?,?,?)')
        .run(result.lastInsertRowid,line.raw_material_id,line.expected_kg,line.counted_kg,line.adjustment_kg,JSON.stringify(line.snapshot),line.post_count_net_kg,line.reconciliation_note);
      db.prepare('UPDATE raw_material SET stock_adjustment_kg=ROUND(stock_adjustment_kg+?,3) WHERE id=?').run(line.adjustment_kg,line.raw_material_id);
    }
    return getStocktake(db,result.lastInsertRowid);
  }).immediate();
}
function getStocktake(db,id) {
  const row=db.prepare('SELECT * FROM inventory_stocktakes WHERE id=?').get(Number(id));
  return row ? { ...row, lines:db.prepare('SELECT raw_material_id,expected_kg,counted_kg,adjustment_kg,post_count_net_kg,reconciliation_note FROM inventory_stocktake_lines WHERE stocktake_id=? ORDER BY raw_material_id').all(row.id) } : null;
}
module.exports={previewStocktake,approveStocktake,getStocktake};
