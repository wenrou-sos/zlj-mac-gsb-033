/* 总部端 · 库存视图（inv-hq.js） */
window.Views = window.Views || {};
Views.hq = Object.assign(Views.hq || {}, {

/* ============ 总部库存总览 ============ */
async 'inventory/overview'(el) {
  const stores = App.ctx.stores;
  el.innerHTML = `
    <div class="card mb-16" style="background:linear-gradient(120deg,#f3f9f7,#fbf7ec);border-color:#e0ece6">
      <div class="card-b" style="padding:14px 20px;font-size:13px;color:#46605b">
        💡 总部可实时查看各门店批次库存、临期批次（30 天内）、低于安全库存的预警项及在途调拨。耗材、单位与项目配方在「耗材与配方标准」中统一维护。
      </div>
    </div>
    <div class="toolbar mb-16" style="justify-content:space-between">
      <select class="inp" id="f-store" style="min-width:220px">${storeOptions(stores, '', '全部门店')}</select>
      <div class="seg" id="tab-seg">
        <button class="active" data-t="low">低库存预警</button>
        <button data-t="exp">临期批次</button>
        <button data-t="stock">实时库存</button>
      </div>
    </div>
    <div id="ov-kpi" class="grid g-4 mb-16"></div>
    <div class="card mb-16"><div class="card-h"><h3>🏬 各门店库存健康度</h3></div><div id="ov-stores" class="card-b"></div></div>
    <div class="card"><div class="card-h"><h3 id="ov-list-title"></h3><span class="sub" id="ov-list-sub"></span></div>
      <div class="tbl-wrap" id="ov-list">${loading()}</div></div>`;

  let tab = 'low', storeId = '';
  const load = async () => {
    const d = await api.get('/api/inventory/overview' + (storeId ? '?storeId=' + storeId : ''));
    $('#ov-kpi', el).innerHTML = `
      <div class="card kpi k-blue"><div class="k-ico">🏬</div><div class="k-label">覆盖门店</div><div class="k-val">${d.kpi.storeCount}<small> 家</small></div></div>
      <div class="card kpi"><div class="k-ico">📦</div><div class="k-label">耗材品类</div><div class="k-val">${d.kpi.materialTypes}<small> 种</small></div></div>
      <div class="card kpi k-red"><div class="k-ico">⚠️</div><div class="k-label">低库存预警</div><div class="k-val">${d.kpi.lowItemCount}<small> 项</small></div><div class="k-foot">可用 &lt; 安全库存</div></div>
      <div class="card kpi k-gold"><div class="k-ico">⏰</div><div class="k-label">临期/过期批次</div><div class="k-val">${d.kpi.nearExpireCount}<small> 个</small></div><div class="k-foot">${d.nearExpireDays} 天内到期</div></div>`;
    $('#ov-stores', el).innerHTML = `<table class="tbl"><thead><tr><th>门店</th><th>城市</th><th class="num">有库存品类</th><th class="num">低库存项</th><th class="num">临期批次</th><th class="num">在途调拨</th></tr></thead>
      <tbody>${d.storeTotals.map(s => `
        <tr><td><b>${esc(s.storeName)}</b></td><td class="muted">${esc(s.city)}</td>
        <td class="num">${s.materialCount}</td>
        <td class="num">${s.lowCount ? `<b style="color:var(--red)">${s.lowCount}</b>` : '0'}</td>
        <td class="num">${s.nearExpireCount ? `<b style="color:#9a7622">${s.nearExpireCount}</b>` : '0'}</td>
        <td class="num">${s.pendingTransfer || ''}</td></tr>`).join('')}</tbody></table>`;

    const titles = {
      low: ['⚠️ 低库存预警（总部）', '按缺口严重程度排序'],
      exp: ['⏰ 临期 / 过期批次', '按有效期升序，建议优先消耗或调拨'],
      stock: ['📦 各门店实时库存', '可用量 = 现存 − 调拨冻结'],
    };
    $('#ov-list-title', el).textContent = titles[tab][0];
    $('#ov-list-sub', el).textContent = titles[tab][1];
    if (tab === 'low') {
      $('#ov-list', el).innerHTML = `<table class="tbl"><thead><tr><th>门店</th><th>耗材</th><th class="num">安全库存</th><th class="num">可用</th><th class="num">缺口</th><th>状态</th></tr></thead>
        <tbody>${d.lowAlerts.length ? d.lowAlerts.map(r => `
          <tr><td>${esc(r.storeName)}</td><td><b>${esc(r.materialName)}</b></td>
          <td class="num muted">${r.safetyStock} ${esc(r.unitName)}</td>
          <td class="num"><b style="color:var(--red)">${r.availableQty}</b> ${esc(r.unitName)}</td>
          <td class="num">${round1(r.safetyStock - r.availableQty)} ${esc(r.unitName)}</td>
          <td>${InvUI.stockTag(r)}</td></tr>`).join('')
          : `<tr><td colspan="6">${emptyBox('所有门店库存均高于安全库存 🎉')}</td></tr>`}</tbody></table>`;
    } else if (tab === 'exp') {
      $('#ov-list', el).innerHTML = `<table class="tbl"><thead><tr><th>门店</th><th>耗材</th><th>批次号</th><th>有效期</th><th>状态</th><th class="num">现存</th><th class="num">可用</th><th>供应商</th></tr></thead>
        <tbody>${d.expiring.length ? d.expiring.map(b => `
          <tr><td>${esc(InvUI.storeNameOf(b.storeId))}</td><td><b>${esc(b.materialName)}</b></td>
          <td class="nowrap muted">${esc(b.batchNo)}</td><td class="nowrap">${b.expireDate}</td>
          <td>${InvUI.expireTag(b)}</td>
          <td class="num">${b.remainingQty} ${esc(b.unitName)}</td>
          <td class="num">${b.availableQty} ${esc(b.unitName)}</td>
          <td class="muted" style="font-size:12px">${esc(b.supplier || '-')}</td></tr>`).join('')
          : `<tr><td colspan="8">${emptyBox('暂无临期批次')}</td></tr>`}</tbody></table>`;
    } else {
      const rows = d.stock;
      $('#ov-list', el).innerHTML = `<table class="tbl"><thead><tr><th>门店</th><th>耗材</th><th class="num">安全库存</th><th class="num">可用</th><th class="num">冻结</th><th>状态</th></tr></thead>
        <tbody>${rows.map(r => `
          <tr><td>${esc(r.storeName)}</td><td>${esc(r.materialName)}</td>
          <td class="num muted">${r.safetyStock} ${esc(r.unitName)}</td>
          <td class="num"><b>${r.availableQty}</b> ${esc(r.unitName)}</td>
          <td class="num">${r.frozenQty ? `<span style="color:#9a7622">${r.frozenQty}</span>` : '0'} ${esc(r.unitName)}</td>
          <td>${InvUI.stockTag(r)}</td></tr>`).join('')}</tbody></table>`;
    }
  };
  $('#f-store', el).onchange = () => { storeId = $('#f-store', el).value; load(); };
  $('#tab-seg', el).querySelectorAll('button').forEach(b => b.onclick = () => {
    $('#tab-seg', el).querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    tab = b.dataset.t; load();
  });
  load();
},

/* ============ 总部：耗材 / 单位 / 配方标准 ============ */
async 'inventory/master'(el) {
  const [materials, units, recipes] = await Promise.all([
    api.get('/api/inventory/materials'),
    api.get('/api/inventory/units'),
    api.get('/api/inventory/recipes'),
  ]);
  const services = App.ctx.services;
  el.innerHTML = `
    <div class="card mb-16">
      <div class="card-h"><h3>📦 耗材档案 / 单位 / 安全库存</h3>
        <div class="toolbar">
          <button class="btn" id="unit-btn">计量单位（${units.length}）</button>
          <button class="btn btn-gold" id="mat-add">＋ 新增耗材</button>
        </div>
      </div>
      <div class="tbl-wrap">
        <table class="tbl"><thead><tr><th>编号</th><th>耗材名称</th><th>单位</th><th class="num">安全库存</th><th class="num">全品牌在库</th><th>关联配方项目</th><th>状态</th><th></th></tr></thead>
          <tbody id="mat-body">${loading()}</tbody></table>
      </div>
    </div>
    <div class="card">
      <div class="card-h"><h3>📐 服务项目标准耗用配方</h3><span class="sub">开单按配方 FEFO 临期优先原子扣减，库存不足整单失败</span></div>
      <div class="tbl-wrap">
        <table class="tbl"><thead><tr><th>服务项目</th><th>品类</th><th>标准耗用配方</th><th class="num">更新时间</th><th></th></tr></thead>
          <tbody>${recipes.map(r => {
            const svc = services.find(s => s.id === r.serviceId);
            return `<tr ${svc && !svc.active ? 'style="opacity:.55"' : ''}>
              <td><b>${esc(r.serviceName)}</b>${svc && !svc.active ? ' <span class="tag tag-gray">已下架</span>' : ''}</td>
              <td><span class="tag tag-blue">${esc(svc?.category || '-')}</span></td>
              <td>${r.items.length ? r.items.map(it => `<span class="tag tag-green" style="margin:2px">${esc(it.name)} × ${it.qty}${esc(it.unitName)}</span>`).join('') : '<span class="muted">未设置配方（开单不扣库存）</span>'}</td>
              <td class="nowrap muted" style="font-size:12px">${r.updatedAt ? r.updatedAt.slice(5, 16) : '-'}</td>
              <td><button class="btn btn-sm" data-rp="${r.serviceId}">${r.items.length ? '编辑配方' : '设置配方'}</button></td></tr>`;
          }).join('')}</tbody></table>
      </div>
    </div>`;

  const renderMats = () => {
    $('#mat-body', el).innerHTML = materials.map(m => `
      <tr><td class="muted">${m.id}</td><td><b>${esc(m.name)}</b>${m.remark ? `<div class="muted" style="font-size:12px">${esc(m.remark)}</div>` : ''}</td>
      <td>${esc(m.unitName)}</td><td class="num">${m.safetyStock} ${esc(m.unitName)}</td>
      <td class="num">${m.totalQty} ${esc(m.unitName)}${m.totalFrozen ? ` <span class="muted" style="font-size:12px">(冻 ${m.totalFrozen})</span>` : ''}</td>
      <td style="max-width:260px">${m.recipeServices.length ? m.recipeServices.slice(0, 3).map(x => `<span class="tag tag-blue" style="margin:2px">${esc(x.serviceName)}</span>`).join('') + (m.recipeServices.length > 3 ? ` <span class="muted">+${m.recipeServices.length - 3}</span>` : '') : '<span class="muted">—</span>'}</td>
      <td>${m.active ? '<span class="tag tag-green">启用</span>' : '<span class="tag tag-gray">停用</span>'}</td>
      <td class="nowrap"><button class="btn btn-sm" data-edit='${esc(JSON.stringify(m))}'>编辑</button></td></tr>`).join('');
    el.querySelectorAll('[data-edit]').forEach(b => b.onclick = () => matDialog(JSON.parse(b.dataset.edit)));
  };
  renderMats();

  const matDialog = (m = {}) => {
    const mm = openModal({ title: m.id ? '编辑耗材' : '新增耗材',
      body: `<div class="form-row"><div class="form-item"><label><span class="req">*</span>耗材名称</label><input id="f-name" value="${esc(m.name || '')}"></div>
        <div class="form-item"><label><span class="req">*</span>计量单位</label><select id="f-unit">${units.map(u => `<option value="${u.id}" ${u.id === m.unitId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></div></div>
      <div class="form-row"><div class="form-item"><label>安全库存（低于则预警）</label><input type="number" min="0" step="0.01" id="f-safety" value="${m.safetyStock ?? 0}"></div>
        <div class="form-item"><label>状态</label><select id="f-active"><option value="1" ${m.active !== 0 ? 'selected' : ''}>启用</option><option value="0" ${m.active === 0 ? 'selected' : ''}>停用</option></select></div></div>
      <div class="form-row one"><div class="form-item"><label>备注</label><input id="f-remark" value="${esc(m.remark || '')}"></div></div>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="ok">保存并同步全部门店</button>` });
    $('#ok', mm.el).onclick = async () => {
      const body = { name: $('#f-name', mm.el).value.trim(), unitId: $('#f-unit', mm.el).value, safetyStock: Number($('#f-safety', mm.el).value), active: Number($('#f-active', mm.el).value), remark: $('#f-remark', mm.el).value.trim() };
      if (!body.name) return toast('请填写耗材名称', 'error');
      try {
        if (m.id) await api.put('/api/inventory/materials/' + m.id, body); else await api.post('/api/inventory/materials', body);
        toast('耗材档案已同步'); closeModal(); Views.hq['inventory/master'](el);
      } catch (e) { toast(e.message, 'error'); }
    };
  };
  $('#mat-add', el).onclick = () => matDialog();

  $('#unit-btn', el).onclick = () => {
    const um = openModal({ title: '计量单位管理',
      body: `<table class="tbl mb-16"><thead><tr><th>单位</th><th class="num">使用中的耗材数</th></tr></thead>
        <tbody>${units.map(u => `<tr><td>${esc(u.name)}</td><td class="num">${u.materialCount}</td></tr>`).join('')}</tbody></table>
        <div class="form-row"><div class="form-item"><label>新增单位</label><input id="u-name" placeholder="如：盒 / 提 / 箱"></div></div>`,
      footer: `<button class="btn" data-close>关闭</button><button class="btn btn-primary" id="u-ok">新增单位</button>` });
    $('#u-ok', um.el).onclick = async () => {
      try { await api.post('/api/inventory/units', { name: $('#u-name', um.el).value.trim() }); toast('单位已新增'); closeModal(); Views.hq['inventory/master'](el); }
      catch (e) { toast(e.message, 'error'); }
    };
  };

  el.querySelectorAll('[data-rp]').forEach(b => b.onclick = () => recipeDialog(b.dataset.rp));

  function recipeDialog(serviceId) {
    const svc = services.find(s => s.id === serviceId);
    const cur = recipes.find(r => r.serviceId === serviceId);
    let rows = cur ? cur.items.map(it => ({ materialId: it.materialId, qty: it.qty })) : [];
    const rm = openModal({ title: `标准耗用配方 · ${svc.name}`, size: 'lg',
      body: `<p class="muted mb-16" style="font-size:13px">门店每开 1 单「${esc(svc.name)}」将按下列配方扣减耗材；扣减顺序为临期/到期最早批次优先（FEFO）。配方为空则该项目开单不占用耗材库存。</p>
        <table class="tbl"><thead><tr><th>耗材</th><th class="num">每单耗用</th><th></th></tr></thead><tbody id="rp-body"></tbody></table>
        <div style="margin-top:10px"><button type="button" class="btn btn-sm" id="rp-add">＋ 添加耗材</button></div>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="rp-ok">保存配方并下发全部门店</button>` });
    const draw = () => {
      $('#rp-body', rm.el).innerHTML = rows.length ? rows.map((r, i) => `
        <tr data-row="${i}">
          <td><select class="inp rp-mat" style="width:100%"><option value="">选择耗材</option>${InvUI.matOptions(r.materialId)}</select></td>
          <td><input type="number" min="0" step="0.01" class="inp rp-qty" value="${r.qty ?? ''}" style="width:120px"></td>
          <td><button type="button" class="btn btn-sm btn-danger rp-del">删除</button></td></tr>`).join('')
        : `<tr><td colspan="3" class="muted">暂无配方行，该项目开单不扣库存</td></tr>`;
      rm.el.querySelectorAll('[data-row]').forEach(tr => {
        const i = Number(tr.dataset.row);
        $('.rp-mat', tr).onchange = (e) => { rows[i].materialId = e.target.value; };
        $('.rp-qty', tr).oninput = (e) => { rows[i].qty = Number(e.target.value); };
        $('.rp-del', tr).onclick = () => { rows.splice(i, 1); draw(); };
      });
    };
    draw();
    $('#rp-add', rm.el).onclick = () => { rows.push({ materialId: '', qty: 1 }); draw(); };
    $('#rp-ok', rm.el).onclick = async () => {
      const items = rows.filter(r => r.materialId && r.qty > 0);
      try {
        await api.put('/api/inventory/recipes/' + serviceId, { items });
        toast('配方已下发全部门店'); closeModal(); Views.hq['inventory/master'](el);
      } catch (e) { toast(e.message, 'error'); }
    };
  }
},

/* ============ 总部：出入库流水 ============ */
async 'inventory/ledger'(el) {
  const stores = App.ctx.stores;
  const today = new Date().toISOString().slice(0, 10);
  const fromDef = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  el.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>📒 全品牌耗材出入库流水</h3>
        <div class="toolbar">
          <select class="inp" id="f-store">${storeOptions(stores, '', '全部门店')}</select>
          <select class="inp" id="f-type">${InvUI.typeOptions('')}</select>
          <select class="inp" id="f-mat"><option value="">全部耗材</option>${InvUI.matOptions('')}</select>
          <input type="date" class="inp" id="f-from" value="${fromDef}">
          <span class="muted">至</span>
          <input type="date" class="inp" id="f-to" value="${today}">
          <button class="btn btn-primary btn-sm" id="f-go">查询</button>
        </div>
      </div>
      <div id="lg-box" class="tbl-wrap">${loading()}</div>
      <div class="card-b" id="lg-sum" style="background:#fafcfb;border-top:1px solid var(--line)"></div>
    </div>`;
  const load = async () => {
    const qs = new URLSearchParams();
    const sid = $('#f-store', el).value; if (sid) qs.set('storeId', sid);
    const type = $('#f-type', el).value; if (type) qs.set('type', type);
    const mid = $('#f-mat', el).value; if (mid) qs.set('materialId', mid);
    qs.set('from', $('#f-from', el).value); qs.set('to', $('#f-to', el).value); qs.set('limit', 1000);
    const list = await api.get('/api/inventory/ledger?' + qs);
    $('#lg-box', el).innerHTML = InvUI.ledgerTable(list, true);
    const inN = list.filter(x => x.direction === 'in').length, outN = list.filter(x => x.direction === 'out').length;
    $('#lg-sum', el).innerHTML = `<b>共 ${list.length} 条</b> ｜ 入库记录 <b style="color:var(--jade)">${inN}</b> 条 ｜ 出库记录 <b style="color:var(--red)">${outN}</b> 条 ｜ 冻结/解冻 <b>${list.filter(x => ['hold', 'release'].includes(x.direction)).length}</b> 条 <span class="muted" style="margin-left:8px">数量按耗材汇总请切换耗材筛选</span>`;
  };
  $('#f-go', el).onclick = () => load().catch(e => toast(e.message, 'error'));
  load();
},
});

function round1(n) { return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000; }
