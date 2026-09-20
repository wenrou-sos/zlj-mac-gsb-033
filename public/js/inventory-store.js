/* 门店端：耗材库存视图（工作台 / 入库 / 盘点 / 调拨 / 流水） */
window.Views = window.Views || {};
Object.assign(Views.store, {

/* ============ 门店库存工作台 ============ */
async 'inventory'(el) {
  const sid = App.session.storeId;
  const ov = await api.get(`/api/stores/${sid}/inventory/overview`);
  el.innerHTML = `
    <div class="toolbar mb-16" style="justify-content:space-between">
      <div style="font-size:13px;color:var(--text-2)">本店实时库存（含冻结/临期状态），点击右侧按钮办理业务</div>
      <div class="toolbar">
        <button class="btn btn-gold" id="go-inbound">📥 耗材入库</button>
        <button class="btn btn-primary" id="go-check">🧮 发起盘点</button>
        <button class="btn" id="go-transfer">🔀 跨店调拨</button>
      </div>
    </div>
    <div class="grid g-4 mb-16">
      <div class="card kpi k-jade"><div class="k-ico">🧴</div><div class="k-label">在管耗材</div><div class="k-val">${ov.kpi.skuCount}<small> 种</small></div></div>
      <div class="card kpi k-red"><div class="k-ico">⚠️</div><div class="k-label">低库存预警</div><div class="k-val">${ov.kpi.lowCount}<small> 项</small></div><div class="k-foot">可用低于安全库存</div></div>
      <div class="card kpi k-gold"><div class="k-ico">⏳</div><div class="k-label">临期 / 过期批次</div><div class="k-val">${ov.kpi.nearCount}<small> / </small>${ov.kpi.expiredCount}</div><div class="k-foot">30 天内到期 / 已过期</div></div>
      <div class="card kpi k-blue"><div class="k-ico">🔀</div><div class="k-label">待处理调拨</div><div class="k-val">${ov.kpi.pendingIn + ov.kpi.pendingOut + ov.kpi.frozenOut}<small> 单</small></div><div class="k-foot">调入 ${ov.kpi.pendingIn} · 待确认 ${ov.kpi.pendingOut} · 冻结 ${ov.kpi.frozenOut}</div></div>
    </div>

    ${ov.pendingIn.length || ov.pendingOut.length || ov.frozenOut.length ? `
    <div class="card mb-16" style="border-color:#d8c89a;background:linear-gradient(120deg,#fffdf6,#fcf9ef)">
      <div class="card-h"><h3>🚨 调拨待办</h3></div>
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>单号</th><th>方向</th><th>对方门店</th><th>耗材</th><th>状态</th><th></th></tr></thead>
        <tbody>${[...ov.pendingIn, ...ov.pendingOut, ...ov.frozenOut].map(t => `
          <tr><td class="muted nowrap" style="font-size:11.5px">${t.transferNo}</td>
          <td>${t.toStoreId === sid ? '<span class="tag tag-blue">调入</span>' : '<span class="tag tag-gold">调出</span>'} ${t.direction === 'in' ? '<span class="muted" style="font-size:11px">请货</span>' : ''}</td>
          <td>${esc(t.toStoreId === sid ? t.fromStoreName : t.toStoreName)}</td>
          <td>${esc(t.materialName)} <b>${t.qty}${esc(t.unit)}</b></td>
          <td>${transferStatusTag(t.status)}</td>
          <td class="nowrap"><button class="btn btn-sm btn-primary" data-t="${t.id}">处 理</button></td></tr>`).join('')}
      </tbody></table></div>
    </div>` : ''}

    <div class="grid g-2 mb-16">
      <div class="card"><div class="card-h"><h3>⚠️ 低库存 / 临期预警</h3>
        <button class="btn btn-sm" id="go-inbound2">补货入库</button></div>
        <div class="tbl-wrap">
          <table class="tbl"><thead><tr><th>耗材</th><th class="num">可用</th><th class="num">安全库存</th><th>批次情况</th></tr></thead>
            <tbody>${ov.rows.filter(r => r.low || r.expiredQty > 0 || r.nearExpireQty > 0).length ? ov.rows.filter(r => r.low || r.expiredQty > 0 || r.nearExpireQty > 0).map(r => `
              <tr><td><b>${esc(r.name)}</b> <span class="muted">${esc(r.unit)}</span><br>
                <span style="font-size:11px">${r.low ? '<span class="tag tag-red">低库存</span> ' : ''}${r.expiredQty > 0 ? '<span class="tag tag-red">过期 ' + r.expiredQty + '</span> ' : ''}${r.nearExpireQty > 0 ? '<span class="tag tag-gold">临期 ' + r.nearExpireQty + '</span>' : ''}</span></td>
              <td class="num"><b style="color:${r.low ? 'var(--red)' : 'var(--ink)'}">${r.available}</b></td>
              <td class="num muted">${r.safetyStock}</td>
              <td class="num muted">${r.batchCount} 批${r.frozen ? ' · 冻 ' + r.frozen : ''}</td></tr>`).join('')
              : `<tr><td colspan="4">${emptyBox('库存健康，暂无预警 🎉')}</td></tr>`}</tbody></table>
        </div></div>
      <div class="card"><div class="card-h"><h3>⏳ 临期 / 过期批次</h3><span class="sub">开单按临期优先消耗</span></div>
        <div class="tbl-wrap">
          <table class="tbl"><thead><tr><th>批次</th><th>耗材</th><th>到期日</th><th class="num">可用</th></tr></thead>
            <tbody>${[...ov.expiredBatches, ...ov.nearExpireBatches].length ? [...ov.expiredBatches, ...ov.nearExpireBatches].slice(0, 30).map(b => `
              <tr><td class="muted nowrap" style="font-size:11.5px">${esc(b.batchNo)}</td>
              <td>${esc(b.materialName)}</td>
              <td>${b.expired ? '<span class="tag tag-red">已过期 ' + b.expireDate + '</span>' : `<span class="tag tag-gold">${b.expireDate}（${b.daysToExpire}天）</span>`}</td>
              <td class="num"><b>${b.available}${esc(b.unit)}</b>${b.frozen ? `<div class="muted" style="font-size:11px">冻 ${b.frozen}</div>` : ''}</td></tr>`).join('')
              : `<tr><td colspan="4">${emptyBox('暂无临期/过期批次')}</td></tr>`}</tbody></table>
        </div></div>
    </div>

    <div class="card">
      <div class="card-h"><h3>📦 本店库存清单</h3>
        <div class="toolbar">
          <input class="inp" id="inv-q" placeholder="搜索耗材" style="width:160px">
          <div class="seg" id="inv-seg"><button class="active" data-f="">全部</button><button data-f="low">低库存</button><button data-f="warn">有临期/过期</button></div>
        </div></div>
      <div class="tbl-wrap" id="inv-tbl"></div>
    </div>`;

  const renderRows = () => {
    const q = $('#inv-q', el).value.trim();
    const f = $('#inv-seg', el).querySelector('button.active').dataset.f;
    let rows = ov.rows;
    if (q) rows = rows.filter(r => r.name.includes(q) || r.category.includes(q));
    if (f === 'low') rows = rows.filter(r => r.low);
    if (f === 'warn') rows = rows.filter(r => r.expiredQty > 0 || r.nearExpireQty > 0);
    $('#inv-tbl', el).innerHTML = rows.length ? `<table class="tbl"><thead><tr><th>耗材</th><th>分类</th><th class="num">账面总量</th><th class="num">冻结中</th><th class="num">可用</th><th class="num">安全库存</th><th class="num">批次</th><th>状态</th><th></th></tr></thead>
      <tbody>${rows.map(r => `
        <tr><td><b>${esc(r.name)}</b></td><td class="muted">${esc(r.category)}</td>
        <td class="num">${r.quantity}${esc(r.unit)}</td>
        <td class="num" style="color:var(--blue)">${r.frozen ? r.frozen : '—'}</td>
        <td class="num"><b>${r.available}${esc(r.unit)}</b></td>
        <td class="num muted">${r.safetyStock}</td>
        <td class="num">${r.batchCount}</td>
        <td>${r.low ? '<span class="tag tag-red">低库存</span>' : '<span class="tag tag-green">正常</span>'}${r.nearExpireQty > 0 ? '<span class="tag tag-gold">临期</span>' : ''}${r.expiredQty > 0 ? '<span class="tag tag-red">过期</span>' : ''}</td>
        <td class="nowrap"><button class="btn btn-sm" data-b="${r.materialId}">批次明细</button></td></tr>`).join('')}
      </tbody></table>`
      : emptyBox('无符合条件的耗材');
    el.querySelectorAll('[data-b]').forEach(b => b.onclick = () => batchDialog(b.dataset.b));
  };
  $('#inv-q', el).oninput = debounce(renderRows, 200);
  $('#inv-seg', el).querySelectorAll('button').forEach(b => b.onclick = () => {
    $('#inv-seg', el).querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); renderRows();
  });
  renderRows();
  ['#go-inbound', '#go-inbound2'].forEach(s => $(s, el)?.addEventListener('click', () => location.hash = '#/store/inbound'));
  $('#go-check', el).onclick = () => location.hash = '#/store/stock-check';
  $('#go-transfer', el).onclick = () => location.hash = '#/store/transfers';
  el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { location.hash = '#/store/transfers'; setTimeout(() => openTransferById(b.dataset.t), 350); });
},

