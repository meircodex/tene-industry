const ModbusRTU = require('modbus-serial');
const {
  MACHINE_COMMAND_REASON,
  MachineCommandError,
  areMachineWritesEnabled,
  assertMachineWriteAuthorization,
} = require('./services/machineSafetyGate');

// XINJE XD5-32T-E registers (D-registers = Holding Registers):
//   D0  (addr 0): Read  – unit counter
//   D1  (addr 1): Write – diameter mm
//   D2  (addr 2): Write – total length mm (main segment)
//   D3  (addr 3): Write – production quantity (with waste margin)
//   D10 (addr 10): Read – error code (0=ok)
//   D100+ (addr 100+): Write – bend angles (D100=angle1, D101=angle2, ...)
const REG = { COUNTER: 0, DIAMETER: 1, LENGTH: 2, QUANTITY: 3, ERROR: 10, ANGLES_BASE: 100 };

const MACHINES_CONFIG = [
  { id: 1, label: 'A', name: 'מכונה A – XINJE', type: 'xinje', mode: 'tcp', host: '192.168.1.101', port: 502, unitId: 1 },
  { id: 2, label: 'B', name: 'מכונה B – XINJE', type: 'xinje', mode: 'tcp', host: '192.168.1.102', port: 502, unitId: 2 },
  { id: 3, label: 'C', name: 'מכונה C – MEP',   type: 'mep',   mode: 'tcp', host: '192.168.1.103', port: 502, unitId: 3 },
  { id: 4, label: 'D', name: 'מכונה D – עתידי', type: 'xinje', mode: 'tcp', host: '192.168.1.104', port: 502, unitId: 4 },
  // RTU example (uncomment and set COM port when using serial gateway):
  // { id: 1, label: 'A', name: 'מכונה A – XINJE', type: 'xinje', mode: 'rtu', serialPort: 'COM3', baudRate: 9600, unitId: 1 },
];

const STATUS_MAP = { 0: 'כבוי', 1: 'ממתין', 2: 'בייצור', 3: 'תקלה' };
const CONNECT_RETRY_MS = 10000;

class ModbusService {
  constructor(db) {
    this.db        = db;   // SQLite db reference for reading live config
    this.clients   = {};   // machineId → ModbusRTU client
    this.state     = {};   // machineId → { counter, status, connected, lastSeen, ... }
    this.listeners = [];
    this.polling   = false;
    this._pollTimer = null;
    this._pollGeneration = 0;
    this._retryTimers = new Map();

    // Init state from hardcoded defaults; DB will override at startPolling
    for (const m of MACHINES_CONFIG) {
      this.state[m.id] = {
        id: m.id, label: m.label, name: m.name,
        counter: 0, statusCode: -1, status: 'לא מחובר',
        connected: false, lastSeen: null, errorCode: 0,
      };
    }
  }

  // ── Read machine config from DB, fall back to hardcoded defaults ──
  _getConfigs() {
    if (!this.db) return MACHINES_CONFIG;
    try {
      const rows = this.db.prepare('SELECT * FROM machines WHERE retired_at IS NULL ORDER BY id').all();
      return rows.map(row => ({
        id:         row.id,
        label:      row.label || String(row.id),
        name:       row.name,
        type:       'xinje',
        mode:       row.conn_mode || 'tcp',
        host:       row.tcp_host  || null,
        port:       row.tcp_port  || 502,
        serialPort: row.rtu_port  || null,
        baudRate:   row.baud_rate || 9600,
        parity:     row.parity    || 'none',
        stopBits:   row.stop_bits || 1,
        unitId:     row.slave_id  || row.id,
      }));
    } catch { return []; }
  }

  // ── Reconnect a single machine after config change ────────────────
  async reconfigMachine(machineId) {
    const id = Number(machineId);
    // Close existing connection
    try { if (this.clients[id]) this.clients[id].close(); } catch (_) {}
    delete this.clients[id];
    if (this.state[id]) {
      this.state[id].connected = false;
      this.state[id].status = 'לא מחובר';
      this._broadcast(id);
    }
    // Re-connect with new config
    const cfg = this._getConfigs().find(c => c.id === id);
    if (cfg) await this.connectMachine(cfg);
  }

  onUpdate(fn) { this.listeners.push(fn); }

  _broadcast(machineId) {
    const data = this.state[machineId];
    this.listeners.forEach(fn => fn(machineId, data));
  }

