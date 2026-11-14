'use strict';

function ensureMachineRegistry(db){
  const columns=db.prepare('PRAGMA table_info(machines)').all();
  if(!columns.some(c=>c.name==='retired_at'))db.exec('ALTER TABLE machines ADD COLUMN retired_at TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS machine_registry_revisions(version TEXT PRIMARY KEY,before_json TEXT NOT NULL,after_json TEXT NOT NULL,applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
}
function applyMachineCatalog(db,catalog){
  ensureMachineRegistry(db);
  if(!catalog?.version||!Array.isArray(catalog.names)||!catalog.names.length||catalog.names.length>100)throw Error('invalid_machine_catalog');
  const names=catalog.names.map(n=>String(n).trim());
  if(names.some(n=>!n||n.length>80||/[\u0000-\u001f]/.test(n))||new Set(names.map(n=>n.toLowerCase())).size!==names.length)throw Error('invalid_machine_names');
  return db.transaction(()=>{
    if(db.prepare('SELECT 1 FROM machine_registry_revisions WHERE version=?').get(catalog.version))return {changed:false};
    const before=db.prepare('SELECT * FROM machines ORDER BY id').all(),active=[];
    for(const name of names){
      let row=before.find(m=>m.name.trim().toLowerCase()===name.toLowerCase()&&!m.retired_at);
      if(!row){const result=db.prepare(`INSERT INTO machines(name,label,conn_mode,tcp_host,rtu_port,min_diameter,max_diameter,single_min_diameter,single_max_diameter,double_min_diameter,double_max_diameter,status)
        VALUES(?,?,'disabled',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'לא מחובר')`).run(name,name);row={id:Number(result.lastInsertRowid)};}
      active.push(row.id);
    }
    for(const old of before)if(!active.includes(old.id)&&!old.retired_at)db.prepare('UPDATE machines SET retired_at=CURRENT_TIMESTAMP WHERE id=?').run(old.id);
    const after=db.prepare('SELECT * FROM machines ORDER BY id').all();
    db.prepare('INSERT INTO machine_registry_revisions(version,before_json,after_json)VALUES(?,?,?)').run(catalog.version,JSON.stringify(before),JSON.stringify(after));
    db.prepare(`INSERT INTO audit_log(entity_type,entity_ref,action,field_name,old_value,new_value,notes,user_name)
      VALUES('machine_registry',?,'catalog_replaced','active_machines',?,?,?,'אישור בעל המוצר')`).run(catalog.version,JSON.stringify(before.filter(m=>!m.retired_at).map(m=>m.name)),JSON.stringify(names),catalog.reason||'עדכון מרשם מאושר');
    return {changed:true,active_ids:active};
  })();
}
function queueMachine(item,machines){
  const byId=machines.find(m=>Number(m.id)===Number(item.machine_id));
  if(byId)return byId.name;
  const raw=String(item.machine||'').trim();
  if(!raw)return null;
  const matches=machines.filter(m=>[m.name,m.label].filter(Boolean).some(v=>String(v).trim().toLowerCase()===raw.toLowerCase()));
  return matches.length===1?matches[0].name:null;
}
module.exports={ensureMachineRegistry,applyMachineCatalog,queueMachine};
