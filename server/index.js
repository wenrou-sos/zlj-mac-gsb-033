/**
 * 悦足堂 · HTTP 服务（零依赖）
 * 提供 REST API 与静态站点。
 * Handler 统一签名: (req, res, p, user, m, body)，其中 p={ query }，m=路径正则匹配
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');
const { load, save, nowLocal, fmtDate, parseDate } = require('./db');
const { createInventory } = require('./inventory');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const db = load();
const Inv = createInventory({ db, nextId, nowLocal, todayStr, fmtDate });
syncCounters();

/* ---------------- 工具 ---------------- */
function json(res, data, code = 200) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}
function fail(res, msg, code = 400) { json(res, { error: msg }, code); }
function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', c => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => {
      if (!buf) return resolve({});
      try { resolve(JSON.parse(buf)); } catch { resolve({}); }
    });
  });
}
function nextId(key, prefix, len = 4) {
  db.counters[key] = (db.counters[key] || 0) + 1;
  return `${prefix}${String(db.counters[key]).padStart(len, '0')}`;
}
/* 启动时根据已有数据校准各序列计数器，避免新建 ID 与种子数据冲突 */
function syncCounters() {
  const tableKey = {
    member: 'members', recharge: 'recharges', tech: 'technicians',
    training: 'trainings', transfer: 'transfers',
    shift: 'shifts', handover: 'handovers',
    order: 'orders', commissionRule: 'commissionRules', user: 'users',
    material: 'materials', materialRecipe: 'materialRecipes',
    stockBatch: 'stockBatches', inbound: 'stockInbounds',
    stockCheck: 'stockChecks', stockTransfer: 'stockTransfers', stockLedger: 'stockLedger',
  };
  for (const [key, tableName] of Object.entries(tableKey)) {
    let max = db.counters[key] || 0;
    for (const row of db[tableName] || []) {
      const num = Number(String(row.id || '').replace(/^\D+/, ''));
      if (Number.isFinite(num) && num > max) max = num;
    }
    db.counters[key] = max;
  }
}
function genToken() { return crypto.randomBytes(24).toString('hex'); }
function todayStr() { return fmtDate(new Date()); }
function daysAgoStr(n) { const d = new Date(); d.setDate(d.getDate() - n); return fmtDate(d); }

function enrichTech(t) {
  const level = db.techLevels.find(l => l.id === t.levelId);
  const store = db.stores.find(s => s.id === t.storeId);
  const specialties = db.techSpecialties
    .filter(x => x.techId === t.id)
    .map(x => db.services.find(v => v.id === x.serviceId))
    .filter(Boolean);
  return { ...t, levelName: level?.name, commissionRate: level?.commissionRate, storeName: store?.name, city: store?.city, specialties };
}
function memberLevel(m) { return db.memberLevels.find(l => l.id === m.levelId); }
function enrichMember(m) {
  const store = db.stores.find(s => s.id === m.storeId);
  const lv = memberLevel(m);
  return { ...m, levelName: lv?.name, discount: lv?.discount, storeName: store?.name };
}
function payLabel(p) { return { cash: '现金', card: '刷卡', member: '会员卡', mp: '移动支付' }[p] || p; }
function orderView(o) {
  return {
    ...o,
    serviceName: db.services.find(v => v.id === o.serviceId)?.name,
    techName: db.technicians.find(t => t.id === o.techId)?.name,
    memberName: o.memberId ? db.members.find(x => x.id === o.memberId)?.name : null,
    storeName: db.stores.find(s => s.id === o.storeId)?.name,
    payMethodName: payLabel(o.payMethod),
  };
}

/* 提成：规则（项目+等级，固定金额/比例）> 等级标准比例 */
function calcCommission(serviceId, levelId, amount) {
  const rule = db.commissionRules.find(r => r.active && r.serviceId === serviceId && r.levelId === levelId);
  const level = db.techLevels.find(l => l.id === levelId);
  if (rule && rule.type === 'fixed') return { value: rule.value, basis: `规则「${rule.name}」固定提成` };
  if (rule && rule.type === 'rate') return { value: Math.round(amount * rule.value), basis: `规则「${rule.name}」比例 ${(rule.value * 100).toFixed(0)}%` };
  return { value: Math.round(amount * level.commissionRate), basis: `${level.name}标准比例 ${(level.commissionRate * 100).toFixed(0)}%` };
}
function applyMemberLevel(m) {
  m.levelId = [...db.memberLevels].reverse().find(l => m.totalRecharge >= l.threshold).id;
}

/* ---------------- 鉴权 ---------------- */
const sessions = new Map();
function auth(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return sessions.get(token) || null;
}
function requireAuth(req, res) {
  const u = auth(req);
  if (!u) { fail(res, '未登录或登录已过期', 401); return null; }
  return u;
}

/* ---------------- 聚合统计 ---------------- */
function hqDashboard(days) {
  const from = daysAgoStr(days - 1), to = todayStr();
  const orders = db.orders.filter(o => o.businessDate >= from && o.businessDate <= to);
  const byStore = Object.fromEntries(db.stores.map(s => [s.id, 0]));
  orders.forEach(o => { byStore[o.storeId] = (byStore[o.storeId] || 0) + o.amount; });
  const totalRevenue = orders.reduce((a, o) => a + o.amount, 0);
  const totalCommission = orders.reduce((a, o) => a + o.techCommission, 0);
  const recharges = db.recharges.filter(r => r.createdAt.slice(0, 10) >= from);
  const rechargeTotal = recharges.reduce((a, r) => a + r.amount, 0);
  const rechargeBonus = recharges.reduce((a, r) => a + (r.bonus || 0), 0);

  const storeRank = db.stores.map(s => ({
    storeId: s.id, name: s.name, city: s.city,
    revenue: byStore[s.id] || 0,
    orders: orders.filter(o => o.storeId === s.id).length,
  })).sort((a, b) => b.revenue - a.revenue);

  const catMap = {};
  orders.forEach(o => {
    const v = db.services.find(x => x.id === o.serviceId);
    const key = v?.category || '其他';
    if (!catMap[key]) catMap[key] = { category: key, revenue: 0, count: 0 };
    catMap[key].revenue += o.amount; catMap[key].count += 1;
  });
  const catShare = Object.values(catMap).sort((a, b) => b.revenue - a.revenue);

  const svcMap = {};
  orders.forEach(o => {
    if (!svcMap[o.serviceId]) svcMap[o.serviceId] = { serviceId: o.serviceId, name: '', revenue: 0, count: 0 };
    const row = svcMap[o.serviceId];
    row.name = db.services.find(v => v.id === o.serviceId)?.name || o.serviceId;
    row.revenue += o.amount; row.count += 1;
  });
  const serviceShare = Object.values(svcMap).sort((a, b) => b.revenue - a.revenue);

  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysAgoStr(i);
    trend.push({ date: d, revenue: db.orders.filter(o => o.businessDate === d).reduce((a, o) => a + o.amount, 0) });
  }

  const memberBalances = db.members.reduce((a, m) => a + m.balance, 0);
  return {
    range: { from, to, days },
    kpi: {
      totalRevenue, totalOrders: orders.length, avgTicket: orders.length ? Math.round(totalRevenue / orders.length) : 0,
      rechargeTotal, rechargeBonus, memberCount: db.members.length, memberBalances, totalCommission,
      storeCount: db.stores.length, activeTechCount: db.technicians.filter(t => t.status === 'active').length,
    },
    storeRank, catShare, serviceShare, trend,
  };
}

function shiftView(shift) {
  if (!shift) return null;
  const so = db.orders.filter(o => o.shiftId === shift.id);
  return {
    ...shift,
    serveCount: so.length,
    revenue: so.reduce((a, o) => a + o.amount, 0),
    cash: so.filter(o => o.payMethod === 'cash').reduce((a, o) => a + o.amount, 0),
    card: so.filter(o => o.payMethod === 'card').reduce((a, o) => a + o.amount, 0),
    member: so.filter(o => o.payMethod === 'member').reduce((a, o) => a + o.amount, 0),
    mp: so.filter(o => o.payMethod === 'mp').reduce((a, o) => a + o.amount, 0),
  };
}