  _scheduleReconnect(machineId) {
    if (!this.polling || this._retryTimers.has(machineId)) return;
    const generation = this._pollGeneration;
    const timer = setTimeout(async () => {
      const cfg = this._getConfigs().find(machine => machine.id === machineId);
      const failed = !this.clients[machineId]?.isOpen
        && (await this.connectMachine(cfg)) === false;
      if (generation !== this._pollGeneration) return;
      this._retryTimers.delete(machineId);
      if (failed) this._scheduleReconnect(machineId);
    }, CONNECT_RETRY_MS);
    this._retryTimers.set(machineId, timer);
  }

  async connectMachine(cfg) {
    if(!cfg||!['tcp','rtu'].includes(cfg.mode)||(cfg.mode==='tcp'&&!cfg.host)||(cfg.mode==='rtu'&&!cfg.serialPort))return;
    const generation = this._pollGeneration;
    const client = new ModbusRTU();
    try {
      if (cfg.mode === 'tcp') {
        await client.connectTCP(cfg.host, { port: cfg.port ?? 502 });
      } else {
        await client.connectRTUBuffered(cfg.serialPort, {
          baudRate: cfg.baudRate ?? 9600, dataBits: 8,
          parity: cfg.parity ?? 'none', stopBits: cfg.stopBits ?? 1,
        });
      }
      if (generation !== this._pollGeneration) {
        try { client.close(); } catch (_) {}
        return;
      }
      client.setID(cfg.unitId);
      client.setTimeout(2000);
      this.clients[cfg.id] = client;
      this.state[cfg.id].connected = true;
      const addr = cfg.mode === 'tcp' ? `${cfg.host}:${cfg.port ?? 502}` : cfg.serialPort;
      console.log(`[Modbus] מחובר: ${cfg.name} (${addr})`);
    } catch (err) {
      try { client.close(); } catch (_) {}
      if (generation !== this._pollGeneration) return;
      console.warn(`[Modbus] לא ניתן להתחבר ל-${cfg.name}: ${err.message}`);
      this.state[cfg.id].connected = false;
      this._scheduleReconnect(cfg.id);
      return false;
    }
  }

  async pollMachine(cfg) {
    const client = this.clients[cfg.id];
    if (!client || !client.isOpen) {
      if (this._retryTimers.has(cfg.id)) return;
      if (this.state[cfg.id].connected) {
        this.state[cfg.id].connected = false;
        this.state[cfg.id].status = 'לא מחובר';
        this._broadcast(cfg.id);
      }
      if (client && this.polling) {
        delete this.clients[cfg.id];
        try { client.close(); } catch (_) {}
        this._scheduleReconnect(cfg.id);
      } else {
        await this.connectMachine(cfg);
      }
      return;
    }

    try {
      const counterData = await client.readHoldingRegisters(REG.COUNTER, 1);
      if (this.clients[cfg.id] !== client) return;
      const statusData  = await client.readHoldingRegisters(REG.ERROR, 1);
      if (this.clients[cfg.id] !== client) return;
      const counter     = counterData.data[0];
      const errorCode   = statusData.data[0];
      const statusCode  = errorCode > 0 ? 3 : 2; // 3=error, 2=running (simplified)
      const statusText  = errorCode > 0 ? `תקלה (${errorCode})` : (STATUS_MAP[statusCode] ?? `קוד ${statusCode}`);

      const prev    = this.state[cfg.id];
      const changed = prev.counter !== counter || prev.errorCode !== errorCode;

      this.state[cfg.id] = {
        ...prev, counter, statusCode, errorCode,
        status: statusText, connected: true, lastSeen: new Date().toISOString(),
      };

      if (changed) this._broadcast(cfg.id);
    } catch (err) {
      if (this.clients[cfg.id] !== client) return;
      if (this.state[cfg.id].connected) {
        this.state[cfg.id].connected = false;
        this.state[cfg.id].status = 'שגיאת תקשורת';
        this._broadcast(cfg.id);
      }
    }
  }

