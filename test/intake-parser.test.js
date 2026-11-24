const assert = require('node:assert/strict');
const test = require('node:test');
const axios = require('axios');
const { parseOCRText, runOCR } = require('../intake');

test('OCR parser extracts a simple rebar row', () => {
  const parsed = parseOCRText('12 6000 4');
  assert.deepEqual(parsed.items, [{ diameter: 12, length: 6000, qty: 4 }]);
});

test('OCR parser extracts delivery date and normalizes phone', () => {
  const parsed = parseOCRText('050-123 4567\n10/06/2026');
  assert.equal(parsed.customerPhone, '0501234567');
  assert.equal(parsed.deliveryDate, '2026-06-10');
});

test('OCR request uses supported document detection feature', async () => {
  const originalPost = axios.post;
  let request;
  axios.post = async (url, body) => {
    request = { url, body };
    return { data: { responses: [{}] } };
  };

  try {
    await runOCR(Buffer.from('image'), { apiKey: 'test-key' });
  } finally {
    axios.post = originalPost;
  }

  assert.match(request.url, /key=test-key$/);
  assert.deepEqual(request.body.requests[0].features, [
    { type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 },
  ]);
});

test('קליטה ממייל שומרת את ההזמנה ביומן לפני סימון ההודעה כנקראה', async t => {
  const Database = require('better-sqlite3');
  const { ImapFlow } = require('imapflow');
  const { pollEmail } = require('../intake');
  const { parseSteelDocument } = require('../services/steelDocumentParser');
  const { pages } = require('./fixtures/order105-tassa-pdf-words.json');
  const { items } = parseSteelDocument({ pages, fileName: 'order105.pdf' });
  const row = items.find(item => item.item_number === '3');
  const orderItem = { diameter: row.diameter, length: row.total_length_mm, qty: row.quantity };
  const text = `הזמנת ברזל 105\r\n${orderItem.diameter} ${orderItem.length} ${orderItem.qty}`;

  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec('CREATE TABLE intake_log (source TEXT, raw_content TEXT, parsed_data TEXT, status TEXT)');
  const lifecycle = [];
  t.mock.method(ImapFlow.prototype, 'connect', async () => { lifecycle.push('connect'); });
  t.mock.method(ImapFlow.prototype, 'getMailboxLock', async mailbox => {
    assert.equal(mailbox, 'INBOX');
    return { release: () => lifecycle.push('release') };
  });
  t.mock.method(ImapFlow.prototype, 'search', async criteria => {
    assert.equal(criteria.seen, false);
    return [1];
  });
  t.mock.method(ImapFlow.prototype, 'fetchOne', async uid => {
    assert.equal(uid, 1);
    return {
      source: Buffer.from(`Content-Type: text/plain; charset=utf-8\r\n\r\n${text}\r\n--boundary`),
      envelope: { subject: 'הזמנת ברזל 105' },
    };
  });
  t.mock.method(ImapFlow.prototype, 'messageFlagsAdd', async (uid, flags) => {
    assert.equal(uid, 1);
    assert.deepEqual(flags, ['\\Seen']);
    assert.equal(db.prepare('SELECT status FROM intake_log').get().status, 'pending_review');
    lifecycle.push('seen');
  });
  t.mock.method(ImapFlow.prototype, 'logout', async () => { lifecycle.push('logout'); });
  const classify = t.mock.method(axios, 'post', async (_url, body) => {
    assert.ok(body.contents[0].parts[0].text.includes(text));
    return { data: { candidates: [{ content: { parts: [{
      text: JSON.stringify({ is_order: true, customer_name: 'עשוש', items: [orderItem] }),
    }] } }] } };
  });
  t.mock.method(console, 'log', () => {});

  const results = await pollEmail(db, {
    host: 'mail.invalid', user: 'offline-fixture', pass: 'offline-fixture', geminiKey: 'offline-fixture',
  });

  assert.equal(classify.mock.callCount(), 1);
  assert.deepEqual(lifecycle, ['connect', 'seen', 'release', 'logout']);
  assert.equal(results.length, 1);
  assert.deepEqual(results[0].items, [{ diameter: 14, length: 8200, qty: 76 }]);
  const logged = db.prepare('SELECT * FROM intake_log').get();
  assert.equal(logged.source, 'email');
  assert.equal(logged.raw_content, text);
  assert.deepEqual(JSON.parse(logged.parsed_data), results[0]);
});
