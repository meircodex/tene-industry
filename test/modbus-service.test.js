'use strict';

const assert = require('node:assert/strict');
const { setImmediate: settle } = require('node:timers/promises');
const test = require('node:test');
const {
  MACHINE_COMMAND_REASON,
  createMachineWriteAuthorization,
} = require('../services/machineSafetyGate');

const machineId = 1;
const retryMs = 10_000;
const params = {
  diameter: 12,
  totalLengthMm: 1000,
  productionQty: 5,
  angles: [90, 135],
  itemId: 22,
  orderId: 33,
};

function setup(t, { connect = async () => {} } = {}) {
  const clientPath = require.resolve('modbus-serial');
  const servicePath = require.resolve('../modbus');
  const savedClient = require.cache[clientPath];
  const savedService = require.cache[servicePath];
  const savedWritesEnabled = process.env.MACHINE_WRITES_ENABLED;
  const clients = [];
  const registers = new Map([[0, 5], [10, 0]]);

  class FakeModbusClient {
    constructor() {
      this.isOpen = false;
      this.closeCalls = 0;
      this.reads = [];
      this.writes = [];
      clients.push(this);
    }

    async connectTCP() {
      await connect();
      this.isOpen = true;
    }

    setID() {}
    setTimeout() {}

    async readHoldingRegisters(address, count) {
      this.reads.push([address, count]);
      assert.equal(this.isOpen, true);
      return { data: [registers.get(address)] };
    }

    async writeRegisters(address, values) {
      assert.equal(this.isOpen, true);
      this.writes.push([address, values]);
      values.forEach((value, index) => registers.set(address + index, value));
    }

    close() {
      this.closeCalls++;
      this.isOpen = false;
    }
  }

  t.mock.timers.enable({ apis: ['setTimeout'] });
  require.cache[clientPath] = { id: clientPath, loaded: true, exports: FakeModbusClient };
  delete require.cache[servicePath];
  t.after(() => {
    if (savedClient) require.cache[clientPath] = savedClient;
    else delete require.cache[clientPath];
    if (savedService) require.cache[servicePath] = savedService;
    else delete require.cache[servicePath];
    if (savedWritesEnabled === undefined) delete process.env.MACHINE_WRITES_ENABLED;
    else process.env.MACHINE_WRITES_ENABLED = savedWritesEnabled;
  });

  const modbus = require('../modbus');
  const [machine] = modbus.init(null)._getConfigs();
  modbus.init({
    prepare: () => ({
      all: () => [{
        id: machine.id,
        label: machine.label,
        name: machine.name,
        conn_mode: machine.mode,
        tcp_host: machine.host,
        tcp_port: machine.port,
        slave_id: machine.unitId,
      }],
    }),
  });
  t.after(() => modbus.stopPolling());
  return { modbus, clients, registers };
}

function authorize() {
  return createMachineWriteAuthorization({
    machineId,
    operation: 'write_params',
    itemId: params.itemId,
    orderId: params.orderId,
  });
}

test('כתיבת קוטר, אורך, כמות וזוויות לאוגרי Modbus', async t => {
  const { modbus, clients, registers } = setup(t);
  process.env.MACHINE_WRITES_ENABLED = 'true';
  await modbus.startPolling();
  await settle();

  await modbus.writeParams(machineId, { ...params, safetyAuthorization: authorize() });

  assert.deepEqual(clients[0].writes, [
    [1, [12]],
    [2, [1000]],
    [3, [5]],
    [100, [90, 135]],
  ]);
  assert.equal(registers.get(101), 135);
});

test('חסימת כתיבה ללא הרשאת בטיחות או כשהכתיבה כבויה', async t => {
  const { modbus, clients } = setup(t);
  await modbus.startPolling();
  await settle();

  process.env.MACHINE_WRITES_ENABLED = 'false';
  await assert.rejects(
    modbus.writeParams(machineId, { ...params, safetyAuthorization: authorize() }),
    { code: MACHINE_COMMAND_REASON.WRITES_DISABLED },
  );

  process.env.MACHINE_WRITES_ENABLED = 'true';
  await assert.rejects(modbus.writeParams(machineId, params), {
    code: MACHINE_COMMAND_REASON.AUTHORIZATION_REQUIRED,
  });
  assert.deepEqual(clients[0].writes, []);
});