function storeDashboard(storeId, days) {
  const from = daysAgoStr(days - 1), to = todayStr();
  const orders = db.orders.filter(o => o.businessDate >= from && o.businessDate <= to && o.storeId === storeId);
  const todayOrders = db.orders.filter(o => o.storeId === storeId && o.businessDate === to);
  const openShift = shiftView(db.shifts.find(s => s.storeId === storeId && s.status === 'open'));

  const trend = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = daysAgoStr(i);
    const dayO = db.orders.filter(o => o.storeId === storeId && o.businessDate === d);
    trend.push({ date: d, revenue: dayO.reduce((a, o) => a + o.amount, 0), orders: dayO.length });
  }
  const catMap = {};
  orders.forEach(o => {
    const key = db.services.find(x => x.id === o.serviceId)?.category || '其他';
    catMap[key] = (catMap[key] || 0) + o.amount;
  });
  const handovers = db.handovers.filter(h => h.storeId === storeId && h.businessDate >= from)
    .sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt));

  return {
    range: { from, to, days },
    kpi: {
      revenue: orders.reduce((a, o) => a + o.amount, 0),
      orders: orders.length,
      todayRevenue: todayOrders.reduce((a, o) => a + o.amount, 0),
      todayOrders: todayOrders.length,
      memberRecharge: db.recharges.filter(r => r.storeId === storeId && r.createdAt.slice(0, 10) >= from).reduce((a, r) => a + r.amount, 0),
    },
    openShift,
    trend,
    catShare: Object.entries(catMap).map(([category, revenue]) => ({ category, revenue })).sort((a, b) => b.revenue - a.revenue),
    recentHandovers: handovers.slice(0, 8),
  };
}

/* ---------------- 路由表 ---------------- */
const routes = [];
const r = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, ...opts });

/* 认证 */
r('GET', /^\/api\/public\/stores$/, async (req, res) => {
  json(res, db.stores.map(s => ({ id: s.id, name: s.name, city: s.city, manager: s.manager })));
});
r('POST', /^\/api\/login$/, async (req, res, p, user, m, body) => {
  const u = db.users.find(x => x.username === body.username && x.password === body.password && x.active);
  if (!u) return fail(res, '账号或密码错误', 401);
  const token = genToken();
  const info = { id: u.id, username: u.username, name: u.name, role: u.role, storeId: u.storeId };
  sessions.set(token, info);
  const store = u.storeId ? db.stores.find(s => s.id === u.storeId) : null;
  json(res, { token, user: info, store });
});
r('POST', /^\/api\/logout$/, async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  sessions.delete(token);
  json(res, { ok: true });
});
r('GET', /^\/api\/bootstrap$/, async (req, res, p, user) => {
  json(res, {
    user,
    store: user.storeId ? db.stores.find(s => s.id === user.storeId) : null,
    stores: db.stores, services: db.services, techLevels: db.techLevels,
    memberLevels: db.memberLevels, shiftDefs: db.shiftDefs,
    materials: db.materials, materialUnits: db.materialUnits,
    recipes: db.materialRecipes,
  });
}, { auth: true });

/* ===== 总部看板 ===== */
r('GET', /^\/api\/hq\/dashboard$/, async (req, res, p, user) => {
  json(res, hqDashboard(Number(p.query.days) || 30));
}, { auth: true, role: 'hq' });

/* ===== 门店管理 ===== */
r('GET', /^\/api\/stores$/, async (req, res) => {
  json(res, db.stores.map(s => ({
    ...s,
    techCount: db.technicians.filter(t => t.storeId === s.id && t.status === 'active').length,
    memberCount: db.members.filter(m => m.storeId === s.id).length,
  })));
}, { auth: true });
r('POST', /^\/api\/stores$/, async (req, res, p, user, m, body) => {
  if (!body.name || !body.city) return fail(res, '门店名称与城市必填');
  const idNum = Math.max(0, ...db.stores.map(s => Number(s.id.slice(1)))) + 1;
  const store = { id: `S${String(idNum).padStart(2, '0')}`, name: body.name, city: body.city, address: body.address || '', phone: body.phone || '', manager: body.manager || '', opened: body.opened || todayStr() };
  db.stores.push(store); save();
  json(res, store);
}, { auth: true, role: 'hq' });
r('PUT', /^\/api\/stores\/(\w+)$/, async (req, res, p, user, m, body) => {
  const s = db.stores.find(x => x.id === m[1]);
  if (!s) return fail(res, '门店不存在', 404);
  ['name', 'city', 'address', 'phone', 'manager', 'opened'].forEach(k => { if (body[k] !== undefined) s[k] = body[k]; });
  save(); json(res, s);
}, { auth: true, role: 'hq' });

/* ===== 项目 / 定价 ===== */
r('GET', /^\/api\/services$/, async (req, res) => {
  json(res, db.services.map(v => ({
    ...v,
    sold30: db.orders.filter(o => o.serviceId === v.id && o.businessDate >= daysAgoStr(29)).length,
  })));
}, { auth: true });
r('POST', /^\/api\/services$/, async (req, res, p, user, m, body) => {
  if (!body.name || !(Number(body.price) > 0)) return fail(res, '项目名称与价格必填');
  const idNum = Math.max(0, ...db.services.map(v => Number(v.id.slice(1)))) + 1;
  const v = { id: `V${String(idNum).padStart(2, '0')}`, name: body.name, duration: Number(body.duration) || 60, price: Number(body.price), category: body.category || '其他', commissionFixed: body.commissionFixed ? Number(body.commissionFixed) : null, active: body.active === 0 ? 0 : 1 };
  db.services.push(v); save(); json(res, v);
}, { auth: true, role: 'hq' });
r('PUT', /^\/api\/services\/(\w+)$/, async (req, res, p, user, m, body) => {
  const v = db.services.find(x => x.id === m[1]);
  if (!v) return fail(res, '项目不存在', 404);
  if (body.name !== undefined) v.name = body.name;
  if (body.category !== undefined) v.category = body.category;
  if (body.duration !== undefined) v.duration = Number(body.duration);
  if (body.price !== undefined) v.price = Number(body.price);
  if (body.active !== undefined) v.active = Number(body.active);
  if (body.commissionFixed !== undefined) v.commissionFixed = body.commissionFixed ? Number(body.commissionFixed) : null;
  save(); json(res, v);
}, { auth: true, role: 'hq' });

/* ===== 会员体系 ===== */
r('GET', /^\/api\/member-levels$/, async (req, res) => json(res, db.memberLevels), { auth: true });
r('PUT', /^\/api\/member-levels\/(\w+)$/, async (req, res, p, user, m, body) => {
  const lv = db.memberLevels.find(x => x.id === m[1]);
  if (!lv) return fail(res, '等级不存在', 404);
  if (body.name) lv.name = body.name;
  if (body.threshold !== undefined && Number(body.threshold) >= 0) lv.threshold = Number(body.threshold);
  if (body.discount !== undefined && Number(body.discount) > 0 && Number(body.discount) <= 1) lv.discount = Number(body.discount);
  save(); json(res, lv);
}, { auth: true, role: 'hq' });

/* ===== 提成标准 ===== */
r('GET', /^\/api\/commission-rules$/, async (req, res) => {
  json(res, { levels: db.techLevels, rules: db.commissionRules, services: db.services });
}, { auth: true });
r('PUT', /^\/api\/tech-levels\/(\w+)$/, async (req, res, p, user, m, body) => {
  const lv = db.techLevels.find(x => x.id === m[1]);
  if (!lv) return fail(res, '技师等级不存在', 404);
  if (body.name) lv.name = body.name;
  if (body.commissionRate !== undefined) {
    const v = Number(body.commissionRate);
    if (!(v > 0 && v < 1)) return fail(res, '提成比例需在 0~1 之间');
    lv.commissionRate = v;
  }
  save(); json(res, lv);
}, { auth: true, role: 'hq' });
r('POST', /^\/api\/commission-rules$/, async (req, res, p, user, m, body) => {
  if (!body.serviceId || !body.levelId || !body.type || body.value === undefined) return fail(res, '请完整填写规则');
  if (db.commissionRules.some(x => x.serviceId === body.serviceId && x.levelId === body.levelId && x.active))
    return fail(res, '该项目+等级已有生效规则，请直接编辑');
  const rule = { id: nextId('commissionRule', 'CR', 3), name: body.name || '提成规则', serviceId: body.serviceId, levelId: body.levelId, type: body.type, value: Number(body.value), active: 1 };
  db.commissionRules.push(rule); save(); json(res, rule);
}, { auth: true, role: 'hq' });
r('PUT', /^\/api\/commission-rules\/(\w+)$/, async (req, res, p, user, m, body) => {
  const rule = db.commissionRules.find(x => x.id === m[1]);
  if (!rule) return fail(res, '规则不存在', 404);
  ['name', 'serviceId', 'levelId', 'type'].forEach(k => { if (body[k] !== undefined) rule[k] = body[k]; });
  if (body.value !== undefined) rule.value = Number(body.value);
  if (body.active !== undefined) rule.active = Number(body.active);
  save(); json(res, rule);
}, { auth: true, role: 'hq' });
r('DELETE', /^\/api\/commission-rules\/(\w+)$/, async (req, res, p, user, m) => {
  const i = db.commissionRules.findIndex(x => x.id === m[1]);
  if (i < 0) return fail(res, '规则不存在', 404);
  db.commissionRules.splice(i, 1); save(); json(res, { ok: true });
}, { auth: true, role: 'hq' });

