'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),Database=require('better-sqlite3');
const {generateKeyPairSync,sign}=require('node:crypto');
const {StationInbox}=require('../services/machineIntegration/stationInbox');
const {AutomaticConnection,proofBytes,keyId}=require('../services/machineIntegration/automaticConnection');
function fixture(t){
 const db=new Database(':memory:');t.after(()=>db.close());db.exec("CREATE TABLE machines(id INTEGER PRIMARY KEY,name TEXT);INSERT INTO machines VALUES(7,'6'),(6,'7'),(8,'תלת מימד');");
 const pair=generateKeyPairSync('ed25519'),der=pair.publicKey.export({type:'spki',format:'der'});
 const grant={keyId:keyId(der),sourceId:'SYNTHETIC-installation-machine6',logicalMachineId:'machine6',machineLabel:'6',centralOrigin:'https://ironbend.invalid',publicKey:der.toString('base64url')};
 let at=Date.now(),grants=[grant];const inbox=new StationInbox({db}),service=new AutomaticConnection({db,inbox,grants:()=>grants,now:()=>at});
 const identity={keyId:grant.keyId,sourceId:grant.sourceId,logicalMachineId:grant.logicalMachineId};
 const finish=c=>({challengeId:c.challengeId,signature:sign(null,proofBytes(c),pair.privateKey).toString('base64url')});
 return {db,pair,grant,inbox,service,identity,finish,advance:ms=>at+=ms,revoke:()=>grants=[]};
}
test('a preprovisioned installation signs one challenge, maps label 6 to row 7 and needs no user password',t=>{
 const f=fixture(t),c=f.service.begin(f.identity);assert.equal(c.machineId,7);assert.deepEqual(f.service.begin(f.identity),c);
 const result=f.service.finish(f.finish(c));assert.equal(result.machineId,7);assert.equal(result.transport,'station-scoped-v1');
 assert.match(result.credential,/^[a-f0-9]{64}$/);assert.equal(f.inbox.authorize({sourceId:f.identity.sourceId,machineId:'machine6'},result.credential).central_machine_id,7);
 assert.equal('accessToken'in result,false);assert.equal('refreshCookie'in result,false);
 assert.throws(()=>f.service.finish(f.finish(c)),/STATION_CHALLENGE_EXPIRED/);
});
test('an unknown key, another source or another machine cannot enroll',t=>{
 const f=fixture(t);for(const input of [{...f.identity,keyId:'a'.repeat(64)},{...f.identity,sourceId:'other'},{...f.identity,logicalMachineId:'machine3d'}])assert.throws(()=>f.service.begin(input),/STATION_NOT_PROVISIONED/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM mi_station_bindings').get().n,0);
});
test('wrong signatures, expired challenges and revoked deployment grants cannot create a binding',t=>{
 const f=fixture(t),c=f.service.begin(f.identity),other=generateKeyPairSync('ed25519');
 assert.throws(()=>f.service.finish({challengeId:c.challengeId,signature:sign(null,proofBytes(c),other.privateKey).toString('base64url')}),/STATION_SIGNATURE_INVALID/);
 f.advance(60001);assert.throws(()=>f.service.finish(f.finish(c)),/STATION_CHALLENGE_EXPIRED/);
 const second=f.service.begin(f.identity);f.revoke();assert.throws(()=>f.service.finish(f.finish(second)),/STATION_NOT_PROVISIONED/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM mi_station_bindings').get().n,0);
});
test('ambiguous directory entries and existing conflicting bindings stay blocked',t=>{
 const f=fixture(t);f.db.exec("INSERT INTO machines VALUES(9,'6')");assert.throws(()=>f.service.begin(f.identity),/STATION_MACHINE_DIRECTORY_UNRESOLVED/);
 f.db.prepare('UPDATE machines SET name=? WHERE id=9').run('other');f.inbox.register({id:1},{...f.identity,machineId:8});
 assert.throws(()=>f.service.begin(f.identity),/STATION_MACHINE_BINDING_CONFLICT/);
});
test('scoped station HTTP authentication permits its own reads, rejects another machine and grants no admin role',async t=>{
 const f=fixture(t),express=require('express'),app=express();app.use(express.json());let audits=0;
 const requireAnyRole=roles=>(req,res,next)=>{if(req.headers.authorization!=='Bearer SYNTHETIC-admin')return res.status(401).json({error:'AUTH_REQUIRED'});req.auth={sub:1,role:'admin'};next();};
 app.use('/api',require('../routes/machineStation')({db:f.db,requireAnyRole,auditLog:()=>audits++,wsBroadcast:()=>{},automaticConnection:{grants:()=>[f.grant]}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const post=async(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
 const challenge=await(await post('/api/machine-integration/automatic/challenge',f.identity)).json();
 const response=await post('/api/machine-integration/automatic/connect',f.finish(challenge));assert.equal(response.status,201);const connected=await response.json();assert.equal(audits,1);
 const headers={'X-Station-Credential':connected.credential,'X-Station-Source':f.identity.sourceId};
 const read=await fetch(base+'/api/machine-integration/station-identity?sourceId='+f.identity.sourceId,{headers});assert.equal(read.status,200);assert.equal((await read.json()).machineId,7);
 assert.equal((await fetch(base+'/api/machine-integration/station-requests?sourceId='+f.identity.sourceId,{headers})).status,200);
 assert.equal((await fetch(base+'/api/machine-integration/station-requests?sourceId=another',{headers})).status,403);
 assert.equal((await fetch(base+'/api/machine-integration/manufacturing-intent?machineId=8',{headers})).status,403);
 assert.equal((await post('/api/machine-integration/stations/register',{sourceId:'foreign',logicalMachineId:'machine3d',machineId:8},headers)).status,401);
 assert.equal((await fetch(base+'/api/machine-integration/station-events',{headers})).status,401);
 assert.equal((await post('/api/machine-integration/manufacturing-intents',{},headers)).status,401);
 assert.equal((await fetch(base+'/api/machine-integration/station-identity?sourceId='+f.identity.sourceId,{headers:{...headers,'X-Station-Credential':'a'.repeat(64)}})).status,403);
});
test('a station can read the original card without scan activity and cannot read another machine card or mutate worker status',async t=>{
 const f=fixture(t),express=require('express'),app=express();app.use(express.json());const c=f.service.begin(f.identity),binding=f.service.finish(f.finish(c));
 let machineId=7;const deny=()=>(req,res)=>res.status(401).json({error:'LOGIN_REQUIRED'});
 app.use('/api/machine-feedback',require('../routes/workerMachineFeedback')({db:f.db,requireQrPermission:deny,parseCard:()=>({itemId:9}),
  authorizeCard:()=>({id:9,machine_id:machineId}),snapshotBuilder:()=>({read_only:true,card_quantity:1,html:'unused'}),wsBroadcast:()=>{}}));
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));const base='http://127.0.0.1:'+server.address().port;
 const headers={'X-Station-Source':f.identity.sourceId,'X-Station-Credential':binding.credential};
 const read=()=>fetch(base+'/api/machine-feedback/snapshot?sourceId='+f.identity.sourceId+'&card=SYNTHETIC-9',{headers});
 const result=await read();assert.equal(result.status,200);assert.equal((await result.json()).activityFree,true);
 machineId=8;assert.equal((await read()).status,409);
 assert.equal((await fetch(base+'/api/machine-feedback/requests',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:'{}'})).status,401);
});
test('worker UI contains automatic matching and no station selection control',()=>{
 const fs=require('node:fs'),path=require('node:path'),source=fs.readFileSync(path.join(__dirname,'../public/worker-machine-feedback.js'),'utf8');
 assert.doesNotMatch(source,/<select|בחר תחנת מכונה|בחר את המכונה של עמדת העבודה/);assert.match(source,/s\.online&&matchesItem\(s\)/);
});
test('a contradictory card machine label and directory ID cannot select or authorize a different machine',t=>{
 const f=fixture(t),c=f.service.begin(f.identity),result=f.service.finish(f.finish(c));
 const binding=f.inbox.authorize({sourceId:f.identity.sourceId,machineId:'machine6'},result.credential);
 const {assertCardMachine}=require('../services/machineIntegration/automaticConnection');
 assert.doesNotThrow(()=>assertCardMachine(f.db,binding,{machine_id:7,machine:'6'}));
 assert.throws(()=>assertCardMachine(f.db,binding,{machine_id:7,machine:'תלת מימד'}),/STATION_CARD_MACHINE_MISMATCH/);
 assert.throws(()=>assertCardMachine(f.db,binding,{machine_id:6,machine:'6'}),/STATION_CARD_MACHINE_MISMATCH/);
});
