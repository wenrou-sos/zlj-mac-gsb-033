/* 门店端 · 库存视图（inv-store.js） */
window.Views = window.Views || {};
Views.store = Object.assign(Views.store || {}, {

/* ============ 门店库存工作台 ============ */
async 'inventory/workbench'(el) {
  const sid = App.session.storeId;
  const d = await api.get(`/api/stores/${sid}/inventory`);
  el.innerHTML = `
    <div class="grid g-4 mb-16">
      <div class="card kpi k-blue"><div class="k-ico">📦</div><div class="k-label">本店耗材品类</div><div class="k-val">${d.kpi.materialTypes}<small> 种</small></div></div>
      <div class="card kpi k-red"><div class="k-ico">⚠️</div><div class="k-label">低库存预警</div><div class="k-val">${d.kpi.lowCount}<small> 项</small></div><div class="k-foot">可用低于安全库存</div></div>
      <div class="card kpi k-gold"><div class="k-ico">⏰</div><div class="k-label">临期/过期批次</div><div class="k-val">${d.kpi.nearExpireCount}<small> 个</small></div><div class="k-foot">30 天内到期</div></div>
      <div class="card kpi k-jade"><div class="k-ico">🔁</div><div class="k-label">待办调拨</div><div class="k-val">${d.kpi.pendingTransferCount}<small> 单</small></div><div class="k-foot">${d.kpi.draftCheck ? `另有盘点单 ${d.kpi.draftCheck.id} 进行中` : '无进行中盘点'}</div></div>
    </div>
    <div class="toolbar mb-16">
      <button class="btn btn-primary" id="go-in">📥 批次入库</button>
      <button class="btn btn-gold" id="go-check">🧮 ${d.kpi.draftCheck ? '继续盘点' : '发起盘点'}</button>
      <button class="btn" id="go-tr">🔁 跨店调拨</button>
      <button class="btn" id="go-batch">🏷️ 批次库存</button>
      <button class="btn" id="go-log">📒 出入库流水</button>
    </div>

    <div class="grid g-2 mb-16">
      <div class="card">
        <div class="card-h"><h3>⚠️ 低库存预警</h3><button class="btn btn-sm" id="go-in2">去补货</button></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>耗材</th><th class="num">安全库存</th><th class="num">当前可用</th><th class="num">冻结</th></tr></thead>
          <tbody>${d.lowAlerts.length ? d.lowAlerts.map(r => `
            <tr><td><b>${esc(r.name)}</b></td><td class="num muted">${r.safetyStock} ${esc(r.unitName)}</td>
            <td class="num"><b style="color:var(--red)">${r.availableQty}</b> ${esc(r.unitName)}</td>
            <td class="num">${r.frozenQty} ${esc(r.unitName)}</td></tr>`).join('')
            : `<tr><td colspan="4">${emptyBox('库存充足，无预警')}</td></tr>`}</tbody></table></div>
      </div>
      <div class="card">
        <div class="card-h"><h3>⏰ 临期 / 过期批次</h3><button class="btn btn-sm" id="go-batch2">全部批次</button></div>
        <div class="tbl-wrap"><table class="tbl"><thead><tr><th>耗材</th><th>批次</th><th>有效期</th><th class="num">可用</th></tr></thead>
          <tbody>${d.expiring.length ? d.expiring.slice(0, 12).map(b => `
            <tr><td>${esc(b.materialName)}</td><td class="nowrap muted">${esc(b.batchNo)}</td>
            <td>${InvUI.expireTag(b)}</td>
            <td class="num">${b.availableQty} ${esc(b.unitName)}</td></tr>`).join('')
            : `<tr><td colspan="4">${emptyBox('30 天内无临期批次')}</td></tr>`}</tbody></table></div>
      </div>
    </div>

    <div class="card">
      <div class="card-h"><h3>🔁 本店相关调拨（最近 20 单）</h3><button class="btn btn-gold btn-sm" id="go-tr2">发起调拨</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>调拨单号</th><th>方向</th><th>对方门店</th><th>状态</th><th class="num">明细数</th><th>时间</th><th></th></tr></thead>
        <tbody>${d.transfers.length ? d.transfers.map(t => `
          <tr><td class="muted">${t.id}</td>
          <td>${t.myRole === 'from' ? '<span class="tag tag-blue">调出</span>' : '<span class="tag tag-gold">调入</span>'}</td>
          <td>${esc(t.myRole === 'from' ? t.toStoreName : t.fromStoreName)}</td>
          <td>${InvUI.transferStatusTag(t.status)}</td>
          <td class="num">${t.items.length}</td><td class="nowrap muted">${t.createdAt.slice(5, 16)}</td>
          <td><button class="btn btn-sm" data-view="${t.id}">处理/查看</button></td></tr>`).join('')
          : `<tr><td colspan="7">${emptyBox('暂无调拨记录')}</td></tr>`}</tbody></table></div>
    </div>`;
  const go = { 'go-in': '#/store/inventory/stockin', 'go-in2': '#/store/inventory/stockin', 'go-check': '#/store/inventory/check',
    'go-tr': '#/store/inventory/transfers', 'go-tr2': '#/store/inventory/transfers', 'go-batch': '#/store/inventory/batches',
    'go-batch2': '#/store/inventory/batches', 'go-log': '#/store/inventory/ledger' };
  Object.entries(go).forEach(([id, hash]) => $('#' + id, el)?.addEventListener('click', () => location.hash = hash));
  el.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    const t = await api.get('/api/inventory/transfers/' + b.dataset.view);
    transferHandleModal(t, () => Views.store['inventory/workbench'](el));
  });
},

