/* 前端视图烟雾测试：极简 DOM stub + API mock，无需 jsdom、无需起服务。
   覆盖：总部库存总览/耗材配方/流水，门店工作台/入库/盘点/调拨/流水 的渲染与核心交互。 */
const fs = require('fs');
const path = require('path');

/* ---------- 极简 DOM stub（仅实现视图代码实际用到的 API） ---------- */
global.__writeLog = [];
function makeEl(tag = 'div') {
  tag = String(tag).toLowerCase();
  const el = {
    tagName: tag, children: [], style: {}, dataset: {}, attributes: {},
    _cls: new Set(), _listeners: {}, _html: '', value: '', textContent: '',
    disabled: false, innerHTML: '',
    classList: {
      add: (...c) => c.forEach(x => el._cls.add(x)),
      remove: (...c) => c.forEach(x => el._cls.delete(x)),
      toggle: (c, f) => { f === undefined ? (el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c)) : (f ? el._cls.add(c) : el._cls.delete(c)); },
      contains: (c) => el._cls.has(c),
    },
    appendChild(child) { el.children.push(child); child.parentNode = el; return child; },
    remove() { if (el.parentNode) el.parentNode.children = el.parentNode.children.filter(x => x !== el); },
    addEventListener(t, fn) { (el._listeners[t] = el._listeners[t] || []).push(fn); },
    dispatchEvent(ev) { (el._listeners[ev.type] || []).forEach(fn => fn(ev)); return true; },
    click() { el.dispatchEvent({ type: 'click' }); },
    focus() {},
    querySelector(sel) { return queryAll(sel, el)[0] || null; },
    querySelectorAll(sel) { return queryAll(sel, el); },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(v) {
      el._html = String(v);
      el.children = [];
      global.__writeLog.push({ el, html: el._html });
      if (el._isTemplate && el.content) {
        el.content._html = el._html;
        const firstTag = el._html.match(/^<([\w-]+)/);
        el.content.firstElementChild = firstTag ? makeEl(firstTag[1]) : null;
        if (el.content.firstElementChild) el.content.firstElementChild._html = el._html;
      }
    },
  });
  Object.defineProperty(el, 'className', { get() { return [...el._cls].join(' '); }, set(v) { el._cls = new Set(v.split(/\s+/).filter(Boolean)); } });
  if (tag === 'template') {
    el.content = makeEl('#document-fragment');
    el._isTemplate = true;
  }
  return el;
}
function queryAll(sel, root) {
  const html = root._html || '';
  const out = [];
  const pushIds = (re) => { let m; while ((m = re.exec(html))) out.push(stubAttrEl(m[1], root, html)); };
  const s = sel.trim();
  if (s.startsWith('#')) {
    const id = s.slice(1);
    if (new RegExp(`id="${id}"`).test(html)) out.push(stubIdEl(id, root, html));
    if (root.id === id) out.push(root);
  } else if (s.startsWith('[')) {
    const mm = s.match(/^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/);
    if (mm) { const re = new RegExp(`${mm[1]}="([^"]*)"`, 'g'); let m; while ((m = re.exec(html))) out.push(stubAttrEl(m[1], root, html, mm[1])); }
  } else if (s.startsWith('.')) {
    const cls = s.slice(1);
    if (new RegExp(`class="[^"]*\\b${cls}\\b`).test(html)) out.push(stubClassEl(cls, root, html));
  } else if (/^[a-z0-9]+$/i.test(s)) {
    const re = new RegExp(`<${s}[\\s>]`, 'g'); let m;
    while ((m = re.exec(html))) out.push(stubTagEl(s, root, html));
  } else {
    // 组合选择器：取后代 id/属性
    const idm = s.match(/#([\w-]+)/);
    if (idm && new RegExp(`id="${idm[1]}"`).test(html)) out.push(stubIdEl(idm[1], root, html));
    else {
      const attrm = s.match(/\[([\w-]+)(?:=["']([^"']*)["'])?\]/);
      if (attrm) { const re = new RegExp(`${attrm[1]}="([^"]*)"`, 'g'); let m; while ((m = re.exec(html))) out.push(stubAttrEl(m[1], root, html, attrm[1])); }
      else { const re = /id="([\w-]+)"/g; let m; while ((m = re.exec(html))) out.push(stubIdEl(m[1], root, html)); }
    }
  }
  return out;
}
function stubIdEl(id, root, html) {
  const e = makeEl(); e.id = id; e._root = root; e._html = html;
  wireValue(e, html, `id="${id}"`);
  return e;
}
function stubAttrEl(val, root, html, attrName) {
  const e = makeEl(); e.dataset[attrName.replace('data-', '')] = val;
  if (attrName === 'data-t' || attrName === 'data-store' || attrName === 'data-b') e.dataset[attrName.slice(5)] = val;
  e._root = root; e._html = html;
  return e;
}
function stubTagEl(tag, root, html) { const e = makeEl(tag); e._root = root; e._html = html; return e; }
function stubClassEl(cls, root, html) {
  const e = makeEl();
  e.classList.add(cls);
  e._root = root; e._html = html;
  // 尽量提取该 class 节点上的 value（input）
  const re = new RegExp(`class="[^"]*\\b${cls}\\b[^"]*"[^>]*`, 'g'); let m;
  if ((m = re.exec(html))) { const vm = m[0].match(/value="([^"]*)"/); if (vm) e.value = vm[1]; }
  return e;
}
function wireValue(e, html, marker) {
  const idx = html.indexOf(marker);
  if (idx < 0) return;
  const tail = html.slice(idx);
  const vm = tail.match(/value="([^"]*)"/);
  if (vm) e.value = vm[1];
}

