/**
 * 悦足堂 · 耗材库存领域逻辑（零依赖，全部同步执行）
 * Node 单线程下：读 -> 全量校验 -> 一次性变更 -> 落库，中途无 await，保证业务原子性。
 */
const { save, nowLocal, fmtDate } = require('./db');

const NEAR_EXPIRE_DAYS = 30; // 临期阈值

class ApiError extends Error {
  constructor(msg, code = 400) { super(msg); this.code = code; }
}

/* 数量统一保留 3 位小数后去尾零，避免 0.1+0.2 浮点问题 */
function roundQty(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}
function addDate(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return fmtDate(d);
}
function daysBetween(todayStr, dateStr) {
  const a = new Date(dateStr + 'T00:00:00').getTime();
  const b = new Date(todayStr + 'T00:00:00').getTime();
  return Math.round((a - b) / 864e5);
}

/* ---------------- 基础视图 ---------------- */
function unitMap(db) { return Object.fromEntries(db.units.map(u => [u.id, u])); }
function materialMap(db) { return Object.fromEntries(db.materials.map(m => [m.id, m])); }

function materialView(db, m, today) {
  const u = db.units.find(x => x.id === m.unitId);
  const recipes = db.recipes.filter(r => r.items.some(it => it.materialId === m.id))
    .map(r => ({ serviceId: r.serviceId, serviceName: db.services.find(v => v.id === r.serviceId)?.name || r.serviceId }));
  const batches = db.invBatches.filter(b => b.materialId === m.id);
  const usable = today ? batches.filter(b => b.expireDate >= today) : batches;
  return {
    ...m,
    unitName: u?.name || '',
    recipeCount: recipes.length,
    recipeServices: recipes,
    totalQty: roundQty(usable.reduce((a, b) => a + (b.remainingQty - b.frozenQty), 0)),
    totalFrozen: roundQty(batches.reduce((a, b) => a + b.frozenQty, 0)),
  };
}

function batchView(db, b, today) {
  const m = db.materials.find(x => x.id === b.materialId);
  const u = db.units.find(x => x.id === m?.unitId);
  const days = daysBetween(today, b.expireDate);
  return {
    ...b,
    materialName: m?.name || b.materialId,
    unitName: u?.name || '',
    availableQty: roundQty(b.remainingQty - b.frozenQty),
    daysToExpire: days,
    expired: days < 0,
    nearExpire: days >= 0 && days <= NEAR_EXPIRE_DAYS,
  };
}

function ledgerView(db, x) {
  const m = db.materials.find(a => a.id === x.materialId);
  const u = db.units.find(a => a.id === m?.unitId);
  return {
    ...x,
    materialName: m?.name || x.materialId,
    unitName: u?.name || '',
    storeName: db.stores.find(s => s.id === x.storeId)?.name || x.storeId,
    typeName: LEDGER_TYPE[x.type]?.name || x.type,
    directionName: x.direction === 'in' ? '入库+' : x.direction === 'out' ? '出库-' : '调拨中',
  };
}

const LEDGER_TYPE = {
  stockin: { name: '采购入库' },
  order: { name: '开单耗用' },
  checkGain: { name: '盘盈入库' },
  checkLoss: { name: '盘亏出库' },
  transferFreeze: { name: '调拨冻结' },
  transferUnfreeze: { name: '解冻返还' },
  transferOut: { name: '调拨调出' },
  transferIn: { name: '调拨签收入库' },
};

/* ---------------- 聚合：门店工作台 / 总部总览 ---------------- */
/* 可用量口径：批次现存 − 冻结，且已过期批次不计入可用（FEFO 也不会选它们） */
function stockSummary(db, today) {
  const map = {}; // storeId#materialId -> {available, frozen}
  for (const b of db.invBatches) {
    const k = b.storeId + '#' + b.materialId;
    (map[k] ||= { available: 0, frozen: 0 });
    map[k].frozen = roundQty(map[k].frozen + b.frozenQty);
    if (b.expireDate >= today) map[k].available = roundQty(map[k].available + b.remainingQty - b.frozenQty);
  }
  return map;
}

function storeWorkbench(db, storeId, today) {
  const batches = db.invBatches.filter(b => b.storeId === storeId).map(b => batchView(db, b, today));
  const sum = stockSummary(db, today);
  const stock = db.materials.filter(m => m.active).map(m => {
    const row = sum[storeId + '#' + m.id] || { available: 0, frozen: 0 };
    return {
      materialId: m.id, name: m.name, unitName: (db.units.find(u => u.id === m.unitId) || {}).name || '',
      safetyStock: m.safetyStock,
      availableQty: row.available, frozenQty: row.frozen,
      low: row.available < m.safetyStock,
    };
  });
  const lowAlerts = stock.filter(x => x.low);
  const expiring = batches.filter(b => b.nearExpire || b.expired);
  const draft = db.invChecks.find(c => c.storeId === storeId && c.status === 'draft') || null;
  const transfers = db.invTransfers
    .filter(t => t.fromStoreId === storeId || t.toStoreId === storeId)
    .slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20)
    .map(t => transferView(db, t, storeId));
  return {
    today,
    kpi: {
      materialTypes: stock.length,
      lowCount: lowAlerts.length,
      nearExpireCount: expiring.length,
      pendingTransferCount: db.invTransfers.filter(t =>
        (t.status === 'requested' && t.fromStoreId === storeId) ||
        (t.status === 'frozen' && t.toStoreId === storeId)).length,
      draftCheck: draft ? { id: draft.id, itemCount: draft.items.filter(i => i.actualQty != null).length } : null,
    },
    stock, lowAlerts, expiring, draft, transfers,
  };
}