  // Write production parameters to machine before starting
  async writeParams(machineId, {
    diameter,
    totalLengthMm,
    productionQty,
    angles = [],
    itemId = null,
    orderId = null,
    safetyAuthorization,
  }) {
    if (!areMachineWritesEnabled()) {
      throw new MachineCommandError(MACHINE_COMMAND_REASON.WRITES_DISABLED);
    }
    assertMachineWriteAuthorization(safetyAuthorization, {
      machineId,
      operation: 'write_params',
      itemId,
      orderId,
    });
    if(this.db&&!this._getConfigs().some(m=>m.id===Number(machineId)&&['tcp','rtu'].includes(m.mode)))throw new Error('המכונה לא הוגדרה לחיבור');
    const cfg    = MACHINES_CONFIG.find(m => m.id === machineId);
    const client = this.clients[machineId];

    if (!cfg) throw new Error(`מכונה ${machineId} לא מוגדרת`);
    if (cfg.type === 'mep') {
      console.log(`[Modbus] MEP machine ${machineId} – proprietary protocol, skipping write`);
      return;
    }
    if (!client || !client.isOpen) throw new Error('מכונה לא מחוברת');

    // Write basic params: D1=diameter, D2=length, D3=qty
    await client.writeRegisters(REG.DIAMETER, [Math.round(diameter)]);
    await client.writeRegisters(REG.LENGTH,   [Math.round(totalLengthMm)]);
    await client.writeRegisters(REG.QUANTITY, [Math.round(productionQty)]);

    // Write bend angles to D100+
    if (angles.length > 0) {
      const angleVals = angles.map(a => Math.round(a));
      await client.writeRegisters(REG.ANGLES_BASE, angleVals);
    }

    console.log(`[Modbus] מכונה ${machineId}: נשלחו פרמטרים – Ø${diameter} / ${totalLengthMm}מ"מ / כמות:${productionQty} / זוויות:${angles.join(',')}`);
  }

  async startPolling(intervalMs = 5000) {
    if (this.polling) return;
    this.polling = true;
    const generation = this._pollGeneration;
    const configs = this._getConfigs();
    // Init state for all machines from DB
    for (const m of configs) {
      if (!this.state[m.id]) {
        this.state[m.id] = {
          id: m.id, label: m.label, name: m.name,
          counter: 0, statusCode: -1, status: 'לא מחובר',
          connected: false, lastSeen: null, errorCode: 0,
        };
      }
    }
    for (const cfg of configs) {
      await this.connectMachine(cfg);
      if (generation !== this._pollGeneration) return;
    }
    const tick = async () => {
      this._pollTimer = null;
      for (const cfg of this._getConfigs()) {
        await this.pollMachine(cfg);
        if (generation !== this._pollGeneration) return;
      }
      this._pollTimer = setTimeout(tick, intervalMs);
    };
    tick();
    console.log(`[Modbus] סקירה החלה (כל ${intervalMs / 1000} שניות)`);
  }

  stopPolling() {
    this.polling = false;
    this._pollGeneration++;
    if (this._pollTimer !== null) clearTimeout(this._pollTimer);
    this._pollTimer = null;
    for (const timer of this._retryTimers.values()) clearTimeout(timer);
    this._retryTimers.clear();
    for (const [id, client] of Object.entries(this.clients)) {
      try { client.close(); } catch (_) {}
      this.state[id].connected = false;
      this.state[id].status = 'לא מחובר';
    }
    this.clients = {};
    console.log('[Modbus] סקירה הופסקה');
  }

  getAllState() { return this._getConfigs().map(m=>({counter:0,statusCode:-1,errorCode:0,lastSeen:null,...this.state[m.id],id:m.id,name:m.name,label:m.label,connected:this.state[m.id]?.connected||false,status:this.state[m.id]?.status||'לא מחובר'})); }
  getState(id)  { return this.state[id]; }
}

// Export class so server.js can pass db reference, and also a lazy singleton
let _instance = null;
module.exports = {
  init(db) { _instance = new ModbusService(db); return _instance; },
  getInstance() { return _instance || (_instance = new ModbusService(null)); },
  // Proxy all methods so existing code (require('./modbus').startPolling etc.) still works
  get startPolling()   { return (...a) => module.exports.getInstance().startPolling(...a); },
  get stopPolling()    { return (...a) => module.exports.getInstance().stopPolling(...a); },
  get onUpdate()       { return (...a) => module.exports.getInstance().onUpdate(...a); },
  get getAllState()     { return (...a) => module.exports.getInstance().getAllState(...a); },
  get getState()       { return (...a) => module.exports.getInstance().getState(...a); },
  get writeParams()    { return (...a) => module.exports.getInstance().writeParams(...a); },
  get reconfigMachine(){ return (...a) => module.exports.getInstance().reconfigMachine(...a); },
};
