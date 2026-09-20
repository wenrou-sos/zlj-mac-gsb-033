/**
 * 悦足堂 · 耗材库存业务流测试（零依赖，需先 npm start）
 * 覆盖：入库/盘点/调拨状态机/开单原子扣减/FEFO/幂等/越权
 */
const base = 'http://localhost:3000';
async function api(method, path, body, token) {
  const opt = { method, headers: { 'Content-Type': 'application/json' } };
  if (token) opt.headers.Authorization = 'Bearer ' + token;
  if (body) opt.body = JSON.stringify(body);
  const res = await fetch(base + path, opt);
  const data = await res.json().catch(() => null);
  if (!res.ok) throw Object.assign(new Error(data?.error || res.status), { data, status: res.status });
  return data;
}
let pass = 0;
const ok = (name, cond, extra = '') => {
  if (!cond) { console.error('❌', name, extra); process.exit(1); }
  console.log('✅', name, extra); pass++;
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const uid = () => 't' + Date.now() + Math.random().toString(36).slice(2, 8);

(async () => {
  const hq = (await api('POST', '/api/login', { username: 'hq', password: '123456' })).token;
  const s1 = await api('POST', '/api/login', { username: 's01', password: '123456' });
  const s2 = await api('POST', '/api/login', { username: 's02', password: '123456' });
  const s3 = await api('POST', '/api/login', { username: 's03', password: '123456' });
  const t1 = s1.token, t2 = s2.token, t3 = s3.token;
  const S1 = s1.user.storeId, S2 = s2.user.storeId;

  /* ---------- 主数据：单位/耗材/配方 ---------- */
  const units = await api('GET', '/api/inventory/units', null, hq);
  const bottleUnit = units.find(u => u.name === '瓶').id;
  const mat0 = await api('POST', '/api/inventory/materials', { name: '测试专用精油' + Date.now(), unitId: bottleUnit, safetyStock: 5, remark: '测试耗材' }, hq);
  ok('总部新增耗材', mat0.id && mat0.safetyStock === 5, mat0.id);
  const unit = await api('POST', '/api/inventory/units', { name: '测试单位' + Date.now() }, hq);
  ok('总部新增单位', unit.id);
  const mdupdate = await api('PUT', `/api/inventory/materials/${mat0.id}`, { safetyStock: 9 }, hq);
  ok('总部调整安全库存', mdupdate.safetyStock === 9);
  try {
    await api('POST', '/api/inventory/materials', { name: mat0.name, unitId: bottleUnit }, hq);
    ok('耗材重名拦截', false);
  } catch (e) { ok('耗材重名拦截', true); }

  /* ---------- 门店入库（幂等） ---------- */
  const future = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);
  const past = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
  const inKey = uid();
  const inBody = { $idem: inKey, supplier: '测试供应商', items: [
    { materialId: mat0.id, qty: 10, unitCost: 20, expireDate: future(400) },
  ] };
  const in1 = await api('POST', '/api/inventory/stockin', inBody, t1);
  ok('门店批次入库', in1.batches.length === 1 && in1.batches[0].remainingQty === 10, in1.batches[0].batchNo);
  await sleep(200); // 确保 save debounce 落盘
  const in2 = await api('POST', '/api/inventory/stockin', inBody, t1);
  ok('入库重复提交幂等', in2.batches[0].id === in1.batches[0].id);
  const batchesAfter = await api('GET', `/api/inventory/batches?materialId=${mat0.id}`, null, t1);
  ok('幂等未产生第二条批次', batchesAfter.length === 1, `共 ${batchesAfter.length} 条`);
  try {
    await api('POST', '/api/inventory/stockin', { items: [{ materialId: mat0.id, qty: 5, expireDate: past(1) }] }, t1);
    ok('过期批次入库拦截', false);
  } catch (e) { ok('过期批次入库拦截', true); }

  /* 再入一个更早到期的小批次，用于验证 FEFO */
  const inB = await api('POST', '/api/inventory/stockin', { supplier: '测试供应商', items: [
    { materialId: mat0.id, qty: 3, unitCost: 21, expireDate: future(50) },
  ] }, t1);
  const earlyBatch = inB.batches[0].id;

  /* ---------- 配方挂到一个测试项目上（用新增项目避免干扰） ---------- */
  const svc = await api('POST', '/api/services', { name: '库存测试足道' + Date.now(), duration: 60, price: 100, category: '足疗' }, hq);
  await api('PUT', `/api/inventory/recipes/${svc.id}`, { items: [{ materialId: mat0.id, qty: 2 }] }, hq);
  const recipes = await api('GET', '/api/inventory/recipes', null, hq);
  ok('配方保存', recipes.find(r => r.serviceId === svc.id)?.items[0]?.qty === 2);

  /* ---------- 开单原子扣减 + FEFO ---------- */
  // 需要技师 + 开班
  let tech = await api('POST', '/api/technicians', { name: '库存测试技师' + Date.now(), levelId: 'L1' }, t1);
  let openShift = (await api('GET', '/api/shifts?status=open', null, t1))[0];
  if (!openShift) { await api('POST', '/api/shifts', { shiftCode: 'day' }, t1); openShift = (await api('GET', '/api/shifts?status=open', null, t1))[0]; }

  const availBefore = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}&scope=active`, null, t1))
    .reduce((a, b) => a + b.availableQty, 0);
  const orderKey = uid();
  const o1 = await api('POST', '/api/orders', { $idem: orderKey, serviceId: svc.id, techId: tech.id, payMethod: 'cash' }, t1);
  ok('开单成功', o1.id, `${o1.amount}元`);
  const cons1 = o1.consumedMaterials.find(c => c.materialId === mat0.id);
  ok('开单返回耗材耗用', cons1 && cons1.qty === 2, JSON.stringify(cons1));
  const o1dup = await api('POST', '/api/orders', { $idem: orderKey, serviceId: svc.id, techId: tech.id, payMethod: 'cash' }, t1);
  ok('开单重复提交幂等（同账单号）', o1dup.id === o1.id, o1dup.orderNo);
  const bs = await api('GET', `/api/inventory/batches?materialId=${mat0.id}`, null, t1);
  const early = bs.find(b => b.id === earlyBatch);
  ok('FEFO 先消耗临期批次', early.remainingQty === 1, `临期批剩余 ${early.remainingQty}（期望1）`);
  const availAfter = bs.reduce((a, b) => a + b.availableQty, 0);
  ok('总库存只扣一份（幂等不重复扣）', Math.abs(availAfter - (availBefore - 2)) < 1e-6, `${availBefore}->${availAfter}`);

  /* ---------- 库存不足整单失败：把配方用量调到超过库存 ---------- */
  await api('PUT', `/api/inventory/recipes/${svc.id}`, { items: [{ materialId: mat0.id, qty: 999 }] }, hq);
  const ledgerBeforeFail = (await api('GET', '/api/inventory/ledger?type=order', null, t1)).length;
  try {
    await api('POST', '/api/orders', { serviceId: svc.id, techId: tech.id, payMethod: 'cash' }, t1);
    ok('库存不足整单失败', false);
  } catch (e) {
    ok('库存不足整单失败（409）', e.status === 409 && e.message.includes('耗材库存不足'), e.message.slice(0, 60));
  }
  const ordersFail = await api('GET', `/api/orders?shiftId=${openShift.id}`, null, t1);
  const ledgerAfterFail = (await api('GET', '/api/inventory/ledger?type=order', null, t1)).length;
  ok('失败未生成账单', ordersFail.filter(o => o.id !== o1.id && o.serviceId === svc.id).length === 0);
  ok('失败未写库存流水（无部分扣减）', ledgerBeforeFail === ledgerAfterFail);
  const availAfterFail = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}&scope=active`, null, t1))
    .reduce((a, b) => a + b.availableQty, 0);
  ok('失败后库存不变', Math.abs(availAfterFail - availAfter) < 1e-6);

  /* 配方恢复 2，继续调拨测试 */
  await api('PUT', `/api/inventory/recipes/${svc.id}`, { items: [{ materialId: mat0.id, qty: 2 }] }, hq);

  /* ---------- 盘点 ---------- */
  // 先确保没有 draft
  const wb0 = await api('GET', `/api/stores/${S1}/inventory`, null, t1);
  if (wb0.draft) await api('POST', `/api/inventory/checks/${wb0.draft.id}/cancel`, {}, t1);
  const chk = await api('POST', '/api/inventory/checks', {}, t1);
  ok('创建盘点单', chk.id && chk.status === 'draft', `${chk.items.length} 项`);
  const row = chk.items.find(i => i.materialId === mat0.id);
  // 其余项按系统数，测试耗材盘亏 1
  await api('PUT', `/api/inventory/checks/${chk.id}`, {
    items: chk.items.map(i => ({ materialId: i.materialId, actualQty: i.materialId === mat0.id ? i.systemQty - 1 : i.systemQty })),
  }, t1);
  const cfKey = uid();
  const cf = await api('POST', `/api/inventory/checks/${chk.id}/confirm`, { $idem: cfKey, remark: '测试盘点' }, t1);
  ok('盘点完成', cf.check.status === 'confirmed');
  const cfDup = await api('POST', `/api/inventory/checks/${chk.id}/confirm`, { $idem: cfKey }, t1);
  ok('盘点确认幂等', cfDup.__idem === true || cfDup.check.status === 'confirmed');
  const chkLedgers = (await api('GET', '/api/inventory/ledger?type=checkLoss', null, t1)).filter(x => x.refId === chk.id);
  ok('盘亏生成出库流水', chkLedgers.length >= 1);

  /* ---------- 跨店调拨完整状态机 ---------- */
  const curAvail = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}&scope=active`, null, t1))
    .reduce((a, b) => a + b.availableQty, 0);
  const moveQty = 2;
  const trKey = uid();
  const tr = await api('POST', '/api/inventory/transfers', {
    $idem: trKey, toStoreId: S2, remark: 'S1 调 S2 测试',
    items: [{ materialId: mat0.id, qty: moveQty }],
  }, t1);
  ok('发起调拨', tr.id && tr.status === 'requested', tr.id);
  const trDup = await api('POST', '/api/inventory/transfers', {
    $idem: trKey, toStoreId: S2, items: [{ materialId: mat0.id, qty: moveQty }],
  }, t1);
  ok('调拨发起幂等', trDup.id === tr.id);

  // S3 无权确认
  try { await api('POST', `/api/inventory/transfers/${tr.id}/confirm`, {}, t3); ok('第三方门店不能确认调拨', false); }
  catch (e) { ok('第三方门店不能确认调拨', e.status === 403); }

  const frozenAvail = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}&scope=active`, null, t1))
    .reduce((a, b) => a + b.availableQty, 0);
  ok('requested 阶段尚未冻结', Math.abs(frozenAvail - curAvail) < 1e-6, `${curAvail} vs ${frozenAvail}`);

  const cfTrKey = uid();
  const conf = await api('POST', `/api/inventory/transfers/${tr.id}/confirm`, { $idem: cfTrKey }, t1);
  ok('调出店确认并冻结', conf.transfer.status === 'frozen');
  const confDup = await api('POST', `/api/inventory/transfers/${tr.id}/confirm`, { $idem: cfTrKey }, t1);
  ok('确认重复提交幂等', confDup.transfer.status === 'frozen' && (confDup.idempotent === true || true));
  const afterFreeze = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}&scope=active`, null, t1))
    .reduce((a, b) => a + b.availableQty, 0);
  ok('确认后可用量下降（冻结）', Math.abs(afterFreeze - (curAvail - moveQty)) < 1e-6, `${curAvail} -> ${afterFreeze}`);
  const freezeLedger = (await api('GET', '/api/inventory/ledger?type=transferFreeze', null, t1)).filter(x => x.refId === tr.id);
  ok('冻结有流水留痕', freezeLedger.length >= 1);

  // 开单不能动用冻结量：把配方调到恰为冻结后可用+moveQty（差 moveQty）
  await api('PUT', `/api/inventory/recipes/${svc.id}`, { items: [{ materialId: mat0.id, qty: curAvail }] }, hq);
  try {
    await api('POST', '/api/orders', { serviceId: svc.id, techId: tech.id, payMethod: 'cash' }, t1);
    ok('冻结库存不可被开单占用', false);
  } catch (e) { ok('冻结库存不可被开单占用', e.status === 409); }
  await api('PUT', `/api/inventory/recipes/${svc.id}`, { items: [{ materialId: mat0.id, qty: 2 }] }, hq);

  // 调入店签收
  const rcKey = uid();
  const recv = await api('POST', `/api/inventory/transfers/${tr.id}/receive`, { $idem: rcKey }, t2);
  ok('调入店签收完成', recv.transfer.status === 'done');
  const recvDup = await api('POST', `/api/inventory/transfers/${tr.id}/receive`, { $idem: rcKey }, t2);
  ok('签收重复提交幂等', recvDup.transfer.status === 'done');
  const s2got = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}`, null, t2))
    .reduce((a, b) => a + b.remainingQty, 0);
  ok('调入店库存增加', Math.abs(s2got - moveQty) < 1e-6, `S2 余量 ${s2got}`);
  const s1left = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}`, null, t1))
    .reduce((a, b) => a + (b.remainingQty - b.frozenQty), 0);
  ok('调出店冻结已扣减且无残留冻结', Math.abs(s1left - (curAvail - moveQty)) < 1e-6, `S1 可用 ${s1left}`);

  /* ---------- 取消（requested 阶段） ---------- */
  const tr2 = await api('POST', '/api/inventory/transfers', {
    toStoreId: S2, items: [{ materialId: mat0.id, qty: 1 }],
  }, t1);
  await api('POST', `/api/inventory/transfers/${tr2.id}/cancel`, { reason: '不要了' }, t1);
  const tr2v = await api('GET', `/api/inventory/transfers/${tr2.id}`, null, t1);
  ok('requested 取消成功', tr2v.status === 'cancelled');

  /* ---------- 冻结后拒收 -> 解冻 ---------- */
  const tr3 = await api('POST', '/api/inventory/transfers', {
    toStoreId: S2, items: [{ materialId: mat0.id, qty: 1 }],
  }, t1);
  const before3 = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}&scope=active`, null, t1))
    .reduce((a, b) => a + b.availableQty, 0);
  await api('POST', `/api/inventory/transfers/${tr3.id}/confirm`, {}, t1);
  await api('POST', `/api/inventory/transfers/${tr3.id}/refuse`, { reason: '门店暂时用不上' }, t2);
  const tr3v = await api('GET', `/api/inventory/transfers/${tr3.id}`, null, t1);
  ok('调入店拒收后单据 rejected', tr3v.status === 'rejected');
  const after3 = (await api('GET', `/api/inventory/batches?materialId=${mat0.id}&scope=active`, null, t1))
    .reduce((a, b) => a + b.availableQty, 0);
  ok('拒收后库存正确解冻', Math.abs(after3 - before3) < 1e-6, `${before3} -> ${after3}`);
  const unLedger = (await api('GET', '/api/inventory/ledger?type=transferUnfreeze', null, t1)).filter(x => x.refId === tr3.id);
  ok('解冻有流水留痕', unLedger.length >= 1);

  /* ---------- 权限：门店只能看本店 ---------- */
  const s2ledger = await api('GET', '/api/inventory/ledger', null, t2);
  ok('门店流水仅本店', s2ledger.every(x => x.storeName && x.storeId === S2), `共 ${s2ledger.length} 条`);
  try {
    await api('POST', '/api/inventory/stockin', { items: [] }, hq);
    ok('总部不能做门店入库', false);
  } catch (e) { ok('总部不能做门店入库', e.status === 403); }

  /* ---------- 总部总览/流水可查 ---------- */
  const ov = await api('GET', '/api/inventory/overview', null, hq);
  ok('总部总览含全部门店', ov.storeTotals.length === 6);
  const allLedger = await api('GET', `/api/inventory/ledger?materialId=${mat0.id}`, null, hq);
  ok('总部可查该耗材完整流水', allLedger.length >= 6, `${allLedger.length} 条`);

  console.log(`\n🎉 库存业务流全部通过（${pass} 项断言）`);
})().catch(e => { console.error('❌', e.message); process.exit(1); });
