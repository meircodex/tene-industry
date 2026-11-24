'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { ensureCoreSchema, runCoreMigrations } = require('../../db/startup');

function openFinanceDb(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tene-finance-'));
  const db = new Database(path.join(directory, 'finance.sqlite'));
  t.after(() => {
    db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  db.pragma('foreign_keys = ON');
  ensureCoreSchema(db);
  runCoreMigrations(db);
  return db;
}

module.exports = { openFinanceDb };