/* ===== 会员 ===== */
r('GET', /^\/api\/members$/, async (req, res, p, user) => {
  let list = db.members;
  if (user.role === 'store') list = list.filter(m => m.storeId === user.storeId);
  if (p.query.storeId && user.role === 'hq') list = list.filter(m => m.storeId === p.query.storeId);
  if (p.query.q) { const q = String(p.query.q).trim(); list = list.filter(m => m.name.includes(q) || m.phone.includes(q)); }
  json(res, list.map(enrichMember));
}, { auth: true });
r('POST', /^\/api\/members$/, async (req, res, p, user, m, body) => {
  if (!body.name || !body.phone) return fail(res, '姓名与手机号必填');
  if (db.members.some(x => x.phone === body.phone)) return fail(res, '该手机号已注册会员');
  const storeId = user.role === 'store' ? user.storeId : (body.storeId || null);
  if (!storeId) return fail(res, '请选择归属门店');
  const mem = { id: nextId('member', 'M'), name: body.name, phone: body.phone, levelId: 'ML1', storeId, balance: 0, totalRecharge: 0, totalConsume: 0, regDate: todayStr() };
  db.members.push(mem);
  if (Number(body.initAmount) > 0) {
    const amt = Number(body.initAmount);
    const bonus = amt >= 3000 ? Math.round(amt * 0.1) : 0;
    mem.balance = amt + bonus; mem.totalRecharge = amt + bonus;
    applyMemberLevel(mem);
    db.recharges.push({ id: nextId('recharge', 'RC', 5), memberId: mem.id, storeId, amount: amt, bonus, payMethod: body.payMethod || 'cash', createdAt: nowLocal() });
  }
  save(); json(res, enrichMember(mem));
}, { auth: true });
r('POST', /^\/api\/members\/(\w+)\/recharge$/, async (req, res, p, user, m, body) => {
  const mem = db.members.find(x => x.id === m[1]);
  if (!mem) return fail(res, '会员不存在', 404);
  if (user.role === 'store' && mem.storeId !== user.storeId) return fail(res, '不能为其他门店会员充值', 403);
  const amt = Number(body.amount);
  if (!(amt > 0)) return fail(res, '充值金额无效');
  const bonus = amt >= 3000 ? Math.round(amt * 0.1) : 0;
  mem.balance += amt + bonus; mem.totalRecharge += amt + bonus;
  applyMemberLevel(mem);
  const rec = { id: nextId('recharge', 'RC', 5), memberId: mem.id, storeId: mem.storeId, amount: amt, bonus, payMethod: body.payMethod || 'cash', createdAt: nowLocal() };
  db.recharges.push(rec); save();
  json(res, { member: enrichMember(mem), recharge: rec });
}, { auth: true });
r('GET', /^\/api\/members\/(\w+)\/recharges$/, async (req, res, p, user, m) => {
  const mem = db.members.find(x => x.id === m[1]);
  if (!mem) return fail(res, '会员不存在', 404);
  json(res, db.recharges.filter(x => x.memberId === mem.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
}, { auth: true });

/* ===== 技师 / 员工 ===== */
r('GET', /^\/api\/technicians$/, async (req, res, p, user) => {
  let list = db.technicians;
  if (user.role === 'store') list = list.filter(t => t.storeId === user.storeId);
  if (p.query.storeId) list = list.filter(t => t.storeId === p.query.storeId);
  if (p.query.status) list = list.filter(t => t.status === p.query.status);
  if (p.query.q) { const q = String(p.query.q).trim(); list = list.filter(t => t.name.includes(q) || t.phone.includes(q) || t.id.includes(q)); }
  json(res, list.map(enrichTech));
}, { auth: true });
r('GET', /^\/api\/technicians\/(\w+)$/, async (req, res, p, user, m) => {
  const t = db.technicians.find(x => x.id === m[1]);
  if (!t) return fail(res, '员工不存在', 404);
  if (user.role === 'store' && t.storeId !== user.storeId) return fail(res, '无权查看该员工', 403);
  json(res, {
    ...enrichTech(t),
    trainings: db.trainings.filter(x => x.techId === t.id).sort((a, b) => b.trainDate.localeCompare(a.trainDate)),
    transfers: db.transfers.filter(x => x.techId === t.id).sort((a, b) => b.transferDate.localeCompare(a.transferDate)),
  });
}, { auth: true });
r('POST', /^\/api\/technicians$/, async (req, res, p, user, m, body) => {
  if (!body.name || !body.levelId) return fail(res, '姓名与技师等级必填');
  const storeId = user.role === 'store' ? user.storeId : (body.storeId || null);
  if (!storeId) return fail(res, '请选择归属门店');
  const t = {
    id: nextId('tech', 'T'), name: body.name, gender: body.gender || '女', age: Number(body.age) || 25,
    phone: body.phone || '', levelId: body.levelId, storeId, status: 'active',
    hireDate: body.hireDate || todayStr(), leaveDate: null, remark: body.remark || '',
  };
  db.technicians.push(t);
  (body.specialties || []).filter(Boolean).forEach(sid => db.techSpecialties.push({ techId: t.id, serviceId: sid }));
  (body.trainings || []).filter(tr => tr && tr.topic).forEach(tr => {
    const score = Number(tr.score) || 0;
    db.trainings.push({ id: nextId('training', 'TR'), techId: t.id, topic: tr.topic, trainDate: tr.trainDate || todayStr(), score, result: score >= 60 ? 'pass' : 'fail', cert: tr.cert || null });
  });
  save(); json(res, enrichTech(t));
}, { auth: true });
r('POST', /^\/api\/technicians\/(\w+)\/trainings$/, async (req, res, p, user, m, body) => {
  const t = db.technicians.find(x => x.id === m[1]);
  if (!t) return fail(res, '员工不存在', 404);
  if (user.role === 'store' && t.storeId !== user.storeId) return fail(res, '无权操作', 403);
  if (!body.topic) return fail(res, '培训主题必填');
  const score = Number(body.score) || 0;
  const tr = { id: nextId('training', 'TR'), techId: t.id, topic: body.topic, trainDate: body.trainDate || todayStr(), score, result: score >= 60 ? 'pass' : 'fail', cert: body.cert || null };
  db.trainings.push(tr); save(); json(res, tr);
}, { auth: true });
r('POST', /^\/api\/technicians\/(\w+)\/specialties$/, async (req, res, p, user, m, body) => {
  const t = db.technicians.find(x => x.id === m[1]);
  if (!t) return fail(res, '员工不存在', 404);
  if (user.role === 'store' && t.storeId !== user.storeId) return fail(res, '无权操作', 403);
  db.techSpecialties = db.techSpecialties.filter(x => x.techId !== t.id);
  (body.serviceIds || []).forEach(sid => db.techSpecialties.push({ techId: t.id, serviceId: sid }));
  save(); json(res, enrichTech(t));
}, { auth: true });
r('POST', /^\/api\/technicians\/(\w+)\/transfer$/, async (req, res, p, user, m, body) => {
  const t = db.technicians.find(x => x.id === m[1]);
  if (!t) return fail(res, '员工不存在', 404);
  if (t.status !== 'active') return fail(res, '仅在职员工可调动');
  const target = db.stores.find(s => s.id === body.toStoreId);
  if (!target) return fail(res, '目标门店不存在');
  if (target.id === t.storeId) return fail(res, '目标门店与当前门店相同');
  const rec = { id: nextId('transfer', 'TF'), techId: t.id, techName: t.name, fromStoreId: t.storeId, toStoreId: target.id, transferDate: body.transferDate || todayStr(), reason: body.reason || '' };
  db.transfers.push(rec);
  t.storeId = target.id;
  save(); json(res, { tech: enrichTech(t), transfer: rec });
}, { auth: true });
r('POST', /^\/api\/technicians\/(\w+)\/leave$/, async (req, res, p, user, m, body) => {
  const t = db.technicians.find(x => x.id === m[1]);
  if (!t) return fail(res, '员工不存在', 404);
  if (t.status !== 'active') return fail(res, '员工当前状态不可离职');
  t.status = 'left';
  t.leaveDate = body.leaveDate || todayStr();
  t.remark = body.reason || t.remark;
  save(); json(res, enrichTech(t));
}, { auth: true });
r('GET', /^\/api\/transfers$/, async (req, res) => {
  json(res, db.transfers.slice().sort((a, b) => b.transferDate.localeCompare(a.transferDate)).map(t => ({
    ...t,
    fromStoreName: db.stores.find(s => s.id === t.fromStoreId)?.name,
    toStoreName: db.stores.find(s => s.id === t.toStoreId)?.name,
  })));
}, { auth: true });

/* ===== 班次 / 交班 ===== */
r('GET', /^\/api\/shifts$/, async (req, res, p, user) => {
  let list = db.shifts;
  if (user.role === 'store') list = list.filter(s => s.storeId === user.storeId);
  if (p.query.storeId && user.role === 'hq') list = list.filter(s => s.storeId === p.query.storeId);
  if (p.query.status) list = list.filter(s => s.status === p.query.status);
  json(res, list.slice().sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, 100).map(shiftView));
}, { auth: true });
r('POST', /^\/api\/shifts$/, async (req, res, p, user, m, body) => {
  const storeId = user.role === 'store' ? user.storeId : body.storeId;
  if (!storeId) return fail(res, '请选择门店');
  if (db.shifts.some(s => s.storeId === storeId && s.status === 'open')) return fail(res, '该门店已有进行中的班次，请先完成交班');
  const def = db.shiftDefs.find(d => d.code === (body.shiftCode || 'day')) || db.shiftDefs[0];
  const endDate = def.end < def.start ? (() => { const x = new Date(); x.setDate(x.getDate() + 1); return fmtDate(x); })() : todayStr();
  const shift = {
    id: nextId('shift', 'SH', 6), storeId, shiftCode: def.code, shiftName: def.name,
    businessDate: todayStr(), startTime: `${todayStr} ${def.start}:00`, endTime: `${endDate} ${def.end}:00`,
    opener: body.opener || user.name, status: 'open', openedAt: nowLocal(), closedAt: null,
  };
  db.shifts.push(shift); save(); json(res, shift);
}, { auth: true });
r('POST', /^\/api\/shifts\/(\w+)\/close$/, async (req, res, p, user, m, body) => {
  const s = db.shifts.find(x => x.id === m[1]);
  if (!s) return fail(res, '班次不存在', 404);
  if (user.role === 'store' && s.storeId !== user.storeId) return fail(res, '无权操作该班次', 403);
  if (s.status === 'closed') return fail(res, '该班次已交班');
  if (!body.closer) return fail(res, '请填写接班人');
  if (!body.openerSign || !body.closerSign) return fail(res, '交班双方均需手写签字确认');
  const orders = db.orders.filter(o => o.shiftId === s.id);
  const sum = (pm) => orders.filter(o => o.payMethod === pm).reduce((a, o) => a + o.amount, 0);
  const hand = {
    id: nextId('handover', 'HD', 6),
    shiftId: s.id, storeId: s.storeId, businessDate: s.businessDate, shiftName: s.shiftName,
    serveCount: orders.length,
    cash: sum('cash'), card: sum('card'), member: sum('member'), mp: sum('mp'),
    revenue: orders.reduce((a, o) => a + o.amount, 0),
    commission: orders.reduce((a, o) => a + o.techCommission, 0),
    opener: body.opener || s.opener, closer: body.closer,
    openerSign: body.openerSign, closerSign: body.closerSign,
    confirmedAt: nowLocal(), remark: body.remark || '',
  };
  db.handovers.push(hand);
  s.status = 'closed'; s.closedAt = nowLocal();
  save(); json(res, hand);
}, { auth: true });
r('GET', /^\/api\/handovers$/, async (req, res, p, user) => {
  let list = db.handovers;
  if (user.role === 'store') list = list.filter(h => h.storeId === user.storeId);
  if (p.query.storeId && user.role === 'hq') list = list.filter(h => h.storeId === p.query.storeId);
  json(res, list.slice().sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)).slice(0, 200).map(h => ({
    ...h, storeName: db.stores.find(s => s.id === h.storeId)?.name,
  })));
}, { auth: true });
r('GET', /^\/api\/handovers\/(\w+)$/, async (req, res, p, user, m) => {
  const h = db.handovers.find(x => x.id === m[1]);
  if (!h) return fail(res, '交接记录不存在', 404);
  if (user.role === 'store' && h.storeId !== user.storeId) return fail(res, '无权查看', 403);
  const orders = db.orders.filter(o => o.shiftId === h.shiftId).map(orderView)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  json(res, { ...h, storeName: db.stores.find(s => s.id === h.storeId)?.name, orders });
}, { auth: true });

