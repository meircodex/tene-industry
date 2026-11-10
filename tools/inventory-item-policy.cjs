'use strict';
// Explicit maintenance: stage on a backup first; never invoked on startup.
const Database=require('better-sqlite3'),fs=require('node:fs');
const {ensureInventoryAccountingSchema}=require('../db/inventoryAccountingSchema');
const completion=require('../services/inventoryItemCompletion');
function applyPolicy(db,baselineDb){
  ensureInventoryAccountingSchema(db);
  return db.transaction(()=>{
    const completed=baselineDb.prepare("SELECT id FROM items WHERE status IN ('הושלם','הועמס','נשלח','סופק')").all().map(i=>i.id);
    const policy=completion.activatePolicy(db,{stocktake_id:1,completed_item_ids:completed});
    const results=db.prepare('SELECT id FROM items ORDER BY id').all().map(i=>{
      const reason=completion.eligibility(db,completion.itemRecord(db,i.id));
      return {item_id:i.id,...(reason?{reason}:completion.consumeItem(db,{item_id:i.id,reason:'התאמת פריטים שהושלמו מאז ספירת 8.11'}))};
    });
    return {policy,baseline_completed_items:completed.length,results,totals:db.prepare("SELECT material_type,ROUND(SUM(weight_received+stock_adjustment_kg-weight_used-weight_scrapped),3) physical_kg FROM raw_material WHERE active=1 AND COALESCE(verification_status,'approved')='approved' GROUP BY material_type").all()};
  }).immediate();
}
module.exports={applyPolicy};
if(require.main===module){
  const [dbPath,baselinePath,reportPath]=process.argv.slice(2);if(!dbPath||!baselinePath||!reportPath)throw Error('Usage: STAGING_DB PRE_COUNT_BACKUP REPORT_JSON');
  const db=new Database(dbPath,{fileMustExist:true}),baseline=new Database(baselinePath,{readonly:true,fileMustExist:true});
  if(db.pragma('integrity_check',{simple:true})!=='ok'||baseline.pragma('integrity_check',{simple:true})!=='ok')throw Error('integrity_check_failed');
  const report=applyPolicy(db,baseline);fs.writeFileSync(reportPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify({...report,results:report.results.filter(r=>!r.reason||r.pending),integrity:db.pragma('integrity_check',{simple:true})}));baseline.close();db.close();
}
