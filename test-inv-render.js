/**
 * 库存视图渲染冒烟（vm + 行为型 DOM 桩，零依赖）
 * 实际调用各视图 handler，确保模板渲染与首屏事件绑定不抛错。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

/* ---- 行为型 DOM 桩 ---- */
class FakeEl {
  constructor(tag = 'div') { this.tagName = tag; this.style = {}; this.dataset = {}; this.children = []; this._html = ''; this.value = ''; this.className = ''; }
  set innerHTML(v) { this._html = String(v); this.children = []; }
  get innerHTML() { return this._html; }
  get textContent() { return this._html.replace(/<[^>]*>/g, ''); }
  set textContent(v) { this._html = String(v); }
  querySelector() { return new FakeEl(); }
  querySelectorAll() { return []; }
  addEventListener() {}
  appendChild(c) { this.children.push(c); return c; }
  focus() {} click() {} remove() {}
}

const store = {};
const root = new FakeEl();
const sandbox = {
  console,
  setTimeout, clearTimeout,
  setInterval: () => 0, clearInterval: () => {},
  Date, Math, JSON, Number, String, Object, Array, Promise, URLSearchParams, isNaN, parseInt, parseFloat,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  location: { hash: '#/store/inventory/workbench' },
  navigator: { userAgent: 'node' },
  crypto: { randomUUID: () => 'u' + Math.random().toString(16).slice(2) },
};
sandbox.window = sandbox;
sandbox.document = {
  readyState: 'complete',
  addEventListener: () => {},
  querySelector: () => root,
  querySelectorAll: () => [],
  getElementById: () => root,
  createElement: (t) => new FakeEl(t),
  body: new FakeEl('body'),
};
sandbox.window.addEventListener = () => {};

/* ---- 接口桩数据 ---- */
const today = new Date().toISOString().slice(0, 10);
const units = ['UN01', 'UN02', 'UN03'].map((id, i) => ({ id, name: ['个', '包', '瓶'][i], materialCount: 1 }));
const materials = Array.from({ length: 15 }, (_, i) => ({
  id: 'MT' + String(i + 1).padStart(2, '0'), name: '耗材' + i, unitId: 'UN01', safetyStock: 10, active: 1, remark: '',
  unitName: '个', recipeCount: 1, recipeServices: [{ serviceId: 'V01', serviceName: '足道' }], totalQty: 20, totalFrozen: 0,
}));
const recipes = [{ id: 'RP001', serviceId: 'V01', serviceName: '经典足道', updatedAt: today + ' 10:00:00', updatedBy: '总部',
  items: [{ materialId: 'MT01', qty: 1, name: '耗材0', unitName: '个' }] }];
const services = [{ id: 'V01', name: '经典足道', category: '足疗', active: 1, price: 128, duration: 60 }];
const stores = [{ id: 'S01', name: '测试店', city: '上海' }, { id: 'S02', name: '二店', city: '北京' }];
const overview = {
  today, nearExpireDays: 30,
  kpi: { storeCount: 2, materialTypes: 15, lowItemCount: 3, nearExpireCount: 2, frozenCount: 1 },
  storeTotals: stores.map(s => ({ ...s, lowCount: 1, nearExpireCount: 1, materialCount: 10, pendingTransfer: 1 })),
  lowAlerts: [{ storeId: 'S01', storeName: '测试店', city: '上海', materialId: 'MT01', materialName: '耗材0', unitName: '个', safetyStock: 10, availableQty: 3, frozenQty: 0, low: true }],
  expiring: [{ storeId: 'S01', materialName: '耗材1', unitName: '个', batchNo: 'L1', expireDate: today, daysToExpire: 5, nearExpire: true, expired: false, remainingQty: 4, availableQty: 4, supplier: 'X' }],
  stock: [],
};
const workbench = {
  today,
  kpi: { materialTypes: 15, lowCount: 1, nearExpireCount: 1, pendingTransferCount: 1, draftCheck: null },
  stock: materials.map(m => ({ materialId: m.id, name: m.name, unitName: '个', safetyStock: 10, availableQty: 20, frozenQty: 0, low: false })),
  lowAlerts: [], expiring: [], draft: null,
  transfers: [{ id: 'IT00001', fromStoreId: 'S01', toStoreId: 'S02', fromStoreName: '测试店', toStoreName: '二店', status: 'requested', statusName: '待调出店确认', myRole: 'from', createdAt: today + ' 09:00:00', confirmedAt: null, receivedAt: null, rejectReason: '', remark: '',
    items: [{ materialId: 'MT01', qty: 2, name: '耗材0', unitName: '个', allocations: [] }] }],
};
const batches = [{ id: 'B1', batchNo: 'LOT1', materialId: 'MT01', materialName: '耗材0', unitName: '个', qty: 10, remainingQty: 8, frozenQty: 1, availableQty: 7, expireDate: today, daysToExpire: 20, nearExpire: false, expired: false, producedDate: today, supplier: 'X' }];
const checks = [{ id: 'IC00001', storeId: 'S01', status: 'confirmed', createdAt: today + ' 08:00:00', confirmedAt: today + ' 09:00:00', createdBy: '店长', confirmedBy: '店长',
  items: [{ materialId: 'MT01', name: '耗材0', unitName: '个', systemQty: 10, actualQty: 9, diff: -1 }] }];
