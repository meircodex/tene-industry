'use strict';
// Runs schema/weight rollout only on a temporary copy; the supplied backup
// is opened read-only. No connection to production or physical adjustments.
const Database=require('better-sqlite3'),fs=require('fs'),crypto=require('crypto'),path=require('path'),os=require('os');
(async()=>{
const sourcePath=process.argv[2];if(!sourcePath)throw Error('backup path required');
const source=new Database(sourcePath,{readonly:true,fileMustExist:true});
const scratchDir=fs.mkdtempSync(path.join(os.tmpdir(),'tene-weight-validation-'));
const scratchPath=path.join(scratchDir,'copy.db');await source.backup(scratchPath);source.close();
const db=new Database(scratchPath);
const ledger=()=>JSON.stringify({lots:db.prepare('SELECT * FROM raw_material ORDER BY id').all(),usage:db.prepare('SELECT * FROM raw_material_usage ORDER BY id').all(),events:db.prepare('SELECT * FROM inventory_item_completion_events ORDER BY id').all(),states:db.prepare('SELECT * FROM inventory_item_completion_state ORDER BY item_id').all()});
const before=ledger();require('../db/coreSchema').ensureCoreSchema(db);
const plan=require('../services/inventoryPlanning').planInventory(db,{include_details:true,detail_limit:100});
const demand=require('../services/inventoryDemand').inventoryDemand(db);
const sum=(rows,key)=>Number(rows.reduce((n,r)=>n+Number(r[key]||0),0).toFixed(3));
const report={source_sha256:crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
  ledger_unchanged:before===ledger(),integrity:db.pragma('integrity_check'),
  review_items:db.prepare('SELECT COUNT(*) n FROM inventory_weight_review_items').get().n,
  open_items:demand.filter(r=>!r.requires_review&&r.remaining_kg>0).length,
  open_kg:sum(demand.filter(r=>!r.requires_review),'remaining_kg'),review_kg:sum(demand.filter(r=>r.requires_review),'remaining_kg'),
  total_kg:sum(plan.groups,'backlog_kg'),
  details_match:plan.groups.every(g=>g.demand_details.total<=100&&Math.abs(g.backlog_kg-sum(g.demand_details.items,'remaining_kg'))<=0.002)};
console.log(JSON.stringify(report,null,2));
if(!report.ledger_unchanged||!report.details_match||report.integrity[0].integrity_check!=='ok')process.exitCode=1;
db.close();fs.unlinkSync(scratchPath);fs.rmdirSync(scratchDir);
})().catch(error=>{console.error(error);process.exitCode=1;});
