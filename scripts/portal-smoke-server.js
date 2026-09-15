'use strict';
// Isolated manual QA only. Never uses the business database or sends messages.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tene-portal-smoke-'));
const port=Number(process.argv[2]||3199);
Object.assign(process.env,{NODE_ENV:'test',JWT_SECRET:'isolated-qa-only',BCRYPT_ROUNDS:'4',DB_PATH:path.join(dir,'qa.db'),BACKUP_DIR:path.join(dir,'backups'),BASE_URL:`http://127.0.0.1:${port}`,PORT:String(port)});
require('../intake').sendWhatsApp=async()=>({testIntercepted:true});
const {server,db,closeServer}=require('../server');
const cid=db.prepare("INSERT INTO customers(name,phone,price_tier,portal_can_manage_users,portal_can_create_sites,portal_can_set_budgets,portal_can_expose_prices) VALUES ('לקוח בדיקה מבודד','0500000900','list',1,1,1,1)").run().lastInsertRowid;
const uid=db.prepare("INSERT INTO portal_users(customer_id,phone,name,role,token,token_expires_at,can_create_orders,can_approve_orders,can_view_prices,can_manage_users,can_create_sites,can_view_budget,can_set_budget,can_view_invoices,can_view_delivery_notes) VALUES (?,'0500000901','בודק פורטל','customer_admin','smoke-only-token','2099-01-01',1,1,1,1,1,1,1,1,1)").run(cid).lastInsertRowid;
const site=db.prepare("INSERT INTO customer_sites(customer_id,name,status) VALUES (?,'אתר בדיקה','active')").run(cid).lastInsertRowid;
db.prepare('INSERT INTO customer_site_users(customer_id,site_id,portal_user_id,is_default) VALUES (?,?,?,1)').run(cid,site,uid);
const book=db.prepare("INSERT INTO pricing_price_books(code,name,price_type,status) VALUES ('QA','מחירון בדיקה','general','active')").run().lastInsertRowid;
for(const diameter of [6,8,10,12,14,16,20,25,28,32]) db.prepare('INSERT INTO pricing_price_items(price_book_id,sku,description,diameter,unit,price_before_vat) VALUES (?,?,?,?,?,?)').run(book,'D'+diameter,'ברזל בדיקה',diameter,'kg',5);
db.prepare("INSERT INTO users(username,display_name,role,pin_hash,active) VALUES ('smoke-admin','מנהל בדיקה','admin',?,1)").run(require('../auth-core').hashPin('9101',4));
server.listen(port,'127.0.0.1',()=>console.log(`Isolated QA: http://127.0.0.1:${port}/customer.html?token=smoke-only-token`));
process.on('SIGTERM',()=>closeServer(()=>{db.close();process.exit(0);}));