const ledger = [{ id: 'L1', ts: today + ' 10:00:00', storeId: 'S01', storeName: '测试店', materialId: 'MT01', materialName: '耗材0', unitName: '个', batchId: 'B1', direction: 'in', type: 'stockin', typeName: '采购入库', qty: 10, refNo: 'LOT1', operator: '店长', remark: '' }];

const GET = {
  '/api/inventory/overview': overview,
  '/api/inventory/materials': materials,
  '/api/inventory/units': units,
  '/api/inventory/recipes': recipes,
  '/api/stores/S01/inventory': workbench,
  '/api/inventory/batches': batches,
  '/api/inventory/checks': checks,
  '/api/inventory/transfers': workbench.transfers,
  '/api/inventory/ledger': ledger,
};
sandbox.fetch = async (url, opt = {}) => {
  const u = String(url).split('?')[0];
  let data = GET[u];
  if (data === undefined) data = Array.isArray(Object.values(GET).find(v => Array.isArray(v))) ? [] : {};
  return { ok: true, status: 200, json: async () => data };
};

vm.createContext(sandbox);
for (const f of ['api.js', 'ui.js', 'charts.js', 'signature.js', 'hq.js', 'store.js', 'inv-ui.js', 'inv-hq.js', 'inv-store.js', 'app.js']) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'public/js', f), 'utf8'), sandbox, { filename: f });
}

/* App.ctx 注入（视图依赖 App.session / App.ctx） */
vm.runInContext(`
  App.ctx = { stores: ${JSON.stringify(stores)}, services: ${JSON.stringify(services)},
    units: ${JSON.stringify(units)}, materials: ${JSON.stringify(materials)}, recipes: ${JSON.stringify(recipes)},
    techLevels: [], memberLevels: [], shiftDefs: [] };
  App.session = { storeId: 'S01', role: 'store', name: '店长' };
`, sandbox);

const cases = [
  ['hq', 'inventory/overview'], ['hq', 'inventory/master'], ['hq', 'inventory/ledger'],
  ['store', 'inventory/workbench'], ['store', 'inventory/stockin'], ['store', 'inventory/batches'],
  ['store', 'inventory/check'], ['store', 'inventory/transfers'], ['store', 'inventory/ledger'],
];
(async () => {
  sandbox.openModal = () => ({ el: new FakeEl(), body: new FakeEl(), footer: new FakeEl() });
  sandbox.closeModal = () => {};
  for (const [role, name] of cases) {
    const el = new FakeEl();
    sandbox.el = el;
    vm.runInContext(`Views['${role}']['${name}'](el)`, sandbox);
    await new Promise(r => setTimeout(r, 0)); // 等待视图内 Promise 微任务
    if (!el.innerHTML.length) throw new Error(`${role}/${name} 渲染为空`);
    console.log('✅ 视图渲染', role + '/' + name, `(${el.innerHTML.length} 字符)`);
  }
  console.log('\n🎉 库存视图渲染冒烟全部通过');
})().catch(e => { console.error('❌', e.stack); process.exit(1); });