/* ============ 耗材入库 ============ */
async 'inbound'(el) {
  const materials = App.ctx.materials.filter(m => m.active);
  const today = new Date().toISOString().slice(0, 10);
  el.innerHTML = `
    <div class="grid g-2" style="grid-template-columns:420px 1fr;align-items:start">
      <div class="card">
        <div class="card-h"><h3>📥 批次入库</h3><span class="sub">每个明细生成独立批次</span></div>
        <div class="card-b">
          <div class="form-row">
            <div class="form-item"><label>供应商</label><input id="in-supplier" value="总部集采"></div>
            <div class="form-item"><label>入库日期</label><input type="date" id="in-date" value="${today}"></div>
          </div>
          <div class="form-item mb-16"><label>备注</label><input id="in-note" placeholder="如：采购单号、经手说明"></div>
          <h4 style="font-size:13.5px;margin:4px 0 8px">入库明细</h4>
          <div id="in-rows"></div>
          <button class="btn btn-sm mb-16" id="in-add" style="width:100%">＋ 添加耗材行</button>
          <button class="btn btn-gold" style="width:100%;justify-content:center;padding:11px" id="in-submit">✓ 确认入库</button>
          <p class="muted" style="font-size:12px;margin-top:8px">入库成功后立即增加批次库存并写入流水；重复提交（网络重试）不会重复入库。</p>
        </div>
      </div>
      <div class="card">
        <div class="card-h"><h3>📋 近期入库记录</h3></div>
        <div class="tbl-wrap" id="in-list">${loading()}</div>
      </div>
    </div>`;

  let rowSeq = 0;
  const addRow = (v = {}) => {
    const rid = 'r' + (++rowSeq);
    const div = h(`<div class="in-row" style="border:1px solid var(--line);border-radius:10px;padding:10px;margin-bottom:8px;position:relative">
      <div class="form-row" style="margin-bottom:8px">
        <div class="form-item"><label><span class="req">*</span>耗材</label>
          <select class="in-mat">${materials.map(m => `<option value="${m.id}" ${v.mat === m.id ? 'selected' : ''}>${esc(m.name)}（${esc(m.unit)}）</option>`).join('')}</select></div>
        <div class="form-item"><label><span class="req">*</span>数量</label><input type="number" min="0" step="0.001" class="in-qty inp" value="${v.qty ?? ''}" placeholder="入库数量"></div>
      </div>
      <div class="form-row" style="margin-bottom:0">
        <div class="form-item"><label>到期日（选填）</label><input type="date" class="in-exp inp" value="${v.exp || ''}"></div>
        <div class="form-item"><label>生产日期（选填）</label><input type="date" class="in-prod inp" value=""></div>
      </div>
      <button class="btn btn-sm btn-danger in-del" style="position:absolute;right:8px;top:8px">删除</button>
    </div>`);
    $('.in-del', div).onclick = () => div.remove();
    $('#in-rows', el).appendChild(div);
  };
  addRow();
  $('#in-add', el).onclick = () => addRow();

  $('#in-submit', el).onclick = async () => {
    const rows = [...el.querySelectorAll('.in-row')].map(d => ({
      materialId: $('.in-mat', d).value,
      qty: Number($('.in-qty', d).value),
      expireDate: $('.in-exp', d).value || null,
      productionDate: $('.in-prod', d).value || null,
    })).filter(r => r.qty > 0);
    if (!rows.length) return toast('请填写至少一条有效入库明细（数量 > 0）', 'error');
    if (rows.some(r => r.expireDate && r.expireDate < $('#in-date', el).value)) {
      if (!await confirmAsync('存在到期日早于入库日期的批次，是否继续？', '继续入库')) return;
    }
    const btn = $('#in-submit', el);
    btn.disabled = true;
    try {
      const r = await api.post('/api/stock-inbounds', {
        supplier: $('#in-supplier', el).value.trim() || '总部集采',
        receivedDate: $('#in-date', el).value,
        note: $('#in-note', el).value.trim(),
        items: rows,
        clientReqId: 'IN-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      });
      toast(r.idempotent ? '该入库已提交（幂等）' : `入库成功：${r.items.length} 个批次`);
      Views.store.inbound(el);
    } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
  };

  const list = await api.get('/api/stock-inbounds');
  $('#in-list', el).innerHTML = list.length ? `<table class="tbl"><thead><tr><th>入库单号</th><th>时间</th><th>供应商</th><th>明细</th><th>经办人</th></tr></thead>
    <tbody>${list.slice(0, 50).map(x => `
      <tr><td class="muted nowrap">${x.id}</td><td class="nowrap muted">${x.receivedDate} ${x.createdAt.slice(11, 16)}</td>
      <td>${esc(x.supplier)}</td>
      <td>${x.items.map(i => { const m = App.ctx.materials.find(z => z.id === i.materialId); return `<span class="tag tag-green" style="margin:1px">${esc(m?.name)} ${i.qty}${esc(m?.unit)}</span>`; }).join('')}</td>
      <td class="nowrap">${esc(x.operator)}</td></tr>`).join('')}</tbody></table>`
    : emptyBox('暂无入库记录');
},

/* ============ 库存盘点 ============ */
async 'stock-check'(el) {
  el.innerHTML = `
    <div class="card mb-16">
      <div class="card-h"><h3>🧮 库存盘点</h3>
        <div class="toolbar"><span class="muted" style="font-size:12.5px">系统按账面生成快照（含冻结量），实物盘点后录入实盘数，盘盈/盘亏按临期批次调整并留痕</span>
        <button class="btn btn-gold" id="ck-new">＋ 发起盘点</button></div></div>
      <div class="tbl-wrap" id="ck-list">${loading()}</div>
    </div>`;
  const load = async () => {
    const list = await api.get('/api/stock-checks');
    $('#ck-list', el).innerHTML = list.length ? `<table class="tbl"><thead><tr><th>盘点单号</th><th>创建时间</th><th>状态</th><th class="num">差异项</th><th>确认时间</th><th>经办人</th><th></th></tr></thead>
      <tbody>${list.map(x => `
        <tr><td class="muted">${x.id}</td><td class="nowrap muted">${x.createdAt.slice(5, 16)}</td>
        <td>${x.status === 'confirmed' ? '<span class="tag tag-green">已确认</span>' : '<span class="tag tag-blue">盘点中（草稿）</span>'}</td>
        <td class="num">${x.diffCount || 0}</td>
        <td class="nowrap muted">${x.confirmedAt ? x.confirmedAt.slice(5, 16) : '—'}</td>
        <td class="nowrap">${esc(x.operator)}</td>
        <td class="nowrap">${x.status === 'draft'
          ? `<button class="btn btn-sm btn-primary" data-go="${x.id}">继续盘点</button> <button class="btn btn-sm btn-danger" data-del="${x.id}">作废</button>`
          : `<button class="btn btn-sm" data-view="${x.id}">查看</button>`}</td></tr>`).join('')}</tbody></table>`
      : emptyBox('暂无盘点单');
    el.querySelectorAll('[data-view]').forEach(b => b.onclick = () => checkViewDialog(b.dataset.view));
    el.querySelectorAll('[data-del]').forEach(b => b.onclick = async () => {
      if (await confirmAsync('确定作废这张未提交的盘点单？', '作废')) {
        await api.del('/api/stock-checks/' + b.dataset.del); toast('已作废'); load();
      }
    });
    el.querySelectorAll('[data-go]').forEach(b => b.onclick = () => checkCountDialog(b.dataset.go, el, load));
  };
  $('#ck-new', el).onclick = async () => {
    try {
      const ck = await api.post('/api/stock-checks', {});
      toast('盘点单已创建，请录入实盘数量');
      checkCountDialog(ck.id, el, load);
    } catch (e) { toast(e.message, 'error'); }
  };
  load();
},

/* ============ 跨店调拨 ============ */
async 'transfers'(el) {
  const sid = App.session.storeId;
  el.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>🔀 跨店耗材调拨</h3>
        <div class="toolbar">
          <div class="seg" id="tr-seg">
            <button class="active" data-f="">全部</button>
            <button data-f="todo">待我处理</button>
            <button data-f="in">调入单</button>
            <button data-f="out">调出单</button>
          </div>
          <button class="btn btn-gold" id="tr-new-out">📤 主动调出</button>
          <button class="btn btn-primary" id="tr-new-in">📥 向他店请货</button>
        </div></div>
      <div class="tbl-wrap" id="tr-list">${loading()}</div>
    </div>`;
  const load = async () => {
    const f = $('#tr-seg', el).querySelector('button.active').dataset.f;
    let list = await api.get('/api/stock-transfers');
    if (f === 'in') list = list.filter(t => t.toStoreId === sid);
    if (f === 'out') list = list.filter(t => t.fromStoreId === sid);
    if (f === 'todo') list = list.filter(t =>
      (t.status === 'pending' && t.fromStoreId === sid) ||
      (t.status === 'frozen' && t.toStoreId === sid));
    $('#tr-list', el).innerHTML = list.length ? `<table class="tbl"><thead><tr><th>调拨单号</th><th>方向</th><th>调出门店</th><th></th><th>调入门店</th><th>耗材</th><th>状态</th><th>发起/确认/签收</th><th></th></tr></thead>
      <tbody>${list.map(t => `
        <tr><td class="muted nowrap" style="font-size:11.5px">${t.transferNo}<br><span class="muted">${t.createdAt.slice(0, 10)}</span></td>
        <td>${t.toStoreId === sid ? '<span class="tag tag-blue">调入</span>' : '<span class="tag tag-gold">调出</span>'}<br><span class="muted" style="font-size:11px">${t.direction === 'in' ? '请货' : '主动'}</span></td>
        <td style="font-size:12.5px">${esc(t.fromStoreName)}<br><span class="muted" style="font-size:11px">${esc(t.fromCity)}</span></td>
        <td class="muted">→</td>
        <td style="font-size:12.5px">${esc(t.toStoreName)}<br><span class="muted" style="font-size:11px">${esc(t.toCity)}</span></td>
        <td><b>${esc(t.materialName)}</b><div class="muted" style="font-size:12px">${t.qty}${esc(t.unit)}</div></td>
        <td>${transferStatusTag(t.status)}</td>
        <td class="nowrap muted" style="font-size:11.5px">${esc(t.createdBy || '')}<br>${t.confirmedAt ? '✓ ' + esc(t.confirmedBy) : ''}${t.receivedAt ? '<br>✓ ' + esc(t.receivedBy) : ''}</td>
        <td class="nowrap"><button class="btn btn-sm btn-primary" data-t="${t.id}">${actionLabel(t, sid)}</button></td></tr>`).join('')}
      </tbody></table>`
      : emptyBox('暂无调拨单');
    el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => openTransferById(b.dataset.t, el));
  };
  $('#tr-seg', el).querySelectorAll('button').forEach(b => b.onclick = () => {
    $('#tr-seg', el).querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b)); load();
  });
  $('#tr-new-out', el).onclick = () => transferCreateDialog('out', el, load);
  $('#tr-new-in', el).onclick = () => transferCreateDialog('in', el, load);
  load();
},

/* ============ 本店出入库流水 ============ */
async 'stock-ledger'(el) {
  const materials = App.ctx.materials;
  const today = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 864e5).toISOString().slice(0, 10);
  el.innerHTML = `
    <div class="card">
      <div class="card-h"><h3>📑 本店出入库流水</h3>
        <div class="toolbar">
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
    const tp = $('#f-type', el).value, mid = $('#f-mat', el).value, q = $('#f-q', el).value.trim();
    if (tp) qs.set('type', tp); if (mid) qs.set('materialId', mid); if (q) qs.set('q', q);
    const list = await api.get('/api/stock-ledger?' + qs);
    $('#lg-box', el).innerHTML = list.length ? `<table class="tbl"><thead><tr><th>时间</th><th>耗材</th><th>批次</th><th>类型</th><th class="num">变动</th><th class="num">批次结存</th><th>关联单号</th><th>经办人</th><th>备注</th></tr></thead>
      <tbody>${list.map(l => `
        <tr><td class="nowrap muted">${l.createdAt.slice(5, 16)}</td>
        <td>${esc(l.materialName)} <span class="muted">${esc(l.unit)}</span></td>
        <td class="muted nowrap" style="font-size:11.5px">${esc(l.batchNo || '—')}</td>
        <td>${ledgerTypeTag(l.type, l.typeName)}</td>
        <td class="num" style="color:${l.change < 0 ? 'var(--red)' : l.change > 0 ? 'var(--jade)' : 'var(--text-2)'};font-weight:600">${l.change > 0 ? '+' : ''}${l.qty}</td>
        <td class="num muted">${l.batchQtyAfter ?? '—'}</td>
        <td class="muted nowrap" style="font-size:11.5px">${esc(l.refId || (l.orderId ? '账单 ' + l.orderId : '—'))}</td>
        <td class="nowrap">${esc(l.operator || '—')}</td>
        <td class="muted" style="font-size:12px;max-width:200px">${esc(l.note || '')}</td></tr>`).join('')}
      </tbody></table>
      <p class="muted" style="padding:10px 16px;font-size:12.5px">共 ${list.length} 条（最多显示 500 条）；仅展示本店数据</p>`
      : emptyBox('该条件下暂无流水');
  };
  $('#f-go', el).onclick = () => load().catch(e => toast(e.message, 'error'));
  load();
},
});

