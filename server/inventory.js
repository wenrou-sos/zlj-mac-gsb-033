/**
 * 悦足堂 · 门店耗材库存领域模块（零依赖）
 * 职责：耗材/配方维护、批次入库、盘点、跨店调拨状态机、开单原子耗用（FEFO 临期优先）、出入库流水。
 * 所有写操作在同一个同步调用栈内完成多表变更后由调用方统一 save()，天然原子。
 */
const NEAR_EXPIRE_DAYS = 30;

function createInventory(deps) {
  const { db, nextId, nowLocal, todayStr, fmtDate } = deps;

  const r3 = (n) => Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;

  const material = (id) => db.materials.find(m => m.id === id && m.active);
  const materialView = (m) => ({ ...m, unitName: m.unit, recipeService: recipeServiceName(m.id) });
  function recipeOf(serviceId) {
    const r = db.materialRecipes.find(x => x.serviceId === serviceId);
    return r ? r.items.map(x => ({ ...x })) : [];
  }
  function recipeServiceName(materialId) {
    const rows = db.materialRecipes.filter(r => r.items.some(i => i.materialId === materialId));
    return rows.map(r => db.services.find(s => s.id === r.serviceId)?.name).filter(Boolean);
  }

  /* ---------------- 批次工具 ---------------- */
  function batchAvail(b, onDate = todayStr()) {
    if (b.expireDate && b.expireDate < onDate) return 0;       // 已过期不可用（仍参与盘点实物）
    return Math.max(0, r3(b.quantity - b.frozen));
  }
  function daysToExpire(b, onDate = todayStr()) {
    if (!b.expireDate) return null;
    return Math.round((new Date(b.expireDate + 'T00:00:00') - new Date(onDate + 'T00:00:00')) / 864e5);
  }
  function batchView(b) {
    const m = db.materials.find(x => x.id === b.materialId);
    const days = daysToExpire(b);
    return {
      ...b,
      materialName: m?.name, category: m?.category, unit: m?.unit,
      available: batchAvail(b),
      daysToExpire: days,
      expired: days !== null && days < 0,
      nearExpire: days !== null && days >= 0 && days <= NEAR_EXPIRE_DAYS,
    };
  }
  /* FEFO：可用批次按到期日升序（无到期日排最后），同到期日按入库时间 */
  function fefoBatches(storeId, materialId, onDate = todayStr()) {
    return db.stockBatches
      .filter(b => b.storeId === storeId && b.materialId === materialId && batchAvail(b, onDate) > 0)
      .sort((a, b) => (a.expireDate || '9999').localeCompare(b.expireDate || '9999') || a.receivedAt.localeCompare(b.receivedAt));
  }

  function addLedger(e) {
    const row = { id: nextId('stockLedger', 'SL', 7), createdAt: nowLocal(), orderId: null, ...e };
    db.stockLedger.push(row);
    return row;
  }
  function ledgerView(l) {
    const m = db.materials.find(x => x.id === l.materialId);
    return {
      ...l, materialName: m?.name, category: m?.category, unit: m?.unit,
      storeName: db.stores.find(s => s.id === l.storeId)?.name,
      batchNo: db.stockBatches.find(b => b.id === l.batchId)?.batchNo || null,
    };
  }
  const LEDGER_TYPE_NAME = {
    inbound: '入库', consume: '开单耗用', check_in: '盘盈入库', check_out: '盘亏出库',
    freeze: '调拨冻结', release: '解冻', transfer_out: '调拨调出', transfer_in: '调拨调入',
  };
  function ledgerTypeName(t) { return LEDGER_TYPE_NAME[t] || t; }

  /* ---------------- 开单耗用：先规划、后落账 ---------------- */
  /* 返回每个耗材的需求与 FEFO 批次分配计划；任一耗材不足时抛出（不修改任何数据） */
  function planConsume(storeId, serviceId, onDate = todayStr()) {
    const svc = db.services.find(v => v.id === serviceId && v.active);
    if (!svc) throw Object.assign(new Error('服务项目不存在或已下架'), { status: 400 });
    const recipe = recipeOf(serviceId);
    const lines = [];
    for (const item of recipe) {
      const need = r3(item.qty);
      if (!(need > 0)) continue;
      const m = material(item.materialId);
      if (!m) throw Object.assign(new Error(`配方耗材已停用（${item.materialId}），请联系总部调整配方`), { status: 400 });
      let remain = need;
      const alloc = [];
      for (const b of fefoBatches(storeId, m.id, onDate)) {
        const take = r3(Math.min(batchAvail(b, onDate), remain));
        if (take > 0) alloc.push({ batchId: b.id, qty: take });
        remain = r3(remain - take);
        if (remain <= 0) break;
      }
      const avail = fefoBatches(storeId, m.id, onDate).reduce((a, b) => a + batchAvail(b, onDate), 0);
      lines.push({ materialId: m.id, materialName: m.name, unit: m.unit, need, available: r3(avail), shortage: remain, alloc });
    }
    const bad = lines.filter(x => x.shortage > 0);
    if (bad.length) {
      const msg = bad.map(x => `「${x.materialName}」缺 ${x.shortage}${x.unit}（可用 ${x.available}${x.unit}）`).join('；');
      throw Object.assign(new Error(`耗材库存不足，整单未提交：${msg}`), { status: 409, code: 'STOCK_SHORTAGE', lines });
    }
    return { serviceId, serviceName: svc.name, lines };
  }

  /* 按已校验的计划原子扣减批次并写流水。
     先做一遍非变更的最终校验（与 planConsume 之间无 await，理论上结果恒等），
     任一异常都在第一条变动之前抛出；通过后顺序执行，不再有可抛错的分支。 */
  function applyConsume(storeId, plan, orderId, operator, createdAt = nowLocal()) {
    const targets = [];
    for (const line of plan.lines) {
      for (const a of line.alloc) {
        const b = db.stockBatches.find(x => x.id === a.batchId);
        if (!b || b.storeId !== storeId) throw Object.assign(new Error('库存批次状态异常，整单失败'), { status: 409 });
        if (batchAvail(b) + 1e-9 < a.qty) throw Object.assign(new Error(`库存批次 ${b.batchNo} 可用量不足，整单失败`), { status: 409, code: 'STOCK_SHORTAGE' });
        targets.push([b, line, a]);
      }
    }
    const rows = [];
    for (const [b, line, a] of targets) {
      b.quantity = r3(b.quantity - a.qty);
      rows.push(addLedger({
        storeId, materialId: line.materialId, batchId: b.id, type: 'consume', qty: a.qty, change: -a.qty,
        refType: 'order', refId: orderId, orderId,
        batchQtyAfter: b.quantity, batchAvailAfter: r3(b.quantity - b.frozen),
        operator, createdAt, note: `开单耗用 · ${plan.serviceName}`,
      }));
    }
    return rows;
  }

  /* ---------------- 库存汇总 / 预警 ---------------- */
  function materialStock(storeId, materialId, onDate = todayStr()) {
    const bs = db.stockBatches.filter(b => b.storeId === storeId && b.materialId === materialId);
    const quantity = r3(bs.reduce((a, b) => a + b.quantity, 0));
    const frozen = r3(bs.reduce((a, b) => a + b.frozen, 0));
    const available = r3(bs.reduce((a, b) => a + batchAvail(b, onDate), 0));
    return { quantity, frozen, available };
  }
  function stockSummary(storeId) {
    const rows = db.materials.map(m => {
      const st = materialStock(storeId, m.id);
      const bs = db.stockBatches.filter(b => b.storeId === storeId && b.materialId === m.id);
      const expQty = r3(bs.filter(b => batchAvail(b) === 0 && b.expireDate && b.expireDate < todayStr()).reduce((a, b) => a + b.quantity - b.frozen, 0));
      const nearBs = bs.filter(b => { const d = daysToExpire(b); return d !== null && d >= 0 && d <= NEAR_EXPIRE_DAYS && batchAvail(b) > 0; });
      const nearQty = r3(nearBs.reduce((a, b) => a + batchAvail(b), 0));
      return {
        materialId: m.id, name: m.name, category: m.category, unit: m.unit,
        safetyStock: m.safetyStock, ...st,
        low: st.available < m.safetyStock,
        expiredQty: expQty, nearExpireQty: nearQty,
        batchCount: bs.length,
        recipeServices: recipeServiceName(m.id),
      };
    });
    return rows;
  }

  function overview() {
    const stores = db.stores.map(s => {
      const rows = stockSummary(s.id);
      return {
        storeId: s.id, name: s.name, city: s.city,
        skuCount: rows.length,
        lowCount: rows.filter(r => r.low).length,
        nearCount: db.stockBatches.filter(b => b.storeId === s.id && (() => { const d = daysToExpire(b); return d !== null && d >= 0 && d <= NEAR_EXPIRE_DAYS && batchAvail(b) > 0; })()).length,
        expiredCount: db.stockBatches.filter(b => b.storeId === s.id && daysToExpire(b) !== null && daysToExpire(b) < 0 && b.quantity - b.frozen > 0).length,
        pendingIn: db.stockTransfers.filter(t => t.toStoreId === s.id && ['pending', 'frozen'].includes(t.status)).length,
        pendingOut: db.stockTransfers.filter(t => t.fromStoreId === s.id && t.status === 'pending').length,
        frozenOut: db.stockTransfers.filter(t => t.fromStoreId === s.id && t.status === 'frozen').length,
      };
    });
    const allBatches = db.stockBatches;
    const kpi = {
      materialCount: db.materials.filter(m => m.active).length,
      recipeCount: db.materialRecipes.filter(r => r.items.length).length,
      storeCount: db.stores.length,
      lowSkus: stores.reduce((a, s) => a + s.lowCount, 0),
      nearBatches: allBatches.filter(b => { const d = daysToExpire(b); return d !== null && d >= 0 && d <= NEAR_EXPIRE_DAYS && batchAvail(b) > 0; }).length,
      expiredBatches: allBatches.filter(b => daysToExpire(b) !== null && daysToExpire(b) < 0 && b.quantity - b.frozen > 0).length,
      pendingTransfers: db.stockTransfers.filter(t => ['pending', 'frozen'].includes(t.status)).length,
    };
    return { kpi, stores };
  }

  /* ---------------- 调拨 ---------------- */
  function transferView(t) {
    const from = db.stores.find(s => s.id === t.fromStoreId);
    const to = db.stores.find(s => s.id === t.toStoreId);
    const m = db.materials.find(x => x.id === t.materialId);
    const batches = (t.batches || []).map(a => ({
      ...a,
      batchNo: db.stockBatches.find(b => b.id === a.batchId)?.batchNo || null,
    }));
    return {
      ...t,
      materialName: m?.name, category: m?.category,
      fromStoreName: from?.name, fromCity: from?.city,
      toStoreName: to?.name, toCity: to?.city,
      batches,
      directionName: t.direction === 'in' ? '请货（调入店发起）' : '主动调拨（调出店发起）',
      statusName: { pending: '待调出店确认', frozen: '已冻结·待签收', received: '已签收完成', rejected: '已拒绝', cancelled: '已取消' }[t.status] || t.status,
    };
  }

  /* 校验调拨行并解析批次（direction=in 且未给 batches 时允许为空，确认时再分配） */
  function resolveTransferBatches(fromStoreId, materialId, qty, batches) {
    const m = material(materialId);
    if (!m) throw Object.assign(new Error('耗材不存在或已停用'), { status: 400 });
    const q = r3(qty);
    if (!(q > 0)) throw Object.assign(new Error('调拨数量无效'), { status: 400 });
    if (!batches) return null;
    if (!Array.isArray(batches) || !batches.length) throw Object.assign(new Error('请指定调出批次'), { status: 400 });
    const sum = r3(batches.reduce((a, x) => a + Number(x.qty || 0), 0));
    if (Math.abs(sum - q) > 0.001) throw Object.assign(new Error(`批次数量合计 ${sum} 与调拨数量 ${q} 不一致`), { status: 400 });
    for (const a of batches) {
      const b = db.stockBatches.find(x => x.id === a.batchId);
      if (!b || b.storeId !== fromStoreId || b.materialId !== materialId) throw Object.assign(new Error('调出批次不存在或不属于本店/该耗材'), { status: 400 });
      if (!(r3(a.qty) > 0)) throw Object.assign(new Error('批次数量无效'), { status: 400 });
      if (batchAvail(b) + 1e-9 < r3(a.qty)) throw Object.assign(new Error(`批次 ${b.batchNo} 可用量不足（冻结/临期占用）`), { status: 409 });
    }
    return batches.map(a => ({ batchId: a.batchId, qty: r3(a.qty) }));
  }

  function autoAllocBatches(storeId, materialId, qty) {
    let remain = r3(qty);
    const alloc = [];
    for (const b of fefoBatches(storeId, materialId)) {
      const take = r3(Math.min(batchAvail(b), remain));
      if (take > 0) alloc.push({ batchId: b.id, qty: take });
      remain = r3(remain - take);
      if (remain <= 0) break;
    }
    if (remain > 0) throw Object.assign(new Error('本店可用库存不足，无法确认调出'), { status: 409 });
    return alloc;
  }

  function freezeTransfer(t, operator) {
    for (const a of t.batches) {
      const b = db.stockBatches.find(x => x.id === a.batchId);
      b.frozen = r3(b.frozen + a.qty);
      addLedger({
        storeId: b.storeId, materialId: b.materialId, batchId: b.id, type: 'freeze', qty: a.qty, change: 0,
        refType: 'transfer', refId: t.id, orderId: null,
        batchQtyAfter: b.quantity, batchAvailAfter: r3(b.quantity - b.frozen),
        operator, createdAt: t.confirmedAt, note: `调拨冻结 · ${transferView(t).toStoreName}`,
      });
    }
  }
  function releaseTransfer(t, type, operator, at, reason) {
    for (const a of (t.batches || [])) {
      const b = db.stockBatches.find(x => x.id === a.batchId);
      b.frozen = r3(Math.max(0, b.frozen - a.qty));
      addLedger({
        storeId: b.storeId, materialId: b.materialId, batchId: b.id, type: 'release', qty: a.qty, change: 0,
        refType: 'transfer', refId: t.id, orderId: null,
        batchQtyAfter: b.quantity, batchAvailAfter: r3(b.quantity - b.frozen),
        operator, createdAt: at, note: `${type === 'reject' ? '拒绝解冻' : '取消解冻'} · ${reason || ''}`,
      });
    }
  }

  return {
    NEAR_EXPIRE_DAYS, r3, material, materialView, recipeOf, recipeServiceName,
    batchAvail, daysToExpire, batchView, fefoBatches,
    addLedger, ledgerView, ledgerTypeName,
    planConsume, applyConsume,
    materialStock, stockSummary, overview,
    transferView, resolveTransferBatches, autoAllocBatches, freezeTransfer, releaseTransfer,
  };
}

module.exports = { createInventory };
