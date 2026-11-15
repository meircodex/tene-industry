'use strict';
const crypto=require('node:crypto');
const POLICY=Object.freeze({version:1,coil_min_meters_per_min:1,approved_peer_min:5,peer_ratio_limit:3,lifts:'manager_review',close_scan_seconds:5});
const exists=(db,name)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
function ensureReviews(db){db.exec(`CREATE TABLE IF NOT EXISTS production_timing_reviews(
 item_id INTEGER PRIMARY KEY,measurement_key TEXT NOT NULL,measurement_json TEXT NOT NULL DEFAULT '{}',decision TEXT NOT NULL CHECK(decision IN ('include','exclude')),
 reason TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,reviewer_id INTEGER,reviewer_name TEXT,reviewed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
)`);
 if(!db.prepare('PRAGMA table_info(production_timing_reviews)').all().some(c=>c.name==='measurement_json'))db.exec("ALTER TABLE production_timing_reviews ADD COLUMN measurement_json TEXT NOT NULL DEFAULT '{}'");
}
function materialIndex(db){
 const usage=new Map(),reserved=new Map();
 const add=(map,id,type)=>{if(!id||!['coil','straight','bent','mesh'].includes(type))return;if(!map.has(id))map.set(id,new Set());map.get(id).add(type);};
 if(exists(db,'raw_material_usage')&&exists(db,'raw_material'))for(const r of db.prepare('SELECT DISTINCT u.item_id,m.material_type FROM raw_material_usage u JOIN raw_material m ON m.id=u.raw_material_id WHERE u.item_id IS NOT NULL').all())add(usage,r.item_id,r.material_type);
 if(exists(db,'inventory_reservations'))for(const r of db.prepare('SELECT DISTINCT item_id,material_type FROM inventory_reservations WHERE item_id IS NOT NULL').all())add(reserved,r.item_id,r.material_type);
 const result=new Map();for(const id of new Set([...usage.keys(),...reserved.keys()])){const types=usage.get(id)||reserved.get(id);result.set(id,types.size===1?[...types][0]:null);}return result;
}
function keyFor(card){return crypto.createHash('sha256').update(JSON.stringify({id:card.item_id,start:card.started_at,end:card.completed_at,end_source:card.timing_end_source,quantity:card.quantity,weight:card.weight_kg,profile:card.fingerprint,geometry_revision:card.geometry_revision,machine:card.machine_id||card.machine,material:card.material_type,net:card.net_minutes,gross:card.gross_minutes,outside:card.outside_work_minutes,lunch:card.lunch_minutes,stops:card.documented_stop_minutes})).digest('hex');}
function peerKey(card){return JSON.stringify([card.machine_id||card.machine,card.material_type,card.fingerprint,card.geometry_revision]);}
function median(values){const a=[...values].sort((a,b)=>a-b),mid=Math.floor(a.length/2);return a.length%2?a[mid]:(a[mid-1]+a[mid])/2;}
function classify(db,cards){
 const materials=materialIndex(db),reviews=exists(db,'production_timing_reviews')?new Map(db.prepare('SELECT item_id,measurement_key,decision,reason,revision,reviewer_id,reviewer_name,reviewed_at FROM production_timing_reviews').all().map(r=>[r.item_id,r])):new Map();
 for(const c of cards){c.material_type=materials.get(c.item_id)||null;c.measurement_key=keyFor(c);const review=reviews.get(c.item_id);c.timing_review=review?.measurement_key===c.measurement_key?review:null;c.review_stale=Boolean(review&&!c.timing_review);c.review_revision=review?.revision||0;}
 const approved=new Map();
 for(const c of cards)if(c.measurement_status==='measured'&&c.net_minutes>0&&c.quantity>0&&c.unitCutLengthMm>0&&c.timing_review?.decision==='include'){
  const key=peerKey(c);if(!approved.has(key))approved.set(key,[]);approved.get(key).push(c);
 }
 for(const c of cards){
  let status='review',reasons=[],include=false;
  const eligible=c.measurement_status==='measured'&&c.net_minutes>0&&c.quantity>0&&c.unitCutLengthMm>0;
  const peers=(approved.get(peerKey(c))||[]).filter(p=>p.item_id!==c.item_id);
  const baseline=peers.length>=POLICY.approved_peer_min?median(peers.map(p=>p.net_minutes/p.quantity)):null;
  const ratio=baseline>0?(c.net_minutes/c.quantity)/baseline:null;
  c.reliability_comparison={approved_peers:peers.length,median_min_per_unit:baseline,ratio};
  if(!eligible){status='unreliable';reasons.push(c.measurement_reason||'חסרים זמן תקין או נתוני אורך וכמות');}
  else if(c.timing_review?.decision==='exclude'){status='unreliable';reasons.push('מנהל סימן את המדידה כלא אמינה: '+c.timing_review.reason);}
  else if(c.timing_review?.decision==='include'){status='reliable';include=true;reasons.push('אושרה על ידי מנהל: '+c.timing_review.reason);}
  else {
   if(c.gross_minutes*60<=POLICY.close_scan_seconds)reasons.push('התחלה וסיום נרשמו בתוך 5 שניות — ייתכן דיווח בדיעבד');
   if(c.review_stale)reasons.push('נתוני המדידה השתנו מאז בדיקת המנהל');
   if(c.material_type==='coil'){
    if(!(c.meters_per_min>POLICY.coil_min_meters_per_min))reasons.push('קצב גלילים אינו מעל מטר לדקה');
    if(baseline===null)reasons.push('טרם אושרו לפחות 5 כרטיסים דומים להשוואה');
    else if(ratio>POLICY.peer_ratio_limit||ratio<1/POLICY.peer_ratio_limit)reasons.push('קצב חריג ביותר מפי 3 מול חציון כרטיסים דומים שאושרו');
    if(c.timing_end_source!=='scan')reasons.push('סיום הייצור אינו מגובה בסריקת סיום');
    if(!reasons.length){status='reliable';include=true;reasons.push('עומדת בסף גלילים ובטווח ההשוואה למדידות שאושרו');}
   } else if(c.material_type==='straight')reasons.push('ליפטים נכללים בסטטיסטיקה לאחר אישור מנהל');
   else reasons.push(c.material_type?'לסוג חומר זה נדרש אישור מנהל':'סוג חומר הגלם אינו מאומת');
  }
  c.reliability_status=status;c.reliability_reasons=reasons;c.included_in_statistics=include;
 }
 return cards;
}
function saveReview(db,{itemId,day,measurementKey,decision,reason,expectedReviewRevision,userId,userName}){
 const fail=(status,message)=>{throw Object.assign(Error(message),{statusCode:status});};
 if(!Number.isSafeInteger(itemId)||itemId<=0||!/^\d{4}-\d{2}-\d{2}$/.test(String(day))||! /^[a-f0-9]{64}$/.test(String(measurementKey)))fail(400,'invalid_measurement_reference');
 if(!Number.isSafeInteger(expectedReviewRevision)||expectedReviewRevision<0)fail(400,'invalid_review_revision');
 if(!['include','exclude'].includes(decision)||typeof reason!=='string'||reason.trim().length<3||reason.trim().length>500)fail(400,'נדרשת החלטה וסיבה באורך 3–500 תווים');
 ensureReviews(db);
 return db.transaction(()=>{
  const {reportProductionTiming,validDay}=require('./productionTiming');if(!validDay(day))fail(400,'invalid_production_date');
  const card=reportProductionTiming(db,{fromDate:day,toDate:day}).cards.find(c=>c.item_id===itemId);
  if(!card||card.measurement_key!==measurementKey)fail(409,'המדידה השתנתה. יש לרענן ולבדוק שוב');
  if(decision==='include'&&(card.measurement_status!=='measured'||!(card.net_minutes>0)||!(card.unitCutLengthMm>0)))fail(422,'אי אפשר לאשר זמן חסר או לא תקין; לא נוצר זמן משוער');
  const before=db.prepare('SELECT * FROM production_timing_reviews WHERE item_id=?').get(itemId)||null;
  if((before?.revision||0)!==expectedReviewRevision)fail(409,'בדיקת המנהל השתנתה. יש לרענן לפני שמירה');
  const snapshot=JSON.stringify(Object.fromEntries(['item_id','order_id','order_num','material_type','machine_id','machine','started_at','completed_at','quantity','weight_kg','weight_source','unitCutLengthMm','geometry_revision','fingerprint','net_minutes','gross_minutes','outside_work_minutes','lunch_minutes','documented_stop_minutes','meters_per_min','kg_per_min','timing_source','timing_end_source','reliability_comparison'].map(key=>[key,card[key]])));
  db.prepare(`INSERT INTO production_timing_reviews(item_id,measurement_key,measurement_json,decision,reason,reviewer_id,reviewer_name) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(item_id) DO UPDATE SET measurement_key=excluded.measurement_key,measurement_json=excluded.measurement_json,decision=excluded.decision,reason=excluded.reason,reviewer_id=excluded.reviewer_id,reviewer_name=excluded.reviewer_name,reviewed_at=CURRENT_TIMESTAMP,revision=production_timing_reviews.revision+1`).run(itemId,measurementKey,snapshot,decision,reason.trim(),userId||null,userName||null);
  const after=db.prepare('SELECT * FROM production_timing_reviews WHERE item_id=?').get(itemId);
  db.prepare('INSERT INTO audit_log(entity_type,entity_id,entity_ref,action,old_value,new_value,notes,user_id,user_name)VALUES(?,?,?,?,?,?,?,?,?)').run('production_timing',itemId,card.order_num,'measurement_review',JSON.stringify(before),JSON.stringify(after),reason.trim(),userId||null,userName||null);
  return after;
 }).immediate();
}
module.exports={POLICY,ensureReviews,materialIndex,keyFor,classify,saveReview};