/* ---------------- 工具：操作按钮文案 ---------------- */
function actionLabel(t, sid) {
  if (t.status === 'pending' && t.fromStoreId === sid) return '确认/拒绝';
  if (t.status === 'frozen' && t.toStoreId === sid) return '签收/取消';
  return '查看';
}

/* ---------------- 批次明细弹窗 ---------------- */
async function batchDialog(materialId) {
  const m = App.ctx.materials.find(x => x.id === materialId);
  const batches = await api.get('/api/stock-batches?materialId=' + materialId);
  openModal({ title: `批次明细 · ${m.name}`, size: 'xl',
    body: batches.length ? `<table class="tbl"><thead><tr><th>批次号</th><th>入库时间</th><th>到期日</th><th class="num">总量</th><th class="num">冻结</th><th class="num">可用</th><th>状态</th></tr></thead>
      <tbody>${batches.map(b => `
        <tr><td class="muted">${esc(b.batchNo)}</td><td class="nowrap muted">${b.receivedAt.slice(0, 16)}</td>
        <td class="nowrap">${b.expireDate || '<span class="muted">无保质期</span>'}</td>
        <td class="num">${b.quantity}${esc(m.unit)}</td>
        <td class="num" style="color:var(--blue)">${b.frozen || '—'}</td>
        <td class="num"><b>${b.available}${esc(m.unit)}</b></td>
        <td>${b.expired ? '<span class="tag tag-red">已过期</span>' : b.nearExpire ? '<span class="tag tag-gold">临期 ' + b.daysToExpire + '天</span>' : '<span class="tag tag-green">正常</span>'}${b.frozen > 0 ? ' <span class="tag tag-blue">部分冻结</span>' : ''}</td></tr>`).join('')}
      </tbody></table>` : emptyBox('暂无批次，请先入库'),
    footer: `<button class="btn btn-primary" data-close>关 闭</button>` });
}