function hqOverview(db, today, storeId) {
  const sum = stockSummary(db, today);
  const rows = [];
  const stores = storeId ? db.stores.filter(s => s.id === storeId) : db.stores;
  for (const s of stores) {
    for (const m of db.materials.filter(x => x.active)) {
      const row = sum[s.id + '#' + m.id] || { available: 0, frozen: 0 };
      rows.push({
        storeId: s.id, storeName: s.name, city: s.city,
        materialId: m.id, materialName: m.name, unitName: unitMap(db)[m.unitId]?.name || '',
        safetyStock: m.safetyStock, availableQty: row.available, frozenQty: row.frozen,
        low: row.available < m.safetyStock,
      });
    }
  }
  const lowAlerts = rows.filter(r => r.low).sort((a, b) => a.availableQty / Math.max(a.safetyStock, 1) - b.availableQty / Math.max(b.safetyStock, 1));
  const expiring = db.invBatches
    .filter(b => (!storeId || b.storeId === storeId))
    .map(b => batchView(db, b, today))
    .filter(b => b.nearExpire || b.expired)
    .sort((a, b) => a.daysToExpire - b.daysToExpire);
  const storeTotals = db.stores.map(s => ({
    storeId: s.id, storeName: s.name, city: s.city,
    lowCount: rows.filter(r => r.storeId === s.id && r.low).length,
    nearExpireCount: expiring.filter(b => b.storeId === s.id).length,
    materialCount: rows.filter(r => r.storeId === s.id && r.availableQty > 0).length,
    pendingTransfer: db.invTransfers.filter(t => (t.fromStoreId === s.id && t.status === 'requested') || (t.toStoreId === s.id && t.status === 'frozen')).length,
  }));
  return {
    today, nearExpireDays: NEAR_EXPIRE_DAYS,
    kpi: {
      storeCount: stores.length,
      materialTypes: db.materials.filter(m => m.active).length,
      lowItemCount: lowAlerts.length,
      nearExpireCount: expiring.length,
      frozenCount: db.invBatches.reduce((a, b) => a + (b.frozenQty > 0 ? 1 : 0), 0),
    },
    storeTotals, lowAlerts, expiring, stock: rows,
  };
}

/* ---------------- 流水 ---------------- */
function queryLedger(db, { storeId, materialId, type, from, to, limit = 300 }) {
  let list = db.invLedger.slice();
  if (storeId) list = list.filter(x => x.storeId === storeId);
  if (materialId) list = list.filter(x => x.materialId === materialId);
  if (type) list = list.filter(x => x.type === type);
  if (from) list = list.filter(x => x.ts.slice(0, 10) >= from);
  if (to) list = list.filter(x => x.ts.slice(0, 10) <= to);
  return list.sort((a, b) => b.ts.localeCompare(a.ts) || b.id.localeCompare(a.id))
    .slice(0, Math.min(Number(limit) || 300, 1000))
    .map(x => ledgerView(db, x));
}

function addLedger(db, o) {
  const row = {
    id: nextSeqId(db, 'ledger', 'L', 6), ts: nowLocal(),
    direction: o.direction, type: o.type, qty: roundQty(o.qty),
    storeId: o.storeId, materialId: o.materialId,
    batchId: o.batchId || null, refType: o.refType || null, refId: o.refId || null, refNo: o.refNo || null,
    operator: o.operator || '', remark: o.remark || '',
  };
  db.invLedger.push(row);
  return row;
}

/* 计数器：沿用 db.counters，不依赖 server/index.js 的 nextId（库存模块自包含） */
function nextSeqId(db, key, prefix, len = 4) {
  db.counters[key] = (db.counters[key] || 0) + 1;
  return `${prefix}${String(db.counters[key]).padStart(len, '0')}`;
}