/* ============ 批次入库 ============ */
async 'inventory/stockin'(el) {
  const sid = App.session.storeId;
  const today = new Date().toISOString().slice(0, 10);
  const defExpire = new Date(Date.now() + 365 * 864e5).toISOString().slice(0, 10);
  let rows = [{ materialId: '', qty: '', unitCost: '', expireDate: defExpire }];
  el.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>📥 耗材批次入库</h3><span class="sub">同一批次单多明细原子提交；有效期必填，过期拒收</span></div>
      <div class="card-b">
        <div class="form-row">
          <div class="form-item"><label>供应商</label><input id="in-supplier" placeholder="如：杭州养生堂供应链"></div>
          <div class="form-item"><label>入库备注</label><input id="in-remark" placeholder="选填"></div>
        </div>
        <table class="tbl mb-16"><thead><tr><th>耗材</th><th class="num">数量</th><th class="num">单价(元)</th><th>生产日期</th><th>有效期</th><th></th></tr></thead>
          <tbody id="in-body"></tbody></table>
        <div class="toolbar" style="justify-content:space-between">
          <button class="btn btn-sm" id="in-add">＋ 添加明细</button>
          <button class="btn btn-gold" id="in-ok" style="padding:9px 22px">✓ 确认入库</button>
        </div>
      </div>
    </div>`;
  const draw = () => {
    $('#in-body', el).innerHTML = rows.map((r, i) => `
      <tr data-row="${i}">
        <td style="width:30%"><select class="inp in-mat" style="width:100%"><option value="">选择耗材</option>${InvUI.matOptions(r.materialId)}</select></td>
        <td><input type="number" min="0" step="0.01" class="inp in-qty" value="${r.qty}" style="width:110px"></td>
        <td><input type="number" min="0" step="0.01" class="inp in-cost" value="${r.unitCost}" style="width:110px"></td>
        <td><input type="date" class="inp in-prod" value="${r.producedDate || ''}" style="width:150px"></td>
        <td><input type="date" class="inp in-exp" min="${today}" value="${r.expireDate}" style="width:150px"></td>
        <td><button type="button" class="btn btn-sm btn-danger in-del">删除</button></td></tr>`).join('') || `<tr><td colspan="6" class="muted">请添加入库明细</td></tr>`;
    el.querySelectorAll('[data-row]').forEach(tr => {
      const i = Number(tr.dataset.row);
      $('.in-mat', tr).onchange = e => rows[i].materialId = e.target.value;
      $('.in-qty', tr).oninput = e => rows[i].qty = e.target.value;
      $('.in-cost', tr).oninput = e => rows[i].unitCost = e.target.value;
      $('.in-prod', tr).onchange = e => rows[i].producedDate = e.target.value;
      $('.in-exp', tr).onchange = e => rows[i].expireDate = e.target.value;
      $('.in-del', tr).onclick = () => { rows.splice(i, 1); draw(); };
    });
  };
  draw();
  $('#in-add', el).onclick = () => { rows.push({ materialId: '', qty: '', unitCost: '', expireDate: defExpire }); draw(); };
  $('#in-ok', el).onclick = async () => {
    const items = rows.filter(r => r.materialId).map(r => ({
      materialId: r.materialId, qty: Number(r.qty), unitCost: Number(r.unitCost) || 0,
      producedDate: r.producedDate || null, expireDate: r.expireDate,
    }));
    if (!items.length || items.some(x => !(x.qty > 0))) return toast('请完整填写明细（耗材与数量）', 'error');
    if (items.some(x => !x.expireDate)) return toast('每条入库都必须填写有效期', 'error');
    const btn = $('#in-ok', el);
    btn.disabled = true;
    try {
      const r = await api.post('/api/inventory/stockin', {
        $idem: InvUI.idem('stockin'), supplier: $('#in-supplier', el).value.trim(),
        remark: $('#in-remark', el).value.trim(), items,
      });
      toast(`入库成功：${r.batches.length} 个批次已登记`);
      rows = [{ materialId: '', qty: '', unitCost: '', expireDate: defExpire }];
      draw();
    } catch (e) { toast(e.message, 'error'); }
    finally { btn.disabled = false; }
  };
},

/* ============ 批次库存 / 临期查询 ============ */
async 'inventory/batches'(el) {
  el.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>🏷️ 本店批次库存（FEFO 明细）</h3>
        <div class="toolbar">
          <select class="inp" id="f-mat"><option value="">全部耗材</option>${InvUI.matOptions('')}</select>
          <div class="seg" id="f-scope">
            <button class="active" data-s="">全部</button>
            <button data-s="active">有可用</button>
            <button data-s="nearexpire">仅临期/过期</button>
          </div>
        </div>
      </div>
      <div id="b-box" class="tbl-wrap">${loading()}</div>
    </div>`;
  const load = async () => {
    const mid = $('#f-mat', el).value, scope = $('#f-scope', el).dataset.s || '';
    const qs = new URLSearchParams(); if (mid) qs.set('materialId', mid); if (scope) qs.set('scope', scope);
    const list = await api.get('/api/inventory/batches?' + qs);
    $('#b-box', el).innerHTML = `<table class="tbl"><thead><tr><th>批次号</th><th>耗材</th><th class="num">入库量</th><th class="num">现存</th><th class="num">冻结</th><th class="num">可用</th><th>生产日期</th><th>有效期</th><th>状态</th><th>供应商</th></tr></thead>
      <tbody>${list.length ? list.map(b => `
        <tr ${b.expired ? 'style="background:#fdf3f2"' : ''}>
          <td class="nowrap muted">${esc(b.batchNo)}</td><td><b>${esc(b.materialName)}</b></td>
          <td class="num muted">${b.qty} ${esc(b.unitName)}</td>
          <td class="num">${b.remainingQty} ${esc(b.unitName)}</td>
          <td class="num">${b.frozenQty ? `<b style="color:#9a7622">${b.frozenQty}</b>` : '0'} ${esc(b.unitName)}</td>
          <td class="num"><b>${b.availableQty}</b> ${esc(b.unitName)}</td>
          <td class="nowrap muted">${b.producedDate || '-'}</td><td class="nowrap">${b.expireDate}</td>
          <td>${InvUI.expireTag(b)}</td><td class="muted" style="font-size:12px">${esc(b.supplier || '-')}</td></tr>`).join('')
        : `<tr><td colspan="10">${emptyBox('暂无批次')}</td></tr>`}</tbody></table>`;
  };
  $('#f-mat', el).onchange = load;
  $('#f-scope', el).querySelectorAll('button').forEach(b => b.onclick = () => {
    $('#f-scope', el).querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    $('#f-scope', el).dataset.s = b.dataset.s; load();
  });
  load();
},

