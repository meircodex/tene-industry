'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {applyMachineCatalog,queueMachine}=require('../services/machineRegistry');
const catalog=require('../db/approvedMachineCatalog.json');
function fixture(t){const db=new Database(':memory:');t.after(()=>db.close());db.exec(`CREATE TABLE machines(id INTEGER PRIMARY KEY,name TEXT,label TEXT,conn_mode TEXT,tcp_host TEXT,rtu_port TEXT,min_diameter REAL,max_diameter REAL,single_min_diameter REAL,single_max_diameter REAL,double_min_diameter REAL,double_max_diameter REAL,status TEXT,counter INTEGER DEFAULT 0,current_item_id INTEGER);
CREATE TABLE audit_log(entity_type TEXT,entity_ref TEXT,action TEXT,field_name TEXT,old_value TEXT,new_value TEXT,notes TEXT,user_name TEXT);
CREATE TABLE items(id INTEGER PRIMARY KEY,machine TEXT,machine_id INTEGER,quantity INTEGER,produced_qty INTEGER);`);for(let id=1;id<=4;id++)db.prepare('INSERT INTO machines(id,name,label,conn_mode,tcp_host,counter)VALUES(?,?,?,?,?,?)').run(id,'מכונה '+String.fromCharCode(64+id),String.fromCharCode(64+id),'tcp','10.0.0.'+id,13);db.exec("INSERT INTO items VALUES(1,'A',1,20,4)");return db;}
test('approved catalog retires old machines without erasing history and adds exactly eight unconfigured records once',async t=>{
 const db=fixture(t),items=db.prepare('SELECT * FROM items').all();assert.equal(applyMachineCatalog(db,catalog).changed,true);
 const active=db.prepare('SELECT * FROM machines WHERE retired_at IS NULL ORDER BY id').all();assert.deepEqual(active.map(m=>m.name),catalog.names);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM machines WHERE retired_at IS NOT NULL').get().n,4);
 for(const row of active){assert.equal(row.conn_mode,'disabled');assert.equal(row.tcp_host,null);assert.equal(row.min_diameter,null);assert.equal(row.max_diameter,null);}
 assert.deepEqual(db.prepare('SELECT * FROM items').all(),items);assert.equal(db.prepare('SELECT counter FROM machines WHERE id=1').get().counter,13);
 assert.equal(queueMachine(items[0],active),null);assert.equal(queueMachine({...items[0],machine_id:active[0].id},active),'MEP');
 assert.equal(applyMachineCatalog(db,catalog).changed,false);assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_log').get().n,1);
 const modbus=require('../modbus').init(db);assert.equal(modbus._getConfigs().length,8);
 for(const cfg of modbus._getConfigs())await modbus.connectMachine(cfg);
 assert.equal(Object.keys(modbus.clients).length,0);assert.deepEqual(modbus.getAllState().map(m=>m.name),catalog.names);
});
test('catalog replacement rejects duplicate names and rolls back if its audit cannot be saved',t=>{
 const db=fixture(t),before=db.prepare('SELECT * FROM machines').all();assert.throws(()=>applyMachineCatalog(db,{version:'bad',names:['MEP','mep']}));
 db.exec("CREATE TRIGGER reject_registry_audit BEFORE INSERT ON audit_log BEGIN SELECT RAISE(ABORT,'audit unavailable');END;");
 assert.throws(()=>applyMachineCatalog(db,catalog),/audit unavailable/);
 assert.deepEqual(db.prepare('SELECT * FROM machines').all().map(({retired_at,...r})=>r),before);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM machine_registry_revisions').get().n,0);
});