/* ---------------- 入库（按批次，支持多明细一次原子提交） ---------------- */
function stockIn(db, storeId, operator, body) {
  const today = fmtDate(new Date());
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new ApiError('请至少填写一条入库明细');
  const batches = [];
  const ledgers = [];
  // 先全量校验，任何一条不合法整单失败
  const parsed = items.map((it, i) => {
    const m = db.materials.find(x => x.id === it.materialId);
    if (!m || !m.active) throw new ApiError(`第 ${i + 1} 行耗材不存在或已停用`);
    const qty = Number(it.qty);
    if (!(qty > 0)) throw new ApiError(`「${m.name}」入库数量必须大于 0`);
    if (!it.expireDate) throw new ApiError(`「${m.name}」请填写有效期`);
    if (daysBetween(today, it.expireDate) < 0) throw new ApiError(`「${m.name}」有效期已过期，不能入库`);
    const cost = Number(it.unitCost);
    return { m, qty: roundQty(qty), expireDate: it.expireDate, producedDate: it.producedDate || '', cost: Number.isFinite(cost) && cost > 0 ? cost : 0 };
  });
  parsed.forEach(({ m, qty, expireDate, producedDate, cost }) => {
    const batch = {
      id: nextSeqId(db, 'batch', 'B', 6), storeId, materialId: m.id,
      batchNo: (body.batchNoPrefix || 'LOT') + today.replace(/-/g, '') + String(db.counters.batch).slice(-4),
      qty, remainingQty: qty, frozenQty: 0,
      unitCost: cost, supplier: body.supplier || '', producedDate, expireDate,
      sourceType: 'stockin', sourceRef: null,
      receivedAt: nowLocal(), createdBy: operator, remark: body.remark || '',
    };
    db.invBatches.push(batch);
    batches.push(batchView(db, batch, today));
    ledgers.push(ledgerView(db, addLedger(db, {
      storeId, materialId: m.id, batchId: batch.id, direction: 'in', type: 'stockin',
      qty, refType: 'stockin', refId: batch.id, refNo: batch.batchNo,
      operator, remark: body.remark || '采购入库',
    }), today));
  });
  save();
  return { batches, ledgers };
}

/* ---------------- 盘点 ---------------- */
function createCheck(db, storeId, operator) {
  if (db.invChecks.some(c => c.storeId === storeId && c.status === 'draft'))
    throw new ApiError('已有进行中的盘点单，请先完成或取消');
  const today = fmtDate(new Date());
  const items = db.materials.filter(m => m.active).map(m => {
    const qty = roundQty(db.invBatches
      .filter(b => b.storeId === storeId && b.materialId === m.id)
      .reduce((a, b) => a + b.remainingQty - b.frozenQty, 0));
    return { materialId: m.id, systemQty: qty, actualQty: null };
  });
  const check = {
    id: nextSeqId(db, 'check', 'IC', 5), storeId, status: 'draft',
    items, createdAt: nowLocal(), createdBy: operator,
    confirmedAt: null, confirmedBy: null, remark: '',
  };
  db.invChecks.push(check);
  save();
  return checkView(db, check);
}

function getCheck(db, storeId, id) {
  const c = db.invChecks.find(x => x.id === id);
  if (!c) throw new ApiError('盘点单不存在', 404);
  if (c.storeId !== storeId) throw new ApiError('无权操作该盘点单', 403);
  return c;
}

function updateCheck(db, storeId, body, id) {
  const c = getCheck(db, storeId, id);
  if (c.status !== 'draft') throw new ApiError('该盘点单已完成，不能修改');
  for (const row of body.items || []) {
    const it = c.items.find(x => x.materialId === row.materialId);
    if (!it) continue;
    if (row.actualQty === null || row.actualQty === '') { it.actualQty = null; continue; }
    const v = Number(row.actualQty);
    if (!(v >= 0)) throw new ApiError('实盘数量不能为负');
    it.actualQty = roundQty(v);
  }
  save();
  return checkView(db, c);
}

function cancelCheck(db, storeId, id) {
  const c = getCheck(db, storeId, id);
  if (c.status !== 'draft') throw new ApiError('该盘点单已完成，不能取消');
  c.status = 'cancelled'; save();
  return { ok: true };
}

function confirmCheck(db, storeId, operator, id, body) {
  const c = getCheck(db, storeId, id);
  if (c.status !== 'draft') throw new ApiError('该盘点单已完成，不能重复提交');
  // 允许确认时一次性带齐实盘数
  if (Array.isArray(body?.items)) updateCheckData(c, body.items);
  if (c.items.some(i => i.actualQty == null)) throw new ApiError('仍有耗材未填写实盘数量');
  const today = fmtDate(new Date());
  // 以当前可用量（不含冻结）为基准重算差异
  for (const it of c.items) {
    const cur = roundQty(db.invBatches
      .filter(b => b.storeId === storeId && b.materialId === it.materialId)
      .reduce((a, b) => a + b.remainingQty - b.frozenQty, 0));
    it.systemQty = cur;
  }
  // 全量校验：盘亏数量必须 <= 当前可用量（冻结量不动）
  const losses = c.items.filter(i => i.actualQty < i.systemQty)
    .map(i => ({ m: db.materials.find(x => x.id === i.materialId), diff: roundQty(i.systemQty - i.actualQty), it: i }));
  const gains = c.items.filter(i => i.actualQty > i.systemQty)
    .map(i => ({ m: db.materials.find(x => x.id === i.materialId), diff: roundQty(i.actualQty - i.systemQty), it }));
  // 预演盘亏扣减（FEFO），不够直接整单失败
  const plan = [];
  for (const { m, diff } of losses) {
    let need = diff;
    const picks = pickFefo(db, storeId, m.id, today);
    for (const b of picks) {
      if (need <= 0) break;
      const take = roundQty(Math.min(b.batch.remainingQty - b.batch.frozenQty, need));
      if (take > 0) { plan.push({ batch: b.batch, take }); need = roundQty(need - take); }
    }
    if (need > 0) throw new ApiError(`「${m.name}」盘亏 ${diff} 超过当前可用库存，盘点失败`);
  }
  // 校验通过，统一落账
  const ledgers = [];
  for (const { batch, take } of plan) {
    batch.remainingQty = roundQty(batch.remainingQty - take);
    ledgers.push(addLedger(db, {
      storeId, materialId: batch.materialId, batchId: batch.id,
      direction: 'out', type: 'checkLoss', qty: take,
      refType: 'check', refId: c.id, refNo: c.id, operator, remark: '盘点盘亏调整',
    }));
  }
  for (const { m, diff } of gains) {
    const batch = {
      id: nextSeqId(db, 'batch', 'B', 6), storeId, materialId: m.id,
      batchNo: `GAIN${c.id.replace(/\D/g, '')}${String(db.counters.batch).slice(-4)}`,
      qty: diff, remainingQty: diff, frozenQty: 0, unitCost: 0,
      supplier: '', producedDate: '', expireDate: '9999-12-31',
      sourceType: 'checkGain', sourceRef: c.id,
      receivedAt: nowLocal(), createdBy: operator, remark: '盘点盘盈入库',
    };
    db.invBatches.push(batch);
    ledgers.push(addLedger(db, {
      storeId, materialId: m.id, batchId: batch.id,
      direction: 'in', type: 'checkGain', qty: diff,
      refType: 'check', refId: c.id, refNo: c.id, operator, remark: '盘点盘盈调整',
    }));
  }
  c.status = 'confirmed'; c.confirmedAt = nowLocal(); c.confirmedBy = operator; c.remark = body?.remark || '';
  save();
  return { check: checkView(db, c), ledgers: ledgers.map(x => ledgerView(db, x)) };
}