/* ===== 开单（上钟） ===== */
r('GET', /^\/api\/orders$/, async (req, res, p, user) => {
  let list = db.orders;
  if (user.role === 'store') list = list.filter(o => o.storeId === user.storeId);
  if (p.query.storeId) list = list.filter(o => o.storeId === p.query.storeId);
  if (p.query.shiftId) list = list.filter(o => o.shiftId === p.query.shiftId);
  if (p.query.date) list = list.filter(o => o.businessDate === p.query.date);
  if (p.query.techId) list = list.filter(o => o.techId === p.query.techId);
  json(res, list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(orderView));
}, { auth: true });
r('POST', /^\/api\/orders\/quote$/, async (req, res, p, user, m, body) => {
  const svc = db.services.find(v => v.id === body.serviceId);
  const tech = db.technicians.find(t => t.id === body.techId);
  if (!svc || !tech) return fail(res, '请选择项目与技师');
  const mem = body.memberId ? db.members.find(x => x.id === body.memberId) : null;
  const rate = mem ? memberLevel(mem).discount : 1;
  const amount = Math.round(svc.price * rate);
  const cm = calcCommission(svc.id, tech.levelId, amount);
  // 耗材配方与本店库存可用性预估（不锁定库存）
  const storeId = user.role === 'store' ? user.storeId : (body.storeId || tech.storeId);
  let stock = { ok: true, lines: Inv.recipeOf(svc.id).map(it => {
    const mm = db.materials.find(x => x.id === it.materialId);
    const st = Inv.materialStock(storeId, it.materialId);
    return { materialId: it.materialId, materialName: mm?.name, unit: mm?.unit, need: it.qty, available: st.available, enough: st.available + 1e-9 >= it.qty };
  }) };
  stock.ok = stock.lines.every(x => x.enough);
  json(res, { price: svc.price, discountRate: rate, amount, commission: cm.value, basis: cm.basis, balance: mem ? mem.balance : null, stock });
}, { auth: true });
r('POST', /^\/api\/orders$/, async (req, res, p, user, m, body) => {
  const storeId = user.role === 'store' ? user.storeId : (body.storeId || null);
  if (!storeId) return fail(res, '请选择门店');

  /* 幂等：相同 clientReqId 的重复提交直接返回首单，不重复扣库存/扣款/生成账单 */
  if (body.clientReqId) {
    const exist = db.orders.find(o => o.storeId === storeId && o.clientReqId === body.clientReqId);
    if (exist) {
      const cm = calcCommission(exist.serviceId, db.technicians.find(t => t.id === exist.techId)?.levelId || 'L1', exist.amount);
      return json(res, { ...orderView(exist), idempotent: true, commissionBasis: cm.basis, payMethodName: payLabel(exist.payMethod) });
    }
  }

  const svc = db.services.find(v => v.id === body.serviceId && v.active);
  if (!svc) return fail(res, '服务项目不存在或已下架');
  const tech = db.technicians.find(t => t.id === body.techId);
  if (!tech || tech.status !== 'active') return fail(res, '技师不存在或非在职状态');
  if (tech.storeId !== storeId) return fail(res, '该技师不属于本门店');

  const shift = body.shiftId
    ? db.shifts.find(s => s.id === body.shiftId)
    : db.shifts.find(s => s.storeId === storeId && s.status === 'open');
  if (!shift) return fail(res, '当前没有进行中的班次，请先开班');
  if (shift.status !== 'open') return fail(res, '该班次已交班，不能再录单');

  let memberId = null, discountRate = 1, amount = svc.price;
  if (body.memberId) {
    const mem = db.members.find(x => x.id === body.memberId);
    if (!mem) return fail(res, '会员不存在');
    if (mem.storeId !== storeId) return fail(res, '该会员不属于本门店');
    discountRate = memberLevel(mem).discount;
    amount = Math.round(svc.price * discountRate);
    if (mem.balance < amount) return fail(res, `会员卡余额不足（余额 ¥${mem.balance}，本单需 ¥${amount}）`);
    memberId = mem.id;
  }
  let payMethod = body.payMethod || 'cash';
  if (memberId) payMethod = 'member';
  if (!['cash', 'card', 'mp', 'member'].includes(payMethod)) return fail(res, '支付方式无效');

  /* 库存预校验：按配方 + FEFO 生成全量扣减计划，任一耗材不足直接整体失败（此时账单/余额均未改动） */
  let plan = null;
  try {
    plan = Inv.planConsume(storeId, svc.id);
  } catch (e) {
    return fail(res, e.message, e.status || 400);
  }

  const cm = calcCommission(svc.id, tech.levelId, amount);
  const now = nowLocal();
  const order = {
    id: nextId('order', 'O', 7), orderNo: `${todayStr().replace(/-/g, '')}${String(db.counters.order).padStart(5, '0').slice(-5)}`,
    clientReqId: body.clientReqId || null,
    storeId, shiftId: shift.id, serviceId: svc.id, techId: tech.id, memberId,
    price: svc.price, discountRate, amount, payMethod, techCommission: cm.value,
    duration: svc.duration, createdAt: now, businessDate: todayStr(),
    materials: plan.lines.map(l => ({ materialId: l.materialId, qty: l.need })),
  };

  /* ---------- 提交段：最终校验通过后，库存→账单→余额在同一同步调用栈内顺序提交，
     applyConsume 的最终校验是最后一个可抛错步骤，之后不会再出现部分提交 ---------- */
  Inv.applyConsume(storeId, plan, order.id, user.name, now);
  db.orders.push(order);
  if (memberId) {
    const mem = db.members.find(x => x.id === memberId);
    mem.balance -= amount; mem.totalConsume += amount;
  }
  save();
  json(res, { ...order, commissionBasis: cm.basis, payMethodName: payLabel(payMethod), stockLines: plan.lines });
}, { auth: true });