/* ============ 盘点 ============ */
async 'inventory/check'(el) {
  const list = await api.get('/api/inventory/checks');
  const draft = list.find(c => c.status === 'draft');
  el.innerHTML = `
    <div class="card mb-16">
      <div class="card-h"><h3>🧮 库存盘点</h3>
        <button class="btn btn-gold" id="chk-new" ${draft ? 'disabled' : ''}>＋ 发起新盘点</button></div>
      <div class="card-b">
        ${draft ? `<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap">
          <span class="tag tag-blue">盘点单 ${draft.id} 进行中</span>
          <span class="muted" style="font-size:13px">发起于 ${draft.createdAt.slice(5, 16)}</span>
          <button class="btn btn-primary" id="chk-go">继续录入 / 完成盘点</button>
        </div>` : `<p class="muted" style="font-size:13px;margin:0">盘点单确认时将以当前可用库存（不含调拨冻结）为基准：盘亏按 FEFO 扣减批次、盘盈自动生成盘盈批次；任一明细库存不足以承担盘亏时整单失败。</p>`}
      </div>
    </div>
    <div class="card"><div class="card-h"><h3>📜 盘点记录</h3></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>单号</th><th>状态</th><th class="num">明细数</th><th class="num">盘盈</th><th class="num">盘亏</th><th>发起人</th><th>发起时间</th><th>完成时间</th><th></th></tr></thead>
        <tbody>${list.length ? list.map(c => {
          const gain = c.items.filter(i => i.diff != null && i.diff > 0).length;
          const loss = c.items.filter(i => i.diff != null && i.diff < 0).length;
          return `<tr><td class="muted">${c.id}</td>
            <td>${c.status === 'confirmed' ? '<span class="tag tag-green">已完成</span>' : c.status === 'cancelled' ? '<span class="tag tag-gray">已取消</span>' : '<span class="tag tag-blue">进行中</span>'}</td>
            <td class="num">${c.items.length}</td><td class="num" style="color:var(--jade)">${gain || ''}</td><td class="num" style="color:var(--red)">${loss || ''}</td>
            <td class="nowrap">${esc(c.createdBy)}</td><td class="nowrap muted">${c.createdAt.slice(5, 16)}</td>
            <td class="nowrap muted">${c.confirmedAt ? c.confirmedAt.slice(5, 16) : '-'}</td>
            <td><button class="btn btn-sm" data-view='${esc(JSON.stringify(c))}'>查看</button></td></tr>`;
        }).join('') : `<tr><td colspan="9">${emptyBox('暂无盘点记录')}</td></tr>`}</tbody></table></div>
    </div>`;
  $('#chk-new', el).onclick = async () => {
    try { const c = await api.post('/api/inventory/checks', {}); toast('盘点单已创建：' + c.id); checkEditor(c.id, el); }
    catch (e) { toast(e.message, 'error'); }
  };
  $('#chk-go', el)?.addEventListener('click', () => checkEditor(draft.id, el));
  el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => {
    const c = JSON.parse(b.dataset.view);
    if (c.status === 'draft') checkEditor(c.id, el); else checkDetailModal(c.id);
  });
},