function updateCheckData(c, rows) {
  for (const row of rows || []) {
    const it = c.items.find(x => x.materialId === row.materialId);
    if (!it) continue;
    if (row.actualQty === null || row.actualQty === '') { it.actualQty = null; continue; }
    const v = Number(row.actualQty);
    if (!(v >= 0)) throw new ApiError('实盘数量不能为负');
    it.actualQty = roundQty(v);
  }
}

function checkView(db, c) {
  return {
    ...c,
    items: c.items.map(i => {
      const m = db.materials.find(x => x.id === i.materialId);
      const u = db.units.find(x => x.id === m?.unitId);
      const diff = i.actualQty == null ? null : roundQty(i.actualQty - i.systemQty);
      return { ...i, name: m?.name, unitName: u?.name || '', diff };
    }),
  };
}

/* ---------------- 调拨 ---------------- */
const TRANSFER_STATUS = {
  requested: '待调出店确认',
  frozen: '已冻结·待调入店签收',
  done: '已完成',
  cancelled: '已取消',
  rejected: '已拒绝',
};

function transferView(db, t, viewerStoreId) {
  const myRole = viewerStoreId ? (t.fromStoreId === viewerStoreId ? 'from' : t.toStoreId === viewerStoreId ? 'to' : null) : null;
  return {
    ...t,
    fromStoreName: db.stores.find(s => s.id === t.fromStoreId)?.name || t.fromStoreId,
    toStoreName: db.stores.find(s => s.id === t.toStoreId)?.name || t.toStoreId,
    statusName: TRANSFER_STATUS[t.status] || t.status,
    myRole,
    items: t.items.map(it => {
      const m = db.materials.find(x => x.id === it.materialId);
      const u = db.units.find(x => x.id === m?.unitId);
      return { ...it, name: m?.name, unitName: u?.name || '', allocated: (it.allocations || []).map(a => ({
        batchId: a.batchId,
        batchNo: db.invBatches.find(b => b.id === a.batchId)?.batchNo || a.batchId,
        qty: a.qty,
      })) };
    }),
  };
}

function createTransfer(db, storeId, operator, body) {
  const toStoreId = body.toStoreId;
  const target = db.stores.find(s => s.id === toStoreId);
  if (!target) throw new ApiError('调入门店不存在');
  if (target.id === storeId) throw new ApiError('调入门店不能与调出门店相同');
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw new ApiError('请至少填写一条调拨明细');
  const today = fmtDate(new Date());
  // 创建时预校验可用库存（确认时还会再校验一次）
  const tItems = items.map((it, i) => {
    const m = db.materials.find(x => x.id === it.materialId && x.active);
    if (!m) throw new ApiError(`第 ${i + 1} 行耗材不存在或已停用`);
    const qty = roundQty(Number(it.qty));
    if (!(qty > 0)) throw new ApiError(`「${m.name}」调拨数量必须大于 0`);
    const avail = roundQty(db.invBatches
      .filter(b => b.storeId === storeId && b.materialId === m.id)
      .reduce((a, b) => a + b.remainingQty - b.frozenQty, 0));
    if (avail < qty) throw new ApiError(`「${m.name}」可用库存不足（可用 ${avail}，申请调拨 ${qty}）`);
    return { materialId: m.id, qty, allocations: [] };
  });
  const t = {
    id: nextSeqId(db, 'itransfer', 'IT', 5),
    fromStoreId: storeId, toStoreId,
    status: 'requested',
    items: tItems, remark: body.remark || '',
    createdAt: nowLocal(), createdBy: operator,
    confirmedAt: null, confirmedBy: null,
    receivedAt: null, receivedBy: null,
    finishedAt: null, rejectReason: '',
  };
  db.invTransfers.push(t);
  save();
  return transferView(db, t, storeId);
}

