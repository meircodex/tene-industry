const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function hashPin(pin, rounds = Number(process.env.BCRYPT_ROUNDS || 10)) {
  return pin ? bcrypt.hashSync(String(pin), Number(rounds)) : null;
}

function addColumn(db, table, column, definition) {
  const columns = db.pragma(`table_info(${table})`).map(row => row.name);
  if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function ensureAuthSchema(db) {
  addColumn(db, 'users', 'pin_hash', 'TEXT');
  addColumn(db, 'users', 'worker_portal_only', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'worker_portal_language', "TEXT NOT NULL DEFAULT 'he'");
  addColumn(db, 'users', 'worker_auth_version', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'users', 'failed_attempts', 'INTEGER DEFAULT 0');
  addColumn(db, 'users', 'locked_until', 'DATETIME');
  addColumn(db, 'users', 'password_changed_at', 'DATETIME');
  db.exec(`
    CREATE TABLE IF NOT EXISTS refresh_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      token_hash TEXT UNIQUE NOT NULL,
      expires_at DATETIME NOT NULL,
      revoked INTEGER DEFAULT 0,
      revoked_at DATETIME,
      user_agent TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens(token_hash);
    CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens(user_id, revoked);

    CREATE TABLE IF NOT EXISTS device_enrollment_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_uid TEXT UNIQUE NOT NULL,
      credential_hash TEXT UNIQUE NOT NULL,
      requester_name TEXT NOT NULL,
      device_name TEXT NOT NULL,
      platform TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected','revoked')),
      user_agent TEXT,
      ip_address TEXT,
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_at DATETIME,
      reviewed_by INTEGER,
      reviewed_by_name TEXT,
      last_seen_at DATETIME,
      FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_device_enrollment_status
      ON device_enrollment_requests(status, requested_at DESC);
  `);
  // These links are additive so devices that were approved before the
  // invitation flow remain valid. New worker devices are tied to one person
  // and one short-lived invitation from the moment they are registered.
  addColumn(db, 'device_enrollment_requests', 'requester_user_id', 'INTEGER');
  addColumn(db, 'device_enrollment_requests', 'invitation_id', 'INTEGER');
  addColumn(db, 'device_enrollment_requests', 'worker_role', 'TEXT');
  addColumn(db, 'device_enrollment_requests', 'permissions_json', "TEXT NOT NULL DEFAULT '[]'");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_device_enrollment_requester_user
      ON device_enrollment_requests(requester_user_id);
    CREATE INDEX IF NOT EXISTS idx_device_enrollment_invitation
      ON device_enrollment_requests(invitation_id);
  `);
  addColumn(db, 'refresh_tokens', 'system_link_id', 'INTEGER');
  require('./services/systemLoginLinks').ensureSchema(db);
}

function migratePlaintextPins(db, options = {}) {
  const rounds = Number(options.rounds || process.env.BCRYPT_ROUNDS || 10);
  const users = db.prepare(
    "SELECT id,pin FROM users WHERE pin IS NOT NULL AND pin<>'' AND (pin_hash IS NULL OR pin_hash='')"
  ).all();
  const update = db.prepare(
    'UPDATE users SET pin_hash=?,password_changed_at=COALESCE(password_changed_at,?) WHERE id=?'
  );
  const migratedAt = new Date().toISOString();
  db.transaction(() => {
    users.forEach(user => update.run(bcrypt.hashSync(String(user.pin), rounds), migratedAt, user.id));
  })();
  return users.length;
}

function createAuthService(db, options = {}) {
  const jwtSecret = options.jwtSecret || process.env.JWT_SECRET;
  if (!jwtSecret) throw new Error('JWT_SECRET is required');
  const rounds = Number(options.rounds || process.env.BCRYPT_ROUNDS || 10);
  const refreshDays = Number(options.refreshDays || process.env.REFRESH_TOKEN_DAYS || 7);
  const maxFailedAttempts = Number(options.maxFailedAttempts || 5);
  const lockMinutes = Number(options.lockMinutes || 15);
  const now = options.now || (() => new Date());
  const systemLinks=require('./services/systemLoginLinks').createService({db,now});

  // Access tokens are long-lived (default 3h) so an active shift never hits a
  // re-login prompt; the refresh cookie renews silently for longer gaps.
  const accessTokenTtl = options.accessTokenTtl || process.env.ACCESS_TOKEN_TTL || '3h';

  function accessTokenFor(user, systemLinkId=null) {
    return jwt.sign(
      { sub: String(user.id), role: user.role, display_name: user.display_name,...(systemLinkId?{system_link_id:systemLinkId}:{}),...(user.worker_portal_only?{portal_only:true,worker_auth_version:user.worker_auth_version}: {}) },
      jwtSecret,
      { expiresIn: accessTokenTtl }
    );
  }

  function storeRefreshToken(userId, meta = {}) {
    const token = crypto.randomBytes(64).toString('hex');
    const expiresAt = new Date(now().getTime() + (meta.systemLinkId?365:refreshDays) * 86400000).toISOString();
    db.prepare(
      'INSERT INTO refresh_tokens (user_id,token_hash,expires_at,user_agent,ip_address,system_link_id) VALUES (?,?,?,?,?,?)'
    ).run(userId, sha256(token), expiresAt, meta.userAgent || null, meta.ipAddress || null,meta.systemLinkId||null);
    return token;
  }

  function publicUser(user) {
    return { id: user.id, username: user.username, display_name: user.display_name, role: user.role,...(user.worker_portal_only?{portal_only:true,language:user.worker_portal_language}: {}) };
  }

  function authenticate({ username, pin }, meta = {}) {
    if (!pin) return { ok: false, status: 400, error: 'PIN is required' };
    const candidates = username
      ? [db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(username)].filter(Boolean)
      : db.prepare("SELECT * FROM users WHERE active=1 AND (pin_hash IS NOT NULL OR pin IS NOT NULL)").all();
    const user = candidates.find(candidate => candidate.pin_hash
      ? bcrypt.compareSync(String(pin), candidate.pin_hash)
      : candidate.pin != null && String(candidate.pin) !== '' && String(candidate.pin) === String(pin));

    if (!user) {
      if (username && candidates[0]) recordFailure(candidates[0]);
      return { ok: false, status: 401, error: 'Invalid credentials' };
    }
    if (user.locked_until && new Date(user.locked_until) > now()) {
      return { ok: false, status: 423, error: 'Account is temporarily locked' };
    }
    if (!user.pin_hash) {
      db.prepare('UPDATE users SET pin_hash=?,password_changed_at=COALESCE(password_changed_at,?) WHERE id=?')
        .run(bcrypt.hashSync(String(pin), rounds), now().toISOString(), user.id);
    }
    db.prepare('UPDATE users SET failed_attempts=0,locked_until=NULL,last_login=? WHERE id=?')
      .run(now().toISOString(), user.id);
    return {
      ok: true,
      accessToken: accessTokenFor(user),
      refreshToken: storeRefreshToken(user.id, meta),
      user: publicUser(user),
    };
  }

  function recordFailure(user) {
    const failedAttempts = Number(user.failed_attempts || 0) + 1;
    const lockedUntil = failedAttempts >= maxFailedAttempts
      ? new Date(now().getTime() + lockMinutes * 60000).toISOString()
      : null;
    db.prepare('UPDATE users SET failed_attempts=?,locked_until=? WHERE id=?')
      .run(failedAttempts, lockedUntil, user.id);
  }

  function refresh(refreshToken, meta = {}) {
    if (!refreshToken) return { ok: false, status: 401, error: 'Refresh token is required' };
    const row = db.prepare(`
      SELECT rt.*,u.username,u.display_name,u.role,u.active,u.worker_portal_only,u.worker_portal_language,u.worker_auth_version
      FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
      WHERE rt.token_hash=? AND rt.revoked=0
    `).get(sha256(refreshToken));
    if (!row || !row.active || new Date(row.expires_at) <= now()) {
      return { ok: false, status: 401, error: 'Refresh token is invalid or expired' };
    }
    if(row.system_link_id){try{systemLinks.session(row.system_link_id,row.user_id);}catch{return {ok:false,status:401,error:'system_link_session_revoked'};}}
    db.prepare('UPDATE refresh_tokens SET revoked=1,revoked_at=? WHERE id=?')
      .run(now().toISOString(), row.id);
    const user = { ...row, id: row.user_id };
    return {
      ok: true,
      accessToken: accessTokenFor(user,row.system_link_id),
      refreshToken: storeRefreshToken(row.user_id, {...meta,systemLinkId:row.system_link_id}),
      refreshDays: row.system_link_id?365:refreshDays,
      user: publicUser(user),
    };
  }

  function logout(refreshToken) {
    if (!refreshToken) return false;
    const row=db.prepare('SELECT user_id,system_link_id FROM refresh_tokens WHERE token_hash=?').get(sha256(refreshToken));
    if(row?.system_link_id)systemLinks.logout(row.system_link_id,row.user_id);
    return db.prepare('UPDATE refresh_tokens SET revoked=1,revoked_at=? WHERE token_hash=? AND revoked=0')
      .run(now().toISOString(), sha256(refreshToken)).changes > 0;
  }

  function savePortalUser({id,username,password,displayName,language,active}){
    if(typeof username!=='string'||!/^[-\p{L}\p{N}_.]{3,40}$/u.test(username))throw Object.assign(Error('invalid_portal_username'),{status:400});
    if((!id||password!==undefined&&password!=='')&&(typeof password!=='string'||password.length<8||Buffer.byteLength(password,'utf8')>72))throw Object.assign(Error('invalid_portal_password'),{status:400});
    const duplicate=db.prepare('SELECT id FROM users WHERE username=?').get(username);
    if(duplicate&&Number(duplicate.id)!==Number(id))throw Object.assign(Error('portal_username_taken'),{status:409});
    const changed=now().toISOString();
    if(id){
      const before=db.prepare('SELECT * FROM users WHERE id=? AND worker_portal_only=1').get(id);if(!before)throw Object.assign(Error('invalid_portal_account'),{status:409});
      db.prepare(`UPDATE users SET username=?,display_name=?,worker_portal_language=?,active=?,pin=NULL,pin_hash=?,password_changed_at=?,worker_auth_version=worker_auth_version+? WHERE id=?`).run(username,displayName,language,Number(active),password?hashPin(password,rounds):before.pin_hash,password?changed:before.password_changed_at,password||!active?1:0,id);
      if(password||!active)db.prepare('UPDATE refresh_tokens SET revoked=1,revoked_at=? WHERE user_id=?').run(changed,id);
    }else id=db.prepare(`INSERT INTO users(username,display_name,role,pin_hash,active,password_changed_at,worker_portal_only,worker_portal_language)VALUES(?,?,'production',?,?,?,1,?)`).run(username,displayName,hashPin(password,rounds),Number(active),changed,language).lastInsertRowid;
    return db.prepare('SELECT id,username,worker_portal_language FROM users WHERE id=?').get(id);
  }
  function authenticateWorker({username,password},meta){
    if(typeof username!=='string'||typeof password!=='string'||password.length>128)return {ok:false,status:401,error:'invalid_worker_credentials'};
    const user=db.prepare('SELECT worker_portal_only FROM users WHERE username=?').get(username);
    if(!user?.worker_portal_only)return {ok:false,status:401,error:'invalid_worker_credentials'};
    const result=authenticate({username,pin:password},meta);if(!result.ok)return {...result,error:result.status===423?'worker_login_locked':'invalid_worker_credentials'};
    return result;
  }
  function setPortalLanguage(userId,language){
    if(!['he','en','th'].includes(language))throw Object.assign(Error('invalid_portal_language'),{status:400});
    db.prepare('UPDATE users SET worker_portal_language=? WHERE id=? AND worker_portal_only=1').run(language,userId);
  }
  function revokePortalSessions(userId){
    db.transaction(()=>{db.prepare('UPDATE users SET worker_auth_version=worker_auth_version+1 WHERE id=? AND worker_portal_only=1').run(userId);db.prepare('UPDATE refresh_tokens SET revoked=1,revoked_at=? WHERE user_id=?').run(now().toISOString(),userId);})();
  }
  function verifyAccessToken(token){
    const claims=jwt.verify(token,jwtSecret);
    if(claims.system_link_id){const current=systemLinks.session(claims.system_link_id,claims.sub);return {...claims,role:current.role,display_name:current.display_name};}
    if(claims.portal_only){const user=db.prepare('SELECT active,worker_portal_only,worker_auth_version FROM users WHERE id=?').get(claims.sub);if(!user?.active||!user.worker_portal_only||Number(user.worker_auth_version)!==Number(claims.worker_auth_version))throw Error('worker_session_revoked');}
    return claims;
  }
  return {
    createSystemLoginLink:systemLinks.create,previewSystemLoginLink:systemLinks.preview,revokeSystemLoginLinks:systemLinks.revoke,
    logoutSystemLoginLink:systemLinks.logout,
    claimSystemLoginLink(token,meta={}){return db.transaction(()=>{const grant=systemLinks.claim(token);db.prepare('UPDATE users SET last_login=? WHERE id=?').run(now().toISOString(),grant.user.id);return {ok:true,accessToken:accessTokenFor(grant.user,grant.id),refreshToken:storeRefreshToken(grant.user.id,{...meta,systemLinkId:grant.id}),refreshDays:365,user:publicUser(grant.user)};})();},
    authenticate,authenticateWorker,savePortalUser,setPortalLanguage,revokePortalSessions,
    logout,
    refresh,
    verifyAccessToken,
  };
}

module.exports = { createAuthService, ensureAuthSchema, hashPin, migratePlaintextPins, sha256 };