/* ---------------- 盘点：录入实盘数 ---------------- */
function checkCountDialog(id, pageEl, reload) {
  (async () => {
    const ck = await api.get('/api/stock-checks/' + id);
    let fillFast = null;
    const dlg = openModal({ title: `库存盘点 · ${ck.id}`, size: 'xl',
      body: `<div class="toolbar mb-16" style="justify-content:space-between">
          <span class="muted" style="font-size:12.5px">账面快照生成于 ${ck.createdAt}；冻结中数量已单列，不属于可用调整量。</span>
          <div class="toolbar">
            <button class="btn btn-sm" id="ck-all">一键实盘=账面</button>
            <select class="inp" id="ck-fast" style="width:150px"><option value="">快速填充差异…</option>
              <option value="-1">-1</option><option value="1">+1</option><option value="-2">-2</option></select>
          </div>
        </div>
        <div class="tbl-wrap" style="max-height:54vh;overflow-y:auto"><table class="tbl"><thead><tr><th>耗材</th><th class="num">账面总量</th><th class="num">冻结中</th><th class="num" style="width:150px">实盘数量</th><th class="num">差异</th></tr></thead>
          <tbody>${ck.items.map(i => `
            <tr data-mid="${i.materialId}">
              <td>${esc(i.materialName)} <span class="muted">${esc(i.unit)}</span></td>
              <td class="num sys">${i.systemQty}</td>
              <td class="num" style="color:var(--blue)">${i.frozen || '—'}</td>
              <td class="num"><input type="number" min="0" step="0.001" class="inp ck-actual" style="width:120px;text-align:right" value="${i.actualQty ?? ''}" placeholder="盘点数"></td>
              <td class="num ck-diff muted">—</td>
            </tr>`).join('')}</tbody></table></div>
        <div class="form-row one" style="margin-top:12px"><div class="form-item"><label>盘点备注</label><input id="ck-remark" value="${esc(ck.remark || '')}" placeholder="如：破损、过期报损、未登记录入等"></div></div>`,
      footer: `<button class="btn btn-danger" id="ck-cancel" style="margin-right:auto">作废盘点单</button>
        <button class="btn" data-close>稍后继续</button>
        <button class="btn btn-gold" id="ck-ok">确认盘点并调整库存</button>` });

    const bindRow = (tr) => {
      const inp = $('.ck-actual', tr), sys = Number($('.sys', tr).textContent);
      inp.oninput = () => {
        const v = inp.value === '' ? null : Number(inp.value);
        const dEl = $('.ck-diff', tr);
        if (v === null || Number.isNaN(v)) { dEl.textContent = '—'; dEl.className = 'num ck-diff muted'; return; }
        const d = Math.round((v - sys) * 1000) / 1000;
        dEl.textContent = (d > 0 ? '+' : '') + d;
        dEl.className = 'num ck-diff ' + (d < 0 ? '' : d > 0 ? '' : 'muted');
        dEl.style.color = d < 0 ? 'var(--red)' : d > 0 ? 'var(--jade)' : '';
      };
    };
    dlg.el.querySelectorAll('tbody tr').forEach(bindRow);
    $('#ck-all', dlg.el).onclick = () => dlg.el.querySelectorAll('tbody tr').forEach(tr => { $('.ck-actual', tr).value = $('.sys', tr).textContent; $('.ck-actual', tr).dispatchEvent(new Event('input')); });
    $('#ck-fast', dlg.el).onchange = () => {
      const v = Number($('#ck-fast', dlg.el).value) || 0;
      dlg.el.querySelectorAll('tbody tr').forEach(tr => {
        const sys = Number($('.sys', tr).textContent);
        $('.ck-actual', tr).value = Math.max(0, Math.round((sys + v) * 1000) / 1000);
        $('.ck-actual', tr).dispatchEvent(new Event('input'));
      });
    };
    $('#ck-cancel', dlg.el).onclick = async () => {
      if (await confirmAsync('作废后该盘点单删除，确定吗？', '作废')) {
        await api.del('/api/stock-checks/' + id); toast('已作废'); closeModal(); reload();
      }
    };
    $('#ck-ok', dlg.el).onclick = async () => {
      const actuals = {};
      for (const tr of dlg.el.querySelectorAll('tbody tr')) {
        const v = $('.ck-actual', tr).value;
        if (v === '') return toast('请完成全部耗材的实盘录入（无差异可点一键填充）', 'error');
        actuals[tr.dataset.mid] = Number(v);
      }
      const btn = $('#ck-ok', dlg.el); btn.disabled = true;
      try {
        const r = await api.post(`/api/stock-checks/${id}/confirm`, { actuals, remark: $('#ck-remark', dlg.el).value.trim() });
        toast(r.idempotent ? '该盘点单已确认（幂等）' : '盘点完成，库存已按差异调整');
        closeModal(); reload();
      } catch (e) { toast(e.message, 'error'); btn.disabled = false; }
    };
  })();
}

