'use strict';
const crypto = require('node:crypto');

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function textOrNull(value, maxLength = 240) {
  const text = String(value || '').trim().slice(0, maxLength);
  return text || null;
}

function createWorkerCardActivityService({ db }) {
  if (!db) throw new Error('worker card activity requires db');

  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_card_activity (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id                   INTEGER NOT NULL,
      order_id                  INTEGER,
      order_num                 TEXT,
      card_token                TEXT,
      action                    TEXT NOT NULL CHECK (action IN ('opened','status_changed','updated')),
      actor_user_id             INTEGER,
      actor_name                TEXT,
      device_enrollment_id      INTEGER,
      device_name               TEXT,
      details_json              JSON NOT NULL DEFAULT '{}',
      occurred_at               DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (item_id) REFERENCES items(id),
      FOREIGN KEY (actor_user_id) REFERENCES users(id),
      FOREIGN KEY (device_enrollment_id) REFERENCES device_enrollment_requests(id)
    );
    CREATE INDEX IF NOT EXISTS idx_worker_card_activity_period
      ON worker_card_activity(occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_worker_card_activity_item
      ON worker_card_activity(item_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_worker_card_activity_actor
      ON worker_card_activity(actor_user_id, occurred_at DESC);
    CREATE TABLE IF NOT EXISTS worker_card_requests (
      request_id TEXT PRIMARY KEY,
      item_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      activity_id INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      FOREIGN KEY(activity_id) REFERENCES worker_card_activity(id)
    );
  `);

  const insertActivity = db.prepare(`
    INSERT INTO worker_card_activity
      (item_id,order_id,order_num,card_token,action,actor_user_id,actor_name,device_enrollment_id,device_name,details_json)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);

  function record(req, item, action, details = {}) {
    const actorUserId = positiveInteger(req?.userId || req?.auth?.sub);
    const actorName = textOrNull(req?.qrAccess?.actor_name, 120)
      || textOrNull(req?.auth?.display_name, 120)
      || (actorUserId ? textOrNull(db.prepare('SELECT display_name FROM users WHERE id=?').get(actorUserId)?.display_name, 120) : null);
    const device = req?.approvedDevice || {};
    const deviceEnrollmentId = positiveInteger(device.id);
    const deviceName = textOrNull(device.device_name, 160);
    const token = textOrNull(req?.query?.card || req?.body?.card || req?.body?.scanToken, 512);
    const itemId = positiveInteger(item?.id);
    if (!itemId || !['opened', 'status_changed', 'updated'].includes(action)) return null;

    const inserted = insertActivity.run(
      itemId,
      positiveInteger(item?.order_id),
      textOrNull(item?.order_num, 120),
      token,
      action,
      actorUserId,
      actorName,
      deviceEnrollmentId,
      deviceName,
      JSON.stringify(details || {}),
    );
    const receipt = db.prepare(`
      SELECT id,item_id,action,strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at) AS occurred_at
      FROM worker_card_activity WHERE id=?
    `).get(inserted.lastInsertRowid);
    const request = requestIdentity(req, itemId, action);
    if (request) receipt.request_id = request.id;
    return receipt;
  }

  function requestIdentity(req, itemId, action) {
    const id = req?.body?.request_id;
    if (id === undefined) return null;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(id)) {
      throw Object.assign(new Error('invalid_worker_request_id'), { status: 400 });
    }
    const body = Object.fromEntries(Object.keys(req.body).filter(key => key !== 'request_id').sort().map(key => [key, req.body[key]]));
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify({ itemId: Number(itemId), action, body })).digest('hex');
    return { id, fingerprint };
  }

  function replay(req, itemId, action) {
    const request = requestIdentity(req, itemId, action);
    if (!request) return null;
    const previous = db.prepare('SELECT * FROM worker_card_requests WHERE request_id=?').get(request.id);
    if (!previous) return null;
    if (previous.item_id !== Number(itemId) || previous.action !== action || previous.fingerprint !== request.fingerprint) {
      throw Object.assign(new Error('worker_request_conflict'), { status: 409 });
    }
    return JSON.parse(previous.response_json);
  }

  function rememberResponse(req, itemId, action, response) {
    const request = requestIdentity(req, itemId, action);
    if (!request) return;
    db.prepare(`INSERT INTO worker_card_requests (request_id,item_id,action,fingerprint,activity_id,response_json)
      VALUES (?,?,?,?,?,?)`).run(request.id, Number(itemId), action, request.fingerprint, response.receipt.id, JSON.stringify(response));
  }

  return { record, replay, rememberResponse };
}

module.exports = { createWorkerCardActivityService };
