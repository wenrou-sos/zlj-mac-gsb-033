/**
 * 零依赖前端加载冒烟测试（Node 内置 vm，模拟最小浏览器环境）
 * 验证所有前端脚本可成功求值、库存视图与路由全部注册，无顶层引用错误。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const store = {};
const sandbox = {
  console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } },
  location: { hash: '' },
  navigator: { userAgent: 'node-smoke' },
  crypto: { randomUUID: () => 'uuid-' + Math.random().toString(16).slice(2) },
  fetch: async () => ({ ok: false, status: 0, json: async () => null }),
};
sandbox.window = sandbox;
sandbox.document = {
  readyState: 'loading', // 避免 App.start 自动执行
  addEventListener: () => {},
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
  createElement: () => ({ style: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {} }),
  body: { appendChild() {}, removeChild() {} },
};
sandbox.window.addEventListener = () => {};
vm.createContext(sandbox);

const files = ['api.js', 'ui.js', 'charts.js', 'signature.js', 'hq.js', 'store.js', 'inv-ui.js', 'inv-hq.js', 'inv-store.js', 'app.js'];
for (const f of files) {
  const code = fs.readFileSync(path.join(__dirname, 'public/js', f), 'utf8');
  try { vm.runInContext(code, sandbox, { filename: f }); }
  catch (e) { console.error('❌ 脚本加载失败', f, e.message); process.exit(1); }
  console.log('✅ 脚本加载', f);
}

const need = (cond, msg) => { if (!cond) { console.error('❌', msg); process.exit(1); } console.log('✅', msg); };
const V = vm.runInContext('window.Views', sandbox);
const App = vm.runInContext('App', sandbox);
const InvUI = vm.runInContext('InvUI', sandbox);

for (const p of ['inventory/overview', 'inventory/master', 'inventory/ledger'])
  need(typeof V.hq[p] === 'function', `总部视图已注册：${p}`);
for (const p of ['inventory/workbench', 'inventory/stockin', 'inventory/batches', 'inventory/check', 'inventory/transfers', 'inventory/ledger'])
  need(typeof V.store[p] === 'function', `门店视图已注册：${p}`);
const paths = App.nav.flatMap(g => g.items.map(i => i.path));
for (const p of ['/hq/inventory/overview', '/hq/inventory/master', '/hq/inventory/ledger',
  '/store/inventory/workbench', '/store/inventory/stockin', '/store/inventory/batches',
  '/store/inventory/check', '/store/inventory/transfers', '/store/inventory/ledger']) {
  need(paths.includes(p), `导航包含 ${p}`);
  need(!!App.titles[p], `标题包含 ${p}`);
}
need(typeof InvUI.transferStatusTag === 'function' && InvUI.transferStatusTag('frozen').includes('待调入签收'), 'InvUI 调拨状态标签正常');
need(InvUI.LEDGER_TYPES.length === 9, '流水类型筛选 9 项');

/* 原有视图未被覆盖 */
need(typeof V.hq.dashboard === 'function' && typeof V.store.orders === 'function', '原有总部/门店视图保留');

console.log('\n🎉 前端库存模块加载冒烟全部通过');