/* 盘点单查看 */
async function checkViewDialog(id) {
  const ck = await api.get('/api/stock-checks/' + id);
  openModal({ title: `盘点单 · ${ck.id}（${ck.status === 'confirmed' ? '已确认' : '草稿'}）`, size: 'xl',
    body: `<p class="muted" style="font-size:12.5px;margin-bottom:8px">创建 ${ck.createdAt}${ck.confirmedAt ? ' ｜ 确认 ' + ck.confirmedAt : ''} ｜ 经办人 ${esc(ck.operator)}${ck.remark ? ' ｜ 备注：' + esc(ck.remark) : ''}</p>
      <table class="tbl"><thead><tr><th>耗材</th><th class="num">账面</th><th class="num">冻结</th><th class="num">实盘</th><th class="num">差异</th></tr></thead>
      <tbody>${ck.items.map(i => `<tr><td>${esc(i.materialName)}</td><td class="num">${i.systemQty}${esc(i.unit)}</td>
        <td class="num" style="color:var(--blue)">${i.frozen || '—'}</td>
        <td class="num">${i.actualQty ?? '—'}</td>
        <td class="num" style="color:${i.diff < 0 ? 'var(--red)' : i.diff > 0 ? 'var(--jade)' : ''}">${i.diff ? (i.diff > 0 ? '+' : '') + i.diff : '0'}</td></tr>`).join('')}</tbody></table>`,
    footer: `<button class="btn btn-primary" data-close>关 闭</button>` });
}

