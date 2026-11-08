'use strict';
// Isolated local review only. Never opens the application's real inventory DB.
const path=require('node:path'),fs=require('node:fs'),crypto=require('node:crypto');
const directory=path.resolve(__dirname,'../tmp/inventory-review-20261108');fs.mkdirSync(directory,{recursive:true});
Object.assign(process.env,{NODE_ENV:'test',DB_PATH:path.join(directory,'review.db'),BACKUP_DIR:path.join(directory,'backups'),PORT:'4601',AUTH_BYPASS:'false',JWT_SECRET:crypto.randomBytes(32).toString('hex'),BCRYPT_ROUNDS:'4',SKIP_STARTUP_DB_SNAPSHOT:'true',AI_ENABLED:'false',INTAKE_AI_ENABLED:'false',PRIORITY_ENABLED:'false',LICENSE_KEY:''});
const {db,startServer,closeServer}=require('../server');const {hashPin}=require('../auth-core');
if(!db.prepare("SELECT id FROM users WHERE username='inventory-review'").get()){
  db.prepare('INSERT INTO users(username,display_name,role,pin,pin_hash,active,password_changed_at) VALUES(?,?,?,?,?,1,?)').run('inventory-review','בדיקת מלאי מקומית','admin','9286',hashPin('9286',4),new Date().toISOString());
  db.exec("INSERT INTO suppliers(id,name) VALUES(81001,'ספק לדוגמה');INSERT INTO raw_material(id,diameter,material_type,weight_received,lot_number) VALUES(81001,12,'coil',5000,'נתוני בדיקה בלבד'),(81002,16,'straight',3500,'נתוני בדיקה בלבד');INSERT INTO orders(id,order_num,status) VALUES(81001,'בדיקת מלאי מקומית','בייצור');INSERT INTO items(id,order_id,diameter,total_weight,quantity) VALUES(81001,81001,12,12000,100),(81002,81001,8,100,110);INSERT INTO purchase_orders(po_num,diameter,material_type,quantity_ton,status) VALUES('REVIEW-COIL',12,'coil',2,'approved')");
  require('../services/inventoryReservation').reserveMaterialForOrder(db,{order_id:81001,items:[{id:81001,diameter:12,material_type:'coil',total_weight:12000}]});
  const mesh=require('../services/meshInventory'),specification={length_mm:6000,width_mm:2500,longitudinal_diameter_mm:8,transverse_diameter_mm:8,longitudinal_spacing_mm:200,transverse_spacing_mm:200,grade:'B500A',standard_code:'SI-4466'};
  const receipt=mesh.receiptDraft(db,{specification,quantity_units:80,idempotency_key:'review-receipt'});mesh.approveReceipt(db,{receipt_id:receipt.id,actor_id:1});mesh.reserveMesh(db,{order_id:81001,item_id:81002,specification,quantity_units:110});
}
startServer(4601,'127.0.0.1');
process.on('SIGINT',()=>closeServer(()=>process.exit(0)));
