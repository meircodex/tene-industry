'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-worker-invitations-'));
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'worker-invitation-test-secret';
process.env.BCRYPT_ROUNDS = '4';
process.env.DB_PATH = path.join(tmpDir, 'worker-invitations.db');
process.env.BACKUP_DIR = path.join(tmpDir, 'backups');
delete process.env.ALLOW_UNINVITED_DEVICE_ENROLLMENT;

const { closeServer, db, server } = require('../server');
const { hashPin } = require('../auth-core');

let baseUrl;

function seedUser(username, role, pin) {
  return db.prepare(`
    INSERT INTO users (username,display_name,role,pin,pin_hash,active,password_changed_at)
    VALUES (?,?,?,?,?,?,?)
  `).run(username, username, role, pin, hashPin(pin, 4), 1, new Date().toISOString()).lastInsertRowid;
}

async function request(pathname, options = {}) {
  return fetch(`${baseUrl}${pathname}`, options);
}

async function login(username, pin) {
  const response = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, pin }),
  });
  assert.equal(response.status, 200);
  return (await response.json()).access_token;
}

test('a personal worker invitation activates one passwordless device with server-side QR permissions', async (t) => {
  seedUser('invite-admin', 'admin', '7701');
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => closeServer(resolve));
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const legacyAttempt = await request('/api/device-enrollment/requests', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requester_name: 'אורח', device_name: 'טלפון' }),
  });
  assert.equal(legacyAttempt.status, 403);
  assert.equal((await legacyAttempt.json()).error, 'worker_invitation_required');

  const adminToken = await login('invite-admin', '7701');
  const adminHeaders = { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' };
  const saveProfile = await request('/api/worker-profiles', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ worker_name: 'דוד כהן', phone: '050-1234567', role: 'production', permissions: ['production'] }),
  });
  assert.equal(saveProfile.status, 201);
  const profile = await saveProfile.json();
  assert.equal(profile.worker_name, 'דוד כהן');
  assert.deepEqual(profile.permissions, ['production']);
  const duplicateProfile = await request('/api/worker-profiles', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ worker_name: 'דוד אחר', phone: '+972 50-1234567', role: 'production', permissions: ['production'] }),
  });
  assert.equal(duplicateProfile.status, 409);
  assert.equal((await duplicateProfile.json()).error, 'worker_phone_already_saved');
  const profiles = await request('/api/worker-profiles', { headers: adminHeaders });
  assert.equal(profiles.status, 200);
  assert.equal((await profiles.json()).length, 1);

  const create = await request(`/api/worker-profiles/${profile.id}/invitations`, {
    method: 'POST', headers: adminHeaders, body: '{}',
  });
  assert.equal(create.status, 201);
  const created = await create.json();
  const activation = new URL(created.activation_url);
  const rawToken = activation.searchParams.get('token');
  assert.match(rawToken, /^WINV-[A-F0-9]{16}\./);
  assert.match(created.activation_qr_data_url, /^data:image\/png;base64,/);
  assert.equal(created.invitation.status, 'pending');

  const inspect = await request(`/api/worker-invitations/activation?token=${encodeURIComponent(rawToken)}`);
  assert.equal(inspect.status, 200);
  assert.deepEqual((({ worker_name, role, status }) => ({ worker_name, role, status }))(await inspect.json()), {
    worker_name: 'דוד כהן', role: 'production', status: 'opened',
  });

  const claim = await request('/api/worker-invitations/activation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rawToken, device_name: 'טלפון דוד', platform: 'Android' }),
  });
  assert.equal(claim.status, 201);
  const claimed = await claim.json();
  assert.equal(claimed.status, 'approved');
  assert.deepEqual(claimed.permissions, ['production']);
  assert.match(claimed.device_credential, /^DEV-[A-F0-9]{16}\./);

  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM users WHERE username='david.cohen'").get().count, 0);
  const device = db.prepare('SELECT * FROM device_enrollment_requests WHERE invitation_id IS NOT NULL').get();
  assert.equal(device.status, 'approved');
  assert.equal(device.worker_role, 'production');
  assert.deepEqual(JSON.parse(device.permissions_json), ['production']);
  assert.ok(device.invitation_id);
  const status = await request('/api/device-enrollment/status', { headers: { 'X-IronBend-Device': claimed.device_credential } });
  assert.equal((await status.json()).status, 'approved');

  assert.equal((await request('/api/qr-access/mode')).status, 200);
  assert.equal((await (await request('/api/qr-access/mode')).json()).mode, 'open');
  const openScan = await request('/api/qr-access/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'card', value: 'ORDER-000001', scanner_id: 'open-test-scanner' }),
  });
  assert.equal(openScan.status, 200);
  const namedOpen = await request('/api/qr-access/scan', {
    method:'POST',headers:{'Content-Type':'application/json','X-IronBend-Device':claimed.device_credential},
    body:JSON.stringify({kind:'card',value:'ORDER-000001'})
  });
  assert.equal(namedOpen.status,200);
  assert.equal(db.prepare('SELECT actor_name FROM qr_scan_activity ORDER BY id DESC LIMIT 1').get().actor_name,'דוד כהן');
  const profileBody={worker_name:'דוד מעודכן',phone:'0501234567',role:'production',permissions:['warehouse'],active:true};
  assert.equal((await request(`/api/worker-profiles/${profile.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify(profileBody)})).status,200);
  const deniedOpen=await request('/api/qr-access/scan',{method:'POST',headers:{'Content-Type':'application/json','X-IronBend-Device':claimed.device_credential},body:JSON.stringify({kind:'card',value:'ORDER-000001'})});
  assert.equal(deniedOpen.status,403);
  assert.equal((await deniedOpen.json()).error,'qr_permission_denied');
  assert.equal(db.prepare('SELECT actor_name FROM qr_scan_activity ORDER BY id DESC LIMIT 1').get().actor_name,'דוד מעודכן');
  profileBody.permissions=['production'];profileBody.active=false;
  assert.equal((await request(`/api/worker-profiles/${profile.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify(profileBody)})).status,200);
  const disabled=await request('/api/qr-access/scan',{method:'POST',headers:{'Content-Type':'application/json','X-IronBend-Device':claimed.device_credential},body:JSON.stringify({kind:'card',value:'ORDER-000001'})});
  assert.equal(disabled.status,403);assert.equal((await disabled.json()).error,'worker_disabled');
  profileBody.active=true;profileBody.worker_name='דוד כהן';
  assert.equal((await request(`/api/worker-profiles/${profile.id}`,{method:'PATCH',headers:adminHeaders,body:JSON.stringify(profileBody)})).status,200);
  const secureMode = await request('/api/qr-access/mode', {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ mode: 'secure' }),
  });
  const secureModeBody = await secureMode.json();
  assert.equal(secureMode.status, 200, JSON.stringify(secureModeBody));
  const productionScan = await request('/api/qr-access/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IronBend-Device': claimed.device_credential },
    body: JSON.stringify({ kind: 'card', value: 'ORDER-000001', scanner_id: 'test-scanner' }),
  });
  assert.equal(productionScan.status, 200);
  const warehouseDenied = await request('/api/qr-access/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IronBend-Device': claimed.device_credential },
    body: JSON.stringify({ kind: 'order', value: 'TENE-ORDER-1', order_id: 1 }),
  });
  assert.equal(warehouseDenied.status, 403);
  assert.equal((await warehouseDenied.json()).error, 'qr_permission_denied');
  const revoke = await request(`/api/device-enrollment/requests/${device.id}`, {
    method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ status: 'revoked' }),
  });
  assert.equal(revoke.status, 200);
  const revokedScan = await request('/api/qr-access/scan', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-IronBend-Device': claimed.device_credential },
    body: JSON.stringify({ kind: 'card', value: 'ORDER-000001' }),
  });
  assert.equal(revokedScan.status, 403);
  assert.equal((await revokedScan.json()).error, 'device_activation_required');
  const activity = db.prepare('SELECT access_mode,permission,outcome,actor_name FROM qr_scan_activity ORDER BY id').all();
  assert.deepEqual(activity.map(row => [row.access_mode, row.permission, row.outcome, row.actor_name]), [
    ['open', 'production', 'allowed', 'סריקה פתוחה'],
    ['open','production','allowed','דוד כהן'],
    ['open','production','qr_permission_denied','דוד מעודכן'],
    ['open','production','worker_disabled','דוד מעודכן'],
    ['secure', 'production', 'allowed', 'דוד כהן'],
    ['secure', 'warehouse', 'qr_permission_denied', 'דוד כהן'],
    ['secure', 'production', 'device_activation_required', 'דוד כהן'],
  ]);

  const reused = await request('/api/worker-invitations/activation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: rawToken, device_name: 'טלפון אחר' }),
  });
  assert.equal(reused.status, 409);
  assert.equal((await reused.json()).error, 'invitation_already_used');

  const reactivate = await request(`/api/worker-profiles/${profile.id}/invitations`, {
    method: 'POST', headers: adminHeaders, body: '{}',
  });
  assert.equal(reactivate.status, 201);
  const reactivateToken = new URL((await reactivate.json()).activation_url).searchParams.get('token');
  const reactivateClaim = await request('/api/worker-invitations/activation', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: reactivateToken, device_name: 'טלפון דוד החדש', platform: 'Android' }),
  });
  assert.equal(reactivateClaim.status, 201);
  const devicesAfterReactivation = db.prepare(`
    SELECT d.status,d.device_name FROM device_enrollment_requests d
    JOIN worker_invitations wi ON wi.id=d.invitation_id
    WHERE wi.worker_profile_id=? ORDER BY d.id
  `).all(profile.id);
  assert.deepEqual(devicesAfterReactivation, [
    { status: 'revoked', device_name: 'טלפון דוד' },
    { status: 'approved', device_name: 'טלפון דוד החדש' },
  ]);

  const expiring = await request('/api/worker-invitations', {
    method: 'POST', headers: adminHeaders,
    body: JSON.stringify({ worker_name: 'נועה לוי', phone: '052-1234567', role: 'warehouse' }),
  });
  const expiringBody = await expiring.json();
  const expiredToken = new URL(expiringBody.activation_url).searchParams.get('token');
  db.prepare("UPDATE worker_invitations SET expires_at=datetime('now','-1 minute') WHERE id=?").run(expiringBody.invitation.id);
  const expired = await request(`/api/worker-invitations/activation?token=${encodeURIComponent(expiredToken)}`);
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).error, 'invitation_expired');
});
