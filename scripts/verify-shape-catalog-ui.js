'use strict';
// Isolated browser verification. Requires Playwright supplied through PLAYWRIGHT_MODULE.
// Uses an in-memory catalogue, no application DB, scheduler or machine connection.
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');
const Database = require('better-sqlite3');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { ensureSavedShapeCatalogSchema, createSavedShapeCatalog } = require('../services/savedShapeCatalog');
const root = path.resolve(__dirname,'..');
(async () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE shapes(id TEXT PRIMARY KEY,name TEXT,bends INTEGER,sides_default TEXT,angles_default TEXT,active INTEGER DEFAULT 1)');
  ensureSavedShapeCatalogSchema(db); const catalog = createSavedShapeCatalog(db);
  const app = express(); app.use(express.json());
  app.get('/api/shape-definitions', (_req,res) => res.json({ entries:catalog.list() }));
  app.post('/api/shape-definitions', (req,res) => { const result = catalog.create(req.body); res.status(result.status).json(result); });
  app.put('/api/shape-definitions/:id', (req,res) => { const result = catalog.update(req.params.id,req.body); res.status(result.status).json(result); });
  for (const [url,file] of Object.entries({shapeSnapshot:'services/shapeSnapshot.js',steelRebarShapes:'modules/steel-rebar/shapes.js',shapeCommercial:'modules/steel-rebar/shape-commercial.js'})) app.get('/'+url+'.js',(_req,res) => res.sendFile(path.join(root,file)));
  app.get('/',(_req,res) => res.send(`<!doctype html><html dir="rtl" lang="he"><meta charset="utf-8"><body><script src="/rebar-weights.js"></script><script src="/display-units.js"></script><script src="/shapeSnapshot.js"></script><script src="/steelRebarShapes.js"></script><script src="/shapeCommercial.js"></script><script src="/shape-editor.js"></script><script>window.editor = new ShapeEditorModal(data => window.approved = data); editor.open();</script></body></html>`));
  app.use(express.static(path.join(root,'public')));
  const server = await new Promise(resolve => { const running = app.listen(0,'127.0.0.1',() => resolve(running)); });
  let browser;
  try {
    browser = await chromium.launch({headless:true});
    const page = await browser.newPage({viewport:{width:1440,height:1000}});
    const errors = []; page.on('pageerror',error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForSelector('#seOverlay.show');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#seCatalogPopup').isVisible(),false);
    await page.locator('#seItemCode').fill('s8');
    await page.locator('#seItemCode').press('ArrowDown');
    assert.equal(await page.locator('#seCatalogPopup').isVisible(),false);
    await page.locator('#seItemCode').press('Enter');
    assert.equal(await page.locator('[data-side]').count(),4);
    assert.equal(await page.locator('#seAddSide').isVisible(),false);
    const before = await page.locator('#seTableBody').boundingBox();
    await page.locator('#seCatalogArrow').click();
    assert.equal(await page.locator('#seCatalogPopup').isVisible(),true);
    const after = await page.locator('#seTableBody').boundingBox(); assert.deepEqual(after,before);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#seCatalogPopup').isVisible(),false);
    for(let i=0;i<4;i++) {
      await page.locator(`[data-side="${i}"]`).fill(String(i%2 ? 20 : 40));
      await page.locator(`[data-side="${i}"]`).press(i%2 ? 'Tab':'Enter');
      assert.equal(await page.evaluate(() => document.activeElement.id || document.activeElement.dataset.side),i===3?'seDiameterSelect':String(i+1));
    }
    await page.locator('#seDiameterSelect').selectOption('8|smooth'); await page.locator('#seDiameterSelect').press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.id),'seQuantityInput');
    await page.locator('#seQuantityInput').fill('20');
    await page.locator('#seBillingDetails summary').first().click();
    const basis = await page.locator('#seBillingBasis').innerText();
    for(const label of ['ברזל חלק','חיתוך','כיפוף','עיבוד חישוקים','20 יח׳']) assert.ok(basis.includes(label),label+'; actual: '+basis+'; quantity='+await page.evaluate(() => editor.current.quantity));
    const shotDir = process.env.SHAPE_QA_OUTPUT;
    if(shotDir) {fs.mkdirSync(shotDir,{recursive:true}); await page.screenshot({path:path.join(shotDir,'hoop-billing.png')});}
    await page.locator('#seQuantityInput').press('Enter');
    const approved = await page.evaluate(() => window.approved);
    assert.equal(approved.catalogIdentity.itemCode,'s8'); assert.ok(approved.billingPolicy.lines.includes('hoops_units'));
    assert.equal(approved.data.steelFinish,'smooth'); assert.equal(approved.calculated.totalLengthMm,1200);
    await page.evaluate(data => editor.open({...data.data,shapeType:data.shapeType,presetName:data.displayName,catalogIdentity:data.catalogIdentity,billingPolicy:data.billingPolicy,quantity:20}),approved);
    assert.equal(await page.locator('#seCatalogPopup').isVisible(),false);
    await page.locator('#seNewShape').click();
    assert.equal(await page.locator('#seAddSide').isVisible(),true);
    await page.locator('[data-side="0"]').fill('40'); await page.locator('[data-side="0"]').press('Enter');
    assert.equal(await page.locator('[data-side]').count(),2);
    await page.locator('[data-side="1"]').fill('20');
    await page.locator('#seSaveShapeBtn').click();
    await page.locator('#seSaveNameInput').fill('צורה משותפת'); await page.locator('#seSaveCodeInput').fill('001');
    await page.locator('#seSaveCodeInput').press('Enter');
    await page.waitForFunction(() => window.editor.current.catalogIdentity?.itemCode==='001',null,{timeout:5000}).catch(async error => {
      throw new Error(error.message+'; save status: '+await page.locator('#seSaveError').innerText());
    });
    assert.equal(catalog.list().length,1); assert.equal(catalog.list()[0].definition.sides.length,2);
    assert.ok(catalog.list()[0].billingPolicy.lines.includes('bending_kg'));
    assert.equal(await page.locator('#seAddSide').isVisible(),false);
    const second = await browser.newPage({viewport:{width:1440,height:1000}});
    await second.goto(`http://127.0.0.1:${server.address().port}`); await second.waitForFunction(() => window.editor?._sharedShapes?.length===1);
    await second.locator('#seItemCode').fill('001'); await second.locator('#seItemCode').press('Enter');
    assert.equal(await second.locator('[data-side]').count(),2);
    assert.equal(await second.locator('#seAddSide').isVisible(),false);
    await second.locator('[data-side="0"]').press('Enter');
    assert.equal(await second.locator('[data-side]').count(),2);
    assert.equal(await second.evaluate(() => document.activeElement.dataset.side),'1');
    assert.equal(await second.evaluate(() => editor.current.catalogIdentity.version),1);
    await page.locator('#seItemCode').fill('s15'); await page.locator('#seItemCode').press('Enter');
    assert.equal(await page.evaluate(() => editor.current.is3d),1);
    assert.equal(await page.locator('[data-el][readonly]').count(),5);
    assert.ok((await page.evaluate(() => editor.current.billingPolicy.lines)).includes('chairs_units'));
    await page.locator('#seCatalogArrow').click();
    if(shotDir) await page.screenshot({path:path.join(shotDir,'floating-catalogue.png')});
    assert.deepEqual(errors,[]);
    console.log('PASS: floating catalogue, keyboard flow, billing snapshot, shared save/reload, 3D preservation; no browser errors.');
  } finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); db.close(); }
})().catch(error => {console.error(error);process.exitCode=1;});
