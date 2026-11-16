'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),http=require('node:http'),{once}=require('node:events'),WebSocket=require('ws');
const {createRealtimeServer}=require('../realtime/ws');
test('open system-link websocket rechecks current access before sending further data',async t=>{
 const server=http.createServer();let active=true,role='production';
 const realtime=createRealtimeServer({server,db:{},modbus:{getAllState:()=>({}),onUpdate(){}},applyAuthBypass(){},authService:{verifyAccessToken(token){assert.equal(token,'linked-test-token');if(!active)throw Error('revoked');return {sub:'7',system_link_id:3,role};}}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const ws=new WebSocket('ws://127.0.0.1:'+server.address().port+'/ws?token=linked-test-token');
 t.after(async()=>{ws.terminate();realtime.close();await new Promise(resolve=>server.close(resolve));});
 const received=[];ws.on('message',raw=>received.push(JSON.parse(String(raw))));await once(ws,'open');
 role='warehouse';const update=once(ws,'message');realtime.wsBroadcast('role-test',{});await update;
 assert.equal([...realtime.wss.clients][0].auth.role,'warehouse');
 active=false;const closed=once(ws,'close');realtime.wsBroadcast('protected-update',{sensitive:true});const [code]=await closed;
 assert.equal(code,1008);assert.ok(!received.some(event=>event.type==='protected-update'));
});