function getTransfer(db, id) {
  const t = db.invTransfers.find(x => x.id === id);
  if (!t) throw new ApiError('调拨单不存在', 404);
  return t;
}

/* 调出店确认：按 FEFO 冻结，幂等（已冻结/完成直接返回现状） */
function confirmTransfer(db, storeId, operator, id) {
  const t = getTransfer(db, id);
  if (t.fromStoreId !== storeId) throw new ApiError('只有调出店可以确认调拨', 403);
  if (t.status === 'frozen' || t.status === 'done') return { idempotent: true, transfer: transferView(db, t, storeId) };
  if (t.status !== 'requested') throw new ApiError(`当前状态「${TRANSFER_STATUS[t.status]}」不能确认`);
  const today = fmtDate(new Date());
  // 预演冻结，任一明细不足则整单失败（不做任何变更）
  const plan = [];
  for (const it of t.items) {
    const m = db.materials.find(x => x.id === it.materialId);
    let need = it.qty;
    const picks = pickFefo(db, storeId, it.materialId, today);
    const alloc = [];
    for (const b of picks) {
      if (need <= 0) break;
      const free = roundQty(b.batch.remainingQty - b.batch.frozenQty);
      const take = roundQty(Math.min(free, need));
      if (take > 0) { alloc.push({ batch: b.batch, take }); need = roundQty(need - take); }
    }
    if (need > 0) throw new ApiError(`「${m?.name || it.materialId}」可用库存不足（缺 ${need}），无法冻结`);
    plan.push({ it, alloc });
  }
  // 统一落账
  const ledgers = [];
  for (const { it, alloc } of plan) {
    it.allocations = alloc.map(({ batch, take }) => {
      batch.frozenQty = roundQty(batch.frozenQty + take);
      ledgers.push(addLedger(db, {
        storeId, materialId: it.materialId, batchId: batch.id,
        direction: 'hold', type: 'transferFreeze', qty: take,
        refType: 'transfer', refId: t.id, refNo: t.id, operator, remark: `调拨至${db.stores.find(s => s.id === t.toStoreId)?.name}`,
      }));
      return { batchId: batch.id, qty: take };
    });
  }
  t.status = 'frozen'; t.confirmedAt = nowLocal(); t.confirmedBy = operator;
  save();
  return { transfer: transferView(db, t, storeId), ledgers: ledgers.map(x => ledgerView(db, x)) };
}

/* 取消（调出门店，requested 阶段）：无需解冻 */
function cancelTransfer(db, storeId, operator, id, body) {
  const t = getTransfer(db, id);
  if (t.fromStoreId !== storeId && t.toStoreId !== storeId) throw new ApiError('无权操作该调拨单', 403);
  if (t.status === 'cancelled' || t.status === 'rejected' || t.status === 'done')
    return { idempotent: true, transfer: transferView(db, t, storeId) };
  if (t.status === 'frozen') throw new ApiError('已冻结的调拨单不能取消，请拒绝签收或联系调入店拒收');
  if (t.status !== 'requested') throw new ApiError('当前状态不能取消');
  t.status = 'cancelled'; t.finishedAt = nowLocal(); t.rejectReason = body?.reason ? `${operator}取消：${body.reason}` : `${operator}取消`;
  save();
  return { transfer: transferView(db, t, storeId) };
}

/* 调出店拒绝/撤回（frozen 阶段拒绝则解冻）——这里的拒绝指调出店在调入店拒收前的操作 */
function rejectTransfer(db, storeId, operator, id, body) {
  const t = getTransfer(db, id);
  if (t.fromStoreId !== storeId) throw new ApiError('只有调出店可以拒绝并解冻', 403);
  if (t.status === 'rejected') return { idempotent: true, transfer: transferView(db, t, storeId) };
  if (t.status !== 'frozen' && t.status !== 'requested') throw new ApiError('当前状态不能拒绝');
  unfreezeTransfer(db, t, operator, 'reject', body?.reason || '调出店拒绝');
  t.status = 'rejected'; t.finishedAt = nowLocal();
  t.rejectReason = body?.reason || '调出店拒绝调拨';
  save();
  return { transfer: transferView(db, t, storeId) };
}

/* 调入店拒收：解冻 */
function refuseTransfer(db, storeId, operator, id, body) {
  const t = getTransfer(db, id);
  if (t.toStoreId !== storeId) throw new ApiError('只有调入店可以拒收', 403);
  if (t.status === 'rejected' || t.status === 'cancelled') return { idempotent: true, transfer: transferView(db, t, storeId) };
  if (t.status !== 'frozen') throw new ApiError('当前状态不能拒收');
  unfreezeTransfer(db, t, operator, 'refuse', body?.reason || '调入店拒收');
  t.status = 'rejected'; t.finishedAt = nowLocal();
  t.rejectReason = body?.reason ? `调入店拒收：${body.reason}` : '调入店拒收';
  save();
  return { transfer: transferView(db, t, storeId) };
}