/* ===== 门店看板 / 技师业绩 ===== */
r('GET', /^\/api\/stores\/(\w+)\/dashboard$/, async (req, res, p, user, m) => {
  if (user.role === 'store' && user.storeId !== m[1]) return fail(res, '无权查看该门店', 403);
  if (!db.stores.find(s => s.id === m[1])) return fail(res, '门店不存在', 404);
  json(res, storeDashboard(m[1], Number(p.query.days) || 30));
}, { auth: true });
r('GET', /^\/api\/stores\/(\w+)\/tech-performance$/, async (req, res, p, user, m) => {
  if (user.role === 'store' && user.storeId !== m[1]) return fail(res, '无权查看', 403);
  const from = p.query.from || daysAgoStr(29), to = p.query.to || todayStr();
  const rows = db.technicians.filter(t => t.storeId === m[1]).map(t => {
    const os = db.orders.filter(o => o.techId === t.id && o.businessDate >= from && o.businessDate <= to);
    return {
      techId: t.id, name: t.name, levelName: db.techLevels.find(l => l.id === t.levelId)?.name,
      status: t.status, orderCount: os.length, hours: Math.round(os.reduce((a, o) => a + o.duration, 0) / 60 * 10) / 10,
      revenue: os.reduce((a, o) => a + o.amount, 0), commission: os.reduce((a, o) => a + o.techCommission, 0),
    };
  }).sort((a, b) => b.commission - a.commission);
  json(res, { from, to, rows });
}, { auth: true });

/* ===== 充值流水（总部） ===== */
r('GET', /^\/api\/recharges$/, async (req, res, p) => {
  let list = db.recharges;
  if (p.query.storeId) list = list.filter(x => x.storeId === p.query.storeId);
  json(res, list.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(x => ({
    ...x,
    memberName: db.members.find(m => m.id === x.memberId)?.name,
    storeName: db.stores.find(s => s.id === x.storeId)?.name,
    payMethodName: payLabel(x.payMethod),
  })));
}, { auth: true, role: 'hq' });

/* ##########################################################################
   ===== 门店耗材库存 =====
   ########################################################################## */

/* ---------------- 总部：耗材 / 单位 / 配方维护 ---------------- */
r('GET', /^\/api\/materials$/, async (req, res, p, user) => {
  let list = db.materials.map(m => ({ ...Inv.materialView(m), recipeServices: recipeMaterialsOf(m.id) }));
  if (p.query.q) { const q = String(p.query.q).trim(); list = list.filter(m => m.name.includes(q) || m.id.includes(q) || m.category.includes(q)); }
  if (p.query.active) list = list.filter(m => m.active === Number(p.query.active));
  json(res, list);
}, { auth: true });
function recipeMaterialsOf(materialId) {
  return db.materialRecipes
    .filter(r => r.items.some(i => i.materialId === materialId))
    .map(r => db.services.find(s => s.id === r.serviceId))
    .filter(Boolean)
    .map(s => ({ serviceId: s.id, name: s.name }));
}
r('GET', /^\/api\/materials\/units$/, async (req, res) => json(res, db.materialUnits), { auth: true });
r('POST', /^\/api\/materials$/, async (req, res, p, user, m, body) => {
  if (!body.name || !body.unit) return fail(res, '耗材名称与单位必填');
  if (db.materials.some(x => x.name === body.name)) return fail(res, '已存在同名耗材');
  const mat = {
    id: nextId('material', 'MA', 4), name: String(body.name).trim(), unit: String(body.unit).trim(),
    category: body.category || '其他耗材', safetyStock: Math.max(0, Number(body.safetyStock) || 0),
    active: body.active === 0 ? 0 : 1, remark: body.remark || '',
  };
  db.materials.push(mat); save(); json(res, mat);
}, { auth: true, role: 'hq' });
r('PUT', /^\/api\/materials\/(\w+)$/, async (req, res, p, user, m, body) => {
  const mat = db.materials.find(x => x.id === m[1]);
  if (!mat) return fail(res, '耗材不存在', 404);
  if (body.name !== undefined) {
    if (db.materials.some(x => x.name === body.name && x.id !== mat.id)) return fail(res, '已存在同名耗材');
    mat.name = String(body.name).trim();
  }
  if (body.unit !== undefined && body.unit) mat.unit = String(body.unit).trim();
  if (body.category !== undefined) mat.category = body.category;
  if (body.safetyStock !== undefined) mat.safetyStock = Math.max(0, Number(body.safetyStock) || 0);
  if (body.active !== undefined) mat.active = Number(body.active) ? 1 : 0;
  if (body.remark !== undefined) mat.remark = body.remark;
  save(); json(res, mat);
}, { auth: true, role: 'hq' });

r('GET', /^\/api\/recipes$/, async (req, res) => {
  json(res, db.services.map(v => {
    const rr = db.materialRecipes.find(x => x.serviceId === v.id);
    return {
      serviceId: v.id, serviceName: v.name, category: v.category, serviceActive: v.active,
      items: (rr?.items || []).map(i => {
        const mm = db.materials.find(x => x.id === i.materialId);
        return { materialId: i.materialId, materialName: mm?.name, unit: mm?.unit, qty: i.qty, active: mm?.active };
      }),
    };
  }));
}, { auth: true });
r('PUT', /^\/api\/recipes\/(\w+)$/, async (req, res, p, user, m, body) => {
  const svc = db.services.find(v => v.id === m[1]);
  if (!svc) return fail(res, '服务项目不存在', 404);
  const items = Array.isArray(body.items) ? body.items : [];
  const merged = {};
  for (const it of items) {
    const mm = db.materials.find(x => x.id === it.materialId && x.active);
    const qty = Inv.r3(Number(it.qty));
    if (mm && qty > 0) merged[mm.id] = Math.max(merged[mm.id] || 0, qty);
  }
  const finalItems = Object.entries(merged).map(([materialId, qty]) => ({ materialId, qty: Inv.r3(qty) }));
  let rr = db.materialRecipes.find(x => x.serviceId === svc.id);
  if (rr) rr.items = finalItems;
  else { rr = { id: nextId('materialRecipe', 'MR', 4), serviceId: svc.id, items: finalItems }; db.materialRecipes.push(rr); }
  save(); json(res, rr);
}, { auth: true, role: 'hq' });

