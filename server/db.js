/**
 * 悦足堂 · 数据层（零依赖 JSON 持久化）
 * 启动时若 data/db.json 不存在则生成确定性种子数据。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

/* ---------------- 工具 ---------------- */
function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function fmtTime(d) { return `${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function parseDate(s) { return new Date(s + 'T00:00:00'); }
function nowLocal() {
  const d = new Date();
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
// 确定性伪随机（mulberry32）
function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20260919);
function ri(min, max) { return Math.floor(rand() * (max - min + 1)) + min; }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

/* ---------------- 基础数据 ---------------- */
const STORES = [
  { id: 'S01', name: '旗舰店·外滩中心店', city: '上海', address: '黄浦区中山东一路 18 号 3F', phone: '021-6321-8801', manager: '周敏', opened: '2021-05-18' },
  { id: 'S02', name: '陆家嘴金融城店', city: '上海', address: '浦东新区世纪大道 100 号 L2', phone: '021-5835-2210', manager: '林海', opened: '2022-03-12' },
  { id: 'S03', name: '静安寺嘉里店', city: '上海', address: '静安区南京西路 1515 号 4F', phone: '021-6288-7766', manager: '苏晴', opened: '2022-09-01' },
  { id: 'S04', name: '国贸 CBD 店', city: '北京', address: '朝阳区建国门外大街 1 号 B1', phone: '010-6505-1188', manager: '赵鹏', opened: '2021-11-20' },
  { id: 'S05', name: '天河城店', city: '广州', address: '天河区天河路 208 号 5F', phone: '020-3880-9900', manager: '陈嘉怡', opened: '2023-01-15' },
  { id: 'S06', name: '南山科技园店', city: '深圳', address: '南山区科技园深南大道 9988 号 3F', phone: '0755-8650-3322', manager: '何俊', opened: '2023-06-08' },
];

const SERVICES = [
  { id: 'V01', name: '经典足道', duration: 60, price: 128, category: '足疗', commissionFixed: null, active: 1 },
  { id: 'V02', name: '养生足道', duration: 75, price: 168, category: '足疗', commissionFixed: null, active: 1 },
  { id: 'V03', name: '本草泡脚+足底拔罐', duration: 90, price: 218, category: '足疗', commissionFixed: null, active: 1 },
  { id: 'V04', name: '中式推拿', duration: 60, price: 188, category: '推拿', commissionFixed: null, active: 1 },
  { id: 'V05', name: '泰式古法按摩', duration: 90, price: 288, category: '推拿', commissionFixed: null, active: 1 },
  { id: 'V06', name: '肩颈深度调理', duration: 45, price: 138, category: '推拿', commissionFixed: null, active: 1 },
  { id: 'V07', name: 'SPA 精油舒缓', duration: 90, price: 328, category: 'SPA', commissionFixed: null, active: 1 },
  { id: 'V08', name: '热石能量 SPA', duration: 105, price: 398, category: 'SPA', commissionFixed: null, active: 1 },
  { id: 'V09', name: '艾灸温养', duration: 60, price: 198, category: '调理', commissionFixed: null, active: 1 },
  { id: 'V10', name: '刮痧排毒', duration: 40, price: 118, category: '调理', commissionFixed: null, active: 1 },
  { id: 'V11', name: '采耳', duration: 30, price: 88, category: '特色', commissionFixed: null, active: 1 },
  { id: 'V12', name: '修脚护理', duration: 30, price: 68, category: '特色', commissionFixed: null, active: 1 },
];

const TECH_LEVELS = [
  { id: 'L1', name: '初级技师', commissionRate: 0.25 },
  { id: 'L2', name: '中级技师', commissionRate: 0.30 },
  { id: 'L3', name: '高级技师', commissionRate: 0.35 },
  { id: 'L4', name: '金牌技师', commissionRate: 0.40 },
];

const MEMBER_LEVELS = [
  { id: 'ML1', name: '银卡会员', threshold: 0, discount: 0.95 },
  { id: 'ML2', name: '金卡会员', threshold: 3000, discount: 0.88 },
  { id: 'ML3', name: '铂金会员', threshold: 8000, discount: 0.82 },
  { id: 'ML4', name: '至尊会员', threshold: 20000, discount: 0.75 },
];

const SHIFT_DEFS = [
  { code: 'day', name: '白班', start: '10:00', end: '18:00' },
  { code: 'night', name: '晚班', start: '18:00', end: '02:00' },
];

/* ---------------- 耗材库存基础数据 ---------------- */
const MATERIALS = [
  { id: 'MA0001', name: '一次性足浴袋', unit: '个', category: '足疗耗材', safetyStock: 200, active: 1, remark: '每客一只' },
  { id: 'MA0002', name: '草本足浴包', unit: '包', category: '足疗耗材', safetyStock: 150, active: 1, remark: '' },
  { id: 'MA0003', name: '一次性毛巾', unit: '条', category: '一次性织物', safetyStock: 300, active: 1, remark: '' },
  { id: 'MA0004', name: '按摩精油', unit: 'ml', category: '按摩耗材', safetyStock: 500, active: 1, remark: '按毫升出库' },
  { id: 'MA0005', name: '艾草条', unit: '盒', category: '调理耗材', safetyStock: 30, active: 1, remark: '' },
  { id: 'MA0006', name: '刮痧润肤油', unit: 'ml', category: '调理耗材', safetyStock: 200, active: 1, remark: '' },
  { id: 'MA0007', name: '一次性床单', unit: '张', category: '一次性织物', safetyStock: 200, active: 1, remark: '' },
  { id: 'MA0008', name: '采耳一次性工具套装', unit: '套', category: '工具配件', safetyStock: 40, active: 1, remark: '一客一套' },
  { id: 'MA0009', name: '一次性修脚刀片', unit: '片', category: '工具配件', safetyStock: 100, active: 1, remark: '一客一片' },
  { id: 'MA0010', name: 'SPA 香薰精油', unit: 'ml', category: 'SPA 耗材', safetyStock: 400, active: 1, remark: '' },
  { id: 'MA0011', name: '一次性平角裤', unit: '条', category: '一次性织物', safetyStock: 120, active: 1, remark: '' },
  { id: 'MA0012', name: '拔罐耗材包', unit: '包', category: '调理耗材', safetyStock: 40, active: 1, remark: '含酒精棉/一次性罐衣' },
];
/* 服务项目标准耗用配方：serviceId -> [[materialId, qty], ...] */
const RECIPE_DEF = {
  V01: [['MA0001', 1], ['MA0002', 1], ['MA0003', 1]],
  V02: [['MA0001', 1], ['MA0002', 2], ['MA0003', 1]],
  V03: [['MA0001', 1], ['MA0002', 2], ['MA0003', 2], ['MA0012', 1]],
  V04: [['MA0003', 1], ['MA0007', 1], ['MA0004', 8]],
  V05: [['MA0003', 2], ['MA0007', 1], ['MA0004', 15]],
  V06: [['MA0003', 1], ['MA0004', 6], ['MA0006', 5]],
  V07: [['MA0003', 2], ['MA0007', 1], ['MA0011', 1], ['MA0010', 20]],
  V08: [['MA0003', 2], ['MA0007', 1], ['MA0011', 1], ['MA0010', 25]],
  V09: [['MA0003', 1], ['MA0005', 1]],
  V10: [['MA0003', 1], ['MA0006', 15]],
  V11: [['MA0003', 1], ['MA0008', 1]],
  V12: [['MA0003', 1], ['MA0009', 1]],
};
/* 默认保质期（天） */
const SHELF_DAYS = {
  MA0001: 1095, MA0002: 365, MA0003: 1095, MA0004: 730, MA0005: 540, MA0006: 730,
  MA0007: 1095, MA0008: 730, MA0009: 730, MA0010: 730, MA0011: 1095, MA0012: 365,
};
const MATERIAL_UNITS = ['个', '包', '条', '瓶', 'ml', '张', '盒', '片', '套', '支'];

const SURNAMES = ['王', '李', '张', '刘', '陈', '杨', '赵', '黄', '周', '吴', '徐', '孙', '马', '朱', '胡', '郭', '何', '林', '罗', '郑'];
const GIVEN = ['芳', '伟', '静', '秀英', '磊', '敏', '艳', '勇', '娟', '涛', '霞', '明', '超', '秀兰', '刚', '桂英', '建华', '文', '云', '志强', '雪梅', '佳', '欣怡', '鹏', '婷'];
const CERTS = ['足部按摩师（中级）', '保健按摩师（高级）', '中医康复理疗师', '反射疗法师', 'SPA 理疗师认证', '泰式按摩认证'];
const TRAIN_TOPICS = ['新员工岗前培训', '足底反射区进阶', '肩颈调理专项', '服务礼仪与话术', '泰式古法复训', '艾灸安全操作', '会员营销实训'];

const STORE_FACTOR = { S01: 1.35, S02: 1.2, S03: 1.05, S04: 1.15, S05: 0.95, S06: 1.0 };

/* ---------------- 种子生成 ---------------- */
function buildSeed() {
  const db = {
    meta: { brand: '悦足堂', generatedAt: nowLocal(), historyDays: 45 },
    counters: {},
    stores: STORES,
    services: SERVICES,
    techLevels: TECH_LEVELS,
    memberLevels: MEMBER_LEVELS,
    shiftDefs: SHIFT_DEFS,
    commissionRules: [],
    users: [],
    technicians: [],
    techSpecialties: [],
    trainings: [],
    transfers: [],
    members: [],
    recharges: [],
    orders: [],
    shifts: [],
    handovers: [],
    materials: MATERIALS,
    materialUnits: MATERIAL_UNITS,
    materialRecipes: [],
    stockBatches: [],
    stockInbounds: [],
    stockChecks: [],
    stockTransfers: [],
    stockLedger: [],
  };
  const seq = (key) => { db.counters[key] = (db.counters[key] || 0) + 1; return db.counters[key]; };
  const id = (key, prefix, len = 4) => `${prefix}${String(seq(key)).padStart(len, '0')}`;

  // 账号：总部 2 个 + 每门店 1 个店长
  db.users.push({ id: 'U0001', username: 'hq', password: '123456', name: '总部运营', role: 'hq', storeId: null, active: 1 });
  db.users.push({ id: 'U0002', username: 'boss', password: '123456', name: '品牌总监', role: 'hq', storeId: null, active: 1 });
  STORES.forEach((s, i) => {
    db.users.push({ id: `U${String(i + 10).padStart(4, '0')}`, username: `s${s.id.slice(1)}`, password: '123456', name: s.manager, role: 'store', storeId: s.id, active: 1 });
  });

  // 技师：每店 8~12 人
  let techNo = 0;
  for (const s of STORES) {
    const count = ri(8, 12);
    for (let k = 0; k < count; k++) {
      techNo++;
      const tId = `T${String(techNo).padStart(4, '0')}`;
      const name = pick(SURNAMES) + pick(GIVEN);
      const level = pick(['L1', 'L1', 'L2', 'L2', 'L2', 'L3', 'L3', 'L4']);
      const monthsAgo = ri(2, 40);
      const hire = new Date(); hire.setMonth(hire.getMonth() - monthsAgo);
      const statusRoll = rand();
      const status = statusRoll < 0.06 ? 'leave' : 'active';
      const tech = {
        id: tId, name, gender: rand() > 0.25 ? '女' : '男', age: ri(21, 46),
        phone: `1${pick(['38', '39', '35', '36', '58', '88'])}${String(ri(10000000, 99999999)).slice(0, 8)}`,
        levelId: level, storeId: s.id, status,
        hireDate: fmtDate(hire), leaveDate: status === 'leave' ? fmtDate(new Date(Date.now() - ri(3, 20) * 864e5)) : null,
        remark: status === 'leave' ? pick(['家中有事请长假', '身体调理中', '返乡休假']) : '',
      };
      db.technicians.push(tech);
      // 擅长项目 2~4 个
      const n = ri(2, 4);
      const svcs = [...SERVICES].sort(() => rand() - 0.5).slice(0, n);
      svcs.forEach(v => db.techSpecialties.push({ techId: tId, serviceId: v.id }));
      // 培训考核 1~3 条
      const tn = ri(1, 3);
      for (let j = 0; j < tn; j++) {
        const td = new Date(hire.getTime() + ri(0, 40) * 864e5);
        if (td > Date.now()) continue;
        const score = ri(72, 99);
        db.trainings.push({
          id: id('training', 'TR'), techId: tId, topic: pick(TRAIN_TOPICS),
          trainDate: fmtDate(td), score,
          result: score >= 60 ? 'pass' : 'fail',
          cert: score >= 90 && rand() > 0.5 ? pick(CERTS) : null,
        });
      }
    }
  }

  // 一次跨店调动样例（发生在 40 天前，便于“调动记录”有数据）
  const moved = db.technicians.find(t => t.storeId === 'S02');
  if (moved) {
    const td = new Date(); td.setDate(td.getDate() - 40);
    moved.storeId = 'S03';
    db.transfers.push({
      id: id('transfer', 'TF'), techId: moved.id, techName: moved.name,
      fromStoreId: 'S02', toStoreId: 'S03',
      transferDate: fmtDate(td), reason: '门店人力调配 · 旺季支援',
    });
  }

  // 会员：60 人，归属各店；按累计充值确定等级
  const MEMBER_SURN = ['沈', '韩', '曹', '邓', '许', '萧', '冯', '宋', '唐', '韩', '蒋', '卢', '姚', '邹', '熊'];
  for (let i = 0; i < 60; i++) {
    const store = pick(STORES);
    const totalRecharge = pick([500, 1000, 1500, 2000, 3000, 5000, 8000, 12000, 20000]);
    const level = [...MEMBER_LEVELS].reverse().find(l => totalRecharge >= l.threshold).id;
    const reg = new Date(); reg.setDate(reg.getDate() - ri(5, 44));
    const mId = `M${String(i + 1).padStart(4, '0')}`;
    db.members.push({
      id: mId, name: pick(MEMBER_SURN) + pick(GIVEN), phone: `1${pick(['38', '39', '35', '88'])}${String(ri(10000000, 99999999)).slice(0, 8)}`,
      levelId: level, storeId: store.id, balance: 0, totalRecharge, totalConsume: 0,
      regDate: fmtDate(reg),
    });
  }
  // 充值记录（每会员 1~3 笔），并初始化余额
  let paySeq = 0;
  for (const m of db.members) {
    const times = ri(1, 3);
    let charged = 0;
    for (let j = 0; j < times; j++) {
      const amt = pick([500, 1000, 2000, 3000, 5000]);
      const bonus = amt >= 3000 ? Math.round(amt * 0.1) : 0;
      charged += amt + bonus;
      const rd = new Date(parseDate(m.regDate).getTime() + j * 5 * 864e5 + ri(0, 3) * 864e5);
      db.recharges.push({
        id: `RC${String(++paySeq).padStart(5, '0')}`, memberId: m.id, storeId: m.storeId,
        amount: amt, bonus, payMethod: pick(['cash', 'card', 'mp']),
        createdAt: `${fmtDate(rd)} ${pad(ri(10, 22))}:${pad(ri(0, 59))}:00`,
      });
    }
    // 用消费消耗一部分余额（先给满，后面订单再扣）
    m.balance = charged;
    m.totalRecharge = charged;
  }
  // 重算会员等级（按含赠的累计充值）
  for (const m of db.members) {
    m.levelId = [...MEMBER_LEVELS].reverse().find(l => m.totalRecharge >= l.threshold).id;
  }

  // 提成标准覆盖规则：默认按技师等级比例提成；指定项目可用固定金额覆盖
  let crSeq = 0;
  db.commissionRules = [
    { id: `CR${String(++crSeq).padStart(3, '0')}`, name: '金牌·热石能量 SPA 专项补贴', serviceId: 'V08', levelId: 'L4', type: 'fixed', value: 180, active: 1 },
    { id: `CR${String(++crSeq).padStart(3, '0')}`, name: '高级·泰式古法专项', serviceId: 'V05', levelId: 'L3', type: 'fixed', value: 110, active: 1 },
    { id: `CR${String(++crSeq).padStart(3, '0')}`, name: '初级·采耳固定提成', serviceId: 'V11', levelId: 'L1', type: 'fixed', value: 25, active: 1 },
  ];

  /* ---------- 服务项目标准耗用配方（总部维护） ---------- */
  let recipeSeq = 0;
  for (const svc of SERVICES) {
    const items = (RECIPE_DEF[svc.id] || []).map(([materialId, qty]) => ({ materialId, qty }));
    db.materialRecipes.push({ id: `MR${String(++recipeSeq).padStart(4, '0')}`, serviceId: svc.id, items });
  }

  /* ---------- 45 天历史班次 + 订单 ---------- */
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const DAYS = 45;
  let orderSeq = 0, shiftSeq = 0, handSeq = 0;
  const techsByStore = Object.fromEntries(STORES.map(s => [s.id, db.technicians.filter(t => t.storeId === s.id && t.status === 'active')]));
  const specialtiesByTech = {};
  db.techSpecialties.forEach(sp => { (specialtiesByTech[sp.techId] ||= []).push(sp.serviceId); });

  for (let d = DAYS - 1; d >= 1; d--) {
    const day = new Date(today.getTime() - d * 864e5);
    const dateStr = fmtDate(day);
    for (const s of STORES) {
      for (const sd of SHIFT_DEFS) {
        const shiftId = `SH${String(++shiftSeq).padStart(6, '0')}`;
        const startDt = new Date(day); const [sh, sm] = sd.start.split(':').map(Number);
        startDt.setHours(sh, sm, 0, 0);
        const endDt = new Date(startDt); endDt.setHours(...sd.end.split(':').map(Number), 0, 0);
        if (sd.code === 'night') endDt.setDate(endDt.getDate() + 1);

        const factor = STORE_FACTOR[s.id];
        const baseCount = sd.code === 'day' ? 7 : 11;
        let n = Math.round((baseCount + ri(-3, 4)) * factor);
        n = Math.max(2, n);

        const shift = {
          id: shiftId, storeId: s.id, shiftCode: sd.code, shiftName: sd.name,
          businessDate: dateStr, startTime: `${dateStr} ${sd.start}:00`,
          endTime: `${fmtDate(endDt)} ${sd.end}:00`,
          opener: pick([s.manager, '值班店长']), status: 'closed',
          openedAt: `${dateStr} ${sd.start}:00`, closedAt: `${dateStr} ${sd.end === '02:00' ? '23:59' : sd.end}:00`,
        };
        db.shifts.push(shift);

        let cash = 0, card = 0, member = 0, mp = 0, revenue = 0, commission = 0;
        for (let k = 0; k < n; k++) {
          const svc = pick(SERVICES);
          const techs = techsByStore[s.id];
          let tech = pick(techs);
          // 70% 概率选擅长该项目的技师
          const good = techs.filter(t => (specialtiesByTech[t.id] || []).includes(svc.id));
          if (good.length && rand() < 0.7) tech = pick(good);
          const level = TECH_LEVELS.find(l => l.id === tech.levelId);
          const price = svc.price;
          const useMember = rand() < 0.45;
          let memberId = null, discount = 1, paid = price, payMethod;
          if (useMember) {
            const ml = pick(db.members.filter(m => m.storeId === s.id));
            if (ml && ml.balance >= price * 0.75) {
              memberId = ml.id;
              discount = MEMBER_LEVELS.find(l => l.id === ml.levelId).discount;
              paid = Math.round(price * discount);
              ml.balance -= paid; ml.totalConsume += paid;
              payMethod = 'member';
            } else {
              payMethod = pick(['cash', 'card', 'mp']);
            }
          } else {
            payMethod = pick(['cash', 'card', 'mp']);
          }
          if (!payMethod) payMethod = pick(['cash', 'card', 'mp']);
          const techCommission = Math.round(paid * level.commissionRate);
          // 下单时间落在班次区间内
          const spanStart = startDt.getTime();
          const span = endDt.getTime() - spanStart - 10 * 60000;
          const ot = new Date(spanStart + rand() * span);
          const order = {
            id: `O${String(++orderSeq).padStart(7, '0')}`,
            orderNo: `${dateStr.replace(/-/g, '')}${String(orderSeq).slice(-5)}`,
            storeId: s.id, shiftId, serviceId: svc.id,
            techId: tech.id, memberId,
            price, discountRate: discount, amount: paid,
            payMethod, techCommission,
            duration: svc.duration,
            createdAt: `${fmtDate(ot)} ${fmtTime(ot)}:00`,
            businessDate: dateStr,
          };
          db.orders.push(order);
          revenue += paid; commission += techCommission;
          if (payMethod === 'cash') cash += paid;
          else if (payMethod === 'card') card += paid;
          else if (payMethod === 'member') member += paid;
          else if (payMethod === 'mp') mp += paid;
        }

        db.handovers.push({
          id: `HD${String(++handSeq).padStart(6, '0')}`,
          shiftId, storeId: s.id, businessDate: dateStr, shiftName: sd.name,
          serveCount: n, cash, card, member, mp, revenue, commission,
          opener: shift.opener, closer: s.manager,
          openerSign: `seed-sign-${shift.opener}`, closerSign: `seed-sign-${s.manager}`,
          confirmedAt: shift.closedAt, remark: '',
        });
      }
    }
  }

  /* ---------- 今日：每店一个进行中的白班（可继续录单、交接） ---------- */
  const todayStr = fmtDate(today);
  const tomorrowStr = fmtDate(new Date(today.getTime() + 864e5));
  for (const s of STORES) {
    const shiftId = `SH${String(++shiftSeq).padStart(6, '0')}`;
    db.shifts.push({
      id: shiftId, storeId: s.id, shiftCode: 'day', shiftName: '白班',
      businessDate: todayStr, startTime: `${todayStr} 10:00:00`,
      endTime: `${todayStr} 18:00:00`,
      opener: s.manager, status: 'open',
      openedAt: `${todayStr} 10:00:00`, closedAt: null,
    });
  }

  /* ================= 门店耗材库存种子数据 ================= */
  let batchSeq = 0, inboundSeq = 0, checkSeq = 0, stockTransferSeq = 0, ledgerSeq = 0;
  const r3 = (n) => Math.round(n * 1000) / 1000;
  const dateAgo = (n) => fmtDate(new Date(today.getTime() + n * 864e5));
  const tsAgo = (daysAgo, hour, minute) => `${dateAgo(-daysAgo)} ${pad(hour)}:${pad(minute)}:00`;
  const addLedger = (e) => db.stockLedger.push({ id: `SL${String(++ledgerSeq).padStart(7, '0')}`, ...e });
  const batchAvailable = (b) => (b.expireDate && b.expireDate < todayStr) ? 0 : Math.max(0, r3(b.quantity - b.frozen));
  const fefoBatches = (storeId, materialId) => db.stockBatches
    .filter(b => b.storeId === storeId && b.materialId === materialId && batchAvailable(b) > 0)
    .sort((a, b) => (a.expireDate || '9999').localeCompare(b.expireDate || '9999') || a.receivedAt.localeCompare(b.receivedAt));

  /* 入库：生成入库单 + 批次 + 入库流水。expireInDays 可负（已过期） */
  const seedInbound = (s, m, daysAgo, qty, expireInDays, operator, note) => {
    const inbId = `IN${String(++inboundSeq).padStart(6, '0')}`;
    const createdAt = tsAgo(daysAgo, ri(9, 16), ri(0, 59));
    const receivedDate = createdAt.slice(0, 10);
    const expireDate = expireInDays === null ? null : dateAgo(expireInDays);
    const batchId = `B${String(++batchSeq).padStart(7, '0')}`;
    db.stockInbounds.push({
      id: inbId, storeId: s.id,
      items: [{ materialId: m.id, qty, batchId, productionDate: null, expireDate, supplier: '总部集采' }],
      supplier: '总部集采', operator, receivedDate, createdAt, note: note || '',
    });
    db.stockBatches.push({
      id: batchId, storeId: s.id, materialId: m.id,
      batchNo: `LOT${receivedDate.replace(/-/g, '')}${String(batchSeq).slice(-3)}`,
      inboundId: inbId, quantity: qty, frozen: 0,
      productionDate: null, expireDate, receivedAt: createdAt,
    });
    addLedger({
      storeId: s.id, materialId: m.id, batchId, type: 'inbound', qty, change: qty,
      refType: 'inbound', refId: inbId, orderId: null,
      batchQtyAfter: qty, batchAvailAfter: qty, operator, createdAt, note: note || '总部集采入库',
    });
  };

  /* FEFO 耗用：按临期优先扣批次，库存不足返回 false（不动任何数据） */
  const seedConsume = (storeId, materialId, qty, createdAt, operator = '系统补录') => {
    let need = qty;
    const allocs = [];
    for (const b of fefoBatches(storeId, materialId)) {
      const take = Math.min(batchAvailable(b), need);
      if (take > 0) allocs.push([b, r3(take)]);
      need = r3(need - take);
      if (need <= 0) break;
    }
    if (need > 0) return false;
    for (const [b, take] of allocs) {
      b.quantity = r3(b.quantity - take);
      addLedger({
        storeId, materialId, batchId: b.id, type: 'consume', qty: take, change: -take,
        refType: null, refId: null, orderId: null,
        batchQtyAfter: b.quantity, batchAvailAfter: r3(b.quantity - b.frozen),
        operator, createdAt, note: '历史账单耗用补录',
      });
    }
    return true;
  };

  /* 每店 2 个批次：40~55 天前的老批次（部分临期/过期）+ 近期补货批次 */
  STORES.forEach((s, si) => {
    MATERIALS.forEach((m, mi) => {
      const shelf = SHELF_DAYS[m.id];
      const receivedAgo = ri(40, 55);
      const roll = rand();
      let expireInDays;
      if (roll < 0.1) expireInDays = -ri(2, 18);                       // 已过期
      else if (roll < 0.32) expireInDays = ri(4, 28);                 // 临期
      else expireInDays = shelf - receivedAgo;                        // 正常效期
      const oldQty = Math.round(m.safetyStock * (1.1 + rand() * 1.0));
      seedInbound(s, m, receivedAgo, oldQty, expireInDays, s.manager);
      // 保证每店至少一个过期批次 + 两个临期批次
      if (mi === 2) seedInbound(s, m, ri(60, 80), ri(20, 40), ri(5, 15), s.manager, '效期预警演示批次（已过期）');
      if (mi === 4) seedInbound(s, m, ri(60, 80), ri(15, 30), ri(6, 20), s.manager, '效期预警演示批次（临期）');
      if (mi === 9) seedInbound(s, m, ri(50, 70), ri(20, 40), ri(10, 25), s.manager, '效期预警演示批次（临期）');
      if (rand() < 0.75) {
        const ago = ri(3, 12);
        seedInbound(s, m, ago, Math.round(m.safetyStock * (0.7 + rand() * 0.9)), shelf - ago, s.manager);
      }
    });
  });

  /* 近 30 天历史耗用：每天每店 0~2 单热门项目，按配方 FEFO 扣减 */
  const POP_SVCS = ['V01', 'V02', 'V04', 'V06', 'V11', 'V12', 'V07'];
  for (let d = 30; d >= 1; d--) {
    const createdAt0 = tsAgo(d, 0, 0).slice(0, 10);
    for (const s of STORES) {
      const n = ri(0, 2);
      for (let k = 0; k < n; k++) {
        const svcId = pick(POP_SVCS);
        const ts = `${createdAt0} ${pad(ri(10, 22))}:${pad(ri(0, 59))}:00`;
        for (const [materialId, qty] of (RECIPE_DEF[svcId] || [])) {
          seedConsume(s.id, materialId, qty, ts);
        }
      }
    }
  }

  /* 每店人为制造一个低库存耗材（昨日集中耗用至安全库存以下） */
  STORES.forEach((s, si) => {
    const m = MATERIALS[(si * 3 + 4) % MATERIALS.length];
    const avail = fefoBatches(s.id, m.id).reduce((a, b) => a + batchAvailable(b), 0);
    const target = Math.round(m.safetyStock * (0.25 + rand() * 0.2));
    const need = r3(Math.max(0, avail - target));
    if (need > 0) seedConsume(s.id, m.id, need, tsAgo(1, 21, ri(10, 50)));
  });
  // S01 再保证采耳套装低库存
  {
    const m = MATERIALS.find(x => x.id === 'MA0008');
    const avail = fefoBatches('S01', m.id).reduce((a, b) => a + batchAvailable(b), 0);
    const need = r3(Math.max(0, avail - 8));
    if (need > 0) seedConsume('S01', m.id, need, tsAgo(1, 20, 20));
  }

  /* 盘点：S01 一张已确认盘亏单 + 一张未提交草稿；S02 一张账实相符单 */
  const snapshotItems = (storeId) => MATERIALS.map(m => {
    const bs = db.stockBatches.filter(b => b.storeId === storeId && b.materialId === m.id);
    const quantity = r3(bs.reduce((a, b) => a + b.quantity, 0));
    const frozen = r3(bs.reduce((a, b) => a + b.frozen, 0));
    return { materialId: m.id, systemQty: quantity, actualQty: quantity, diff: 0, frozen };
  });
  {
    const items = snapshotItems('S01');
    const it = items.find(x => x.materialId === 'MA0003');
    it.actualQty = r3(it.systemQty - 2); it.diff = -2;
    const createdAt = tsAgo(6, 17, 20);
    const ck = {
      id: `SC${String(++checkSeq).padStart(6, '0')}`, storeId: 'S01', status: 'confirmed',
      items, operator: '周敏', createdAt, confirmedAt: tsAgo(6, 17, 45), remark: '月末盘点，一次性毛巾破损 2 条',
    };
    db.stockChecks.push(ck);
    const b = fefoBatches('S01', 'MA0003')[0];
    if (b) {
      b.quantity = r3(b.quantity - 2);
      addLedger({
        storeId: 'S01', materialId: 'MA0003', batchId: b.id, type: 'check_out', qty: 2, change: -2,
        refType: 'check', refId: ck.id, orderId: null,
        batchQtyAfter: b.quantity, batchAvailAfter: r3(b.quantity - b.frozen),
        operator: '周敏', createdAt: ck.confirmedAt, note: '盘点盘亏：月末盘点，一次性毛巾破损 2 条',
      });
    }
  }
  db.stockChecks.push({
    id: `SC${String(++checkSeq).padStart(6, '0')}`, storeId: 'S01', status: 'draft',
    items: snapshotItems('S01'), operator: '周敏', createdAt: nowLocal(), confirmedAt: null, remark: '',
  });
  db.stockChecks.push({
    id: `SC${String(++checkSeq).padStart(6, '0')}`, storeId: 'S02', status: 'confirmed',
    items: snapshotItems('S02'), operator: '林海', createdAt: tsAgo(15, 16, 30), confirmedAt: tsAgo(15, 16, 55),
    remark: '旬度盘点，账实相符',
  });

  /* 跨店调拨样例：已签收 / 冻结中 / 已拒绝 / 已取消 / 待确认（主动调拨 + 请货） */
  const allocBatches = (storeId, materialId, qty) => {
    let need = qty; const allocs = [];
    for (const b of fefoBatches(storeId, materialId)) {
      const take = Math.min(batchAvailable(b), need);
      if (take > 0) allocs.push({ batchId: b.id, qty: r3(take) });
      need = r3(need - take);
      if (need <= 0) break;
    }
    return need > 0 ? null : allocs;
  };
  const seedTransfer = (o) => {
    const tr = {
      id: `ST${String(++stockTransferSeq).padStart(6, '0')}`,
      transferNo: `DB${tsAgo(o.createdDaysAgo, 0, 0).slice(0, 10).replace(/-/g, '')}${String(stockTransferSeq).padStart(4, '0')}`,
      fromStoreId: o.from, toStoreId: o.to, direction: o.direction || 'out',
      materialId: o.materialId, qty: o.qty, unit: MATERIALS.find(m => m.id === o.materialId).unit,
      status: 'pending', batches: o.batches === undefined ? null : o.batches,
      createdBy: o.createdBy, createdAt: tsAgo(o.createdDaysAgo, ri(9, 18), ri(0, 59)),
      confirmedAt: null, confirmedBy: null, receivedAt: null, receivedBy: null,
      rejectedAt: null, rejectedBy: null, rejectReason: null,
      canceledAt: null, canceledBy: null, cancelReason: null, note: o.note || '',
    };
    db.stockTransfers.push(tr);
    const doFreeze = (at) => {
      (tr.batches || []).forEach(a => {
        const b = db.stockBatches.find(x => x.id === a.batchId);
        b.frozen = r3(b.frozen + a.qty);
        addLedger({
          storeId: b.storeId, materialId: b.materialId, batchId: b.id, type: 'freeze', qty: a.qty, change: 0,
          refType: 'transfer', refId: tr.id, orderId: null,
          batchQtyAfter: b.quantity, batchAvailAfter: r3(b.quantity - b.frozen),
          operator: tr.confirmedBy, createdAt: at, note: `调拨冻结：${db.stores.find(s => s.id === tr.toStoreId).name}`,
        });
      });
    };
    const doRelease = (at, type, by, reason) => {
      (tr.batches || []).forEach(a => {
        const b = db.stockBatches.find(x => x.id === a.batchId);
        b.frozen = r3(Math.max(0, b.frozen - a.qty));
        addLedger({
          storeId: b.storeId, materialId: b.materialId, batchId: b.id, type: 'release', qty: a.qty, change: 0,
          refType: 'transfer', refId: tr.id, orderId: null,
          batchQtyAfter: b.quantity, batchAvailAfter: r3(b.quantity - b.frozen),
          operator: by, createdAt: at, note: `${type === 'reject' ? '拒绝解冻' : '取消解冻'}：${reason || tr.id}`,
        });
      });
    };
    if (o.status === 'pending') return tr;
    tr.status = 'frozen';
    tr.confirmedBy = o.confirmedBy; tr.confirmedAt = tsAgo(o.confirmedDaysAgo, ri(9, 18), ri(0, 59));
    doFreeze(tr.confirmedAt);
    if (o.status === 'rejected') {
      tr.status = 'rejected';
      tr.rejectedBy = o.rejectedBy; tr.rejectReason = o.endReason || '';
      tr.rejectedAt = tsAgo(o.endDaysAgo, ri(9, 18), ri(0, 59));
      doRelease(tr.rejectedAt, 'reject', tr.rejectedBy, o.endReason);
      return tr;
    }
    if (o.status === 'cancelled') {
      tr.status = 'cancelled';
      tr.canceledBy = o.canceledBy; tr.cancelReason = o.endReason || '';
      tr.canceledAt = tsAgo(o.endDaysAgo, ri(9, 18), ri(0, 59));
      doRelease(tr.canceledAt, 'cancel', tr.canceledBy, o.endReason);
      return tr;
    }
    if (o.status === 'received') {
      const at = tsAgo(o.receivedDaysAgo, ri(9, 18), ri(0, 59));
      tr.status = 'received'; tr.receivedBy = o.receivedBy; tr.receivedAt = at;
      let total = 0, earliest = null;
      (tr.batches || []).forEach(a => {
        const b = db.stockBatches.find(x => x.id === a.batchId);
        b.frozen = r3(Math.max(0, b.frozen - a.qty));
        b.quantity = r3(b.quantity - a.qty);
        total += a.qty;
        if (b.expireDate && (!earliest || b.expireDate < earliest)) earliest = b.expireDate;
        addLedger({
          storeId: b.storeId, materialId: b.materialId, batchId: b.id, type: 'transfer_out', qty: a.qty, change: -a.qty,
          refType: 'transfer', refId: tr.id, orderId: null,
          batchQtyAfter: b.quantity, batchAvailAfter: r3(b.quantity - b.frozen),
          operator: tr.receivedBy, createdAt: at, note: `调出至 ${db.stores.find(s => s.id === tr.toStoreId).name}`,
        });
      });
      // 调入店生成一个新批次（沿用最早效期）
      const newBatchId = `B${String(++batchSeq).padStart(7, '0')}`;
      db.stockBatches.push({
        id: newBatchId, storeId: tr.toStoreId, materialId: tr.materialId,
        batchNo: `DB${tr.id.slice(2)}`, inboundId: null, quantity: r3(total), frozen: 0,
        productionDate: null, expireDate: earliest, receivedAt: at,
      });
      addLedger({
        storeId: tr.toStoreId, materialId: tr.materialId, batchId: newBatchId, type: 'transfer_in', qty: r3(total), change: r3(total),
        refType: 'transfer', refId: tr.id, orderId: null,
        batchQtyAfter: r3(total), batchAvailAfter: r3(total),
        operator: tr.receivedBy, createdAt: at, note: `由 ${db.stores.find(s => s.id === tr.fromStoreId).name} 调入`,
      });
    }
    return tr;
  };

  // 1) 已签收：S01 → S02
  seedTransfer({
    from: 'S01', to: 'S02', materialId: 'MA0001', qty: 60, status: 'received',
    createdDaysAgo: 9, confirmedDaysAgo: 9, receivedDaysAgo: 8,
    batches: allocBatches('S01', 'MA0001', 60), createdBy: '周敏', confirmedBy: '周敏', receivedBy: '林海',
    note: '周末客流支援',
  });
  // 2) 冻结中：S02 → S03
  seedTransfer({
    from: 'S02', to: 'S03', materialId: 'MA0003', qty: 80, status: 'frozen',
    createdDaysAgo: 2, confirmedDaysAgo: 0,
    batches: allocBatches('S02', 'MA0003', 80), createdBy: '林海', confirmedBy: '林海',
    note: '静安寺店补货申请',
  });
  // 3) 待确认即被拒绝（请货，未指定批次 → 无冻结无解冻）
  seedTransfer({
    from: 'S03', to: 'S04', materialId: 'MA0005', qty: 5, direction: 'in', status: 'rejected',
    createdDaysAgo: 4, confirmedDaysAgo: 3, endDaysAgo: 3, batches: null,
    createdBy: '苏晴', confirmedBy: '苏晴', rejectedBy: '赵鹏', endReason: '本店艾草条仅够自用，暂无法调出',
  });
  // 4) 冻结后取消（验证解冻流水）
  seedTransfer({
    from: 'S04', to: 'S05', materialId: 'MA0002', qty: 30, status: 'cancelled',
    createdDaysAgo: 5, confirmedDaysAgo: 4, endDaysAgo: 3,
    batches: allocBatches('S04', 'MA0002', 30), createdBy: '赵鹏', confirmedBy: '赵鹏',
    canceledBy: '赵鹏', endReason: '广州店临时取消需求',
  });
  // 5) 待确认主动调拨（S05 发起、已选批次，尚未确认 → 不冻结）
  seedTransfer({
    from: 'S05', to: 'S06', materialId: 'MA0010', qty: 50, status: 'pending',
    createdDaysAgo: 1, batches: allocBatches('S05', 'MA0010', 50), createdBy: '陈嘉怡',
    note: '深圳店开业支援',
  });
  // 6) 待确认请货（S06 向 S01 请货，等待 S01 确认）
  seedTransfer({
    from: 'S01', to: 'S06', materialId: 'MA0012', qty: 6, direction: 'in', status: 'pending',
    createdDaysAgo: 0, batches: null, createdBy: '何俊',
    note: '拔罐耗材包备货不足，请总部协调外滩店支援',
  });

  db.counters.material = MATERIALS.length;
  db.counters.materialRecipe = db.materialRecipes.length;
  db.counters.stockBatch = batchSeq;
  db.counters.inbound = inboundSeq;
  db.counters.stockCheck = checkSeq;
  db.counters.stockTransfer = stockTransferSeq;
  db.counters.stockLedger = ledgerSeq;

  db.meta.orderCount = db.orders.length;
  return db;
}

/* ---------------- 加载 / 保存 ---------------- */
let db = null;
let saveTimer = null;

function load() {
  if (db) return db;
  try {
    if (fs.existsSync(DB_FILE)) {
      db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      // 兼容旧版本数据：补齐库存相关表与基础数据
      db.materials = db.materials || MATERIALS;
      db.materialUnits = db.materialUnits || MATERIAL_UNITS;
      if (!db.materialRecipes) {
        db.materialRecipes = SERVICES.map((svc, i) => ({
          id: `MR${String(i + 1).padStart(4, '0')}`, serviceId: svc.id,
          items: (RECIPE_DEF[svc.id] || []).map(([materialId, qty]) => ({ materialId, qty })),
        }));
      }
      ['stockBatches', 'stockInbounds', 'stockChecks', 'stockTransfers', 'stockLedger'].forEach(k => { db[k] = db[k] || []; });
    } else {
      db = buildSeed();
      save(true);
    }
  } catch (e) {
    console.error('数据加载失败，重建种子：', e.message);
    db = buildSeed();
    save(true);
  }
  return db;
}

function save(sync = false) {
  if (!db) return;
  const doSave = () => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, JSON.stringify(db));
    } catch (e) { console.error('保存失败：', e.message); }
  };
  if (sync) { clearTimeout(saveTimer); doSave(); return; }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 120);
}

function reseed() {
  db = buildSeed();
  save(true);
  return db;
}

module.exports = { load, save, reseed, nowLocal, fmtDate, parseDate, DB_FILE };

/* 直接执行：node server/db.js --reseed */
if (require.main === module && process.argv.includes('--reseed')) {
  const d = reseed();
  console.log('种子数据已重建：', {
    stores: d.stores.length, technicians: d.technicians.length,
    members: d.members.length, orders: d.orders.length,
    shifts: d.shifts.length, handovers: d.handovers.length,
    materials: d.materials.length, recipes: d.materialRecipes.length,
    batches: d.stockBatches.length, ledger: d.stockLedger.length,
    transfers: d.stockTransfers.length, file: DB_FILE,
  });
}