/* ============ 跨店调拨 ============ */
async 'inventory/transfers'(el) {
  const sid = App.session.storeId;
  const list = await api.get('/api/inventory/transfers');
  const fromMe = list.filter(t => t.myRole === 'from');
  const toMe = list.filter(t => t.myRole === 'to');
  el.innerHTML = `
    <div class="card mb-16">
      <div class="card-h"><h3>📥 待我签收 / 处理（调入）</h3>
        <span class="sub">调出店确认后库存冻结，本店签收才完成入库；可拒收并自动解冻</span></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>单号</th><th>调出门店</th><th>明细</th><th>状态</th><th>发起/确认时间</th><th></th></tr></thead>
        <tbody>${toMe.length ? toMe.map(t => `
          <tr><td class="muted">${t.id}</td><td><b>${esc(t.fromStoreName)}</b></td>
          <td>${t.items.map(i => `<span class="tag tag-blue" style="margin:2px">${esc(i.name)} × ${i.qty}${esc(i.unitName)}</span>`).join('')}</td>
          <td>${InvUI.transferStatusTag(t.status)}</td>
          <td class="nowrap muted" style="font-size:12px">${t.createdAt.slice(5, 16)}${t.confirmedAt ? '<br>' + t.confirmedAt.slice(5, 16) : ''}</td>
          <td class="nowrap">
            ${t.status === 'frozen' ? `<button class="btn btn-sm btn-primary" data-rcv="${t.id}">签收</button> <button class="btn btn-sm btn-danger" data-ref="${t.id}">拒收</button>` : `<button class="btn btn-sm" data-view="${t.id}">查看</button>`}
          </td></tr>`).join('')
          : `<tr><td colspan="6">${emptyBox('暂无调入记录')}</td></tr>`}</tbody></table></div>
    </div>
    <div class="card">
      <div class="card-h"><h3>📤 我发起的调拨（调出）</h3>
        <button class="btn btn-gold" id="tr-new">＋ 发起跨店调拨</button></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>单号</th><th>调入门店</th><th>明细</th><th>状态</th><th>发起时间</th><th>确认时间</th><th></th></tr></thead>
        <tbody>${fromMe.length ? fromMe.map(t => `
          <tr><td class="muted">${t.id}</td><td><b>${esc(t.toStoreName)}</b></td>
          <td>${t.items.map(i => `<span class="tag tag-blue" style="margin:2px">${esc(i.name)} × ${i.qty}${esc(i.unitName)}</span>`).join('')}</td>
          <td>${InvUI.transferStatusTag(t.status)}</td>
          <td class="nowrap muted">${t.createdAt.slice(5, 16)}</td>
          <td class="nowrap muted">${t.confirmedAt ? t.confirmedAt.slice(5, 16) : '-'}</td>
          <td class="nowrap">
            ${t.status === 'requested' ? `<button class="btn btn-sm btn-primary" data-cfm="${t.id}">确认并冻结</button> <button class="btn btn-sm" data-cancel="${t.id}">取消</button>`
              : t.status === 'frozen' ? `<span class="muted" style="font-size:12px">等待对方签收</span>`
              : `<button class="btn btn-sm" data-view="${t.id}">查看</button>`}
          </td></tr>`).join('')
          : `<tr><td colspan="7">${emptyBox('暂无调出记录')}</td></tr>`}</tbody></table></div>
    </div>`;

  $('#tr-new', el).onclick = () => transferCreateDialog(() => Views.store['inventory/transfers'](el));
  el.querySelectorAll('[data-view]').forEach(b => b.onclick = async () => {
    const t = await api.get('/api/inventory/transfers/' + b.dataset.view);
    transferHandleModal(t, () => Views.store['inventory/transfers'](el));
  });
  el.querySelectorAll('[data-cfm]').forEach(b => b.onclick = async () => {
    if (!await confirmAsync('确认后将按临期优先（FEFO）冻结对应批次库存，冻结期间不可用于开单。是否确认调拨？', '确认冻结', false)) return;
    try { await api.post(`/api/inventory/transfers/${b.dataset.cfm}/confirm`, { $idem: InvUI.idem('tcfm') }); toast('已冻结，等待调入店签收'); Views.store['inventory/transfers'](el); }
    catch (e) { toast(e.message, 'error'); }
  });
  el.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    const reason = await promptText('取消原因（选填）', '');
    if (reason === null) return;
    try { await api.post(`/api/inventory/transfers/${b.dataset.cancel}/cancel`, { reason }); toast('调拨已取消'); Views.store['inventory/transfers'](el); }
    catch (e) { toast(e.message, 'error'); }
  });
  el.querySelectorAll('[data-rcv]').forEach(b => b.onclick = async () => {
    if (!await confirmAsync('确认签收？签收后调出店批次将完成扣减，本店按原批次生产/有效期入库。', '确认签收', false)) return;
    try { await api.post(`/api/inventory/transfers/${b.dataset.rcv}/receive`, { $idem: InvUI.idem('trcv') }); toast('签收成功，库存已入本店'); Views.store['inventory/transfers'](el); }
    catch (e) { toast(e.message, 'error'); }
  });
  el.querySelectorAll('[data-ref]').forEach(b => b.onclick = async () => {
    const reason = await promptText('拒收原因（将通知调出店并解冻库存）', '暂时用不上');
    if (reason === null) return;
    try { await api.post(`/api/inventory/transfers/${b.dataset.ref}/refuse`, { reason }); toast('已拒收，对方库存已解冻'); Views.store['inventory/transfers'](el); }
    catch (e) { toast(e.message, 'error'); }
  });
},