/* ---------------- 门店：库存总览（工作台） ---------------- */
r('GET', /^\/api\/stores\/(\w+)\/inventory\/overview$/, async (req, res, p, user, m) => {
  const sid = m[1];
  if (!db.stores.find(s => s.id === sid)) return fail(res, '门店不存在', 404);
  if (user.role === 'store' && user.storeId !== sid) return fail(res, '无权查看其他门店库存', 403);
  const rows = Inv.stockSummary(sid);
  const batches = db.stockBatches.filter(b => b.storeId === sid).map(Inv.batchView);
  const tv = (t) => Inv.transferView(t);
  json(res, {
    storeId: sid,
    kpi: {
      skuCount: rows.length,
      lowCount: rows.filter(r => r.low).length,
      nearCount: batches.filter(b => b.nearExpire && b.available > 0).length,
      expiredCount: batches.filter(b => b.expired && b.quantity - b.frozen > 0).length,
      frozenSkus: new Set(batches.filter(b => b.frozen > 0).map(b => b.materialId)).size,
      pendingIn: db.stockTransfers.filter(t => t.toStoreId === sid && ['pending', 'frozen'].includes(t.status)).length,
      pendingOut: db.stockTransfers.filter(t => t.fromStoreId === sid && t.status === 'pending').length,
      frozenOut: db.stockTransfers.filter(t => t.fromStoreId === sid && t.status === 'frozen').length,
    },
    rows,
    nearExpireBatches: batches.filter(b => b.nearExpire && b.available > 0)
      .sort((a, b) => (a.expireDate || '9999').localeCompare(b.expireDate || '9999')).slice(0, 100),
    expiredBatches: batches.filter(b => b.expired && b.quantity - b.frozen > 0).slice(0, 100),
    lowItems: rows.filter(r => r.low),
    pendingIn: db.stockTransfers.filter(t => t.toStoreId === sid && ['pending', 'frozen'].includes(t.status)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(tv),
    pendingOut: db.stockTransfers.filter(t => t.fromStoreId === sid && t.status === 'pending').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(tv),
    frozenOut: db.stockTransfers.filter(t => t.fromStoreId === sid && t.status === 'frozen').sort((a, b) => b.confirmedAt.localeCompare(a.confirmedAt)).map(tv),
  });
}, { auth: true });

/* 总部跨店库存总览 */
r('GET', /^\/api\/hq\/inventory\/overview$/, async (req, res) => {
  json(res, Inv.overview());
}, { auth: true, role: 'hq' });

/* 批次查询（门店仅本店；总部可按店/耗材/状态筛选） */
r('GET', /^\/api\/stock-batches$/, async (req, res, p, user) => {
  let list = db.stockBatches.slice();
  if (user.role === 'store') list = list.filter(b => b.storeId === user.storeId);
  else if (p.query.storeId) list = list.filter(b => b.storeId === p.query.storeId);
  if (p.query.materialId) list = list.filter(b => b.materialId === p.query.materialId);
  list = list.map(Inv.batchView);
  const f = p.query.filter;
  if (f === 'near') list = list.filter(b => b.nearExpire && b.available > 0);
  if (f === 'expired') list = list.filter(b => b.expired && b.quantity - b.frozen > 0);
  if (f === 'frozen') list = list.filter(b => b.frozen > 0);
  if (f === 'active') list = list.filter(b => !b.expired && b.available > 0);
  list.sort((a, b) => (a.expireDate || '9999').localeCompare(b.expireDate || '9999') || b.receivedAt.localeCompare(a.receivedAt));
  json(res, list.slice(0, 500));
}, { auth: true });

/* ---------------- 门店：批次入库 ---------------- */
r('GET', /^\/api\/stock-inbounds$/, async (req, res, p, user) => {
  let list = db.stockInbounds.slice();
  if (user.role === 'store') list = list.filter(x => x.storeId === user.storeId);
  else if (p.query.storeId) list = list.filter(x => x.storeId === p.query.storeId);
  json(res, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200).map(x => ({
    ...x, storeName: db.stores.find(s => s.id === x.storeId)?.name,
  })));
}, { auth: true });
r('POST', /^\/api\/stock-inbounds$/, async (req, res, p, user, m, body) => {
  const storeId = user.role === 'store' ? user.storeId : (body.storeId || null);
  if (!storeId) return fail(res, '请选择门店');
  if (!db.stores.find(s => s.id === storeId)) return fail(res, '门店不存在', 404);

  /* 幂等：重复提交入库（双击/超时重试）直接返回首单 */
  if (body.clientReqId) {
    const exist = db.stockInbounds.find(x => x.storeId === storeId && x.clientReqId === body.clientReqId);
    if (exist) return json(res, { ...exist, idempotent: true });
  }
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) return fail(res, '请至少填写一条入库明细');
  const supplier = String(body.supplier || '总部集采').trim();
  const receivedDate = body.receivedDate || todayStr();
  const now = nowLocal();

  /* 先做全部校验，全部通过才写数据（原子） */
  const parsed = [];
  for (const it of rawItems) {
    const mm = db.materials.find(x => x.id === it.materialId && x.active);
    if (!mm) return fail(res, `耗材不存在或已停用：${it.materialId || ''}`);
    const qty = Inv.r3(Number(it.qty));
    if (!(qty > 0)) return fail(res, `「${mm.name}」入库数量无效`);
    let expireDate = it.expireDate || null;
    if (expireDate && !/^\d{4}-\d{2}-\d{2}$/.test(expireDate)) return fail(res, `「${mm.name}」到期日格式无效`);
    parsed.push({ materialId: mm.id, qty, expireDate, productionDate: it.productionDate || null, supplier: it.supplier || supplier });
  }

  const inbId = nextId('inbound', 'IN', 6);
  const inbound = {
    id: inbId, storeId, supplier, items: [],
    operator: body.operator || user.name, receivedDate, createdAt: now,
    note: body.note || '', clientReqId: body.clientReqId || null,
  };
  parsed.forEach((it) => {
    const batchId = nextId('stockBatch', 'B', 7);
    const batch = {
      id: batchId, storeId, materialId: it.materialId,
      batchNo: `LOT${receivedDate.replace(/-/g, '')}${String(db.counters.stockBatch).slice(-3)}`,
      inboundId: inbId, quantity: it.qty, frozen: 0,
      productionDate: it.productionDate, expireDate: it.expireDate, receivedAt: now,
    };
    db.stockBatches.push(batch);
    inbound.items.push({ materialId: it.materialId, qty: it.qty, batchId, productionDate: it.productionDate, expireDate: it.expireDate, supplier: it.supplier });
    Inv.addLedger({
      storeId, materialId: it.materialId, batchId, type: 'inbound', qty: it.qty, change: it.qty,
      refType: 'inbound', refId: inbId, orderId: null,
      batchQtyAfter: it.qty, batchAvailAfter: it.qty,
      operator: inbound.operator, createdAt: now, note: `入库 · ${it.supplier}`,
    });
  });
  db.stockInbounds.push(inbound);
  save();
  json(res, inbound);
}, { auth: true });

