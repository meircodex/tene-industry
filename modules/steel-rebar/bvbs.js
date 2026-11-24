'use strict';

const { rebarKgPerMeter } = require('./weights');

function readNumber(value) {
  return /^-?\d+(?:[.,]\d+)?$/.test(value) ? Number(value.replace(',', '.')) : NaN;
}

function parseBF2D(line) {
  const [, first, ...fields] = line.split('@');
  const item = { project: first.startsWith('Hj') ? first.slice(2) : '' };

  // שדות הגיאומטריה והמחברים יכולים להשתמש שוב במפתחות מהכותרת.
  const blockStart = fields.findIndex(field => /^[A-Z]/.test(field));
  const headerFields = blockStart < 0 ? fields : fields.slice(0, blockStart);
  const firstBlock = fields[blockStart];
  if (firstBlock && /^[GMA]/.test(firstBlock) &&
      !/^Gl[\d.,]+@w0@C\d+@$/.test(fields.slice(blockStart).join('@'))) {
    item.shape_code = 'BF2D';
  }

  for (const field of headerFields) {
    const value = field.slice(1);
    switch (field[0]) {
      case 'j': item.project = value; break;
      case 'p': item.mark = value; break;
      case 'l': item.total_length = readNumber(value); break;
      case 'n': item.quantity = readNumber(value); break;
      case 'd': item.diameter = readNumber(value); break;
      case 'g': item.grade = value; break;
    }
  }

  return item;
}

/**
 * פרסר BVBS — פורמט תקני גרמני/ישראלי לקבצי כיפוף ברזל.
 * מקור: routes/bvbs.js — הועבר לכאן כדי שיהיה שייך למודול הפלדה.
 */
function parseBVBSLine(line) {
  line = line.trim();
  if (line.startsWith('BF2D@H')) return withWeights(parseBF2D(line));
  if (!line.startsWith('@')) return null;

  const item = {};
  const parts = line.split('^');

  for (const part of parts) {
    if (!part || part === '!' || part.startsWith('@')) continue;

    const m = part.match(/^([a-zA-Z]+)(.+)$/);
    if (!m) {
      // בלוק גיאומטריה [A 500 B 1800 ...]
      const geoM = part.match(/\[([^\]]+)\]/);
      if (geoM) {
        const legs = [];
        const tokens = geoM[1].trim().split(/\s+/);
        for (let i = 0; i < tokens.length - 1; i += 2) {
          const label = tokens[i];
          const len = parseFloat(tokens[i + 1]);
          if (!isNaN(len)) legs.push({ label, length: len });
        }
        item.legs  = legs;
        item.sides = legs.map(l => l.length);
      }
      continue;
    }

    const [, key, val] = m;
    switch (key.toLowerCase()) {
      case 'd':  item.diameter     = readNumber(val); break;
      case 'l':  item.total_length = readNumber(val); break;
      case 'n':  item.mark         = val; break;
      case 'p':  item.quantity     = readNumber(val); break;
      case 'a':  item.shape_code   = val; break;
      case 'r':
        item.grade_code = val;
        item.grade = val === '1' ? 'B500B' : val === '2' ? 'B500C' : 'B500B';
        break;
      case 'w':
        if (!item.angles) item.angles = [];
        item.angles.push(parseFloat(val));
        break;
    }
  }

  return withWeights(item);
}

function withWeights(item) {
  if (!Number.isFinite(item.diameter) || item.diameter <= 0 ||
      !Number.isFinite(item.total_length) || item.total_length <= 0 ||
      !Number.isSafeInteger(item.quantity) || item.quantity <= 0) return null;

  const kgPerM = rebarKgPerMeter(item.diameter);
  item.weight_per_unit = (item.total_length / 1000) * kgPerM;
  item.total_weight    = item.weight_per_unit * item.quantity;
  return Number.isFinite(item.total_weight) && item.total_weight > 0 ? item : null;
}

function parseBVBS(content) {
  const lines = content.split(/\r?\n/);
  const items = [];
  const header = {};

  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;

    if (t.startsWith('@1') || t.startsWith('@2')) {
      const parts = t.split('^');
      for (const p of parts) {
        const m = p.match(/^([A-Za-z]+)(.+)$/);
        if (!m) continue;
        if (m[1].toLowerCase() === 'bs') header.project  = m[2];
        if (m[1].toLowerCase() === 'kd') header.customer = m[2];
        if (m[1].toLowerCase() === 'da') header.date     = m[2];
      }
      continue;
    }

    const item = parseBVBSLine(t);
    if (item) {
      if (item.project && !header.project) header.project = item.project;
      delete item.project;
      items.push(item);
    }
  }

  return {
    header,
    items,
    total_weight: items.reduce((s, i) => s + i.total_weight, 0),
  };
}

module.exports = { parseBVBS, parseBVBSLine };