/* ---------------- 调拨：发起 ---------------- */
function transferCreateDialog(direction, pageEl, reload) {
  (async () => {
    const sid = App.session.storeId;
    const stores = App.ctx.stores.filter(s => s.id !== sid);
    const materials = App.ctx.materials.filter(m => m.active);
    const dlg = openModal({ title: direction === 'out' ? '📤 主动调出（本店 → 他店）' : '📥 向他店请货（他店 → 本店）', size: 'lg',
      body: `<div class="form-row">
        <div class="form-item"><label><span class="req">*</span>${direction === 'out' ? '调入门店' : '请货来源（调出门店）'}</label>
          <select id="t-store">${stores.map(s => `<option value="${s.id}">${esc(s.name)}（${esc(s.city)}）</option>`).join('')}</select></div>
        <div class="form-item"><label><span class="req">*</span>耗材</label><select id="t-mat">${materials.map(m => `<option value="${m.id}">${esc(m.name)}（${esc(m.unit)}）</option>`).join('')}</select></div>
      </div>
      <div class="form-row">
        <div class="form-item"><label><span class="req">*</span>数量</label><input type="number" min="0" step="0.001" id="t-qty" value="1"></div>
        <div class="form-item"><label>备注</label><input id="t-note" placeholder="用途/紧急程度"></div>
      </div>
      <div id="t-batches-box" style="${direction === 'out' ? '' : 'display:none'}">
        <h4 style="font-size:13px;margin:6px 0 6px">选择调出批次（临期优先排前，合计须等于调拨数量）</h4>
        <div class="toolbar mb-16"><button class="btn btn-sm" id="t-auto">按临期优先自动选择</button><span class="muted" id="t-alloc-sum" style="font-size:12.5px"></span></div>
        <div class="tbl-wrap" id="t-batches" style="max-height:38vh;overflow-y:auto;border:1px solid var(--line);border-radius:8px"></div>
      </div>
      <p class="muted" id="t-in-tip" style="font-size:12.5px;${direction === 'in' ? '' : 'display:none'}">请货单提交后由对方门店确认，确认时按临期优先自动分配批次并冻结库存，本店签收后库存才到账。</p>`,
      footer: `<button class="btn" data-close>取消</button><button class="btn btn-primary" id="t-ok">${direction === 'out' ? '提交调拨（待对方确认）' : '提交请货申请'}</button>` });

    let batches = [];
    const loadBatches = async () => {
      const mid = $('#t-mat', dlg.el).value;
      batches = await api.get('/api/stock-batches?materialId=' + mid + '&filter=active');
      renderBatches();
    };
    const renderBatches = () => {
      const qty = Number($('#t-qty', dlg.el).value) || 0;
      $('#t-batches', dlg.el).innerHTML = batches.length ? `<table class="tbl"><thead><tr><th>批次号</th><th>到期日</th><th class="num">可用</th><th class="num" style="width:130px">调出数量</th></tr></thead>
        <tbody>${batches.map(b => `
          <tr data-bid="${b.id}"><td class="muted" style="font-size:12px">${esc(b.batchNo)}</td>
          <td>${b.expireDate ? `<span class="tag ${b.nearExpire ? 'tag-gold' : 'tag-gray'}">${b.expireDate}</span>` : '无'}</td>
          <td class="num">${b.available}</td>
          <td class="num"><input type="number" min="0" max="${b.available}" step="0.001" class="inp b-qty" style="width:110px;text-align:right" value=""></td></tr>`).join('')}</tbody></table>`
        : emptyBox('该耗材本店无可用批次');
      const updateSum = () => {
        const sum = [...dlg.el.querySelectorAll('.b-qty')].reduce((a, x) => a + (Number(x.value) || 0), 0);
        const rs = Math.round(sum * 1000) / 1000;
        $('#t-alloc-sum', dlg.el).innerHTML = `已选 <b>${rs}</b> / 需 <b>${qty}</b> ${rs === qty ? '<span style="color:var(--jade)">✓ 一致</span>' : '<span class="muted">待一致</span>'}`;
      };
      dlg.el.querySelectorAll('.b-qty').forEach(x => x.oninput = updateSum);
      updateSum();
    };
    $('#t-mat', dlg.el).onchange = loadBatches;
    $('#t-qty', dlg.el).oninput = renderBatches;
    $('#t-auto', dlg.el).onclick = () => {
      let remain = Number($('#t-qty', dlg.el).value) || 0;
      dlg.el.querySelectorAll('#t-batches tbody tr').forEach(tr => {
        const avail = Number(tr.children[2].textContent);
        const take = Math.min(avail, remain);
        remain = Math.round((remain - take) * 1000) / 1000;
        $('.b-qty', tr).value = take > 0 ? take : '';
      });
      dlg.el.querySelector('.b-qty')?.dispatchEvent(new Event('input'));
      const ev = new Event('input', { bubbles: true });
      dlg.el.querySelectorAll('.b-qty').forEach(x => x.dispatchEvent(ev));
    };
    await loadBatches();

    $('#t-ok', dlg.el).onclick = async () => {
      const body = {
        materialId: $('#t-mat', dlg.el).value,
        qty: Number($('#t-qty', dlg.el).value),
        note: $('#t-note', dlg.el).value.trim(),
        direction,
      };
      const other = $('#t-store', dlg.el).value;
      if (direction === 'out') body.toStoreId = other; else body.fromStoreId = other;
      if (!(body.qty > 0)) return toast('请填写有效数量', 'error');
      if (direction === 'out') {
        body.batches = [...dlg.el.querySelectorAll('#t-batches tbody tr')].map(tr => ({
          batchId: tr.dataset.bid, qty: Number($('.b-qty', tr).value) || 0,
        })).filter(x => x.qty > 0);
        const sum = body.batches.reduce((a, x) => a + x.qty, 0);
        if (Math.abs(sum - body.qty) > 1e-9) return toast(`批次合计 ${sum} 与调拨数量 ${body.qty} 不一致`, 'error');
      }
      try {
        const t = await api.post('/api/stock-transfers', body);
        toast('调拨单已提交：' + t.transferNo); closeModal(); reload();
      } catch (e) { toast(e.message, 'error'); }
    };
  })();
}

