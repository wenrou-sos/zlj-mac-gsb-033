/* 库存业务流 API 测试：入库/盘点/调拨状态机/原子扣减/幂等/越权（需先 npm start） */
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
const ok = (cond, msg) => { if (!cond) throw new Error('断言失败：' + msg); console.log('  ✅', msg); };

(async () => {
  const hq = (await api('POST', '/api/login', { username: 'hq', password: '123456' })).token;
  const a = await api('POST', '/api/login', { username: 's05', password: '123456' }); // 广州
  const b = await api('POST', '/api/login', { username: 's06', password: '123456' }); // 深圳
  const ta = a.token, tb = b.token, A = a.user.storeId, B = b.user.storeId;
  const getTech = async (t, sid) => (await api('GET', '/api/technicians?status=active', null, t)).find(x => x.storeId === sid);

  /* ---------- 1. 总部维护耗材 + 配方 ---------- */
  const mat = await api('POST', '/api/materials', { name: '测试专用足浴粉', unit: '包', category: '测试耗材', safetyStock: 50 }, hq);
  ok(mat.id, `总部新增耗材 ${mat.id}`);
  const svc = await api('POST', '/api/services', { name: '测试足道项目', duration: 30, price: 1, category: '足疗' }, hq);
  await api('PUT', `/api/recipes/${svc.id}`, { items: [{ materialId: mat.id, qty: 2 }] }, hq);
  const recipes = await api('GET', '/api/recipes', null, hq);
  ok(recipes.find(r => r.serviceId === svc.id)?.items[0]?.qty === 2, '总部配方已保存');
  // 门店不能改配方/耗材
  try { await api('PUT', `/api/recipes/${svc.id}`, { items: [] }, ta); throw new Error('未拦截'); } catch (e) { ok(e.status === 403, '门店无权修改配方'); }

  /* ---------- 2. 批次入库（幂等） ---------- */
  const today = new Date().toISOString().slice(0, 10);
  const inBody = { supplier: '测试供应商', items: [{ materialId: mat.id, qty: 10, expireDate: today }] };
  const in1 = await api('POST', '/api/stock-inbounds', { ...inBody, clientReqId: 'IN-IDEM-1' }, ta);
  const in2 = await api('POST', '/api/stock-inbounds', { ...inBody, clientReqId: 'IN-IDEM-1' }, ta);
  ok(in1.id === in2.id && in2.idempotent, '重复入库幂等，只生成一单一批次');
  // 再入一个临期批次 + 一个远期批次（共 30 个：10 今天到期 + 20 远期）
  await api('POST', '/api/stock-inbounds', { supplier: '测试供应商', items: [{ materialId: mat.id, qty: 20, expireDate: '2099-12-31' }] }, ta);
  const batches = await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta);
  ok(batches.filter(x => x.expireDate === '2099-12-31')[0]?.available === 20, '远期批次可用量 20');

  /* ---------- 3. 开单原子扣减：临期优先（FEFO） ---------- */
  const techA = await getTech(ta, A);
  const before = await api('GET', '/api/stock-ledger?materialId=' + mat.id + '&type=consume', null, ta);
  const o1 = await api('POST', '/api/orders', { serviceId: svc.id, techId: techA.id, payMethod: 'cash', clientReqId: 'ORD-1' }, ta);
  ok(o1.id, '开单成功');
  const bs1 = await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta);
  const expToday = bs1.find(x => x.expireDate === today);
  ok(expToday.quantity === 8, `临期批次先扣（10-2=8，实际 ${expToday.quantity}）`);
  // 重复提交：同一 clientReqId 直接返回首单，库存不二次扣减
  const o1b = await api('POST', '/api/orders', { serviceId: svc.id, techId: techA.id, payMethod: 'cash', clientReqId: 'ORD-1' }, ta);
  ok(o1b.id === o1.id && o1b.idempotent, '重复开单幂等，账单与库存只扣一次');
  const bs1b = await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta);
  ok(bs1b.find(x => x.expireDate === today).quantity === 8, '幂等重放未重复扣库存');

  /* ---------- 4. 库存不足整单失败：不生成账单、不扣任何库存 ---------- */
  // 消耗掉剩余 8（4 单）使临期批次清零，再消耗远期
  for (let i = 0; i < 4; i++) await api('POST', '/api/orders', { serviceId: svc.id, techId: techA.id, payMethod: 'cash' }, ta);
  // 当前远期剩 20。改配方为 7 个/单，开 3 单后可用 -1
  await api('PUT', `/api/recipes/${svc.id}`, { items: [{ materialId: mat.id, qty: 7 }] }, hq);
  await api('POST', '/api/orders', { serviceId: svc.id, techId: techA.id, payMethod: 'cash' }, ta); // 20-7=13
  await api('POST', '/api/orders', { serviceId: svc.id, techId: techA.id, payMethod: 'cash' }, ta); // 13-7=6
  const ordersBefore = (await api('GET', '/api/orders?date=' + today, null, ta)).filter(o => o.serviceId === svc.id).length;
  const farBefore = (await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta)).find(x => x.expireDate === '2099-12-31').quantity;
  ok(farBefore === 6, `前置扣减后远期批次剩 6（实际 ${farBefore}）`);
  try {
    await api('POST', '/api/orders', { serviceId: svc.id, techId: techA.id, payMethod: 'cash' }, ta);
    throw new Error('未拦截');
  } catch (e) {
    ok(e.status === 409 && /库存不足/.test(e.message), '库存不足整单被拒：' + e.message);
  }
  const ordersAfter = (await api('GET', '/api/orders?date=' + today, null, ta)).filter(o => o.serviceId === svc.id).length;
  const farAfter = (await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta)).find(x => x.expireDate === '2099-12-31').quantity;
  ok(ordersAfter === ordersBefore, '失败单据未生成账单');
  ok(farAfter === 6, '失败单据未部分扣减库存（原子性）');

  /* ---------- 5. 补货入库 + 盘点 ---------- */
  await api('POST', '/api/stock-inbounds', { supplier: '测试供应商', items: [{ materialId: mat.id, qty: 100, expireDate: '2099-11-30' }] }, ta);
  const ck = await api('POST', '/api/stock-checks', { materialIds: [mat.id] }, ta);
  const detail = await api('GET', '/api/stock-checks/' + ck.id, null, ta);
  const sys = detail.items[0].systemQty;
  // 盘亏 3
  const ckDone = await api('POST', `/api/stock-checks/${ck.id}/confirm`, { actuals: { [mat.id]: sys - 3 }, remark: '测试盘亏' }, ta);
  ok(ckDone.status === 'confirmed' && ckDone.items[0].diff === -3, '盘点单确认盘亏 3');
  const ckDone2 = await api('POST', `/api/stock-checks/${ck.id}/confirm`, { actuals: { [mat.id]: sys - 3 } }, ta);
  ok(ckDone2.idempotent, '重复确认盘点幂等，不重复调整');
  const ckLedger = await api('GET', '/api/stock-ledger?refType=check', null, ta);
  ok(ckLedger.filter(l => l.type === 'check_out').reduce((s, l) => s + l.qty, 0) === 3, '盘亏流水仅一笔 3');

  /* ---------- 6. 调拨全状态机：主动调拨 → 确认冻结 → 签收扣增；幂等；解冻 ---------- */
  const alloc = async (sid, materialId, qty, token) => {
    const bs = await api('GET', `/api/stock-batches?materialId=${materialId}&filter=active`, null, token);
    let need = qty; const rows = [];
    for (const x of bs) { const take = Math.min(x.available, need); if (take > 0) rows.push({ batchId: x.id, qty: take }); need -= take; if (need <= 0) break; }
    if (need > 0) throw new Error('测试前置库存不足');
    return rows;
  };
  const batchesOut = await alloc(A, mat.id, 10, ta);
  const tr = await api('POST', '/api/stock-transfers', { toStoreId: B, materialId: mat.id, qty: 10, direction: 'out', batches: batchesOut, note: '测试主动调拨' }, ta);
  ok(tr.status === 'pending', '发起调拨 pending');
  // B 店不能确认
  try { await api('POST', `/api/stock-transfers/${tr.id}/confirm`, {}, tb); throw new Error('未拦截'); } catch (e) { ok(e.status === 403, '非调出店不能确认调拨'); }
  await api('POST', `/api/stock-transfers/${tr.id}/confirm`, {}, ta);
  const trFrozen = await api('GET', '/api/stock-transfers/' + tr.id, null, ta);
  ok(trFrozen.status === 'frozen', '调出店确认后冻结');
  const f1 = trFrozen.batches[0];
  const fBatch = (await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta)).find(x => x.id === f1.batchId);
  ok(fBatch.frozen === f1.qty, `批次冻结量 ${fBatch.frozen} === ${f1.qty}`);
  // 重复确认幂等
  const trFrozen2 = await api('POST', `/api/stock-transfers/${tr.id}/confirm`, {}, ta);
  ok(trFrozen2.idempotent, '重复确认冻结幂等');
  const fBatch2 = (await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta)).find(x => x.id === f1.batchId);
  ok(fBatch2.frozen === f1.qty, '幂等确认未重复冻结');
  // A 店不能签收
  try { await api('POST', `/api/stock-transfers/${tr.id}/receive`, {}, ta); throw new Error('未拦截'); } catch (e) { ok(e.status === 403, '非调入店不能签收'); }
  // B 店签收
  await api('POST', `/api/stock-transfers/${tr.id}/receive`, { remark: '完好签收' }, tb);
  const trDone = await api('GET', '/api/stock-transfers/' + tr.id, null, tb);
  ok(trDone.status === 'received', '调入店签收完成');
  const inBatches = await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, tb);
  ok(Math.abs(inBatches.reduce((s, x) => s + x.quantity, 0) - 10) < 1e-6, '调入店新增 10 库存批次');
  const aBatches = await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta);
  const stillFrozen = aBatches.some(x => x.frozen > 0);
  ok(!stillFrozen, '签收后调出店冻结量清零');
  // 重复签收幂等
  const trR2 = await api('POST', `/api/stock-transfers/${tr.id}/receive`, {}, tb);
  ok(trR2.idempotent, '重复签收幂等，不重复扣增');
  const inBatches2 = await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, tb);
  ok(Math.abs(inBatches2.reduce((s, x) => s + x.quantity, 0) - 10) < 1e-6, '幂等签收未重复增加调入库存');

  /* 6b. 冻结后取消 → 正确解冻 */
  const rows2 = await alloc(A, mat.id, 6, ta);
  const tr2 = await api('POST', '/api/stock-transfers', { toStoreId: B, materialId: mat.id, qty: 6, direction: 'out', batches: rows2 }, ta);
  await api('POST', `/api/stock-transfers/${tr2.id}/confirm`, {}, ta);
  const frozenBatchId = (await api('GET', '/api/stock-transfers/' + tr2.id, null, ta)).batches[0].batchId;
  const beforeFrozen = (await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta)).find(x => x.id === frozenBatchId).frozen;
  await api('POST', `/api/stock-transfers/${tr2.id}/cancel`, { reason: 'B 店取消需求' }, tb);
  const tr2c = await api('GET', '/api/stock-transfers/' + tr2.id, null, ta);
  ok(tr2c.status === 'cancelled', '调入店取消成功');
  const afterFrozen = (await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta)).find(x => x.id === frozenBatchId).frozen;
  ok(afterFrozen === beforeFrozen - 6, `取消后冻结量正确释放（${beforeFrozen} → ${afterFrozen}）`);
  // 重复取消幂等
  const tr2c2 = await api('POST', `/api/stock-transfers/${tr2.id}/cancel`, {}, tb);
  ok(tr2c2.idempotent && tr2c2.status === 'cancelled', '重复取消幂等');
  const afterFrozen2 = (await api('GET', `/api/stock-batches?materialId=${mat.id}`, null, ta)).find(x => x.id === frozenBatchId).frozen;
  ok(afterFrozen2 === afterFrozen, '幂等取消未二次解冻（frozen 不为负）');

  /* 6c. 请货流程：B 店发起 → A 店确认（自动 FEFO 分配冻结）→ B 签收 */
  const tr3 = await api('POST', '/api/stock-transfers', { fromStoreId: A, materialId: mat.id, qty: 4, direction: 'in', note: '请货测试' }, tb);
  ok(tr3.status === 'pending' && tr3.batches.length === 0, '请货单 pending 且未占批次');
  await api('POST', `/api/stock-transfers/${tr3.id}/confirm`, {}, ta);
  const tr3f = await api('GET', '/api/stock-transfers/' + tr3.id, null, ta);
  ok(tr3f.status === 'frozen' && tr3f.batches.length >= 1, '调出店确认时自动 FEFO 分配并冻结');
  await api('POST', `/api/stock-transfers/${tr3.id}/receive`, {}, tb);
  ok((await api('GET', '/api/stock-transfers/' + tr3.id, null, tb)).status === 'received', '请货签收完成');

  /* 6d. 拒绝：pending 直接拒绝，无冻结无解冻 */
  const tr4 = await api('POST', '/api/stock-transfers', { fromStoreId: A, materialId: mat.id, qty: 999, direction: 'in' }, tb);
  await api('POST', `/api/stock-transfers/${tr4.id}/reject`, { reason: '库存紧张' }, ta);
  ok((await api('GET', '/api/stock-transfers/' + tr4.id, null, ta)).status === 'rejected', '调出店拒绝请货');

  /* ---------- 7. 数据隔离 ---------- */
  const myLedger = await api('GET', '/api/stock-ledger', null, tb);
  ok(myLedger.every(l => l.storeId === B), '门店流水仅含本店数据');
  const myTransfers = await api('GET', '/api/stock-transfers', null, ta);
  ok(myTransfers.every(t => t.fromStoreId === A || t.toStoreId === A), '门店调拨列表仅含与本店相关单据');
  try { await api('GET', `/api/stock-transfers/${tr3.id}`, null, (await api('POST', '/api/login', { username: 's01', password: '123456' })).token); throw new Error('未拦截'); } catch (e) { ok(e.status === 403, '无关门店不能查看调拨单'); }

  /* ---------- 8. 总部全量流水 ---------- */
  const all = await api('GET', '/api/stock-ledger?limit=500', null, hq);
  ok(all.length > 0 && new Set(all.map(l => l.storeId)).size > 1, '总部可查全品牌流水');

  console.log('\n✅ 库存业务流全部通过');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