/* ---------- 浏览器环境 stub ---------- */
const rootEl = makeEl();
rootEl.id = 'app';
const document = {
  readyState: 'complete',
  getElementById: (id) => (id === 'app' ? rootEl : document.body.querySelector('#' + id)),
  querySelector: (s) => queryAll(s, document.body)[0] || queryAll(s, rootEl)[0] || null,
  querySelectorAll: (s) => [...new Set([...queryAll(s, document.body), ...queryAll(s, rootEl)])],
  createElement: (t) => makeEl(t),
  body: makeEl('body'),
  addEventListener() {},
  createEvent() { return { initEvent() {} }; },
};
const window = { document, location: { hash: '#/store/dashboard' }, addEventListener() {}, open: null, confirm: () => true, prompt: () => '' };
window.window = window;
global.window = window;
global.document = document;
global.location = window.location;
global.navigator = { language: 'zh-CN' };
global.localStorage = { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
global.confirmAsync = async () => true;

// 浏览器中各 classic script 共享全局词法作用域，这里拼接为同一个 Function 执行
const files = ['js/api.js', 'js/ui.js', 'js/charts.js', 'js/signature.js', 'js/hq.js', 'js/store.js', 'js/inventory-hq.js', 'js/inventory-store.js'];
const bundle = files.map(f => fs.readFileSync(path.join('public', f), 'utf8') + '\n//# sourceURL=' + f).join('\n;\n') + `
;window.__getApi = () => api; window.__Views = Views; window.__h = (html) => h(html); window.__openModal = (o) => openModal(o); window.__closeModal = () => closeModal(); window.__toast = (m, t) => toast(m, t); window.__confirmAsync = (m) => confirmAsync(m);`;
new Function('window', 'document', 'localStorage', 'navigator', 'location', bundle)(window, document, global.localStorage, global.navigator, window.location);
const Views = window.__Views;
const api = window.__getApi();
api._calls = [];
api.get = async (p) => { api._calls.push(['GET', p]); return mockData(p); };
api.post = async (p, b) => { api._calls.push(['POST', p, b]); return mockPost(p, b); };
api.put = async (p, b) => { api._calls.push(['PUT', p, b]); return { ok: true }; };
api.del = async (p) => { api._calls.push(['DELETE', p]); return { ok: true }; };
window.__modalRoot = () => window._modalRoot;

/* App ctx/session stub */
global.App = {
  session: { role: 'store', storeId: 'S01', name: '周敏' },
  ctx: {
    stores: [
      { id: 'S01', name: '外滩店', city: '上海' },
      { id: 'S02', name: '陆家嘴店', city: '上海' },
      { id: 'S06', name: '南山店', city: '深圳' },
    ],
    materials: [
      { id: 'MA0001', name: '一次性足浴袋', unit: '个', category: '足疗耗材', safetyStock: 200, active: 1 },
      { id: 'MA0003', name: '一次性毛巾', unit: '条', category: '织物', safetyStock: 300, active: 1 },
    ],
    materialUnits: ['个', '包', '条'],
  },
};
/* api mock：按路径返回固定数据（api 在上面已从 bundle 取出并 patch） */
const day = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
function mockData(p) {
  if (p.startsWith('/api/hq/inventory/overview')) return {
    kpi: { materialCount: 12, recipeCount: 12, storeCount: 6, lowSkus: 3, nearBatches: 10, expiredBatches: 2, pendingTransfers: 3 },
    stores: [{ storeId: 'S01', name: '外滩店', city: '上海', skuCount: 12, lowCount: 1, nearCount: 2, expiredCount: 1, pendingIn: 1, pendingOut: 1, frozenOut: 1 }],
  };
  if (p.includes('/inventory/overview')) return {
    storeId: 'S01',
    kpi: { skuCount: 12, lowCount: 1, nearCount: 2, expiredCount: 1, frozenSkus: 0, pendingIn: 1, pendingOut: 1, frozenOut: 1 },
    rows: [
      { materialId: 'MA0001', name: '一次性足浴袋', category: '足疗耗材', unit: '个', safetyStock: 200, quantity: 320, frozen: 0, available: 320, low: false, expiredQty: 0, nearExpireQty: 0, batchCount: 2 },
      { materialId: 'MA0003', name: '一次性毛巾', category: '织物', unit: '条', safetyStock: 300, quantity: 120, frozen: 10, available: 110, low: true, expiredQty: 0, nearExpireQty: 10, batchCount: 2 },
    ],
    nearExpireBatches: [{ id: 'B1', materialId: 'MA0003', materialName: '一次性毛巾', unit: '条', batchNo: 'LOT1', expireDate: day(10), daysToExpire: 10, available: 10, frozen: 0, quantity: 10 }],
    expiredBatches: [{ id: 'B2', materialId: 'MA0001', materialName: '一次性足浴袋', unit: '个', batchNo: 'LOT2', expireDate: day(-2), daysToExpire: -2, available: 0, frozen: 0, quantity: 5 }],
    lowItems: [],
    pendingIn: [{ id: 'ST2', transferNo: 'DB2', fromStoreId: 'S06', toStoreId: 'S01', materialId: 'MA0001', materialName: '一次性足浴袋', unit: '个', qty: 6, status: 'pending', direction: 'in' }],
    pendingOut: [{ id: 'ST1', transferNo: 'DB1', fromStoreId: 'S01', toStoreId: 'S02', materialId: 'MA0003', materialName: '一次性毛巾', unit: '条', qty: 80, status: 'pending', direction: 'out' }],
    frozenOut: [{ id: 'ST3', transferNo: 'DB3', fromStoreId: 'S01', toStoreId: 'S03', materialId: 'MA0003', materialName: '一次性毛巾', unit: '条', qty: 80, status: 'frozen', direction: 'out' }],
  };
  if (p.startsWith('/api/stock-batches')) return [
    { id: 'B10', materialId: 'MA0001', materialName: '一次性足浴袋', unit: '个', batchNo: 'LOT-A', expireDate: day(100), daysToExpire: 100, quantity: 300, frozen: 0, available: 300, nearExpire: false, expired: false, receivedAt: '2026-09-01 10:00:00' },
    { id: 'B11', materialId: 'MA0001', materialName: '一次性足浴袋', unit: '个', batchNo: 'LOT-B', expireDate: day(5), daysToExpire: 5, quantity: 20, frozen: 0, available: 20, nearExpire: true, expired: false, receivedAt: '2026-09-10 10:00:00' },
  ];
  if (p.startsWith('/api/stock-inbounds')) return [
    { id: 'IN000001', storeId: 'S01', supplier: '总部集采', receivedDate: day(-1), createdAt: day(-1) + ' 12:00:00', operator: '周敏', items: [{ materialId: 'MA0001', qty: 100 }] },
  ];
  if (p.startsWith('/api/stock-checks')) {
    if (p.includes('/SC1')) return { id: 'SC1', storeId: 'S01', status: 'draft', createdAt: '2026-09-20 10:00:00', confirmedAt: null, operator: '周敏', remark: '',
      items: [{ materialId: 'MA0001', materialName: '一次性足浴袋', unit: '个', systemQty: 320, actualQty: null, diff: 0, frozen: 0 }, { materialId: 'MA0003', materialName: '一次性毛巾', unit: '条', systemQty: 120, actualQty: null, diff: 0, frozen: 10 }] };
    return [
      { id: 'SC1', storeId: 'S01', status: 'draft', createdAt: '2026-09-20 10:00:00', diffCount: 0, operator: '周敏', confirmedAt: null },
      { id: 'SC0', storeId: 'S01', status: 'confirmed', createdAt: '2026-09-01 10:00:00', confirmedAt: '2026-09-01 10:30:00', diffCount: 1, operator: '周敏' },
    ];
  }
  if (p.startsWith('/api/stock-transfers/')) return {
    id: 'ST1', transferNo: 'DB1', fromStoreId: 'S01', toStoreId: 'S02', fromStoreName: '外滩店', toStoreName: '陆家嘴店', fromCity: '上海', toCity: '上海',
    materialId: 'MA0003', materialName: '一次性毛巾', unit: '条', qty: 80, status: 'frozen', direction: 'out',
    batches: [{ batchId: 'B20', batchNo: 'LOT-X', qty: 80 }], createdBy: '周敏', createdAt: '2026-09-19 10:00:00',
    confirmedAt: '2026-09-20 09:00:00', confirmedBy: '周敏', receivedAt: null, receivedBy: null,
    ledgers: [{ id: 'SL1', storeId: 'S01', storeName: '外滩店', materialId: 'MA0003', type: 'freeze', typeName: '调拨冻结', qty: 80, change: 0, createdAt: '2026-09-20 09:00:00', note: '冻结' }],
  };
  if (p.startsWith('/api/stock-transfers')) return [
    { id: 'ST1', transferNo: 'DB2026091901', fromStoreId: 'S01', toStoreId: 'S02', fromStoreName: '外滩店', fromCity: '上海', toStoreName: '陆家嘴店', toCity: '上海', materialId: 'MA0003', materialName: '一次性毛巾', unit: '条', qty: 80, status: 'frozen', direction: 'out', createdBy: '周敏', createdAt: '2026-09-19 10:00:00', confirmedAt: '2026-09-20 09:00:00', confirmedBy: '周敏', receivedAt: null },
    { id: 'ST2', transferNo: 'DB2026092001', fromStoreId: 'S06', toStoreId: 'S01', fromStoreName: '南山店', fromCity: '深圳', toStoreName: '外滩店', toCity: '上海', materialId: 'MA0001', materialName: '一次性足浴袋', unit: '个', qty: 6, status: 'pending', direction: 'in', createdBy: '何俊', createdAt: '2026-09-20 08:00:00' },
  ];
  if (p.startsWith('/api/stock-ledger')) return [
    { id: 'SL1', storeId: 'S01', materialId: 'MA0001', materialName: '一次性足浴袋', category: '足疗耗材', unit: '个', batchNo: 'LOT-A', type: 'inbound', typeName: '入库', qty: 100, change: 100, batchQtyAfter: 300, refId: 'IN000001', operator: '周敏', createdAt: '2026-09-19 12:00:00', note: '入库' },
    { id: 'SL2', storeId: 'S01', materialId: 'MA0003', materialName: '一次性毛巾', category: '织物', unit: '条', batchNo: 'LOT-B', type: 'consume', typeName: '开单耗用', qty: 1, change: -1, batchQtyAfter: 119, refId: null, orderId: 'O1', operator: '周敏', createdAt: '2026-09-20 11:00:00', note: '经典足道' },
  ];
  if (p.startsWith('/api/materials')) return global.App.ctx.materials.map(m => ({ ...m, recipeServices: [{ serviceId: 'V01', name: '经典足道' }] }));
  if (p.startsWith('/api/recipes')) return [
    { serviceId: 'V01', serviceName: '经典足道', category: '足疗', serviceActive: 1, items: [{ materialId: 'MA0001', materialName: '一次性足浴袋', unit: '个', qty: 1, active: 1 }] },
  ];
  if (p.startsWith('/api/stores')) return global.App.ctx.stores;
  return [];
}
async function mockPost(p, b) {
  if (p === '/api/stock-checks') return { id: 'SC' + Date.now(), status: 'draft', items: [] };
  if (p.includes('/confirm')) return { status: 'confirmed', idempotent: false };
  if (p === '/api/stock-inbounds') return { id: 'IN9', items: b.items, idempotent: false };
  if (p === '/api/stock-transfers') return { id: 'ST9', transferNo: 'DB9', status: 'pending' };
  if (p.includes('/receive')) return { id: 'ST1', status: 'received', idempotent: false };
  if (p.includes('/confirm')) return { id: 'ST1', status: 'frozen', idempotent: false };
  return { ok: true };
}

/* ---------- 执行视图 ---------- */
(async () => {
  const assert = (c, msg) => { if (!c) { console.error('❌', msg); process.exit(1); } console.log('  ✅', msg); };
  const Views = window.Views;
  // 视图内异步列表渲染会写入 detached 子容器，汇总该阶段所有 innerHTML 写入
  const renderAll = async (fn, host) => {
    const start = global.__writeLog.length;
    host._html = '';
    await fn(host);
    await new Promise(r => setTimeout(r, 20));
    return [host._html, ...global.__writeLog.slice(start).map(w => w.html)].join('\n');
  };
  const clean = (s) => !/>undefined<|>NaN<|\bundefined\b\s*[<（]/.test(s) && !/>NaN</.test(s);

  for (const [name, fn, role] of [
    ['门店库存工作台', Views.store.inventory, 'store'],
    ['门店入库', Views.store.inbound, 'store'],
    ['门店盘点', Views.store['stock-check'], 'store'],
    ['门店调拨', Views.store.transfers, 'store'],
    ['门店流水', Views.store['stock-ledger'], 'store'],
  ]) {
    global.App.session.role = role;
    const host = makeEl(); host.id = 'view-' + name;
    const html = await renderAll(fn, host);
    assert(html.length > 500, name + ' 渲染出内容');
    assert(clean(html), name + ' 无 undefined/NaN 占位');
  }

  // 工作台：关键预警与待办均出现
  {
    const host = makeEl();
    const html = await renderAll(Views.store.inventory, host);
    assert(/低库存预警/.test(html) && /调拨待办/.test(html), '工作台包含预警与调拨待办');
    assert(host.querySelector('#inv-tbl'), '库存清单容器存在');
    assert(host.querySelector('[data-t]'), '调拨待办带处理按钮');
  }

  // 入库页：添加行/提交按钮存在
  {
    const host = makeEl();
    await renderAll(Views.store.inbound, host);
    assert(host.querySelector('#in-add'), '入库页有添加行按钮');
    assert(host.querySelector('#in-submit'), '入库页有提交按钮');
  }

  // 盘点列表渲染
  {
    const host = makeEl();
    const html = await renderAll(Views.store['stock-check'], host);
    assert(/继续盘点/.test(html), '草稿盘点显示继续盘点');
    assert(/data-go=/.test(html), '存在继续盘点按钮');
  }

  // 调拨列表
  {
    const host = makeEl();
    const html = await renderAll(Views.store.transfers, host);
    assert(/待我处理/.test(html) && /主动调出/.test(html), '调拨页含筛选与发起按钮');
    assert(/data-t=/.test(html), '调拨列表含处理按钮');
  }

  // 总部视图
  global.App.session.role = 'hq';
  global.App.session.storeId = null;
  for (const [name, fn] of [['总部库存总览', Views.hq.inventory], ['总部耗材配方', Views.hq.materials], ['总部流水', Views.hq['stock-ledger']]]) {
    const host = makeEl();
    const html = await renderAll(fn, host);
    assert(html.length > 500, name + ' 渲染出内容');
    assert(clean(html), name + ' 无 undefined 占位');
  }
  {
    const host = makeEl();
    const html = await renderAll(Views.hq.inventory, host);
    assert(/各门店实时库存概览/.test(html), '总部总览含门店表');
    assert(host.querySelector('[data-store]'), '总部总览可进入单店明细');
  }

  console.log('\n✅ 前端库存视图烟雾测试全部通过');
})().catch(e => { console.error('❌', e.stack); process.exit(1); });
