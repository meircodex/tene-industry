'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const source=fs.readFileSync(require.resolve('../public/dashboard.js'),'utf8').replace(/bootDashboard\(\);\s*$/,'');
function fixture(){const pending=new Map(),calls=[],renders=[],nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{textContent:'—',style:{setProperty(){}},classList:{toggle(){}}});return nodes.get(id);};
const c={window:{},document:{addEventListener(){},getElementById:node},Date,URLSearchParams,AbortController,console,setTimeout,clearTimeout,fetch:url=>{calls.push(url);return new Promise(resolve=>pending.set(url,resolve));},record:d=>renders.push(d)};vm.createContext(c);vm.runInContext(source,c);
vm.runInContext(`renderKPIs=record;renderMachinesCompact=()=>{};renderWasteByMachine=()=>{};renderDailyProductionPlan=()=>{};renderTodayDeliveries=()=>{};renderProdQueue=()=>{};renderProductionCardsSummary=()=>{};renderStockShortages=()=>{};renderActionCenter=()=>{};`,c);
return {c,calls,renders,node,resolve(url,data,status=200){pending.get(url)({ok:status===200,status,json:async()=>data});},rest(){for(const url of calls.filter(u=>u!=='/api/dashboard'))this.resolve(url,url.includes('production-queue')?{items:[]}:url.includes('procurement')?{groups:[]}:[]);}};}
const flush=()=>new Promise(setImmediate);
test('dashboard displays main data before slow secondary responses and merges concurrent refreshes',async()=>{
 const f=fixture(),first=f.c.fetchDashboard(),second=f.c.fetchDashboard();assert.equal(first,second);assert.equal(f.calls.length,6);
 f.resolve('/api/dashboard',{pending:7,machines:[]});await flush();assert.equal(f.renders[0].pending,7);
 assert.equal(f.calls.filter(u=>u.includes('production-queue')).length,1);f.rest();await first;
 assert.equal(vm.runInContext('forecastLoaded',f.c),true);assert.ok(!f.calls.includes('/api/inventory/forecast'));
});
test('HTTP failure is never rendered as zero data and last valid dashboard values survive',async()=>{
 const f=fixture(),loading=f.c.fetchDashboard();f.resolve('/api/dashboard',{pending:4,machines:[]});f.rest();await loading;
 const previous=f.renders.length,next=f.c.fetchDashboard();f.resolve('/api/dashboard',{error:'unauthorized'},401);f.rest();await next;
 assert.ok(f.renders.slice(previous).every(d=>d.pending===4));assert.equal(vm.runInContext('dashData.pending',f.c),4);
 assert.match(f.node('overallStatusBadge').textContent,/התחברות/);
});