function unfreezeTransfer(db, t, operator, _kind, reason) {
  const ledgers = [];
  for (const it of t.items) {
    for (const a of it.allocations || []) {
      const batch = db.invBatches.find(b => b.id === a.batchId);
      if (!batch) continue;
      batch.frozenQty = roundQty(Math.max(0, batch.frozenQty - a.qty));
      ledgers.push(addLedger(db, {
        storeId: t.fromStoreId, materialId: it.materialId, batchId: batch.id,
        direction: 'release', type: 'transferUnfreeze', qty: a.qty,
        refType: 'transfer', refId: t.id, refNo: t.id, operator, remark: reason,
      }));
    }
    it.allocations = [];
  }
  return ledgers;
}

/* 调入店签收：幂等；扣减调出批次、按批次入库到调入店 */
function receiveTransfer(db, storeId, operator, id, body = {}) {
  const t = getTransfer(db, id);
  if (t.toStoreId !== storeId) throw new ApiError('只有调入店可以签收', 403);
  if (t.status === 'done') return { idempotent: true, transfer: transferView(db, t, storeId) };
  if (t.status !== 'frozen') throw new ApiError('调拨单尚未冻结，不能签收');
  const today = fmtDate(new Date());
  // 校验冻结量仍与明细一致
  for (const it of t.items) {
    const frozen = roundQty((it.allocations || []).reduce((a, x) => {
      const b = db.invBatches.find(z => z.id === x.batchId);
      return a + (b ? Math.min(x.qty, b.frozenQty) : 0);
    }, 0));
    if (roundQty(frozen) !== roundQty(it.qty)) throw new ApiError('冻结数据异常，请联系总部核查');
  }
  const ledgers = [];
  const inBatches = [];
  for (const it of t.items) {
    const m = db.materials.find(x => x.id === it.materialId);
    const merge = body.mergeBatchId ? db.invBatches.find(b => b.id === body.mergeBatchId && b.storeId === storeId && b.materialId === it.materialId) : null;
    // 默认：原批次在调入店各生成一个签收批次（保留生产/有效期，FEFO 延续）
    const targetBySource = {};
    for (const a of it.allocations || []) {
      const src = db.invBatches.find(b => b.id === a.batchId);
      if (!src) continue;
      // 调出店：冻结量与余量同时扣减
      src.remainingQty = roundQty(src.remainingQty - a.qty);
      src.frozenQty = roundQty(src.frozenQty - a.qty);
      ledgers.push(addLedger(db, {
        storeId: t.fromStoreId, materialId: it.materialId, batchId: src.id,
        direction: 'out', type: 'transferOut', qty: a.qty,
        refType: 'transfer', refId: t.id, refNo: t.id, operator, remark: `调出至${db.stores.find(s => s.id === t.toStoreId)?.name}`,
      }));
      let nb;
      if (merge) {
        nb = merge;
        nb.qty = roundQty(nb.qty + a.qty); nb.remainingQty = roundQty(nb.remainingQty + a.qty);
      } else {
        if (!targetBySource[src.id]) {
          nb = {
            id: nextSeqId(db, 'batch', 'B', 6), storeId, materialId: it.materialId,
            batchNo: `IN${t.id.replace(/\D/g, '')}${String(db.counters.batch).slice(-4)}`,
            qty: 0, remainingQty: 0, frozenQty: 0,
            unitCost: src.unitCost, supplier: src.supplier,
            producedDate: src.producedDate, expireDate: src.expireDate,
            sourceType: 'transfer', sourceRef: t.id,
            receivedAt: nowLocal(), createdBy: operator, remark: `调自${db.stores.find(s => s.id === t.fromStoreId)?.name}（原批 ${src.batchNo}）`,
          };
          db.invBatches.push(nb);
          targetBySource[src.id] = nb;
        } else nb = targetBySource[src.id];
        nb.qty = roundQty(nb.qty + a.qty); nb.remainingQty = roundQty(nb.remainingQty + a.qty);
      }
      ledgers.push(addLedger(db, {
        storeId, materialId: it.materialId, batchId: nb.id,
        direction: 'in', type: 'transferIn', qty: a.qty,
        refType: 'transfer', refId: t.id, refNo: t.id, operator,
        remark: `调自${db.stores.find(s => s.id === t.fromStoreId)?.name}`,
      }));
      inBatches.push(batchView(db, nb, today));
    }
  }
  t.status = 'done'; t.receivedAt = nowLocal(); t.receivedBy = operator; t.finishedAt = t.receivedAt;
  save();
  return { transfer: transferView(db, t, storeId), inBatches, ledgers: ledgers.map(x => ledgerView(db, x)) };
}

function listTransfers(db, storeId, status) {
  let list = db.invTransfers.slice();
  if (storeId) list = list.filter(t => t.fromStoreId === storeId || t.toStoreId === storeId);
  if (status) list = list.filter(t => t.status === status);
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map(t => transferView(db, t, storeId));
}