test('קוד תקלה מאוגר D10 מופיע בסטטוס ובעדכונים', async t => {
  const { modbus, clients, registers } = setup(t);
  const updates = [];
  modbus.onUpdate((id, { counter, errorCode, statusCode, status }) => {
    updates.push({ id, counter, errorCode, statusCode, status });
  });
  registers.set(10, 7);

  await modbus.startPolling(1000);
  await settle();

  assert.deepEqual(clients[0].reads, [[0, 1], [10, 1]]);
  assert.deepEqual(updates, [
    { id: machineId, counter: 5, errorCode: 7, statusCode: 3, status: 'תקלה (7)' },
  ]);
  assert.equal(modbus.getState(machineId).status, 'תקלה (7)');

  registers.set(10, 0);
  t.mock.timers.tick(1000);
  await settle();

  assert.deepEqual(updates[1], {
    id: machineId, counter: 5, errorCode: 0, statusCode: 2, status: 'בייצור',
  });
});

test('חיבור חוזר לאחר כשל ממתין 10 שניות, גם בין סבבי קריאה', async t => {
  let attempts = 0;
  const { modbus, clients } = setup(t, {
    async connect() {
      if (++attempts <= 2) throw new Error('שגיאת תקשורת');
    },
  });

  await modbus.startPolling(30_000);
  await settle();
  assert.equal(attempts, 1);
  assert.equal(modbus.getState(machineId).connected, false);

  for (const expectedAttempts of [2, 3]) {
    t.mock.timers.tick(retryMs - 1);
    await settle();
    assert.equal(attempts, expectedAttempts - 1);

    t.mock.timers.tick(1);
    await settle();
    assert.equal(attempts, expectedAttempts);
  }

  assert.equal(clients[2].isOpen, true);
  assert.equal(modbus.getState(machineId).connected, true);
});

test('עצירת הסקירה מבטלת את טיימרי הקריאה והחיבור החוזר', async t => {
  const { modbus, clients } = setup(t);
  const clearTimeout = t.mock.method(globalThis, 'clearTimeout');
  await modbus.startPolling(1000);
  await settle();

  clients[0].isOpen = false;
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(clients.length, 1);

  modbus.stopPolling();
  assert.equal(clearTimeout.mock.callCount(), 2);

  t.mock.timers.tick(retryMs + 1000);
  await settle();
  assert.equal(clients.length, 1);
  assert.equal(modbus.getState(machineId).connected, false);
});

test('עצירת הסקירה סוגרת חיבור ומונעת תזמון נוסף כשקריאה מסתיימת', async t => {
  const { modbus, clients } = setup(t);
  const setTimeout = t.mock.method(globalThis, 'setTimeout');
  await modbus.startPolling(1000);
  await settle();

  let finishRead;
  t.mock.method(clients[0], 'readHoldingRegisters', () => new Promise(resolve => {
    finishRead = resolve;
  }), { times: 1 });
  t.mock.timers.tick(1000);
  assert.equal(typeof finishRead, 'function');
  const scheduled = setTimeout.mock.callCount();

  modbus.stopPolling();
  assert.equal(clients[0].closeCalls, 1);
  assert.equal(clients[0].isOpen, false);
  finishRead({ data: [5] });
  await settle();

  assert.equal(setTimeout.mock.callCount(), scheduled);
  assert.equal(modbus.getState(machineId).connected, false);
});

test('חיבור שהושלם אחרי עצירת הסקירה נסגר', async t => {
  let finishConnect;
  const { modbus, clients } = setup(t, {
    connect: () => new Promise(resolve => {
      finishConnect = resolve;
    }),
  });
  const starting = modbus.startPolling();
  assert.equal(typeof finishConnect, 'function');

  modbus.stopPolling();
  finishConnect();
  await starting;
  await settle();

  assert.equal(clients[0].closeCalls, 1);
  assert.equal(clients[0].isOpen, false);
  assert.deepEqual(clients[0].reads, []);
  assert.equal(modbus.getState(machineId).connected, false);
});
