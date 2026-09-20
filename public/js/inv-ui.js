/* 库存模块共享前端工具（inv-ui.js，依赖 ui.js / App.ctx） */
const InvUI = {
  keyPrefix: 'yzt-idem-',
  /* 幂等键：同一页面动作生成一个键并短期缓存，双击/网络重试共用 */
  idem(scene) {
    if (crypto?.randomUUID) return scene + '-' + crypto.randomUUID().slice(0, 12);
    return scene + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  },
  mat(id) { return App.ctx.materials.find(m => m.id === id); },
  unit(id) { return App.ctx.units.find(u => u.id === id); },
  unitName(id) { return this.unit(id)?.name || ''; },
  matName(id) { return this.mat(id)?.name || id; },
  svcName(id) { return App.ctx.services.find(s => s.id === id)?.name || id; },
  storeNameOf(id) { return App.ctx.stores.find(s => s.id === id)?.name || id; },
  recipeOf(serviceId) { return App.ctx.recipes.find(r => r.serviceId === serviceId); },

  matOptions(selected) {
    return App.ctx.materials.filter(m => m.active)
      .map(m => `<option value="${m.id}" ${m.id === selected ? 'selected' : ''}>${esc(m.name)}（${this.unitName(m.unitId)}）</option>`).join('');
  },
  storeOptions(selected, excludeId) {
    return App.ctx.stores.filter(s => s.id !== excludeId)
      .map(s => `<option value="${s.id}" ${s.id === selected ? 'selected' : ''}>${esc(s.name)}（${esc(s.city)}）</option>`).join('');
  },

  /* 库存状态标签 */
  stockTag(row) {
    if (row.low) return `<span class="tag tag-red">低库存</span>`;
    return `<span class="tag tag-green">充足</span>`;
  },
  expireTag(b) {
    if (b.expired) return `<span class="tag tag-red">已过期 ${-b.daysToExpire} 天</span>`;
    if (b.nearExpire) return `<span class="tag tag-gold">${b.daysToExpire} 天后到期</span>`;
    return `<span class="tag tag-gray">${b.daysToExpire} 天</span>`;
  },
  transferStatusTag(s) {
    return ({
      requested: '<span class="tag tag-gold">待调出确认</span>',
      frozen: '<span class="tag tag-blue">待调入签收</span>',
      done: '<span class="tag tag-green">已完成</span>',
      cancelled: '<span class="tag tag-gray">已取消</span>',
      rejected: '<span class="tag tag-red">已拒绝/拒收</span>',
    })[s] || s;
  },
  dirTag(x) {
    if (x.direction === 'in') return '<span class="tag tag-green">入库+</span>';
    if (x.direction === 'out') return '<span class="tag tag-red">出库-</span>';
    if (x.direction === 'hold') return '<span class="tag tag-gold">冻结</span>';
    if (x.direction === 'release') return '<span class="tag tag-blue">解冻</span>';
    return x.direction;
  },
  qtyColor(x) {
    if (x.direction === 'in') return 'color:var(--jade)';
    if (x.direction === 'out') return 'color:var(--red)';
    if (x.direction === 'hold') return 'color:#9a7622';
    return 'color:var(--blue)';
  },
  LEDGER_TYPES: [
    ['', '全部类型'], ['stockin', '采购入库'], ['order', '开单耗用'],
    ['checkGain', '盘盈入库'], ['checkLoss', '盘亏出库'],
    ['transferFreeze', '调拨冻结'], ['transferUnfreeze', '解冻返还'],
    ['transferOut', '调拨调出'], ['transferIn', '调拨签收入库'],
  ],
  typeOptions(sel) {
    return this.LEDGER_TYPES.map(([v, n]) => `<option value="${v}" ${v === sel ? 'selected' : ''}>${n}</option>`).join('');
  },

  /* 动态明细行：{materials, needQty, hintQty} */
  itemRows(rows, opts = {}) {
    const withStock = !!opts.withStock;
    return rows.map((r, i) => `
      <tr data-row="${i}">
        <td style="width:38%">
          <select class="inp f-mat" style="width:100%">
            <option value="">选择耗材</option>${this.matOptions(r.materialId)}
          </select>
          ${withStock ? `<div class="muted f-avail" style="font-size:12px;margin-top:2px"></div>` : ''}
        </td>
        <td style="width:22%"><input type="number" min="0" step="0.01" class="inp f-qty" value="${r.qty ?? ''}" placeholder="数量" style="width:100%"></td>
        ${opts.extraCols ? opts.extraCols(r, i) : ''}
        <td class="nowrap" style="width:60px"><button type="button" class="btn btn-sm btn-danger f-del">删除</button></td>
      </tr>`).join('');
  },

  /* 流水表格（hq 传 showStore） */
  ledgerTable(list, showStore) {
    return `<table class="tbl"><thead><tr>
      <th>时间</th>${showStore ? '<th>门店</th>' : ''}<th>类型</th><th>耗材/批次</th><th class="num">数量</th><th>关联单号</th><th>操作人</th><th>备注</th>
      </tr></thead><tbody>
      ${list.length ? list.map(x => `
        <tr>
          <td class="nowrap muted">${x.ts.slice(5, 16)}</td>
          ${showStore ? `<td style="max-width:130px">${esc(x.storeName)}</td>` : ''}
          <td class="nowrap">${this.dirTag(x)} <span class="muted" style="font-size:12px">${esc(x.typeName)}</span></td>
          <td><b>${esc(x.materialName)}</b><div class="muted" style="font-size:12px">${x.refType === 'checkGain' ? '盘盈批次' : esc(x.batchId ? (x.refNo && x.type === 'stockin' ? x.refNo : x.batchId) : '-')}</div></td>
          <td class="num" style="${this.qtyColor(x)};font-weight:650">${x.direction === 'in' ? '+' : x.direction === 'out' ? '-' : x.direction === 'hold' ? '❄' : '↺'}${x.qty} ${esc(x.unitName)}</td>
          <td class="nowrap muted" style="font-size:12px">${esc(x.refNo || '-')}</td>
          <td class="nowrap">${esc(x.operator)}</td>
          <td class="muted" style="font-size:12px;max-width:180px">${esc(x.remark || '')}</td>
        </tr>`).join('')
        : `<tr><td colspan="${showStore ? 8 : 7}">${emptyBox('暂无流水')}</td></tr>`}
      </tbody></table>`;
  },

  /* 调拨明细弹窗（含批次分配） */
  transferDetail(t) {
    openModal({
      title: `调拨单 ${t.id} · ${t.statusName}`, size: 'lg',
      body: `
      <div class="pay-grid mb-16">
        <div class="pay-box"><div class="p-l">调出门店</div><div style="font-weight:700;margin-top:4px">${esc(t.fromStoreName)}</div></div>
        <div class="pay-box"><div class="p-l">调入门店</div><div style="font-weight:700;margin-top:4px">${esc(t.toStoreName)}</div></div>
        <div class="pay-box"><div class="p-l">状态</div><div style="margin-top:4px">${this.transferStatusTag(t.status)}</div></div>
        <div class="pay-box"><div class="p-l">发起时间</div><div style="font-weight:700;margin-top:4px;font-size:13px">${t.createdAt.slice(5, 16)}</div></div>
      </div>
      <table class="tbl mb-16"><thead><tr><th>耗材</th><th class="num">调拨数量</th><th>批次分配（FEFO 临期优先）</th></tr></thead>
        <tbody>${t.items.map(it => `
          <tr><td><b>${esc(it.name)}</b></td><td class="num">${it.qty} ${esc(it.unitName)}</td>
          <td>${it.allocated?.length ? it.allocated.map(a => `<span class="tag tag-blue" style="margin:2px">${esc(a.batchNo)} × ${a.qty}</span>`).join('') : '<span class="muted">待调出店确认后分配</span>'}</td></tr>`).join('')}
        </tbody></table>
      <p class="muted" style="font-size:12.5px">发起人 ${esc(t.createdBy)}${t.confirmedBy ? ` ｜ 确认 ${esc(t.confirmedBy)} @ ${t.confirmedAt?.slice(5, 16)}` : ''}${t.receivedBy ? ` ｜ 签收 ${esc(t.receivedBy)} @ ${t.receivedAt?.slice(5, 16)}` : ''}</p>
      ${t.rejectReason ? `<p class="muted" style="font-size:12.5px;color:var(--red)">说明：${esc(t.rejectReason)}</p>` : ''}
      ${t.remark ? `<p class="muted" style="font-size:12.5px">备注：${esc(t.remark)}</p>` : ''}`,
      footer: `<button class="btn btn-primary" data-close>关 闭</button>`,
    });
  },
};
