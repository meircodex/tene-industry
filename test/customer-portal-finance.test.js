'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { portalInvoices } = require('../services/customerPortalFinance');

test('portal debt uses recorded invoice balances, never quotes, and enforces every linked site', () => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE orders(id INTEGER,customer_id INTEGER,order_num TEXT,site_id INTEGER);
      CREATE TABLE customer_sites(id INTEGER,customer_id INTEGER,name TEXT);
      CREATE TABLE invoices(id INTEGER,customer_id INTEGER,invoice_num TEXT,invoice_type TEXT,order_id INTEGER,items_json TEXT,total REAL,paid_amount REAL,status TEXT,due_date TEXT,issue_date TEXT);
      INSERT INTO orders VALUES(1,7,'O1',10),(2,7,'O2',20),(3,8,'OTHER',10);
      INSERT INTO customer_sites VALUES(10,7,'A'),(20,7,'B');`);
    const insert = db.prepare('INSERT INTO invoices VALUES(?,7,?, ?,?, ?,100,?, ?,?,NULL)');
    insert.run(1,'PARTIAL','tax_invoice',1,'[]',25,'חלקית','2026-01-01');
    insert.run(2,'CANCEL','tax_invoice',1,'[]',0,'ביטול','2026-01-01');
    insert.run(3,'PAID','tax_invoice',1,'[]',100,'שולמה','2026-01-01');
    insert.run(4,'OTHER-SITE','tax_invoice',2,'[]',0,'פתוחה','2026-01-01');
    insert.run(5,'CONSOLIDATED','tax_invoice',1,JSON.stringify([{order_id:2}]),0,'פתוחה','2026-01-01');
    insert.run(6,'UNASSIGNED','tax_invoice',null,'[]',0,'פתוחה','2026-01-01');
    insert.run(7,'DRAFT','draft',1,'[]',0,'פתוחה','2026-01-01');
    insert.run(8,'UNDATED','tax_invoice',1,'[]',0,'פתוחה',null);
    insert.run(9,'WRONG-CUSTOMER','tax_invoice',3,'[]',0,'פתוחה','2026-01-01');
    const rows = portalInvoices(db,{customerId:7,siteIds:[10]});
    assert.deepEqual(rows.map(r=>r.id),[1,3,8]);
    assert.equal(rows[0].amount,75);
    assert.equal(rows[1].amount,0);
    assert.equal(rows[2].dueDate,null);
    assert.ok(rows.every(r=>r.source==='invoice'));
    assert.deepEqual(portalInvoices(db,{customerId:7,siteIds:[10],siteId:20}),[]);
    assert.equal(portalInvoices(db,{customerId:7,siteIds:[10,20]}).find(r=>r.id===5).amount,100);
  } finally { db.close(); }
});
