'use strict';
const {hashEvent} = require('../../contracts/machine-station/v1');
const {ITEM_STATUS} = require('../../status-contracts');
const {assertCardMachine}=require('./automaticConnection');
const ACTIONS = new Set(['card.open', 'mirror.read', 'completion.prepare', 'completion.record']);
const fail = (code, status = 422) => {throw Object.assign(Error(code), {status});};
const text = (v, max = 200) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\x00-\x1f]/.test(v);

class WorkerFeedback {
  constructor({db, inbox, now = () => new Date().toISOString()}) {
    if (!db || !inbox) throw Error('WORKER_FEEDBACK_DEPENDENCY_REQUIRED');
    this.db = db; this.inbox = inbox; this.now = now;
    db.exec(`CREATE TABLE IF NOT EXISTS mi_worker_requests(id TEXT PRIMARY KEY,source_id TEXT NOT NULL,
      item_id INTEGER NOT NULL,card TEXT NOT NULL,actor_key TEXT NOT NULL,action TEXT NOT NULL,input_hash TEXT NOT NULL,
      state TEXT NOT NULL,body TEXT NOT NULL,result_hash TEXT,result_body TEXT,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS mi_worker_request_source ON mi_worker_requests(source_id,state,created_at);
      CREATE TABLE IF NOT EXISTS mi_station_presence(source_id TEXT PRIMARY KEY,last_seen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS mi_station_current(source_id TEXT PRIMARY KEY,received_at TEXT NOT NULL,body TEXT NOT NULL);`);
  }
  stations({limit=100,offset=0}={}) {
    if(!Number.isInteger(limit)||limit<1||limit>200||!Number.isInteger(offset)||offset<0)fail('INVALID_STATION_PAGE');
    return {total:this.db.prepare('SELECT count(*) n FROM mi_station_bindings WHERE active=1').get().n,limit,offset,items: this.db.prepare(`SELECT b.source_id,b.logical_machine_id,b.central_machine_id,p.last_seen
      FROM mi_station_bindings b LEFT JOIN mi_station_presence p ON p.source_id=b.source_id WHERE b.active=1 ORDER BY b.central_machine_id,b.source_id LIMIT ? OFFSET ?`).all(limit,offset).map(row => {
      const machine = this.db.prepare('SELECT * FROM machines WHERE id=?').get(row.central_machine_id);
      const age = Date.parse(this.now()) - Date.parse(row.last_seen);
      return {sourceId: row.source_id, logicalMachineId: row.logical_machine_id, machineId: row.central_machine_id,
        label: machine?.label || machine?.name || row.logical_machine_id, lastSeenAtUtc: row.last_seen || null,
        online: Number.isFinite(age) && age >= -2000 && age < 10000};
    })};
  }
  create(actorKey, item, input) {
    if (!text(actorKey) || !Number.isSafeInteger(Number(item?.id))) fail('WORKER_SCOPE_REQUIRED', 403);
    if (!input || Object.keys(input).some(k => !['requestId', 'sourceId', 'itemId', 'card', 'action', 'payload'].includes(k)) ||
        !text(input.requestId, 160) || !text(input.sourceId) || !text(input.card, 512) ||
        Number(input.itemId) !== Number(item.id) || !ACTIONS.has(input.action)) fail('INVALID_WORKER_MACHINE_REQUEST');
    const binding = this.db.prepare('SELECT * FROM mi_station_bindings WHERE source_id=? AND active=1').get(input.sourceId);
    if (!binding) fail('MACHINE_STATION_NOT_REGISTERED', 404);
    assertCardMachine(this.db,binding,item);
    const payload = input.payload || {}, allowed = input.action === 'card.open' ? ['receiptId'] : input.action === 'completion.record'
      ? ['runId', 'proposalId', 'saveRecipe', 'receiptId'] : ['runId'];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || Object.keys(payload).some(k => !allowed.includes(k))) fail('INVALID_WORKER_MACHINE_PAYLOAD');
    if (input.action !== 'card.open' && !text(payload.runId)) fail('INVALID_WORKER_MACHINE_PAYLOAD');
    if (input.action === 'completion.record') {
      if (typeof payload.saveRecipe !== 'boolean' || payload.proposalId != null && !text(payload.proposalId)) fail('INVALID_WORKER_MACHINE_PAYLOAD');
      const receipt = Number.isSafeInteger(payload.receiptId) && this.db.prepare('SELECT * FROM worker_card_activity WHERE id=?').get(payload.receiptId);
      let details; try {details = receipt && JSON.parse(receipt.details_json);} catch {}
      if (!receipt || receipt.item_id !== Number(item.id) || receipt.action !== 'status_changed' || details?.to_status !== ITEM_STATUS.DONE ||
          receipt.card_token !== input.card) fail('BUSINESS_COMPLETION_RECEIPT_REQUIRED', 409);
    }
    const content = {sourceId: input.sourceId, logicalMachineId: binding.logical_machine_id, machineId: binding.central_machine_id,
      itemId: Number(item.id), card: input.card, action: input.action, payload}, inputHash = hashEvent(content);
    const old = this.db.prepare('SELECT * FROM mi_worker_requests WHERE id=?').get(input.requestId);
    if (old) {
      if (old.actor_key !== actorKey || old.input_hash !== inputHash) fail('WORKER_MACHINE_REQUEST_CONFLICT', 409);
      return this.get(actorKey, input.requestId);
    }
    if(input.action==='mirror.read'){
      const cached=this.db.prepare('SELECT * FROM mi_station_current WHERE source_id=?').get(input.sourceId);
      if(cached&&Date.parse(this.now())-Date.parse(cached.received_at)<10000){
        const data=JSON.parse(cached.body);
        if(data.card===input.card&&data.runId===payload.runId){
          const age=Date.parse(this.now())-Date.parse(data.observedAtUtc);
          data.live=data.live===true&&Number.isFinite(age)&&age>=-2000&&age<=5000;
          return {id:input.requestId,itemId:Number(item.id),sourceId:input.sourceId,card:input.card,action:input.action,
            state:'done',expiresAtUtc:new Date(Date.parse(cached.received_at)+10000).toISOString(),result:{ok:true,data}};
        }
      }
    }
    const createdAtUtc = this.now(), expiresAtUtc = new Date(Date.parse(createdAtUtc) + (input.action === 'completion.record' ? 86400000 : 30000)).toISOString();
    const body = {id: input.requestId, ...content, requestHash: inputHash, createdAtUtc, expiresAtUtc};
    this.db.prepare('INSERT INTO mi_worker_requests VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(body.id, body.sourceId, body.itemId, body.card, actorKey, body.action, inputHash, 'pending', JSON.stringify(body), null, null, createdAtUtc, expiresAtUtc);
    return this.get(actorKey, body.id);
  }
  get(actorKey, id) {
    if (!text(id, 160)) fail('INVALID_WORKER_MACHINE_REQUEST');
    const row = this.db.prepare('SELECT * FROM mi_worker_requests WHERE id=?').get(id);
    if (!row || row.actor_key !== actorKey) fail('WORKER_MACHINE_REQUEST_NOT_FOUND', 404);
    const expired = row.state === 'pending' && row.expires_at < this.now();
    return {id: row.id, itemId: row.item_id, sourceId: row.source_id, card: row.card, action: row.action,
      state: expired ? 'expired' : row.state, expiresAtUtc: row.expires_at,
      result: row.result_body ? JSON.parse(row.result_body) : null};
  }
  authorize(sourceId, credential) {
    const b = text(sourceId) && this.db.prepare('SELECT * FROM mi_station_bindings WHERE source_id=? AND active=1').get(sourceId);
    if (!b || !this.inbox.authorize({sourceId, machineId: b.logical_machine_id}, credential)) fail('STATION_SCOPE_FORBIDDEN', 403);
    return b;
  }
  publish(sourceId,credential,data){
    const binding=this.authorize(sourceId,credential);
    if(!data||data.sourceId!==sourceId||data.machineId!==binding.logical_machine_id||!text(data.card,512)||!text(data.runId)||
      !Array.isArray(data.rows)||data.rows.length>1000||typeof data.live!=='boolean'||Buffer.byteLength(JSON.stringify(data))>65536)fail('INVALID_STATION_MIRROR');
    const at=this.now();
    this.db.prepare('INSERT INTO mi_station_current VALUES(?,?,?) ON CONFLICT(source_id) DO UPDATE SET received_at=excluded.received_at,body=excluded.body')
      .run(sourceId,at,JSON.stringify(data));
    return {sourceId,receivedAtUtc:at,contentHash:hashEvent(data)};
  }
  pending(sourceId, credential, {limit = 10, offset = 0} = {}) {
    this.authorize(sourceId, credential);
    if (!Number.isInteger(limit) || limit < 1 || limit > 20 || !Number.isInteger(offset) || offset < 0) fail('INVALID_STATION_REQUEST_PAGE');
    const now = this.now();
    this.db.prepare('INSERT INTO mi_station_presence VALUES(?,?) ON CONFLICT(source_id) DO UPDATE SET last_seen=excluded.last_seen').run(sourceId, now);
    return {items: this.db.prepare("SELECT body FROM mi_worker_requests WHERE source_id=? AND state='pending' AND expires_at>=? ORDER BY rowid LIMIT ? OFFSET ?")
      .all(sourceId, now, limit, offset).map(row => JSON.parse(row.body)), limit, offset};
  }
  respond(sourceId, credential, input) {
    this.authorize(sourceId, credential);
    if (!input || Object.keys(input).some(k => !['requestId', 'requestHash', 'result'].includes(k)) || !text(input.requestId, 160) ||
        !/^[a-f0-9]{64}$/.test(input.requestHash || '') || typeof input.result?.ok !== 'boolean' || Buffer.byteLength(JSON.stringify(input.result)) > 262144) fail('INVALID_STATION_REQUEST_RESULT');
    const row = this.db.prepare('SELECT * FROM mi_worker_requests WHERE id=? AND source_id=?').get(input.requestId, sourceId);
    if (!row || row.input_hash !== input.requestHash) fail('STATION_REQUEST_SCOPE_MISMATCH', 409);
    const resultHash = hashEvent(input.result);
    if (row.state === 'done') {if (row.result_hash !== resultHash) fail('STATION_RESULT_CONFLICT', 409); return {id: row.id, status: 'duplicate', resultHash};}
    if (row.expires_at < this.now()) fail('STATION_REQUEST_EXPIRED', 409);
    this.db.prepare("UPDATE mi_worker_requests SET state='done',result_hash=?,result_body=? WHERE id=?")
      .run(resultHash, JSON.stringify(input.result), row.id);
    return {id: row.id, status: 'accepted', resultHash};
  }
}
module.exports = {WorkerFeedback, ACTIONS};