/* ---------------- 调拨：详情 + 确认/拒绝/取消/签收 ---------------- */
async function openTransferById(id, pageEl) {
  const sid = App.session.storeId;
  const t = await api.get('/api/stock-transfers/' + id);
  const isFrom = t.fromStoreId === sid, isTo = t.toStoreId === sid;
  const timeLine = [
    ['发起', t.createdAt, t.createdBy],
    ['调出确认', t.confirmedAt, t.confirmedBy],
    ['签收完成', t.receivedAt, t.receivedBy],
    ['拒绝', t.rejectedAt, t.rejectedBy],
    ['取消', t.canceledAt, t.canceledBy],
  ].filter(x => x[1]);
  const dlg = openModal({ title: `调拨单 · ${t.transferNo}`, size: 'xl',
    body: `
    <div class="grid g-3 mb-16">
      <div class="pay-box"><div class="p-l">方向</div><div style="font-weight:700;margin-top:4px;font-size:14px">${esc(t.fromStoreName)}<br>→ ${esc(t.toStoreName)}</div></div>
      <div class="pay-box"><div class="p-l">耗材 / 数量</div><div style="font-weight:700;margin-top:4px">${esc(t.materialName)}<br>${t.qty}${esc(t.unit)}</div></div>
      <div class="pay-box"><div class="p-l">状态</div><div style="margin-top:6px">${transferStatusTag(t.status)}<div class="muted" style="font-size:11.5px;margin-top:3px">${esc(t.directionName)}</div></div></div>
    </div>
    ${t.batches.length ? `<h4 style="font-size:13.5px;margin:6px 0 8px">${isFrom ? '调出批次' : '调出批次（对方门店）'}</h4>
      <table class="tbl mb-16"><thead><tr><th>批次号</th><th class="num">数量</th></tr></thead>
      <tbody>${t.batches.map(b => `<tr><td class="muted">${esc(b.batchNo || b.batchId)}</td><td class="num">${b.qty}${esc(t.unit)}</td></tr>`).join('')}</tbody></table>` : ''}
    <h4 style="font-size:13.5px;margin:6px 0 8px">流转记录</h4>
    <div style="line-height:2;font-size:13px">${timeLine.map(([n, ts, by]) => `<div>✅ <b>${n}</b> · ${ts.slice(5, 16)} · ${esc(by || '')}</div>`).join('')}</div>
    ${t.rejectReason ? `<p class="muted" style="margin-top:8px">拒绝原因：${esc(t.rejectReason)}</p>` : ''}
    ${t.cancelReason ? `<p class="muted" style="margin-top:8px">取消原因：${esc(t.cancelReason)}</p>` : ''}
    ${t.note ? `<p class="muted" style="margin-top:8px">备注：${esc(t.note)}</p>` : ''}
    ${t.ledgers?.length ? `<h4 style="font-size:13.5px;margin:10px 0 6px">关联库存流水</h4>
      <table class="tbl"><thead><tr><th>时间</th><th>门店</th><th>类型</th><th class="num">数量</th><th>备注</th></tr></thead>
      <tbody>${t.ledgers.map(l => `<tr><td class="nowrap muted">${l.createdAt.slice(5, 16)}</td><td style="font-size:12px">${esc(l.storeName)}</td>
        <td>${ledgerTypeTag(l.type, l.typeName)}</td><td class="num">${l.change > 0 ? '+' : ''}${l.qty}</td><td class="muted" style="font-size:12px">${esc(l.note || '')}</td></tr>`).join('')}</tbody></table>` : ''}`,
    footer: transferFooter(t, sid, isFrom, isTo, id, pageEl) });
}
function transferFooter(t, sid, isFrom, isTo, id, pageEl) {
  const close = `<button class="btn" data-close>关 闭</button>`;
  const act = (label, id2, cls = 'btn-primary') => `<button class="btn ${cls}" id="${id2}">${label}</button>`;
  let btns = close;
  if (t.status === 'pending' && isFrom) {
    btns = close + act('✓ 确认调拨并冻结库存', 'tf-confirm') + act('拒绝', 'tf-reject', 'btn-danger');
  } else if (t.status === 'frozen' && isTo) {
    btns = close + act('取消调拨（解冻）', 'tf-cancel') + act('✓ 签收入库', 'tf-receive', 'btn-gold');
  } else if (t.status === 'frozen' && isFrom) {
    btns = close + `<span class="muted" style="align-self:center;margin-right:auto;font-size:12.5px">已冻结，等待 ${esc(t.toStoreName)} 签收</span>`;
  } else if (t.status === 'pending' && isTo) {
    btns = close + act('取消申请', 'tf-cancel') + `<span class="muted" style="align-self:center;font-size:12.5px">等待 ${esc(t.fromStoreName)} 确认</span>`;
  }
  setTimeout(() => {
    const go = async (fn, msg) => { try { await fn(); toast(msg); closeModal(); pageEl ? Views.store.transfers(pageEl) : (location.hash = '#/store/transfers'); } catch (e) { toast(e.message, 'error'); } };
    $('#tf-confirm')?.addEventListener('click', () => go(api.post(`/api/stock-transfers/${id}/confirm`, {}), '已确认并冻结库存，等待对方签收'));
    $('#tf-receive')?.addEventListener('click', async () => {
      const note = await promptText('签收备注（选填，如批次完好）', '');
      if (note === null) return;
      await go(api.post(`/api/stock-transfers/${id}/receive`, { remark: note }), '签收成功，库存已到账');
    });
    $('#tf-reject')?.addEventListener('click', async () => {
      const reason = await promptText('拒绝原因', '本店库存紧张，暂无法调出');
      if (reason === null) return;
      await go(api.post(`/api/stock-transfers/${id}/reject`, { reason }), '已拒绝该调拨');
    });
    $('#tf-cancel')?.addEventListener('click', async () => {
      const reason = await promptText('取消原因', '需求取消');
      if (reason === null) return;
      await go(api.post(`/api/stock-transfers/${id}/cancel`, { reason }), '已取消，冻结库存已释放');
    });
  }, 0);
  return btns;
}

/* 简易单行输入弹窗（返回 Promise<string|null>） */
function promptText(title, def = '') {
  return new Promise((resolve) => {
    const m = openModal({ title,
      body: `<div class="form-row one"><div class="form-item"><input id="pt-inp" value="${esc(def)}" style="width:100%"></div></div>`,
      footer: `<button class="btn" data-c="0">取消</button><button class="btn btn-primary" data-c="1">确 定</button>` });
    $('#pt-inp', m.el).focus();
    m.el.querySelectorAll('[data-c]').forEach(b => b.onclick = () => { const v = $('#pt-inp', m.el).value.trim(); closeModal(); resolve(b.dataset.c === '1' ? v : null); });
  });
}
