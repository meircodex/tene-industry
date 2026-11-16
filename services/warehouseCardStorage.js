'use strict';
// Warehouse owns the existing item.zone field; Production calls this contract.
function fail(error){throw Object.assign(Error(error),{status:409});}
function zones(db){
 return [...new Set(['A','B','C','D',...db.prepare("SELECT DISTINCT zone FROM items WHERE zone IS NOT NULL AND TRIM(zone)<>'' LIMIT 200").all().map(r=>r.zone)])];
}
function validate(db,item,zone,status){
 if(typeof zone!=='string'||!zone.trim()||zone.trim().length>80)throw Object.assign(Error('invalid_storage_zone'),{status:400});
 if(!['בייצור','הושלם','הועמס'].includes(status))fail('storage_requires_completed');
 if(item.package_id)fail('packed_card_move_requires_warehouse');
 return zone.trim();
}
function setZone(db,item,zone,actor){
 db.prepare('UPDATE items SET zone=? WHERE id=?').run(zone,item.id);
 db.prepare(`INSERT INTO audit_log(entity_type,entity_id,action,field_name,old_value,new_value,user_id,user_name)
 VALUES('item',?,'storage_moved','zone',?,?,?,?)`).run(item.id,item.zone||null,zone,Number(actor.sub),actor.display_name);
}
module.exports={zones,validate,setZone};