/* ---------------- FEFO 批次选择 ---------------- */
function pickFefo(db, storeId, materialId, today) {
  return db.invBatches
    .filter(b => b.storeId === storeId && b.materialId === materialId && (b.remainingQty - b.frozenQty) > 0 && b.expireDate >= today)
    .map(batch => ({ batch, days: daysBetween(today, batch.expireDate), receivedAt: batch.receivedAt }))
    .sort((a, b) => a.days - b.days || a.receivedAt.localeCompare(b.receivedAt) || a.batch.id.localeCompare(b.batch.id));
}

/* ---------------- 开单：配方原子扣减 ---------------- */
/* 返回 { allocations, lines }，先纯预演不写数据；调用方紧接着 commitConsume 提交（中间不得有失败分支） */
function planOrderConsume(db, storeId, serviceId, today) {
  const recipe = db.recipes.find(r => r.serviceId === serviceId);
  if (!recipe || !recipe.items.length) return { recipe: null, allocations: [], need: [] };
  const allocations = []; // {materialId, m, qty, picks:[{batch,take}]}
  const need = [];
  for (const it of recipe.items) {
    const m = db.materials.find(x => x.id === it.materialId);
    if (!m || !m.active) throw new ApiError(`配方耗材「${m?.name || it.materialId}」已停用，无法开单`, 409);
    let remain = it.qty;
    const picks = pickFefo(db, storeId, it.materialId, today);
    const takePlan = [];
    for (const p of picks) {
      if (remain <= 0) break;
      const free = roundQty(p.batch.remainingQty - p.batch.frozenQty);
      const take = roundQty(Math.min(free, remain));
      if (take > 0) { takePlan.push({ batch: p.batch, take }); remain = roundQty(remain - take); }
    }
    if (remain > 0) {
      const avail = roundQty(db.invBatches
        .filter(b => b.storeId === storeId && b.materialId === it.materialId)
        .reduce((a, b) => a + b.remainingQty - b.frozenQty, 0));
      need.push({ materialId: it.materialId, name: m.name, need: it.qty, available: avail, shortage: remain, unitName: db.units.find(u => u.id === m.unitId)?.name || '' });
    }
    allocations.push({ materialId: it.materialId, m, qty: it.qty, picks: takePlan });
  }
  if (need.length) {
    const e = new ApiError('耗材库存不足：' + need.map(n => `「${n.name}」需${n.need}${n.unitName}/可用${n.available}${n.unitName}`).join('；'), 409);
    e.shortage = need;
    throw e;
  }
  return { recipe, allocations, need };
}

function commitOrderConsume(db, storeId, order, operator, plan) {
  const ledgers = [];
  for (const a of plan.allocations) {
    for (const { batch, take } of a.picks) {
      batch.remainingQty = roundQty(batch.remainingQty - take);
      ledgers.push(addLedger(db, {
        storeId, materialId: a.materialId, batchId: batch.id,
        direction: 'out', type: 'order', qty: take,
        refType: 'order', refId: order.id, refNo: order.orderNo, operator,
        remark: `开单耗用·${db.services.find(v => v.id === order.serviceId)?.name || order.serviceId}`,
      }));
    }
  }
  return ledgers;
}

/* 开单试算：返回配方耗材清单与是否齐全（只读） */
function quoteRequirement(db, storeId, serviceId, today) {
  const recipe = db.recipes.find(r => r.serviceId === serviceId);
  if (!recipe) return { items: [], ready: true };
  const items = recipe.items.map(it => {
    const m = db.materials.find(x => x.id === it.materialId);
    const available = roundQty(db.invBatches
      .filter(b => b.storeId === storeId && b.materialId === it.materialId)
      .reduce((a, b) => a + b.remainingQty - b.frozenQty, 0));
    return {
      materialId: it.materialId, name: m?.name, unitName: db.units.find(u => u.id === m.unitId)?.name || '',
      qty: it.qty, available, ready: available >= it.qty,
    };
  });
  return { items, ready: items.every(i => i.ready) };
}

function orderConsumedView(db, order) {
  const rows = db.invLedger.filter(x => x.type === 'order' && x.refId === order.id);
  const byMat = {};
  rows.forEach(r => { byMat[r.materialId] = roundQty((byMat[r.materialId] || 0) + r.qty); });
  return Object.entries(byMat).map(([materialId, qty]) => ({
    materialId, qty,
    name: db.materials.find(m => m.id === materialId)?.name || materialId,
    unitName: db.units.find(u => u.id === db.materials.find(m => m.id === materialId)?.unitId)?.name || '',
  }));
}

/* ---------------- 幂等 ---------------- */
/* 同店（或全局）同 key 的 POST 在 TTL 内直接返回首次结果 */
function withIdem(db, scope, key, fn) {
  if (!key) return fn();
  const hit = db.idempotency.find(x => x.scope === scope && x.key === key);
  if (hit) return { __idem: true, ...hit.result };
  const result = fn();
  db.idempotency.push({ scope, key, result, ts: nowLocal() });
  pruneIdem(db);
  return result;
}
function pruneIdem(db) {
  const cutoff = addDate(-7);
  if (db.idempotency.length > 2000 || db.idempotency.some(x => x.ts.slice(0, 10) < cutoff)) {
    db.idempotency = db.idempotency.filter(x => x.ts.slice(0, 10) >= cutoff).slice(-1000);
  }
}