/* ============ 本店出入库流水 ============ */
async 'inventory/ledger'(el) {
  const today = new Date().toISOString().slice(0, 10);
  const fromDef = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  el.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>📒 本店耗材出入库流水</h3>
        <div class="toolbar">
          <select class="inp" id="f-type">${InvUI.typeOptions('')}</select>
          <select class="inp" id="f-mat"><option value="">全部耗材</option>${InvUI.matOptions('')}</select>
          <input type="date" class="inp" id="f-from" value="${fromDef}">
          <span class="muted">至</span>
          <input type="date" class="inp" id="f-to" value="${today}">
          <button class="btn btn-primary btn-sm" id="f-go">查询</button>
        </div>
      </div>
      <div id="lg-box" class="tbl-wrap">${loading()}</div>
    </div>`;
  const load = async () => {
    const qs = new URLSearchParams();
    const type = $('#f-type', el).value; if (type) qs.set('type', type);
    const mid = $('#f-mat', el).value; if (mid) qs.set('materialId', mid);
    qs.set('from', $('#f-from', el).value); qs.set('to', $('#f-to', el).value); qs.set('limit', 1000);
    const list = await api.get('/api/inventory/ledger?' + qs);
    $('#lg-box', el).innerHTML = InvUI.ledgerTable(list, false);
  };
  $('#f-go', el).onclick = () => load().catch(e => toast(e.message, 'error'));
  load();
},
});

/* ---------------- 盘点编辑器（草稿） ---------------- */
async function checkEditor(id, rootEl) {
  let c = await api.get('/api/inventory/checks/' + id);
  const m = openModal({ title: `盘点录入 · ${c.id}`, size: 'xl',
    body: `<p class="muted mb-16" style="font-size:13px">请按实际盘点填写每项数量（留空表示未盘）。差异 = 实盘 − 系统可用；提交时盘亏按临期优先扣减。</p>
      <div class="toolbar mb-16">
        <button class="btn btn-sm" id="ck-fillall">一键全部按系统数填充</button>
        <input class="inp" id="ck-q" placeholder="筛选耗材名" style="margin-left:auto;width:200px">
      </div>
      <div style="max-height:52vh;overflow:auto;border:1px solid var(--line);border-radius:10px">
      <table class="tbl"><thead style="position:sticky;top:0"><tr><th>耗材</th><th class="num">系统可用</th><th class="num">实盘数量</th><th class="num">差异</th></tr></thead>
        <tbody id="ck-body"></tbody></table></div>
      <p id="ck-progress" class="muted" style="font-size:12.5px;margin-top:8px"></p>`,
    footer: `<button class="btn btn-danger" id="ck-cancel" style="margin-right:auto">作废盘点单</button>
      <button class="btn" data-close>关闭（保留草稿）</button>
      <button class="btn btn-gold" id="ck-ok">✓ 确认盘点结果并调账</button>` });

  const diffColor = (d) => d > 0 ? 'color:var(--jade)' : d < 0 ? 'color:var(--red)' : '';
  const draw = () => {
    const q = $('#ck-q', m.el).value.trim();
    const items = q ? c.items.filter(i => i.name.includes(q)) : c.items;
    $('#ck-body', m.el).innerHTML = items.map(i => `
      <tr data-mat="${i.materialId}">
        <td><b>${esc(i.name)}</b></td><td class="num muted">${i.systemQty} ${esc(i.unitName)}</td>
        <td class="num"><input type="number" min="0" step="0.01" class="inp ck-actual" value="${i.actualQty ?? ''}" style="width:130px;text-align:right"></td>
        <td class="num ck-diff" style="font-weight:650;${diffColor(i.diff)}">${i.diff == null ? '—' : (i.diff > 0 ? '+' : '') + i.diff + ' ' + esc(i.unitName)}</td>
      </tr>`).join('');
    m.el.querySelectorAll('[data-mat]').forEach(tr => {
      const mid = tr.dataset.mat;
      $('.ck-actual', tr).oninput = (e) => {
        const it = c.items.find(x => x.materialId === mid);
        it.actualQty = e.target.value === '' ? null : Number(e.target.value);
        const d = it.actualQty == null ? null : Math.round((it.actualQty - it.systemQty) * 1000) / 1000;
        const td = $('.ck-diff', tr);
        td.textContent = d == null ? '—' : (d > 0 ? '+' : '') + d + ' ' + it.unitName;
        td.style = 'font-weight:650;' + diffColor(d);
        updateProgress();
      };
    });
    updateProgress();
  };
  const updateProgress = () => {
    const done = c.items.filter(i => i.actualQty != null).length;
    const gain = c.items.filter(i => i.diff > 0).length, loss = c.items.filter(i => i.diff < 0).length;
    $('#ck-progress', m.el).textContent = `已盘 ${done}/${c.items.length} 项 ｜ 盘盈 ${gain} 项 ｜ 盘亏 ${loss} 项`;
  };
  $('#ck-q', m.el).oninput = draw;
  $('#ck-fillall', m.el).onclick = () => { c.items.forEach(i => { i.actualQty = i.systemQty; }); draw(); };
  $('#ck-cancel', m.el).onclick = async () => {
    if (!await confirmAsync('确定作废该盘点单？已录入数据将不生效。', '作废')) return;
    try { await api.post(`/api/inventory/checks/${id}/cancel`, {}); toast('盘点单已作废'); closeModal(); rootEl ? Views.store['inventory/check'](rootEl) : null; }
    catch (e) { toast(e.message, 'error'); }
  };
  $('#ck-ok', m.el).onclick = async () => {
    const missing = c.items.filter(i => i.actualQty == null).length;
    if (missing > 0 && !await confirmAsync(`还有 ${missing} 项未盘，未盘项将按系统数量提交。是否继续？`, '继续提交', false)) return;
    const btn = $('#ck-ok', m.el); btn.disabled = true;
    try {
      const items = c.items.map(i => ({ materialId: i.materialId, actualQty: i.actualQty == null ? i.systemQty : i.actualQty }));
      const r = await api.post(`/api/inventory/checks/${id}/confirm`, { $idem: InvUI.idem('ckcfm'), items });
      const gain = r.check.items.filter(i => i.diff > 0).length, loss = r.check.items.filter(i => i.diff < 0).length;
      toast(`盘点完成：盘盈 ${gain} 项 / 盘亏 ${loss} 项，库存已调整`);
      closeModal(); if (rootEl) Views.store['inventory/check'](rootEl);
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  };
  draw();
}

async function checkDetailModal(id) {
  const c = await api.get('/api/inventory/checks/' + id);
  openModal({ title: `盘点单 ${c.id} · ${c.status === 'confirmed' ? '已完成' : '已取消'}`, size: 'lg',
    body: `<table class="tbl"><thead><tr><th>耗材</th><th class="num">系统可用</th><th class="num">实盘</th><th class="num">差异</th></tr></thead>
      <tbody>${c.items.map(i => `
        <tr><td>${esc(i.name)}</td><td class="num muted">${i.systemQty} ${esc(i.unitName)}</td>
        <td class="num">${i.actualQty ?? '-'} ${esc(i.unitName)}</td>
        <td class="num" style="font-weight:650;${i.diff > 0 ? 'color:var(--jade)' : i.diff < 0 ? 'color:var(--red)' : ''}">${i.diff == null ? '—' : (i.diff > 0 ? '+' : '') + i.diff} ${esc(i.unitName)}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted" style="font-size:12.5px;margin-top:10px">完成于 ${c.confirmedAt || '-'} ｜ ${esc(c.confirmedBy || '')} ｜ ${esc(c.remark || '')}</p>`,
    footer: `<button class="btn btn-primary" data-close>关 闭</button>` });
}

