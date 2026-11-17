'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync('public/nav.js','utf8');
function fixture(active='orders'){
 const model=source.slice(source.indexOf('  const LINKS ='),source.indexOf('  let visibleLinks ='));
 const renderer=source.slice(source.indexOf('  function escapeAttr('),source.indexOf('  const styleEl'));
 const access=source.slice(source.indexOf('  function rebuildVisibleLinks('),source.indexOf('  async function refreshLicensedModules'))+source.slice(source.indexOf('  const GATEABLE ='),source.indexOf('  const topnav ='));
 const c={window:{},localStorage:{getItem:()=> 'token',setItem(){}},sessionStorage:{getItem:()=> 'token'},location:{pathname:'/orders.html',search:'',replace(path){c.redirect=path}},fetch:async()=>({ok:true,status:200,json:async()=>c.accessData})};vm.createContext(c);vm.runInContext(model+`\nlet visibleLinks=[];const activeId=${JSON.stringify(active)};const ia=id=>id===activeId?'ib-active':'';\n`+renderer+`\nfunction renderShellLinks(){}\nfunction gotoLogin(){location.replace('/login.html');}\n`+access+`\nglobalThis.nav={LINKS,buildNavigation,configure(screens,modules){roleScreens=screens===null?null:new Set(screens);licensedModules=modules===null?null:new Set(modules);visibleLinks=LINKS.filter(permittedLink);return visibleLinks;},render:renderNavLinks,applyLicense:applyLicensedModules,async access(screens){globalThis.accessData={screens:screens.map(id=>({id})),role:'production'};await applyAccessControl();return visibleLinks;},current(){return visibleLinks;},path(path){location.pathname=path;},redirect(){return globalThis.redirect;},expand(key,value){navExpansion.set(key,value);}};`,c);return c.nav;
}
const flatten=nodes=>nodes.flatMap(n=>[...(n.link?[n.link.id]:[]),...flatten(n.children)]);
function screens(nav){return nav.LINKS.map(l=>l.id==='new'?'new-order':l.id);}
test('approved compact tree contains daily screens once and removes fleet, drivers, holdings and warroom',()=>{
 const n=fixture(),allowed=n.configure(screens(n),null),tree=n.buildNavigation(allowed),ids=flatten(tree);
 assert.deepEqual(Array.from(tree.filter(n=>n.link).map(n=>n.key)),['new','dashboard','orders','production-queue','inventory','procurement','customers','reports']);
 for(const id of ['delivery-admin','driver','holdings','warroom'])assert.ok(!ids.includes(id));
 assert.equal(new Set(ids).size,ids.length);
 assert.ok(tree.find(n=>n.key==='customers').children.some(n=>n.key==='projects'));
 const more=tree.find(n=>n.key==='more'),settings=tree.find(n=>n.key==='settings');
 for(const id of ['intake','warehouse','quality','maintenance','finance','pricing','profitability'])assert.ok(flatten(more.children).includes(id));
 for(const id of ['machine','kiosk','production-setup','worker-visual','scanner','support','bugs','admin'])assert.ok(flatten(settings.children).includes(id));
 assert.ok(n.LINKS.some(l=>l.id==='holdings'),'bookmark screen metadata retained for role guard');
});
test('role and license restrictions intersect and cannot be undone by either refresh order',async()=>{
 const n=fixture(),roles=['orders','new-order','production-queue','inventory','finance','customers','projects','admin'];
 n.path('/dashboard.html');const first=n.configure(roles,['orders','production','inventory']);
 n.configure(null,null);await n.access(roles);n.applyLicense({restricted:true,modules:['orders','production','inventory']});
 assert.deepEqual(Array.from(n.current().map(l=>l.id)),Array.from(first.map(l=>l.id)));
 await n.access(roles);assert.ok(!n.current().some(l=>l.id==='finance'),'access refresh cannot restore an unlicensed finance module');
 n.applyLicense({restricted:false});await n.access(['production-queue','kiosk']);n.applyLicense({restricted:true,modules:['orders','production']});assert.ok(!n.current().some(l=>l.id==='orders'),'license refresh cannot restore role-hidden orders');
 const ids=flatten(n.buildNavigation(first));for(const id of ['finance','pricing','profitability','customers','projects'])assert.ok(!ids.includes(id));
 const withoutLicense=flatten(n.buildNavigation(n.configure(roles,null)));for(const id of ['finance','pricing','profitability'])assert.ok(withoutLicense.includes(id));
 const production=flatten(n.buildNavigation(n.configure(['production-queue','kiosk','machine'],null)));for(const id of ['orders','admin','finance','projects'])assert.ok(!production.includes(id));assert.ok(production.includes('kiosk'));
 const orphanProjects=n.buildNavigation(n.configure(['projects'],null));assert.ok(flatten(orphanProjects).includes('projects'),'permitted child is reachable when its parent is unavailable');
});
test('desktop and drawer render the same allowed destinations with active groups and explicit close state',()=>{
 const n=fixture('kiosk');n.configure(screens(n),null);
 const desktop=n.render('ib-link'),drawer=n.render('ib-dl');
 const hrefs=html=>[...html.matchAll(/href="([^"]+)"/g)].map(m=>m[1]);assert.deepEqual(hrefs(desktop),hrefs(drawer));
 assert.match(desktop,/data-nav-group="settings" aria-expanded="true"/);
 assert.match(desktop,/aria-current="page"/);assert.doesNotMatch(desktop,/href="\/(driver|delivery-admin|holdings|warroom)\.html/);
 n.expand('settings',false);assert.match(n.render('ib-link'),/data-nav-group="settings" aria-expanded="false"/);
 const main=fixture('orders');main.configure(screens(main),null);assert.match(main.render('ib-link'),/data-nav-group="more" aria-expanded="false"/);assert.match(main.render('ib-link'),/data-nav-group="settings" aria-expanded="false"/);
});
test('hidden secondary group labels are escaped and refreshed mobile links use delegated close handling',()=>{
 const n=fixture();const links=n.configure(screens(n),null);links.find(l=>l.id==='customers').label='<img src=x onerror=1>';assert.match(n.render('ib-link'),/&lt;img/);assert.doesNotMatch(n.render('ib-link'),/<img src=x/);
 assert.match(source,/drawer\.addEventListener\('click',e=>\{if\(e\.target\.closest\('a\.ib-dl'\)\)closeDrawer/);
 assert.match(source,/if\(!button\)return;e\.stopPropagation\(\)/);
 const admin=fs.readFileSync('public/admin.html','utf8');assert.doesNotMatch(admin,/<a href="\/(delivery-admin|holdings)\.html"[^>]*class="qn"/);
});

test('bookmarked removed screens retain their role guard independently of navigation hiding',async()=>{
 const n=fixture();n.path('/holdings.html');await n.access(['orders']);assert.equal(n.redirect(),'/dashboard.html');
});
