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
if (process.env.PORTAL_SMOKE_QUALITY_FIXTURES === '1') {
  const role = process.env.PORTAL_SMOKE_CUSTOMER_ROLE;
  if (role) {
    if (!['orderer', 'field_manager', 'approver', 'finance', 'both'].includes(role)) throw new Error('Unknown QA role');
    db.prepare(`UPDATE portal_users SET role=?, can_create_orders=?, can_approve_orders=?, can_view_prices=?,
      can_manage_users=0,can_create_sites=0,can_view_budget=?,can_set_budget=0,can_view_invoices=?
      WHERE id=?`).run(role, Number(role !== 'finance'), Number(['approver', 'both'].includes(role)),
        Number(['finance', 'both'].includes(role)), Number(role === 'finance'), Number(role === 'finance'), uid);
  }
  db.prepare("UPDATE customers SET portal_price_list_visibility='general' WHERE id=?").run(cid);
  const catalog = require('../services/savedShapeCatalog').createSavedShapeCatalog(db);
  const commercial = require('../modules/steel-rebar/shape-commercial');
  const definition = { family: 'bars', sides: [1250], angles: [] };
  const billingPolicy = commercial.defaultPolicy(definition);
  const saved = catalog.create({ name: 'צורת קטלוג לבדיקה', itemCode: '9501', definition, billingPolicy });
  if (!saved.entry) throw new Error(saved.error);
  db.prepare("UPDATE portal_users SET password_hash=? WHERE id=?").run(require('bcryptjs').hashSync('smoke-pin-enrollment', 4), uid);
  db.prepare("INSERT INTO portal_users(customer_id,phone,name,role,token,token_expires_at) VALUES (?,'0500000903','משתמש שפג תוקפו','customer_admin','smoke-expired-token','2001-01-01')").run(cid);
  const legacyOrder = db.prepare("INSERT INTO orders(order_num,customer_id,site_id,status,delivery_date) VALUES ('QA-LEGACY',?,?,'הושלמה','2020-01-01')").run(cid,site).lastInsertRowid;
  db.prepare("INSERT INTO invoices(invoice_num,customer_id,order_id,issue_date,items_json) VALUES ('QA-INVOICE',?,?,'2020-01-01','[]')").run(cid,legacyOrder);
  db.prepare("INSERT INTO delivery_notes(note_num,customer_id,order_id,issued_at,total_weight,items_json) VALUES ('DN-1',?,?,CURRENT_TIMESTAMP,12,'[]')").run(cid,legacyOrder);
}
server.listen(port,'127.0.0.1',()=>console.log(`Isolated QA: http://127.0.0.1:${server.address().port}/customer.html?token=smoke-only-token`));
process.on('SIGTERM',()=>closeServer(()=>{db.close();fs.rmSync(dir,{recursive:true,force:true});process.exit(0);}));