/* ---------------- 门店：盘点 ---------------- */
r('GET', /^\/api\/stock-checks$/, async (req, res, p, user) => {
  let list = db.stockChecks.slice();
  if (user.role === 'store') list = list.filter(x => x.storeId === user.storeId);
  else if (p.query.storeId) list = list.filter(x => x.storeId === p.query.storeId);
  if (p.query.status) list = list.filter(x => x.status === p.query.status);
  json(res, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200).map(x => ({
    ...x, storeName: db.stores.find(s => s.id === x.storeId)?.name,
    diffCount: x.items.filter(i => Math.abs(i.diff) > 1e-9).length,
  })));
}, { auth: true });
r('GET', /^\/api\/stock-checks\/(\w+)$/, async (req, res, p, user, m) => {
  const ck = db.stockChecks.find(x => x.id === m[1]);
  if (!ck) return fail(res, '盘点单不存在', 404);
  if (user.role === 'store' && ck.storeId !== user.storeId) return fail(res, '无权查看该盘点单', 403);
  const items = ck.items.map(i => {
    const mm = db.materials.find(x => x.id === i.materialId);
    return { ...i, materialName: mm?.name, category: mm?.category, unit: mm?.unit };
  });
  json(res, { ...ck, storeName: db.stores.find(s => s.id === ck.storeId)?.name, items });
}, { auth: true });
/* 创建盘点单：服务端按当前账面生成快照（含冻结量），前端只回填实盘数 */
r('POST', /^\/api\/stock-checks$/, async (req, res, p, user, m, body) => {
  const storeId = user.role === 'store' ? user.storeId : (body.storeId || null);
  if (!storeId) return fail(res, '请选择门店');
  if (db.stockChecks.some(x => x.storeId === storeId && x.status === 'draft'))
    return fail(res, '该门店已有未提交的盘点单，请先完成或作废后再新建');
  const materialIds = (Array.isArray(body.materialIds) && body.materialIds.length)
    ? body.materialIds : db.materials.filter(x => x.active).map(x => x.id);
  const items = materialIds.map(mid => {
    const bs = db.stockBatches.filter(b => b.storeId === storeId && b.materialId === mid);
    const quantity = Inv.r3(bs.reduce((a, b) => a + b.quantity, 0));
    const frozen = Inv.r3(bs.reduce((a, b) => a + b.frozen, 0));
    return { materialId: mid, systemQty: quantity, actualQty: null, diff: 0, frozen };
  });
  const ck = {
    id: nextId('stockCheck', 'SC', 6), storeId, status: 'draft', items,
    operator: body.operator || user.name, createdAt: nowLocal(), confirmedAt: null, remark: body.remark || '',
  };
  db.stockChecks.push(ck); save(); json(res, ck);
}, { auth: true });
r('POST', /^\/api\/stock-checks\/(\w+)\/confirm$/, async (req, res, p, user, m, body) => {
  const ck = db.stockChecks.find(x => x.id === m[1]);
  if (!ck) return fail(res, '盘点单不存在', 404);
  if (user.role === 'store' && ck.storeId !== user.storeId) return fail(res, '无权操作该盘点单', 403);
  /* 幂等：重复确认直接返回已确认单据 */
  if (ck.status === 'confirmed') return json(res, { ...ck, idempotent: true });

  const actuals = new Map(Object.entries(body.actuals || {}));
  const now = nowLocal();
  /* 先全部解析并校验差异，任一项不合法整体不调整 */
  const adjustments = [];
  for (const item of ck.items) {
    if (!actuals.has(item.materialId)) return fail(res, '请填写全部耗材的实盘数量（无差异请与账面一致）');
    const actual = Inv.r3(Number(actuals.get(item.materialId)));
    if (!(actual >= 0)) return fail(res, '实盘数量无效');
    item.actualQty = actual;
    item.diff = Inv.r3(actual - item.systemQty);
    if (Math.abs(item.diff) > 1e-9) adjustments.push(item);
  }
  /* 盘亏不能超过非冻结可用量（冻结部分属于在途调拨，不属于可调出量） */
  for (const item of adjustments) {
    if (item.diff < 0) {
      const need = Inv.r3(-item.diff);
      const avail = Inv.fefoBatches(ck.storeId, item.materialId).reduce((a, b) => a + Inv.batchAvail(b), 0);
      if (avail + 1e-9 < need) {
        const mm = db.materials.find(x => x.id === item.materialId);
        return fail(res, `「${mm.name}」盘亏 ${need}${mm.unit}，但非冻结可用库存仅 ${avail}${mm.unit}（已冻结 ${item.frozen}${mm.unit}），请先核查在途调拨`, 409);
      }
    }
  }
  /* 全部通过后落账：盘亏按 FEFO 扣减可用批次，盘盈生成盘盈批次 */
  ck.remark = body.remark !== undefined ? String(body.remark) : ck.remark;
  for (const item of adjustments) {
    const mm = db.materials.find(x => x.id === item.materialId);
    if (item.diff > 0) {
      const batchId = nextId('stockBatch', 'B', 7);
      db.stockBatches.push({
        id: batchId, storeId: ck.storeId, materialId: item.materialId,
        batchNo: `PD${ck.id.slice(2)}`, inboundId: null, quantity: item.diff, frozen: 0,
        productionDate: null, expireDate: null, receivedAt: now,
      });
      Inv.addLedger({
        storeId: ck.storeId, materialId: item.materialId, batchId, type: 'check_in', qty: item.diff, change: item.diff,
        refType: 'check', refId: ck.id, orderId: null,
        batchQtyAfter: item.diff, batchAvailAfter: item.diff,
        operator: user.name, createdAt: now, note: `盘点盘盈 · ${ck.remark || ck.id}`,
      });
    } else {
      let remain = Inv.r3(-item.diff);
      for (const b of Inv.fefoBatches(ck.storeId, item.materialId)) {
        const take = Inv.r3(Math.min(Inv.batchAvail(b), remain));
        if (take <= 0) continue;
        b.quantity = Inv.r3(b.quantity - take);
        remain = Inv.r3(remain - take);
        Inv.addLedger({
          storeId: ck.storeId, materialId: item.materialId, batchId: b.id, type: 'check_out', qty: take, change: -take,
          refType: 'check', refId: ck.id, orderId: null,
          batchQtyAfter: b.quantity, batchAvailAfter: Inv.r3(b.quantity - b.frozen),
          operator: user.name, createdAt: now, note: `盘点盘亏 · ${ck.remark || ck.id}`,
        });
        if (remain <= 0) break;
      }
    }
  }
  ck.status = 'confirmed';
  ck.confirmedAt = now;
  ck.confirmedBy = user.name;
  save();
  json(res, ck);
}, { auth: true });
/* 作废未提交盘点单 */
r('DELETE', /^\/api\/stock-checks\/(\w+)$/, async (req, res, p, user, m) => {
  const ck = db.stockChecks.find(x => x.id === m[1]);
  if (!ck) return fail(res, '盘点单不存在', 404);
  if (user.role === 'store' && ck.storeId !== user.storeId) return fail(res, '无权操作该盘点单', 403);
  if (ck.status !== 'draft') return fail(res, '已确认的盘点单不能作废');
  db.stockChecks.splice(db.stockChecks.indexOf(ck), 1);
  save(); json(res, { ok: true });
}, { auth: true });