/* ---------------- 调拨：发起弹窗 ---------------- */
function transferCreateDialog(onDone) {
  const sid = App.session.storeId;
  let rows = [{ materialId: '', qty: '' }];
  const m = openModal({ title: '发起跨店调拨', size: 'lg',
    body: `<div class="form-row one mb-16"><div class="form-item"><label><span class="req">*</span>调入门店</label>
        <select id="tr-to" class="inp">${InvUI.storeOptions('', sid)}</select></div></div>
      <table class="tbl mb-16"><thead><tr><th>耗材</th><th class="num">调拨数量</th><th>本店可用</th><th></th></tr></thead><tbody id="tr-body"></tbody></table>
      <div class="form-row one"><div class="form-item"><label>备注</label><textarea id="tr-remark" placeholder="如：旺季支援、应急补给"></textarea></div></div>
      <p class="muted" style="font-size:12.5px">提交后状态为「待确认」，需本店确认后冻结库存；对方签收才完成扣减，取消/拒收自动解冻。</p>`,
    footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="tr-ok">发起调拨</button>` });
  const draw = () => {
    $('#tr-body', m.el).innerHTML = rows.map((r, i) => `
      <tr data-row="${i}">
        <td style="width:46%"><select class="inp tr-mat" style="width:100%"><option value="">选择耗材</option>${InvUI.matOptions(r.materialId)}</select></td>
        <td><input type="number" min="0" step="0.01" class="inp tr-qty" value="${r.qty}" style="width:120px"></td>
        <td class="tr-avail muted" style="font-size:12.5px"></td>
        <td><button type="button" class="btn btn-sm btn-danger tr-del">删除</button></td></tr>`).join('');
    m.el.querySelectorAll('[data-row]').forEach(tr => {
      const i = Number(tr.dataset.row);
      const matSel = $('.tr-mat', tr);
      const refreshAvail = async () => {
        const mid = matSel.value;
        rows[i].materialId = mid;
        if (!mid) { $('.tr-avail', tr).textContent = ''; return; }
        const bs = await api.get('/api/inventory/batches?materialId=' + mid);
        const avail = bs.reduce((a, b) => a + b.availableQty, 0);
        const unit = InvUI.unitName(InvUI.mat(mid).unitId);
        $('.tr-avail', tr).innerHTML = `可用 <b style="color:var(--teal-800)">${Math.round(avail * 1000) / 1000}</b> ${esc(unit)}`;
      };
      matSel.onchange = refreshAvail;
      $('.tr-qty', tr).oninput = e => rows[i].qty = e.target.value;
      $('.tr-del', tr).onclick = () => { rows.splice(i, 1); draw(); };
      if (rows[i].materialId) { matSel.value = rows[i].materialId; refreshAvail(); }
    });
  };
  draw();
  const addBtn = h(`<button type="button" class="btn btn-sm" style="margin-bottom:12px">＋ 添加耗材</button>`);
  addBtn.onclick = () => { rows.push({ materialId: '', qty: '' }); draw(); };
  $('.modal-b', m.el).appendChild(addBtn);
  $('#tr-ok', m.el).onclick = async () => {
    const toStoreId = $('#tr-to', m.el).value;
    const items = rows.filter(r => r.materialId).map(r => ({ materialId: r.materialId, qty: Number(r.qty) }));
    if (!toStoreId) return toast('请选择调入门店', 'error');
    if (!items.length || items.some(x => !(x.qty > 0))) return toast('请完整填写调拨耗材与数量', 'error');
    try {
      const t = await api.post('/api/inventory/transfers', { $idem: InvUI.idem('trnew'), toStoreId, items, remark: $('#tr-remark', m.el).value.trim() });
      toast(`调拨单 ${t.id} 已发起，等待本店确认`); closeModal(); onDone?.();
    } catch (e) { toast(e.message, 'error'); }
  };
}

/* 调拨查看/处理弹窗（详情 + 按状态给出操作） */
function transferHandleModal(t, onDone) {
  InvUI.transferDetail(t);
  const modal = $('.modal-mask');
  const foot = $('.modal-f', modal);
  const btns = [];
  if (t.myRole === 'from' && t.status === 'requested') {
    btns.push(`<button class="btn btn-danger" data-act="cancel">取消调拨</button>`);
    btns.push(`<button class="btn btn-primary" data-act="confirm">确认并冻结</button>`);
  }
  if (t.myRole === 'from' && t.status === 'frozen') {
    btns.push(`<button class="btn btn-danger" data-act="reject">撤回并解冻</button>`);
  }
  if (t.myRole === 'to' && t.status === 'frozen') {
    btns.push(`<button class="btn btn-danger" data-act="refuse">拒收（解冻）</button>`);
    btns.push(`<button class="btn btn-primary" data-act="receive">确认签收</button>`);
  }
  if (btns.length) {
    foot.innerHTML = btns.join('') + `<button class="btn" data-close>关 闭</button>`;
    foot.querySelectorAll('[data-act]').forEach(b => b.onclick = async () => {
      const act = b.dataset.act;
      try {
        if (act === 'confirm') { await api.post(`/api/inventory/transfers/${t.id}/confirm`, { $idem: InvUI.idem('tcfm') }); toast('已冻结'); }
        else if (act === 'receive') { await api.post(`/api/inventory/transfers/${t.id}/receive`, { $idem: InvUI.idem('trcv') }); toast('签收完成'); }
        else if (act === 'refuse') { await api.post(`/api/inventory/transfers/${t.id}/refuse`, { reason: '门店拒收' }); toast('已拒收并解冻'); }
        else if (act === 'reject') { await api.post(`/api/inventory/transfers/${t.id}/reject`, { reason: '调出店撤回' }); toast('已撤回并解冻'); }
        else if (act === 'cancel') { await api.post(`/api/inventory/transfers/${t.id}/cancel`, {}); toast('已取消'); }
        closeModal(); onDone?.();
      } catch (e) { toast(e.message, 'error'); }
    });
  }
}

/* 简易输入弹窗（用于取消/拒收原因） */
function promptText(title, def = '') {
  return new Promise(resolve => {
    const m = openModal({ title, body: `<input class="inp" id="pt-input" value="${esc(def)}" style="width:100%">`,
      footer: `<button class="btn" data-c="0">取消</button><button class="btn btn-primary" data-c="1">确定</button>` });
    setTimeout(() => $('#pt-input', m.el)?.focus(), 0);
    m.el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => {
      const v = b.dataset.c === '1' ? $('#pt-input', m.el).value.trim() : null;
      closeModal(); resolve(v);
    });
  });
}
