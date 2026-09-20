/* 总部端：耗材库存视图（库存总览 / 耗材与配方 / 出入库流水） */
window.Views = window.Views || {};
Object.assign(Views.hq, {

/* ============ 总部库存总览 ============ */
async 'inventory'(el) {
  const [ov, stores] = await Promise.all([
    api.get('/api/hq/inventory/overview'),
    api.get('/api/stores'),
  ]);
  const storeMap = Object.fromEntries(stores.map(s => [s.id, s]));
  el.innerHTML = `
    <div class="grid g-4 mb-16">
      <div class="card kpi k-jade"><div class="k-ico">🧴</div><div class="k-label">在管耗材 SKU</div><div class="k-val">${ov.kpi.materialCount}<small> 种</small></div><div class="k-foot">标准配方 ${ov.kpi.recipeCount} 个服务项目</div></div>
      <div class="card kpi k-red"><div class="k-ico">⚠️</div><div class="k-label">全品牌低库存 SKU</div><div class="k-val">${ov.kpi.lowSkus}<small> 项</small></div><div class="k-foot">低于总部安全库存</div></div>
      <div class="card kpi k-gold"><div class="k-ico">⏳</div><div class="k-label">临期批次</div><div class="k-val">${ov.kpi.nearBatches}<small> 个</small></div><div class="k-foot">30 天内到期（未过期）</div></div>
      <div class="card kpi k-red"><div class="k-ico">🧊</div><div class="k-label">过期批次 / 在途调拨</div><div class="k-val">${ov.kpi.expiredBatches}<small> / </small>${ov.kpi.pendingTransfers}</div><div class="k-foot">已过期批次 / 待处理调拨</div></div>
    </div>
    <div class="card mb-16">
      <div class="card-h"><h3>🏬 各门店实时库存概览</h3><span class="sub">点击门店查看批次明细</span></div>
      <div class="tbl-wrap">
        <table class="tbl"><thead><tr><th>门店</th><th>城市</th><th class="num">耗材 SKU</th><th class="num">低库存</th><th class="num">临期批次</th><th class="num">过期批次</th><th class="num">待我调入</th><th class="num">待确认调出</th><th class="num">冻结中</th><th></th></tr></thead>
          <tbody>${ov.stores.map(s => `
            <tr><td><b>${esc(s.name)}</b></td><td class="muted">${esc(s.city)}</td>
            <td class="num">${s.skuCount}</td>
            <td class="num">${s.lowCount ? `<b style="color:var(--red)">${s.lowCount}</b>` : '0'}</td>
            <td class="num">${s.nearCount ? `<b style="color:#b3862f">${s.nearCount}</b>` : '0'}</td>
            <td class="num">${s.expiredCount ? `<b style="color:var(--red)">${s.expiredCount}</b>` : '0'}</td>
            <td class="num">${s.pendingIn || '—'}</td>
            <td class="num">${s.pendingOut || '—'}</td>
            <td class="num">${s.frozenOut || '—'}</td>
            <td class="nowrap"><button class="btn btn-sm" data-store="${s.storeId}">库存明细</button></td></tr>`).join('')}
          </tbody></table>
      </div>
    </div>
    <div class="grid g-3">
      <div class="card"><div class="card-h"><h3>⚠️ 低库存预警</h3><span class="sub">可用 < 安全库存</span></div>
        <div class="tbl-wrap" id="hq-low">${loading()}</div></div>
      <div class="card"><div class="card-h"><h3>⏳ 临期批次</h3><span class="sub">30 天内到期</span></div>
        <div class="tbl-wrap" id="hq-near">${loading()}</div></div>
      <div class="card"><div class="card-h"><h3>🚚 在途调拨</h3><span class="sub">待确认 / 待签收</span></div>
        <div class="tbl-wrap" id="hq-trans">${loading()}</div></div>
    </div>`;
  el.querySelectorAll('[data-store]').forEach(b => b.onclick = () => hqStoreInventoryDialog(b.dataset.store));

  // 逐店拉明细做全品牌预警（门店数少，直接并发）
  const details = await Promise.all(ov.stores.map(s => api.get(`/api/stores/${s.storeId}/inventory/overview`)));
  const lowRows = [], nearRows = [];
  details.forEach(d => {
    const sname = storeMap[d.storeId]?.name || d.storeId;
    d.lowItems.forEach(r => lowRows.push({ ...r, storeName: sname }));
    d.nearExpireBatches.forEach(b => nearRows.push({ ...b, storeName: sname }));
  });
  lowRows.sort((a, b) => a.available / Math.max(1, a.safetyStock) - b.available / Math.max(1, b.safetyStock));
  nearRows.sort((a, b) => (a.expireDate || '').localeCompare(b.expireDate || ''));

  $('#hq-low', el).innerHTML = lowRows.length ? `<table class="tbl"><thead><tr><th>门店</th><th>耗材</th><th class="num">可用</th><th class="num">安全库存</th></tr></thead>
    <tbody>${lowRows.slice(0, 60).map(r => `<tr><td style="font-size:12.5px">${esc(r.storeName)}</td><td>${esc(r.name)}</td>
      <td class="num"><b style="color:var(--red)">${r.available}${esc(r.unit)}</b></td><td class="num muted">${r.safetyStock}${esc(r.unit)}</td></tr>`).join('')}</tbody></table>`
    : emptyBox('全部达标 🎉');
  $('#hq-near', el).innerHTML = nearRows.length ? `<table class="tbl"><thead><tr><th>门店</th><th>耗材/批次</th><th>到期日</th><th class="num">可用</th></tr></thead>
    <tbody>${nearRows.slice(0, 60).map(b => `<tr><td style="font-size:12.5px">${esc(b.storeName)}</td><td>${esc(b.materialName)}<div class="muted" style="font-size:11.5px">${esc(b.batchNo)}</div></td>
      <td class="nowrap"><span class="tag tag-gold">${b.expireDate}（${b.daysToExpire}天）</span></td><td class="num">${b.available}${esc(b.unit)}</td></tr>`).join('')}</tbody></table>`
    : emptyBox('暂无临期批次');

  const trans = (await api.get('/api/stock-transfers?status=pending')).concat(
    await api.get('/api/stock-transfers?status=frozen'));
  trans.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  $('#hq-trans', el).innerHTML = trans.length ? `<table class="tbl"><thead><tr><th>单号</th><th>调出 → 调入</th><th>耗材</th><th>状态</th></tr></thead>
    <tbody>${trans.slice(0, 40).map(t => `<tr><td class="muted nowrap" style="font-size:11.5px">${t.transferNo}</td>
      <td style="font-size:12.5px">${esc(t.fromStoreName)}<br>→ ${esc(t.toStoreName)}</td>
      <td>${esc(t.materialName)} ${t.qty}${esc(t.unit)}</td><td>${transferStatusTag(t.status)}</td></tr>`).join('')}</tbody></table>`
    : emptyBox('暂无在途调拨');
},

/* ============ 耗材目录与标准配方 ============ */
async 'materials'(el) {
  const [materials, recipes] = await Promise.all([api.get('/api/materials'), api.get('/api/recipes')]);
  const cats = [...new Set(materials.map(m => m.category))];
  el.innerHTML = `
    <div class="card mb-16" style="background:linear-gradient(120deg,#f3f9f7,#fbf7ec);border-color:#e0ece6">
      <div class="card-b" style="padding:14px 20px;font-size:13px;color:#46605b">
        💡 耗材目录、计量单位与安全库存由总部统一维护；每个服务项目可配置「标准耗用配方」，门店开单时按配方<b>临期优先（FEFO）原子扣减</b>对应批次库存，任一耗材不足则整单失败。
      </div>
    </div>
    <div class="card mb-16">
      <div class="card-h"><h3>🧴 耗材目录</h3>
        <div class="toolbar"><div class="seg" id="mcat-seg"><button class="active" data-c="">全部</button>${cats.map(c => `<button data-c="${esc(c)}">${esc(c)}</button>`).join('')}</div>
        <button class="btn btn-gold" id="add-mat">＋ 新增耗材</button></div></div>
      <div class="tbl-wrap" id="mat-tbl"></div>
    </div>
    <div class="card">
      <div class="card-h"><h3>📐 服务项目标准耗用配方</h3><span class="sub">用量为每单标准消耗量</span></div>
      <div class="tbl-wrap" id="rcp-tbl"></div>
    </div>`;

  const renderMat = (cat) => {
    const list = cat ? materials.filter(m => m.category === cat) : materials;
    $('#mat-tbl', el).innerHTML = `<table class="tbl"><thead><tr><th>编号</th><th>耗材名称</th><th>分类</th><th>单位</th><th class="num">安全库存</th><th>用于项目</th><th>状态</th><th></th></tr></thead>
      <tbody>${list.map(m => `
        <tr><td class="muted">${m.id}</td><td><b>${esc(m.name)}</b></td><td><span class="tag tag-blue">${esc(m.category)}</span></td>
        <td>${esc(m.unit)}</td><td class="num">${m.safetyStock}${esc(m.unit)}</td>
        <td style="font-size:12px;max-width:280px">${m.recipeServices.length ? m.recipeServices.slice(0, 3).map(s => `<span class="tag tag-gray" style="margin:1px">${esc(s.name)}</span>`).join('') + (m.recipeServices.length > 3 ? ` <span class="muted">+${m.recipeServices.length - 3}</span>` : '') : '<span class="muted">未配置配方</span>'}</td>
        <td>${m.active ? '<span class="tag tag-green">启用</span>' : '<span class="tag tag-gray">停用</span>'}</td>
        <td class="nowrap"><button class="btn btn-sm" data-edit='${esc(JSON.stringify(m))}'>编辑</button></td></tr>`).join('')}
      </tbody></table>`;
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => matDialog(JSON.parse(b.dataset.edit), el));
  };
  renderMat('');
  $('#mcat-seg', el).querySelectorAll('button').forEach(b => b.onclick = () => {
    $('#mcat-seg', el).querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    renderMat(b.dataset.c);
  });
  $('#add-mat', el).onclick = () => matDialog(null, el);

  $('#rcp-tbl', el).innerHTML = `<table class="tbl"><thead><tr><th>服务项目</th><th>品类</th><th>配方耗用</th><th>状态</th><th></th></tr></thead>
    <tbody>${recipes.map(r => `
      <tr><td><b>${esc(r.serviceName)}</b></td><td><span class="tag tag-blue">${esc(r.category)}</span></td>
      <td>${r.items.length ? r.items.map(i => `<span class="tag ${i.active ? 'tag-green' : 'tag-red'}" style="margin:1px">${esc(i.materialName)} × ${i.qty}${esc(i.unit)}</span>`).join('') : '<span class="muted">无配方（开单不扣库存）</span>'}</td>
      <td>${r.serviceActive ? '<span class="tag tag-green">上架</span>' : '<span class="tag tag-gray">下架</span>'}</td>
      <td><button class="btn btn-sm" data-r="${r.serviceId}">配置配方</button></td></tr>`).join('')}</tbody></table>`;
  el.querySelectorAll('[data-r]').forEach(b => b.onclick = () => recipeDialog(b.dataset.r, recipes, materials, el));
},

/* ============ 全品牌出入库流水 ============ */
async 'stock-ledger'(el) {
  const stores = App.ctx.stores;
  const materials = App.ctx.materials;
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  el.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>📑 全品牌出入库流水</h3>
        <div class="toolbar">
          <select class="inp" id="f-store">${storeOptions(stores, '', '全部门店')}</select>
          <select class="inp" id="f-type"><option value="">全部类型</option>
            ${[['inbound', '入库'], ['consume', '开单耗用'], ['check_in', '盘盈'], ['check_out', '盘亏'], ['freeze', '调拨冻结'], ['release', '解冻'], ['transfer_out', '调拨调出'], ['transfer_in', '调拨调入']].map(([v, n]) => `<option value="${v}">${n}</option>`).join('')}
          </select>
          <select class="inp" id="f-mat"><option value="">全部耗材</option>${materials.map(m => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select>
          <input type="date" class="inp" id="f-from" value="${from}"><input type="date" class="inp" id="f-to" value="${today}">
          <input class="inp" id="f-q" placeholder="单号/备注" style="width:140px">
          <button class="btn btn-primary" id="f-go">查询</button>
        </div></div>
      <div id="lg-box" class="tbl-wrap">${loading()}</div>
    </div>`;
  const load = async () => {
    const qs = new URLSearchParams({ from: $('#f-from', el).value, to: $('#f-to', el).value, limit: 500 });
    const sid = $('#f-store', el).value, tp = $('#f-type', el).value, mid = $('#f-mat', el).value, q = $('#f-q', el).value.trim();
    if (sid) qs.set('storeId', sid); if (tp) qs.set('type', tp); if (mid) qs.set('materialId', mid); if (q) qs.set('q', q);
    const list = await api.get('/api/stock-ledger?' + qs);
    const total = list.length;
    $('#lg-box', el).innerHTML = list.length ? `<table class="tbl"><thead><tr><th>时间</th><th>门店</th><th>耗材</th><th>批次</th><th>类型</th><th class="num">数量</th><th class="num">批次结存</th><th>关联单号</th><th>经办人</th><th>备注</th></tr></thead>
      <tbody>${list.map(l => `
        <tr><td class="nowrap muted">${l.createdAt.slice(5, 16)}</td><td style="font-size:12.5px">${esc(l.storeName)}</td>
        <td>${esc(l.materialName)}</td><td class="muted nowrap" style="font-size:11.5px">${esc(l.batchNo || '—')}</td>
        <td>${ledgerTypeTag(l.type, l.typeName)}</td>
        <td class="num" style="color:${l.change < 0 ? 'var(--red)' : l.change > 0 ? 'var(--jade)' : 'var(--text-2)'}">${l.change > 0 ? '+' : ''}${l.qty}${esc(l.unit)}</td>
        <td class="num muted">${l.batchQtyAfter ?? '—'}${esc(l.unit)}</td>
        <td class="muted nowrap" style="font-size:11.5px">${esc(l.refId || (l.orderId ? '账单 ' + l.orderId : '—'))}</td>
        <td class="nowrap">${esc(l.operator || '—')}</td><td class="muted" style="font-size:12px;max-width:200px">${esc(l.note || '')}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted" style="padding:10px 16px;font-size:12.5px">共 ${total} 条（最多显示 500 条）</p>`
      : emptyBox('该条件下暂无流水');
  };
  $('#f-go', el).onclick = () => load().catch(e => toast(e.message, 'error'));
  load();
},
});

/* ---------------- 共享：状态/类型标签 ---------------- */
function transferStatusTag(status) {
  return {
    pending: '<span class="tag tag-blue">待调出确认</span>',
    frozen: '<span class="tag tag-gold">已冻结·待签收</span>',
    received: '<span class="tag tag-green">已签收</span>',
    rejected: '<span class="tag tag-red">已拒绝</span>',
    cancelled: '<span class="tag tag-gray">已取消</span>',
  }[status] || status;
}
function ledgerTypeTag(type, name) {
  const map = { inbound: 'tag-green', consume: 'tag-gray', check_in: 'tag-jade', check_out: 'tag-red', freeze: 'tag-gold', release: 'tag-blue', transfer_out: 'tag-red', transfer_in: 'tag-green' };
  const cls = map[type] || 'tag-gray';
  return `<span class="tag ${cls === 'tag-jade' ? 'tag-green' : cls}">${esc(name || type)}</span>`;
}

/* ---------------- 耗材编辑弹窗 ---------------- */
function matDialog(m, el) {
  const units = App.ctx.materialUnits;
  const cats = ['足疗耗材', '按摩耗材', 'SPA 耗材', '调理耗材', '一次性织物', '工具配件', '其他耗材'];
  const dlg = openModal({ title: m ? '编辑耗材 · ' + m.name : '新增耗材',
    body: `<div class="form-row">
      <div class="form-item"><label><span class="req">*</span>耗材名称</label><input id="f-name" value="${esc(m?.name || '')}"></div>
      <div class="form-item"><label>分类</label><select id="f-cat">${cats.map(c => `<option ${m?.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></div></div>
    <div class="form-row">
      <div class="form-item"><label><span class="req">*</span>计量单位</label>
        <select id="f-unit">${units.map(u => `<option ${m?.unit === u ? 'selected' : ''}>${u}</option>`).join('')}<option value="__custom">＋ 自定义…</option></select>
        <input id="f-unit-c" class="inp" style="margin-top:6px;display:none" placeholder="输入新单位，如：瓶"></div>
      <div class="form-item"><label>安全库存（低于则预警）</label><input type="number" min="0" step="0.001" id="f-safe" value="${m?.safetyStock ?? 0}"></div></div>
    <div class="form-row one"><div class="form-item"><label>备注</label><input id="f-remark" value="${esc(m?.remark || '')}"></div></div>
    ${m ? `<div class="form-row one"><div class="form-item"><label>状态</label><select id="f-active"><option value="1" ${m.active ? 'selected' : ''}>启用</option><option value="0" ${!m.active ? 'selected' : ''}>停用（历史流水保留）</option></select></div></div>` : ''}`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="f-ok">保存并同步全部门店</button>` });
  $('#f-unit', dlg.el).onchange = () => { $('#f-unit-c', dlg.el).style.display = $('#f-unit', dlg.el).value === '__custom' ? '' : 'none'; };
  $('#f-ok', dlg.el).onclick = async () => {
    const selUnit = $('#f-unit', dlg.el).value;
    const body = {
      name: $('#f-name', dlg.el).value.trim(),
      category: $('#f-cat', dlg.el).value,
      unit: selUnit === '__custom' ? $('#f-unit-c', dlg.el).value.trim() : selUnit,
      safetyStock: Number($('#f-safe', dlg.el).value) || 0,
      remark: $('#f-remark', dlg.el).value.trim(),
    };
    if (!body.name || !body.unit) return toast('名称与单位必填', 'error');
    if (m) body.active = Number($('#f-active', dlg.el).value);
    try {
      if (m) await api.put('/api/materials/' + m.id, body); else await api.post('/api/materials', body);
      toast('耗材已保存'); closeModal(); Views.hq.materials(el);
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 配方编辑弹窗 ---------------- */
function recipeDialog(serviceId, recipes, materials, el) {
  const r = recipes.find(x => x.serviceId === serviceId);
  const chosen = new Map(r.items.map(i => [i.materialId, i.qty]));
  const rowsHtml = () => materials.filter(m => m.active).map(m => {
    const q = chosen.get(m.id);
    return `<tr data-mid="${m.id}">
      <td><label style="display:flex;align-items:center;gap:8px;cursor:pointer"><input type="checkbox" class="rc-chk" ${q ? 'checked' : ''}> ${esc(m.name)} <span class="muted">（${esc(m.unit)}）</span></label></td>
      <td style="width:140px"><input type="number" min="0" step="0.001" class="inp rc-qty" value="${q ?? ''}" placeholder="每单用量" style="width:120px" ${q ? '' : 'disabled'}></td>
      <td class="muted" style="font-size:12px">安全库存 ${m.safetyStock}${esc(m.unit)}</td></tr>`;
  }).join('');
  const dlg = openModal({ title: '配置配方 · ' + r.serviceName, size: 'lg',
    body: `<p class="muted" style="font-size:12.5px;margin-bottom:10px">勾选该项目每单需要消耗的耗材并填写标准用量。保存后全部门店新开单即时生效，历史账单不受影响。</p>
      <div class="tbl-wrap" style="max-height:52vh;overflow-y:auto;border:1px solid var(--line);border-radius:8px">
      <table class="tbl"><thead><tr><th>耗材</th><th>每单用量</th><th></th></tr></thead><tbody id="rc-body">${rowsHtml()}</tbody></table></div>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="rc-ok">保存配方</button>` });
  dlg.el.querySelectorAll('#rc-body tr').forEach(tr => {
    const chk = $('.rc-chk', tr), qty = $('.rc-qty', tr);
    chk.onchange = () => { qty.disabled = !chk.checked; if (chk.checked && !qty.value) qty.value = 1; qty.focus(); };
  });
  $('#rc-ok', dlg.el).onclick = async () => {
    const items = [];
    for (const tr of dlg.el.querySelectorAll('#rc-body tr')) {
      const chk = $('.rc-chk', tr), qty = $('.rc-qty', tr);
      if (chk.checked) {
        const q = Number(qty.value);
        if (!(q > 0)) return toast(`「${tr.querySelector('label').textContent.trim()}」用量无效`, 'error');
        items.push({ materialId: tr.dataset.mid, qty });
      }
    }
    try {
      await api.put('/api/recipes/' + serviceId, { items });
      toast('配方已保存并同步全部门店'); closeModal(); Views.hq.materials(el);
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* ---------------- 总部：单店库存明细弹窗 ---------------- */
async function hqStoreInventoryDialog(storeId) {
  const [ov] = await Promise.all([api.get(`/api/stores/${storeId}/inventory/overview`)]);
  const dlg = openModal({ title: `库存明细 · ${App.ctx.stores.find(s => s.id === storeId)?.name}`, size: 'xl',
    body: `<div id="d-body">${loading()}</div>`,
    footer: `<button class="btn btn-primary" data-close>关 闭</button>` });
  const rows = ov.rows;
  $('#d-body', dlg.el).innerHTML = `
    <div class="grid g-4 mb-16">
      <div class="pay-box"><div class="p-l">低库存 SKU</div><div class="p-v" style="color:var(--red)">${ov.kpi.lowCount}</div></div>
      <div class="pay-box"><div class="p-l">临期批次</div><div class="p-v" style="color:#b3862f">${ov.kpi.nearCount}</div></div>
      <div class="pay-box"><div class="p-l">过期批次</div><div class="p-v" style="color:var(--red)">${ov.kpi.expiredCount}</div></div>
      <div class="pay-box"><div class="p-l">在途/冻结</div><div class="p-v" style="color:var(--blue)">${ov.kpi.pendingIn}/${ov.kpi.frozenOut}</div></div>
    </div>
    <div class="tbl-wrap" style="max-height:56vh;overflow-y:auto"><table class="tbl"><thead><tr><th>耗材</th><th>分类</th><th class="num">账面总量</th><th class="num">冻结中</th><th class="num">可用</th><th class="num">安全库存</th><th>状态</th></tr></thead>
      <tbody>${rows.map(r => `<tr><td><b>${esc(r.name)}</b></td><td class="muted">${esc(r.category)}</td>
        <td class="num">${r.quantity}${esc(r.unit)}</td>
        <td class="num" style="color:var(--blue)">${r.frozen ? r.frozen + esc(r.unit) : '—'}</td>
        <td class="num"><b>${r.available}${esc(r.unit)}</b></td>
        <td class="num muted">${r.safetyStock}${esc(r.unit)}</td>
        <td>${r.low ? '<span class="tag tag-red">低库存</span>' : '<span class="tag tag-green">正常</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
}