/* ---------------- 总部主数据 ---------------- */
function listMaterials(db) { const today = fmtDate(new Date()); return db.materials.map(m => materialView(db, m, today)); }
function createMaterial(db, body) {
  if (!body.name) throw new ApiError('耗材名称必填');
  if (!db.units.find(u => u.id === body.unitId)) throw new ApiError('请选择计量单位');
  if (db.materials.some(m => m.name === body.name)) throw new ApiError('同名耗材已存在');
  const m = {
    id: nextSeqId(db, 'material', 'MT', 2), name: body.name, unitId: body.unitId,
    safetyStock: roundQty(Math.max(0, Number(body.safetyStock) || 0)), active: 1, remark: body.remark || '',
  };
  db.materials.push(m); save();
  return materialView(db, m, fmtDate(new Date()));
}
function updateMaterial(db, id, body) {
  const m = db.materials.find(x => x.id === id);
  if (!m) throw new ApiError('耗材不存在', 404);
  if (body.name !== undefined) {
    if (db.materials.some(x => x.name === body.name && x.id !== id)) throw new ApiError('同名耗材已存在');
    m.name = body.name;
  }
  if (body.unitId !== undefined) {
    if (!db.units.find(u => u.id === body.unitId)) throw new ApiError('计量单位不存在');
    m.unitId = body.unitId;
  }
  if (body.safetyStock !== undefined) m.safetyStock = roundQty(Math.max(0, Number(body.safetyStock) || 0));
  if (body.active !== undefined) m.active = Number(body.active) ? 1 : 0;
  if (body.remark !== undefined) m.remark = body.remark;
  save();
  return materialView(db, m, fmtDate(new Date()));
}
function createUnit(db, body) {
  const name = String(body.name || '').trim();
  if (!name) throw new ApiError('单位名称必填');
  if (db.units.some(u => u.name === name)) throw new ApiError('单位已存在');
  const u = { id: nextSeqId(db, 'unit', 'UN', 2), name };
  db.units.push(u); save();
  return { ...u, materialCount: 0 };
}
function deleteUnit(db, id) {
  if (!db.units.find(u => u.id === id)) throw new ApiError('单位不存在', 404);
  if (db.materials.some(m => m.unitId === id)) throw new ApiError('该单位仍被耗材使用，不能删除');
  db.units = db.units.filter(u => u.id !== id); save();
  return { ok: true };
}
function upsertRecipe(db, serviceId, body, operator) {
  const svc = db.services.find(v => v.id === serviceId);
  if (!svc) throw new ApiError('服务项目不存在', 404);
  const items = [];
  for (const it of body.items || []) {
    const m = db.materials.find(x => x.id === it.materialId && x.active);
    if (!m) throw new ApiError(`耗材 ${it.materialId} 不存在或已停用`);
    const qty = roundQty(Number(it.qty));
    if (!(qty > 0)) throw new ApiError(`「${m.name}」用量必须大于 0`);
    const ex = items.find(x => x.materialId === m.id);
    if (ex) ex.qty = roundQty(ex.qty + qty); else items.push({ materialId: m.id, qty });
  }
  let r = db.recipes.find(x => x.serviceId === serviceId);
  if (!r) {
    r = { id: nextSeqId(db, 'recipe', 'RP', 3), serviceId, items: [], updatedAt: nowLocal(), updatedBy: operator };
    db.recipes.push(r);
  }
  r.items = items; r.updatedAt = nowLocal(); r.updatedBy = operator;
  save();
  return recipeView(db, r);
}
function recipeView(db, r) {
  return {
    ...r,
    serviceName: db.services.find(v => v.id === r.serviceId)?.name || r.serviceId,
    items: r.items.map(it => ({ ...it, name: db.materials.find(m => m.id === it.materialId)?.name, unitName: db.units.find(u => u.id === db.materials.find(m => m.id === it.materialId)?.unitId)?.name || '' })),
  };
}
function listRecipes(db) {
  return db.services.map(v => {
    const r = db.recipes.find(x => x.serviceId === v.id);
    return r ? recipeView(db, r) : { id: null, serviceId: v.id, serviceName: v.name, items: [], updatedAt: null, updatedBy: '' };
  });
}

module.exports = {
  ApiError, NEAR_EXPIRE_DAYS, roundQty,
  materialView, batchView, ledgerView, transferView, checkView, recipeView,
  storeWorkbench, hqOverview, queryLedger,
  stockIn, createCheck, updateCheck, cancelCheck, confirmCheck, checkView,
  createTransfer, confirmTransfer, cancelTransfer, rejectTransfer, refuseTransfer, receiveTransfer, listTransfers,
  planOrderConsume, commitOrderConsume, quoteRequirement, orderConsumedView,
  withIdem, listMaterials, createMaterial, updateMaterial,
  createUnit, deleteUnit, upsertRecipe, listRecipes,
  TRANSFER_STATUS, LEDGER_TYPE,
};