/* ---------------- 门店：跨店调拨 ---------------- */
r('GET', /^\/api\/stock-transfers$/, async (req, res, p, user) => {
  let list = db.stockTransfers.slice();
  if (user.role === 'store') {
    list = list.filter(t => t.fromStoreId === user.storeId || t.toStoreId === user.storeId);
    if (p.query.rel === 'in') list = list.filter(t => t.toStoreId === user.storeId);
    if (p.query.rel === 'out') list = list.filter(t => t.fromStoreId === user.storeId);
  } else if (p.query.storeId) {
    list = list.filter(t => t.fromStoreId === p.query.storeId || t.toStoreId === p.query.storeId);
  }
  if (p.query.status) list = list.filter(t => t.status === p.query.status);
  json(res, list.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 300).map(Inv.transferView));
}, { auth: true });
r('GET', /^\/api\/stock-transfers\/(\w+)$/, async (req, res, p, user, m) => {
  const t = db.stockTransfers.find(x => x.id === m[1]);
  if (!t) return fail(res, '调拨单不存在', 404);
  if (user.role === 'store' && t.fromStoreId !== user.storeId && t.toStoreId !== user.storeId)
    return fail(res, '无权查看该调拨单', 403);
  const ledgers = db.stockLedger.filter(l => l.refType === 'transfer' && l.refId === t.id).map(Inv.ledgerView);
  json(res, { ...Inv.transferView(t), ledgers });
}, { auth: true });
/* 发起调拨：direction=out 主动调出（必须指定批次）；direction=in 请货（确认时再按 FEFO 分配批次） */
r('POST', /^\/api\/stock-transfers$/, async (req, res, p, user, m, body) => {
  const direction = body.direction === 'in' ? 'in' : 'out';
  let fromStoreId, toStoreId;
  if (user.role === 'store') {
    fromStoreId = direction === 'out' ? user.storeId : (body.fromStoreId || null);
    toStoreId = direction === 'in' ? user.storeId : (body.toStoreId || null);
  } else {
    fromStoreId = body.fromStoreId; toStoreId = body.toStoreId;
  }
  if (!fromStoreId || !toStoreId) return fail(res, '请选择调入/调出门店');
  if (fromStoreId === toStoreId) return fail(res, '调入门店与调出门店不能相同');
  if (!db.stores.find(s => s.id === fromStoreId) || !db.stores.find(s => s.id === toStoreId)) return fail(res, '门店不存在');
  const mm = db.materials.find(x => x.id === body.materialId && x.active);
  if (!mm) return fail(res, '耗材不存在或已停用');
  const qty = Inv.r3(Number(body.qty));
  if (!(qty > 0)) return fail(res, '调拨数量无效');

  let batches = null;
  if (direction === 'out') {
    if (!Array.isArray(body.batches) || !body.batches.length) return fail(res, '主动调拨请指定调出批次');
    try { batches = Inv.resolveTransferBatches(fromStoreId, mm.id, qty, body.batches); }
    catch (e) { return fail(res, e.message, e.status || 400); }
  } else if (Array.isArray(body.batches) && body.batches.length) {
    try { batches = Inv.resolveTransferBatches(fromStoreId, mm.id, qty, body.batches); }
    catch (e) { return fail(res, e.message, e.status || 400); }
  }

  const t = {
    id: nextId('stockTransfer', 'ST', 6),
    transferNo: `DB${todayStr().replace(/-/g, '')}${String(db.counters.stockTransfer).padStart(4, '0')}`,
    fromStoreId, toStoreId, direction, materialId: mm.id, qty, unit: mm.unit,
    status: 'pending', batches,
    createdBy: user.name, createdAt: nowLocal(),
    confirmedAt: null, confirmedBy: null, receivedAt: null, receivedBy: null,
    rejectedAt: null, rejectedBy: null, rejectReason: null,
    canceledAt: null, canceledBy: null, cancelReason: null, note: body.note || '',
  };
  db.stockTransfers.push(t);
  save(); json(res, Inv.transferView(t));
}, { auth: true });
/* 调出店确认：冻结对应批次（请货单未指定批次时自动按 FEFO 分配） */
r('POST', /^\/api\/stock-transfers\/(\w+)\/confirm$/, async (req, res, p, user, m, body) => {
  const t = db.stockTransfers.find(x => x.id === m[1]);
  if (!t) return fail(res, '调拨单不存在', 404);
  if (user.role === 'store' && t.fromStoreId !== user.storeId) return fail(res, '仅调出店可确认调拨', 403);
  /* 幂等：重复确认直接返回当前单据 */
  if (t.status === 'frozen') return json(res, { ...Inv.transferView(t), idempotent: true });
  if (t.status !== 'pending') return fail(res, '当前状态不能确认调拨', 409);

  const batches = Array.isArray(body.batches) ? body.batches : null;
  if (!t.batches) {
    /* 请货单：确认时确定批次（前端可传入，否则自动 FEFO 分配） */
    if (batches && batches.length) {
      try { t.batches = Inv.resolveTransferBatches(t.fromStoreId, t.materialId, t.qty, batches); }
      catch (e) { return fail(res, e.message, e.status || 400); }
    } else {
      try { t.batches = Inv.autoAllocBatches(t.fromStoreId, t.materialId, t.qty); }
      catch (e) { return fail(res, e.message, e.status || 400); }
    }
  } else {
    /* 发起时已选批次：确认前再次校验可用量（可能期间已被其他调拨/耗用占用） */
    try { Inv.resolveTransferBatches(t.fromStoreId, t.materialId, t.qty, t.batches); }
    catch (e) { return fail(res, e.message, e.status || 400); }
  }
  t.status = 'frozen';
  t.confirmedAt = nowLocal();
  t.confirmedBy = user.name;
  Inv.freezeTransfer(t, user.name);
  save(); json(res, Inv.transferView(t));
}, { auth: true });
/* 调出店拒绝（仅 pending，尚未冻结，不涉及批次变动） */
r('POST', /^\/api\/stock-transfers\/(\w+)\/reject$/, async (req, res, p, user, m, body) => {
  const t = db.stockTransfers.find(x => x.id === m[1]);
  if (!t) return fail(res, '调拨单不存在', 404);
  if (user.role === 'store' && t.fromStoreId !== user.storeId) return fail(res, '仅调出店可拒绝调拨', 403);
  if (t.status === 'rejected') return json(res, { ...Inv.transferView(t), idempotent: true });
  if (t.status !== 'pending') return fail(res, '已冻结的调拨请使用「取消」，不能拒绝', 409);
  t.status = 'rejected';
  t.rejectedAt = nowLocal();
  t.rejectedBy = user.name;
  t.rejectReason = body.reason || '调出门店拒绝';
  save(); json(res, Inv.transferView(t));
}, { auth: true });
/* 取消：pending（未冻结）双方均可；frozen 后仅调入店可取消（需求取消时），冻结正确解冻 */
r('POST', /^\/api\/stock-transfers\/(\w+)\/cancel$/, async (req, res, p, user, m, body) => {
  const t = db.stockTransfers.find(x => x.id === m[1]);
  if (!t) return fail(res, '调拨单不存在', 404);
  if (user.role === 'store' && t.fromStoreId !== user.storeId && t.toStoreId !== user.storeId)
    return fail(res, '无权操作该调拨单', 403);
  if (['cancelled', 'rejected', 'received'].includes(t.status)) return json(res, { ...Inv.transferView(t), idempotent: true });
  if (t.status === 'frozen' && user.role === 'store' && user.storeId === t.fromStoreId)
    return fail(res, '已冻结待签收的调拨需由调入店取消', 403);
  const at = nowLocal();
  const wasFrozen = t.status === 'frozen';
  t.status = 'cancelled';
  t.canceledAt = at;
  t.canceledBy = user.name;
  t.cancelReason = body.reason || '取消调拨';
  if (wasFrozen) Inv.releaseTransfer(t, 'cancel', user.name, at, t.cancelReason);
  save(); json(res, Inv.transferView(t));
}, { auth: true });
/* 调入店签收：冻结量扣减 + 调入店新批次入库，完成扣增 */
r('POST', /^\/api\/stock-transfers\/(\w+)\/receive$/, async (req, res, p, user, m, body) => {
  const t = db.stockTransfers.find(x => x.id === m[1]);
  if (!t) return fail(res, '调拨单不存在', 404);
  if (user.role === 'store' && t.toStoreId !== user.storeId) return fail(res, '仅调入店可签收', 403);
  /* 幂等：重复签收直接返回已完成单据 */
  if (t.status === 'received') return json(res, { ...Inv.transferView(t), idempotent: true });
  if (t.status !== 'frozen') return fail(res, '调拨尚未冻结，不能签收', 409);

  const now = nowLocal();
  /* 先校验所有冻结批次数量仍然匹配 */
  for (const a of t.batches) {
    const b = db.stockBatches.find(x => x.id === a.batchId);
    if (!b || b.storeId !== t.fromStoreId) return fail(res, '调出批次状态异常', 500);
    if (b.frozen + 1e-9 < a.qty) return fail(res, `批次 ${b.batchNo} 冻结量异常，请联系总部核查`, 409);
  }
  /* 扣减调出店（同时解冻），再给调入店生成新批次（沿用最早到期日，继续遵守临期优先） */
  let total = 0, earliestExpire = null;
  for (const a of t.batches) {
    const b = db.stockBatches.find(x => x.id === a.batchId);
    b.frozen = Inv.r3(b.frozen - a.qty);
    b.quantity = Inv.r3(b.quantity - a.qty);
    total = Inv.r3(total + a.qty);
    if (b.expireDate && (!earliestExpire || b.expireDate < earliestExpire)) earliestExpire = b.expireDate;
    Inv.addLedger({
      storeId: t.fromStoreId, materialId: t.materialId, batchId: b.id, type: 'transfer_out', qty: a.qty, change: -a.qty,
      refType: 'transfer', refId: t.id, orderId: null,
      batchQtyAfter: b.quantity, batchAvailAfter: Inv.r3(b.quantity - b.frozen),
      operator: user.name, createdAt: now, note: `调出至 ${db.stores.find(s => s.id === t.toStoreId).name}`,
    });
  }
  const newBatchId = nextId('stockBatch', 'B', 7);
  db.stockBatches.push({
    id: newBatchId, storeId: t.toStoreId, materialId: t.materialId,
    batchNo: `DB${t.id.slice(2)}`, inboundId: null, quantity: total, frozen: 0,
    productionDate: null, expireDate: earliestExpire, receivedAt: now,
  });
  Inv.addLedger({
    storeId: t.toStoreId, materialId: t.materialId, batchId: newBatchId, type: 'transfer_in', qty: total, change: total,
    refType: 'transfer', refId: t.id, orderId: null,
    batchQtyAfter: total, batchAvailAfter: total,
    operator: user.name, createdAt: now, note: `由 ${db.stores.find(s => s.id === t.fromStoreId).name} 调入${body.remark ? ' · ' + body.remark : ''}`,
  });
  t.status = 'received';
  t.receivedAt = now;
  t.receivedBy = user.name;
  save(); json(res, Inv.transferView(t));
}, { auth: true });

/* ---------------- 出入库流水（门店仅本店；总部全量可筛选） ---------------- */
r('GET', /^\/api\/stock-ledger$/, async (req, res, p, user) => {
  let list = db.stockLedger.slice();
  if (user.role === 'store') list = list.filter(l => l.storeId === user.storeId);
  else if (p.query.storeId) list = list.filter(l => l.storeId === p.query.storeId);
  if (p.query.materialId) list = list.filter(l => l.materialId === p.query.materialId);
  if (p.query.batchId) list = list.filter(l => l.batchId === p.query.batchId);
  if (p.query.type) {
    const types = String(p.query.type).split(',');
    list = list.filter(l => types.includes(l.type));
  }
  if (p.query.refType) list = list.filter(l => l.refType === p.query.refType);
  if (p.query.from) list = list.filter(l => l.createdAt.slice(0, 10) >= p.query.from);
  if (p.query.to) list = list.filter(l => l.createdAt.slice(0, 10) <= p.query.to);
  if (p.query.q) { const q = String(p.query.q).trim(); list = list.filter(l => (l.note || '').includes(q) || (l.refId || '').toUpperCase().includes(q.toUpperCase())); }
  list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const limit = Math.min(500, Number(p.query.limit) || 300);
  json(res, list.slice(0, limit).map(l => ({ ...Inv.ledgerView(l), typeName: Inv.ledgerTypeName(l.type) })));
}, { auth: true });

/* ---------------- 静态文件 ---------------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1).split('?')[0]);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) {
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('Not Found'); }
        else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(idx); }
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------------- 服务入口 ---------------- */
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const route = routes.find(x => x.method === req.method && x.pattern.test(pathname));
      if (!route) return fail(res, '接口不存在', 404);
      let user = null;
      if (route.auth) {
        user = requireAuth(req, res);
        if (!user) return;
        if (route.role === 'hq' && user.role !== 'hq') return fail(res, '仅总部账号可操作', 403);
      }
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
      const m = pathname.match(route.pattern);
      await route.handler(req, res, { query: parsed.query }, user, m, body);
    } else {
      serveStatic(req, res, pathname);
    }
  } catch (e) {
    console.error(e);
    fail(res, '服务器内部错误：' + e.message, 500);
  }
});

server.listen(PORT, () => {
  console.log(`悦足堂管理平台已启动: http://localhost:${PORT}`);
  console.log('总部账号 hq / 123456 ，门店账号 s01 / 123456');
});
