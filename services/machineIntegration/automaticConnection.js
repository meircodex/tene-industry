'use strict';
const {randomBytes,createHash,createPublicKey,verify}=require('node:crypto');
const fail=(code,status=422)=>{throw Object.assign(Error(code),{status});};
const text=(v,max=240)=>typeof v==='string'&&v.length>0&&v.length<=max&&!/[\x00-\x1f]/.test(v);
const keyId=der=>createHash('sha256').update(der).digest('hex');
const proofBytes=p=>Buffer.from(JSON.stringify({purpose:'ironbend.station.enrollment.v1',keyId:p.keyId,sourceId:p.sourceId,
 logicalMachineId:p.logicalMachineId,machineId:p.machineId,centralOrigin:p.centralOrigin,challengeId:p.challengeId,nonce:p.nonce,expiresAt:p.expiresAt}));

// Operator sessions and passwords never enter this protocol. The deployment
// owner provisions a public installation key, source and exact directory label.
class AutomaticConnection{
 constructor({db,inbox,grants=()=>Object.entries(process.env).filter(([k])=>k.startsWith('IB_STATION_GRANT_')).map(([,v])=>v),now=()=>Date.now()}){
  if(!db||!inbox)throw Error('AUTOMATIC_CONNECTION_DEPENDENCY_REQUIRED');
  this.db=db;this.inbox=inbox;this.grants=grants;this.now=now;this.challenges=new Map();
 }
 grant(input){
  if(!input||!text(input.sourceId)||!text(input.logicalMachineId,120)||!/^[a-f0-9]{64}$/.test(input.keyId||''))fail('INVALID_STATION_IDENTITY');
  const matches=[];
  for(const raw of this.grants()){
   try{const g=typeof raw==='string'?JSON.parse(raw):raw,der=Buffer.from(g.publicKey,'base64url');
    if(g.keyId!==input.keyId||keyId(der)!==g.keyId||g.sourceId!==input.sourceId||g.logicalMachineId!==input.logicalMachineId||
      !text(g.machineLabel,120)||new URL(g.centralOrigin).origin!==g.centralOrigin||!g.centralOrigin.startsWith('https://'))continue;
    const publicKey=createPublicKey({key:der,type:'spki',format:'der'});if(publicKey.asymmetricKeyType!=='ed25519')continue;
    matches.push({...g,publicKey});
   }catch{}
  }
  if(matches.length!==1)fail('STATION_NOT_PROVISIONED',403);
  const grant=matches[0],machines=this.db.prepare('SELECT * FROM machines').all().filter(m=>String(m.label||m.name||'').trim()===grant.machineLabel);
  if(machines.length!==1)fail('STATION_MACHINE_DIRECTORY_UNRESOLVED',409);
  const binding=this.db.prepare('SELECT * FROM mi_station_bindings WHERE source_id=?').get(input.sourceId);
  if(binding&&(binding.logical_machine_id!==input.logicalMachineId||binding.central_machine_id!==machines[0].id))fail('STATION_MACHINE_BINDING_CONFLICT',409);
  return {...grant,machineId:machines[0].id};
 }
 begin(input){
  if(Object.keys(input||{}).some(k=>!['keyId','sourceId','logicalMachineId'].includes(k)))fail('INVALID_STATION_IDENTITY');
  const grant=this.grant(input),at=this.now();
  for(const [id,p] of this.challenges)if(Date.parse(p.expiresAt)<=at)this.challenges.delete(id);
  const old=[...this.challenges.values()].find(p=>p.keyId===input.keyId&&p.sourceId===input.sourceId);
  if(old)return old;
  if(this.challenges.size>=1000)fail('STATION_ENROLLMENT_BUSY',429);
  const challenge={...input,machineId:grant.machineId,centralOrigin:grant.centralOrigin,challengeId:randomBytes(24).toString('base64url'),
   nonce:randomBytes(32).toString('base64url'),expiresAt:new Date(at+60000).toISOString()};
  this.challenges.set(challenge.challengeId,challenge);return challenge;
 }
 finish(input){
  if(!input||Object.keys(input).some(k=>!['challengeId','signature'].includes(k))||!text(input.challengeId,100)||!/^[A-Za-z0-9_-]{86}$/.test(input.signature||''))fail('INVALID_STATION_PROOF');
  const challenge=this.challenges.get(input.challengeId);
  if(!challenge||Date.parse(challenge.expiresAt)<=this.now()){this.challenges.delete(input.challengeId);fail('STATION_CHALLENGE_EXPIRED',409);}
  const grant=this.grant(challenge);
  if(grant.machineId!==challenge.machineId||grant.centralOrigin!==challenge.centralOrigin||!verify(null,proofBytes(challenge),grant.publicKey,Buffer.from(input.signature,'base64url')))fail('STATION_SIGNATURE_INVALID',403);
  const result=this.inbox.register({id:'provisioned:'+grant.keyId},{sourceId:challenge.sourceId,logicalMachineId:challenge.logicalMachineId,machineId:grant.machineId});
  this.challenges.delete(input.challengeId);
  return {...result,keyId:grant.keyId,machineLabel:grant.machineLabel,transport:'station-scoped-v1'};
 }
}

function stationOrRole(feedback,fallback){
 return(req,res,next)=>{
  if(!req.headers['x-station-credential'])return fallback(req,res,next);
  try{const sourceId=req.query.sourceId||req.headers['x-station-source'];req.stationBinding=feedback.authorize(sourceId,req.headers['x-station-credential']);next();}
  catch(error){res.status(error.status||403).json({error:error.message});}
 };
}
function assertCardMachine(db,binding,item){
 if(!binding)return;
 const explicit=Number(item.machine_id),label=String(item.machine||'').trim();
 if(Number.isSafeInteger(explicit)&&explicit>0&&explicit!==binding.central_machine_id)fail('STATION_CARD_MACHINE_MISMATCH',409);
 if(label){const machine=db.prepare('SELECT * FROM machines WHERE id=?').get(binding.central_machine_id);
  if(label!==String(machine?.label||machine?.name||'').trim())fail('STATION_CARD_MACHINE_MISMATCH',409);}
}
module.exports={AutomaticConnection,stationOrRole,assertCardMachine,proofBytes,keyId};
