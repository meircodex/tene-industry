'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadPortalClient } = require('./helpers/customer-portal-client');

const reply = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
const approved = { id: 7, status: 'approved', original_name: 'approved.pdf', uploaded_at: '2026-11-25 12:00:00' };
const pending = { id: 8, status: 'uploaded_pending_review', original_name: 'fixture.pdf', uploaded_at: '2026-11-25 13:00:00' };

function setup() {
  const client = loadPortalClient();
  client.run('TOKEN = "fixture"');
  const file = new File(['synthetic'], pending.original_name, { type: 'application/pdf' });
  Object.assign(client.element('guaranteeFile'), { files: [file], value: file.name });
  const notices = [];
  client.context.toast = (...args) => notices.push(args);
  return {
    ...client, file, notices,
    status: () => client.element('guaranteeStatus').textContent,
    list: () => client.element('guaranteeDocsList').innerHTML,
    note: () => client.element('guaranteeListNotice').textContent,
    retry: () => client.element('guaranteeListRetry'),
  };
}

test('only a successful empty GET says no guarantee was uploaded', async () => {
  const c = setup();
  c.context.fetch = async () => reply({ documents: [] });
  await c.run('loadGuaranteeDocuments()');
  assert.equal(c.status(), 'לא הועלה');
  assert.match(c.list(), /אין עדיין טופס/);
  assert.equal(c.retry().hidden, true);
});

for (const [name, fetch] of [
  ['HTTP 503 even with an empty error payload', async () => reply({ documents: [] }, 503)],
  ['network failure', async () => { throw new Error('offline'); }],
  ['unexpected JSON response', async () => reply({})],
  ['invalid JSON', async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('invalid'); } })],
]) {
  test(`${name} shows unknown status and a list-only retry`, async () => {
    const c = setup();
    c.context.fetch = fetch;
    await c.run('loadGuaranteeDocuments()');
    assert.match(c.status(), /לא ניתן לבדוק/);
    assert.doesNotMatch(c.list(), /אין עדיין טופס/);
    assert.equal(c.retry().hidden, false);
    c.context.fetch = async (url, options) => {
      assert.match(url, /guarantee-documents\?/);
      assert.equal(options?.method, undefined);
      return reply({ documents: [approved] });
    };
    await c.run('loadGuaranteeDocuments()');
    assert.equal(c.status(), 'מאושר');
    assert.match(c.list(), /<bdi>25\/11\/2026/);
    assert.equal(c.retry().hidden, true);
  });
}

test('refresh failure retains last good status; a forbidden response clears it', async () => {
  const c = setup();
  const sequence = [reply({ documents: [approved] }), reply({}, 503), reply({}, 403)];
  c.context.fetch = async () => sequence.shift();
  await c.run('loadGuaranteeDocuments()');
  await c.run('loadGuaranteeDocuments()');
  assert.equal(c.status(), 'מאושר');
  assert.match(c.note(), /המידע האחרון/);
  await c.run('loadGuaranteeDocuments()');
  assert.equal(c.status(), 'אין גישה למסמכי הערבות');
  assert.doesNotMatch(c.list(), /approved.pdf/);
  assert.equal(c.retry().hidden, true);
});

test('confirmed upload survives failed and stale list refreshes, then resolves by document ID', async () => {
  const c = setup();
  const calls = [];
  const results = [reply({ success: true, id: 8, status: pending.status }), reply({}, 503), reply({ documents: [approved] }), reply({ documents: [pending, approved] })];
  c.context.fetch = async (url, options) => {
    calls.push(options?.method || 'GET');
    if (options?.method === 'POST') assert.equal(options.body.get('file').name, 'fixture.pdf');
    return results.shift();
  };
  await c.run('uploadGuaranteeDocument()');
  assert.equal(c.status(), 'ממתין לבדיקת המשרד');
  assert.match(c.note(), /אין צורך להעלות שוב/);
  assert.match(c.list(), /fixture.pdf/);
  assert.equal(c.element('guaranteeFile').value, '');
  assert.equal(c.element('uploadGuaranteeBtn').disabled, false);
  assert.equal(c.retry().hidden, false);
  await c.run('loadGuaranteeDocuments()');
  assert.equal(c.status(), 'ממתין לבדיקת המשרד');
  assert.equal(c.retry().hidden, false);
  await c.run('loadGuaranteeDocuments()');
  assert.equal(c.retry().hidden, true);
  assert.equal((c.list().match(/fixture\.pdf/g) || []).length, 1);
  assert.deepEqual(calls, ['POST', 'GET', 'GET', 'GET']);
});

test('old GET cannot erase newer upload acknowledgment and repeated clicks cause one POST', async () => {
  const c = setup();
  let finishOld, finishPost, posts = 0, gets = 0;
  c.context.fetch = async (_url, options) => {
    if (options?.method === 'POST') {
      posts++;
      return new Promise(resolve => { finishPost = resolve; });
    }
    if (++gets === 1) return new Promise(resolve => { finishOld = resolve; });
    return reply({}, 503);
  };
  const old = c.run('loadGuaranteeDocuments()');
  const upload = c.run('uploadGuaranteeDocument()');
  await c.run('uploadGuaranteeDocument()');
  finishPost(reply({ success: true, id: 8, status: pending.status }));
  await upload;
  finishOld(reply({ documents: [] }));
  await old;
  assert.equal(posts, 1);
  assert.equal(c.status(), 'ממתין לבדיקת המשרד');
});

test('explicitly rejected upload keeps the selected file and does not announce success', async () => {
  const c = setup();
  c.context.fetch = async () => reply({ error: 'סוג קובץ לא נתמך' }, 400);
  await c.run('uploadGuaranteeDocument()');
  assert.equal(c.element('guaranteeFile').value, 'fixture.pdf');
  assert.equal(c.element('uploadGuaranteeBtn').disabled, false);
  assert.deepEqual(c.notices, [['סוג קובץ לא נתמך', true]]);
});

test('unconfirmed upload is not posted again automatically', async () => {
  const c = setup();
  const calls = [];
  c.context.fetch = async (_url, options) => {
    calls.push(options?.method || 'GET');
    if (options?.method === 'POST') return reply({ success: true });
    return reply({ documents: [pending] });
  };
  await c.run('uploadGuaranteeDocument()');
  assert.equal(c.element('guaranteeFile').value, 'fixture.pdf');
  assert.match(c.notices[0][0], /לא התקבל אישור קליטה/);
  assert.deepEqual(calls, ['POST', 'GET']);
});

test('logging out invalidates pending refresh and clears prior name and retry', async () => {
  const c = setup();
  let finish;
  c.context.fetch = async () => new Promise(resolve => { finish = resolve; });
  const old = c.run('loadGuaranteeDocuments()');
  c.run('TOKEN = null; clearGuaranteePanel(); TOKEN = "other"');
  finish(reply({ documents: [approved] }));
  await old;
  assert.doesNotMatch(c.list(), /approved.pdf/);
  assert.equal(c.retry().hidden, true);
  assert.equal(c.element('guaranteeFile').value, '');
});
