import db, { getSetting, setSetting, tx, afterCommit } from './db.js'

// 园区物资采购与库存模块：
// 供应商 → 采购单（商铺申购/运营审批协同）→ 入库批次（验收差异）→ 库存（批次成本/FEFO 出库）
//  → 商铺销售联动扣减库存 → 缺货预警/自动申购 → 采购退货 → 供应商账单结算 → 盘点/异常对账
// 现金口径：采购入库不付现（形成应付），付款才流出现金；商铺售出不再另计成本（成本在采购付款时确认）。
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d }

const ctx = {
  day: () => num(getSetting('day'), 1),
  hour: () => num(getSetting('hour'), 9),
  tick: () => num(getSetting('tick'), 0),
  cash: () => num(getSetting('cash'), 0),
  logFinance: null,     // 财务流水（采购付款/供应商退现/盘亏损失）
  createEvent: null     // 经营事件推送（缺货预警等，注入 index.js 的 events 写入）
}
export function initInventoryContext(deps = {}) { Object.assign(ctx, deps) }

const cfg = (k, d = 0) => num(getSetting(k), d)

// ---------------- 基础工具 ----------------
function logPurchase(orderId, action, note = '', staffId = null, extra = {}) {
  db.prepare(`INSERT INTO purchase_logs(order_id,material_id,supplier_id,tick,day,hour,action,note,staff_id)
              VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(orderId, extra.materialId ?? null, extra.supplierId ?? null,
      ctx.tick(), ctx.day(), ctx.hour(), action, note, staffId)
}

function materialById(id) { return db.prepare('SELECT * FROM materials WHERE id=?').get(id) }
function supplierById(id) { return db.prepare('SELECT * FROM suppliers WHERE id=?').get(id) }

// 单据号
function codeOf(table, prefix, id) {
  const code = prefix + String(id).padStart(4, '0')
  db.prepare(`UPDATE ${table} SET code=? WHERE id=?`).run(code, id)
  return code
}

// 刷新物资汇总计数器（以批次剩余为事实源）并按安全库存刷新预警状态
function refreshStock(materialId) {
  const rows = db.prepare('SELECT qty_remain, unit_cost, qty_in FROM stock_batches WHERE material_id=? AND qty_remain>0')
    .all(materialId)
  const onhand = rows.reduce((s, r) => s + r.qty_remain, 0)
  const m = materialById(materialId)
  // 移动平均成本：仅对当前在库批次按剩余数量加权（出库批次不参与）
  const avg = onhand > 0
    ? Math.round(rows.reduce((s, r) => s + r.qty_remain * r.unit_cost, 0) / onhand)
    : (m?.last_cost || 0)
  const status = onhand <= 0 ? 'out' : onhand < (m?.safety_stock || 0) ? 'low' : 'ok'
  db.prepare('UPDATE material_stock SET onhand_qty=?, avg_cost=?, alert_status=? WHERE material_id=?')
    .run(onhand, avg, status, materialId)
  return { onhand, avg, status }
}

function ensureStockRow(materialId) {
  db.prepare('INSERT OR IGNORE INTO material_stock(material_id) VALUES(?)').run(materialId)
}

function stockStatus(materialId) {
  ensureStockRow(materialId)
  const r = db.prepare('SELECT * FROM material_stock WHERE material_id=?').get(materialId)
  const m = materialById(materialId)
  return {
    ...r,
    safety_stock: m?.safety_stock || 0,
    target_stock: m?.target_stock || 0,
    low: r.onhand_qty < (m?.safety_stock || 0),
    out: r.onhand_qty <= 0
  }
}

// ---------------- 库存出入库（批次 FEFO：先到期先出，无保质期排后） ----------------
// 出库 qty：按批次拆分，返回各批次成本合计（移动成本）；库存不足时返回 {ok:false}
function issueStock(materialId, qty, { kind = 'sale', refType = '', refId = null, vendorId = null, note = '' } = {}) {
  if (qty <= 0) return { ok: false, msg: '出库数量需大于 0' }
  let remain = qty
  const batches = db.prepare(`SELECT * FROM stock_batches WHERE material_id=? AND qty_remain>0
                              ORDER BY (expire_day=0), expire_day ASC, id ASC`).all(materialId)
  const avail = batches.reduce((s, b) => s + b.qty_remain, 0)
  if (avail < qty) return { ok: false, msg: '库存不足', available: avail }
  let cost = 0
  for (const b of batches) {
    if (remain <= 0) break
    const take = Math.min(b.qty_remain, remain)
    db.prepare('UPDATE stock_batches SET qty_remain=qty_remain-? WHERE id=?').run(take, b.id)
    remain -= take
    cost += take * b.unit_cost
  }
  db.prepare('UPDATE material_stock SET onhand_qty=onhand_qty-?, total_out_qty=total_out_qty+? WHERE material_id=?')
    .run(qty, qty, materialId)
  const after = refreshStock(materialId)
  db.prepare(`INSERT INTO stock_ledger(material_id,change_qty,balance_after,kind,ref_type,ref_id,vendor_id,unit_cost,day,tick,note)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(materialId, -qty, after.onhand, kind, refType, refId, vendorId, Math.round(cost / qty), ctx.day(), ctx.tick(), note)
  return { ok: true, cost }
}

// 入库（采购入库/退货入库/盘盈）：建批次 + 计数器 + 流水
function receiveStock(materialId, qty, unitCost, { kind = 'inbound', refType = '', refId = null, inboundItemId = null, vendorId = null, expireDay = 0, note = '' } = {}) {
  if (qty <= 0) return { ok: false, msg: '入库数量需大于 0' }
  ensureStockRow(materialId)
  db.prepare('INSERT INTO stock_batches(material_id,inbound_item_id,qty_in,qty_remain,unit_cost,expire_day,in_day,in_tick) VALUES(?,?,?,?,?,?,?,?)')
    .run(materialId, inboundItemId, qty, qty, unitCost, expireDay, ctx.day(), ctx.tick())
  const before = stockStatus(materialId)
  db.prepare('UPDATE material_stock SET onhand_qty=onhand_qty+?, total_in_qty=total_in_qty+? WHERE material_id=?')
    .run(qty, qty, materialId)
  if (kind === 'inbound') {
    db.prepare('UPDATE materials SET last_cost=? WHERE id=?').run(unitCost, materialId)
  }
  const after = refreshStock(materialId)
  db.prepare(`INSERT INTO stock_ledger(material_id,change_qty,balance_after,kind,ref_type,ref_id,vendor_id,unit_cost,day,tick,note)
              VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .run(materialId, qty, after.onhand, kind, refType, refId, vendorId, unitCost, ctx.day(), ctx.tick(), note)
  return { ok: true, before: before.alert_status, after: after.status }
}

// ---------------- 供应商 / 物资 / 商铺目录 ----------------
export function createSupplier(payload = {}) {
  const name = String(payload.name || '').trim()
  if (!name) return { ok: false, msg: '请填写供应商名称' }
  const r = db.prepare(`INSERT INTO suppliers(name,contact,phone,category,lead_days,rating,status,note,created_day)
                        VALUES(?,?,?,?,?,?, 'active', ?, ?)`)
    .run(name, String(payload.contact || ''), String(payload.phone || ''),
      String(payload.category || '综合'), clampInt(payload.lead_days, 0, 30, 2),
      clampInt(payload.rating, 1, 5, 3), String(payload.note || ''), ctx.day())
  const id = Number(r.lastInsertRowid)
  return { ok: true, id, code: codeOf('suppliers', 'GYS', id) }
}

export function updateSupplier(id, patch = {}) {
  const s = supplierById(id)
  if (!s) return { ok: false, msg: '供应商不存在' }
  const sets = [], vals = []
  for (const k of ['name', 'contact', 'phone', 'category', 'note']) {
    if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(String(patch[k])) }
  }
  if (patch.lead_days !== undefined) { sets.push('lead_days=?'); vals.push(clampInt(patch.lead_days, 0, 30, 2)) }
  if (patch.rating !== undefined) { sets.push('rating=?'); vals.push(clampInt(patch.rating, 1, 5, 3)) }
  if (patch.status !== undefined) {
    if (!['active', 'suspended'].includes(patch.status)) return { ok: false, msg: '非法状态' }
    sets.push('status=?'); vals.push(patch.status)
  }
  if (!sets.length) return { ok: true }
  vals.push(id)
  db.prepare(`UPDATE suppliers SET ${sets.join(',')} WHERE id=?`).run(...vals)
  return { ok: true }
}

export function listSuppliers() {
  return db.prepare(`SELECT s.*,
      (SELECT COUNT(*) FROM purchase_orders WHERE supplier_id=s.id) order_count,
      (SELECT COALESCE(SUM(b.amount_due-b.amount_paid-b.amount_returned),0)
         FROM supplier_bills b WHERE b.supplier_id=s.id AND b.status<>'settled') payable
    FROM suppliers s ORDER BY s.id`).all()
}

export function createMaterial(payload = {}) {
  const name = String(payload.name || '').trim()
  if (!name) return { ok: false, msg: '请填写物资名称' }
  const std = clampInt(payload.std_cost, 0, 1000000, 0)
  const r = db.prepare(`INSERT INTO materials(name,category,unit,std_cost,last_cost,safety_stock,target_stock,shelf_days,status,note)
                        VALUES(?,?,?,?,?,?,?,?, 'on', ?)`)
    .run(name, ['原料', '包装', '百货'].includes(payload.category) ? payload.category : '原料',
      String(payload.unit || '份'), std, std,
      clampInt(payload.safety_stock, 0, 1000000, 80),
      clampInt(payload.target_stock, 0, 1000000, 300),
      clampInt(payload.shelf_days, 0, 3650, 0), String(payload.note || ''))
  const id = Number(r.lastInsertRowid)
  ensureStockRow(id)
  return { ok: true, id, code: codeOf('materials', 'WZ', id) }
}

export function updateMaterial(id, patch = {}) {
  const m = materialById(id)
  if (!m) return { ok: false, msg: '物资不存在' }
  const sets = [], vals = []
  for (const k of ['name', 'unit', 'category', 'note']) {
    if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(String(patch[k])) }
  }
  for (const k of ['std_cost', 'safety_stock', 'target_stock', 'shelf_days']) {
    if (patch[k] !== undefined) { sets.push(`${k}=?`); vals.push(clampInt(patch[k], 0, 1000000, m[k])) }
  }
  if (patch.status !== undefined) {
    if (!['on', 'off'].includes(patch.status)) return { ok: false, msg: '非法状态' }
    sets.push('status=?'); vals.push(patch.status)
  }
  if (!sets.length) return { ok: true }
  vals.push(id)
  db.prepare(`UPDATE materials SET ${sets.join(',')} WHERE id=?`).run(...vals)
  refreshStock(id)
  return { ok: true }
}

// 物资库存总览（含关联商铺、今日销量/缺货损失）
export function listMaterials() {
  const rows = db.prepare('SELECT * FROM materials ORDER BY category,id').all()
  const today = ctx.day()
  return rows.map(m => {
    ensureStockRow(m.id)
    const st = db.prepare('SELECT * FROM material_stock WHERE material_id=?').get(m.id)
    const outToday = num(db.prepare("SELECT COALESCE(SUM(-change_qty),0) n FROM stock_ledger WHERE material_id=? AND kind='sale' AND day=?").get(m.id, today).n)
    const lostToday = num(db.prepare("SELECT COALESCE(SUM(-change_qty),0) n FROM stock_ledger WHERE material_id=? AND kind='stockout_loss' AND day=?").get(m.id, today).n)
    const vendors = db.prepare(`SELECT v.id,v.name,vm.qty_per_sale FROM vendor_materials vm JOIN vendors v ON v.id=vm.vendor_id WHERE vm.material_id=?`).all(m.id)
    return {
      ...m, ...st, low: st.onhand_qty < m.safety_stock, out: st.onhand_qty <= 0,
      out_today: outToday, lost_today: lostToday, vendors
    }
  })
}

export function setVendorMaterial(vendorId, materialId, qtyPerSale = 1) {
  const v = db.prepare('SELECT id FROM vendors WHERE id=?').get(vendorId)
  const m = materialById(materialId)
  if (!v || !m) return { ok: false, msg: '商铺或物资不存在' }
  const q = clampInt(qtyPerSale, 1, 100, 1)
  db.prepare(`INSERT INTO vendor_materials(vendor_id,material_id,qty_per_sale) VALUES(?,?,?)
              ON CONFLICT(vendor_id,material_id) DO UPDATE SET qty_per_sale=excluded.qty_per_sale`)
    .run(vendorId, materialId, q)
  return { ok: true }
}

export function removeVendorMaterial(vendorId, materialId) {
  db.prepare('DELETE FROM vendor_materials WHERE vendor_id=? AND material_id=?').run(vendorId, materialId)
  return { ok: true }
}

// ---------------- 采购单：申购 → 审批 → 到货验收（分批） ----------------
function normalizeItems(rawItems) {
  const map = new Map()
  for (const it of rawItems || []) {
    const mid = clampInt(it.material_id, 0)
    const qty = clampInt(it.qty, 0)
    if (!mid || qty <= 0) continue
    const m = materialById(mid)
    if (!m || m.status === 'off') continue
    const unit = it.unit_cost !== undefined && num(it.unit_cost) >= 0
      ? clampInt(it.unit_cost, 0)
      : (m.last_cost || m.std_cost)
    if (!map.has(mid)) map.set(mid, { material_id: mid, qty: 0, unit_cost: unit })
    const row = map.get(mid)
    row.qty += qty
    row.unit_cost = unit   // 同物资多行以后者单价为准
  }
  return [...map.values()]
}

// 创建采购单。status: draft 暂存 / pending 直接提交待审批（默认）
export function createPurchaseOrder(payload = {}) {
  const supplier = supplierById(num(payload.supplier_id))
  if (!supplier) return { ok: false, msg: '请选择有效的供应商' }
  if (supplier.status !== 'active') return { ok: false, msg: '该供应商已暂停合作，请更换供应商' }
  const items = normalizeItems(payload.items)
  if (!items.length) return { ok: false, msg: '请至少添加一条有效采购明细（物资与数量）' }
  const submit = payload.submit !== false
  const status = submit ? 'pending' : 'draft'
  let id
  tx(() => {
    const totalQty = items.reduce((s, i) => s + i.qty, 0)
    const totalAmount = items.reduce((s, i) => s + i.qty * i.unit_cost, 0)
    const r = db.prepare(`INSERT INTO purchase_orders(code,supplier_id,status,source,vendor_id,creator_staff_id,total_qty,total_amount,created_tick,created_day,note)
                          VALUES('',?,?,?,?,?,?,?,?,?,?)`)
      .run(supplier.id, status,
        ['manual', 'shop', 'auto'].includes(payload.source) ? payload.source : 'manual',
        payload.vendor_id ? clampInt(payload.vendor_id) : null,
        payload.creator_staff_id ? clampInt(payload.creator_staff_id) : null,
        totalQty, totalAmount, ctx.tick(), ctx.day(), String(payload.note || ''))
    id = Number(r.lastInsertRowid)
    codeOf('purchase_orders', 'CG', id)
    const ii = db.prepare('INSERT INTO purchase_order_items(order_id,material_id,qty,unit_cost,amount) VALUES(?,?,?,?,?)')
    for (const i of items) ii.run(id, i.material_id, i.qty, i.unit_cost, i.qty * i.unit_cost)
    logPurchase(id, submit ? 'submit' : 'create',
      submit ? `${payload.source === 'shop' ? '商铺申购提交' : payload.source === 'auto' ? '缺货自动申购' : '运营提交采购'}：${totalQty} 件 / ¥${totalAmount}` : '采购单暂存',
      payload.creator_staff_id ? clampInt(payload.creator_staff_id) : null,
      { supplierId: supplier.id })
  })
  return { ok: true, id, code: 'CG' + String(id).padStart(4, '0'), status }
}

// 草稿提交
export function submitPurchaseOrder(id) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, msg: '采购单不存在' }
  if (o.status !== 'draft') return { ok: false, msg: '仅暂存草稿可提交' }
  db.prepare("UPDATE purchase_orders SET status='pending' WHERE id=?").run(id)
  logPurchase(id, 'submit', '草稿提交，等待运营主管审批', null, { supplierId: o.supplier_id })
  return { ok: true }
}

// 审批（运营主管）：通过 → 预计到货日 = 当日 + 供应商供货周期；驳回需理由
export function approvePurchaseOrder(id, { approve = true, staffId = null, note = '' } = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, msg: '采购单不存在' }
  if (o.status !== 'pending') return { ok: false, msg: '仅待审批采购单可审批' }
  if (!approve) {
    if (!String(note).trim()) return { ok: false, msg: '驳回需填写原因（便于商铺调整申购）' }
    db.prepare("UPDATE purchase_orders SET status='rejected', reject_reason=?, approver_id=? WHERE id=?")
      .run(String(note).trim(), staffId, id)
    logPurchase(id, 'reject', `运营驳回：${note}`, staffId, { supplierId: o.supplier_id })
    return { ok: true, status: 'rejected' }
  }
  const s = supplierById(o.supplier_id)
  const arriveDay = ctx.day() + Math.max(0, s?.lead_days || 0)
  db.prepare("UPDATE purchase_orders SET status='approved', approver_id=?, arrive_day=?, approve_tick=? WHERE id=?")
    .run(staffId, arriveDay, ctx.tick(), id)
  logPurchase(id, 'approve', `审批通过，预计第 ${arriveDay} 天到货（供货周期 ${s?.lead_days || 0} 天）`, staffId, { supplierId: o.supplier_id })
  return { ok: true, status: 'approved', arriveDay }
}

// 撤销：草稿/待审批/已批准未入库可撤销
export function cancelPurchaseOrder(id, { note = '' } = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, msg: '采购单不存在' }
  if (!['draft', 'pending', 'approved'].includes(o.status)) return { ok: false, msg: '当前状态不可撤销（已入库请走采购退货）' }
  db.prepare("UPDATE purchase_orders SET status='cancelled', note=? WHERE id=?").run(String(note), o.id)
  logPurchase(id, 'cancel', note || '采购单撤销', null, { supplierId: o.supplier_id })
  return { ok: true }
}

// 找/建供应商账单（一个采购单一张账单，首笔入库时建立）
function ensureBill(orderId, supplierId) {
  let bill = db.prepare('SELECT * FROM supplier_bills WHERE order_id=?').get(orderId)
  if (!bill) {
    const r = db.prepare(`INSERT INTO supplier_bills(code,supplier_id,order_id,amount_due,status,due_day,created_tick,created_day)
                          VALUES('',?, ?, 0, 'open', ?, ?, ?)`)
      .run(supplierId, orderId, ctx.day(), ctx.tick(), ctx.day())
    const id = Number(r.lastInsertRowid)
    codeOf('supplier_bills', 'ZD', id)
    bill = db.prepare('SELECT * FROM supplier_bills WHERE id=?').get(id)
  }
  return bill
}

function billRefresh(billId) {
  const b = db.prepare('SELECT * FROM supplier_bills WHERE id=?').get(billId)
  const remain = b.amount_due - b.amount_paid - b.amount_returned
  const status = remain <= 0 ? 'settled' : b.amount_paid + b.amount_returned > 0 ? 'partial' : 'open'
  db.prepare('UPDATE supplier_bills SET status=?, note=? WHERE id=?')
    .run(status, status === 'settled' ? '账单已结清' : b.note, billId)
  // 回写采购单结清日
  if (status === 'settled' && b.order_id) {
    db.prepare('UPDATE purchase_orders SET settled_day=? WHERE id=? AND settled_day=0').run(ctx.day(), b.order_id)
  }
  return { status, remain: Math.max(0, remain) }
}

// 验收入库。items: [{ item_id/material_id, recv_qty, damaged_qty }]
// 实收 → 库存批次 + 应付账单；少送 → 记录待补发（订单保持 receiving，不自动追加）；破损 → 不入库不挂账
export function receivePurchase(id, payload = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, msg: '采购单不存在' }
  if (!['approved', 'receiving'].includes(o.status)) return { ok: false, msg: '仅已批准/部分入库的采购单可验收入库' }
  const rows = Array.isArray(payload.items) ? payload.items : []
  if (!rows.length) return { ok: false, msg: '请填写验收数量' }
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(id)
  const itemMap = new Map(items.map(i => [i.id, i]))

  let batchId
  try {
    const result = tx(() => {
    let totalQty = 0, totalAmount = 0, shortage = 0, damaged = 0
    const norm = []
    for (const r of rows) {
      const iid = clampInt(r.item_id || r.order_item_id)
      const it = itemMap.get(iid)
      if (!it) continue
      const recv = clampInt(r.recv_qty, 0)
      const dmg = clampInt(r.damaged_qty, 0)
      const openQty = it.qty - it.received_qty
      if (recv < 0 || recv + dmg > openQty) {
        throw new Error(`「${materialById(it.material_id)?.name}」验收数+破损数不能超过待交数量 ${openQty}`)
      }
      if (recv === 0 && dmg === 0) continue
      norm.push({ it, recv, dmg })
      totalQty += recv; totalAmount += recv * it.unit_cost
      shortage += Math.max(0, openQty - recv - dmg)
      damaged += dmg
    }
    if (!norm.length) throw new Error('没有可入库的验收明细')

    const br = db.prepare(`INSERT INTO inbound_batches(code,order_id,status,source,recv_staff_id,total_qty,total_amount,shortage_qty,damaged_qty,tick,day,note)
                           VALUES('',?, 'done', ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, payload.source === 'auto' ? 'auto' : 'manual',
        payload.staff_id ? clampInt(payload.staff_id) : null,
        totalQty, totalAmount, norm.reduce((s, x) => s + Math.max(0, (x.it.qty - x.it.received_qty) - x.recv - x.dmg), 0),
        damaged, ctx.tick(), ctx.day(), String(payload.note || ''))
    batchId = Number(br.lastInsertRowid)
    codeOf('inbound_batches', 'RK', batchId)

    const ii = db.prepare('INSERT INTO inbound_batch_items(batch_id,order_item_id,material_id,recv_qty,damaged_qty,shortage_qty,unit_cost) VALUES(?,?,?,?,?,?,?)')
    for (const { it, recv, dmg } of norm) {
      const m = materialById(it.material_id)
      const openQtyBefore = it.qty - it.received_qty
      const short = Math.max(0, openQtyBefore - recv - dmg)
      ii.run(batchId, it.id, it.material_id, recv, dmg, short, it.unit_cost)
      if (recv > 0) {
        // 入库批次（保质期 = 当日 + 物资保质期）
        receiveStock(it.material_id, recv, it.unit_cost, {
          kind: 'inbound', refType: 'batch', refId: batchId, inboundItemId: null,
          expireDay: m.shelf_days ? ctx.day() + m.shelf_days : 0,
          note: `${o.code} 验收入库`
        })
      }
      db.prepare('UPDATE purchase_order_items SET received_qty=received_qty+? WHERE id=?').run(recv + dmg, it.id)
    }

    // 形成应付账单（实收才挂账；少送/破损不挂应付）
    if (totalAmount > 0) {
      const bill = ensureBill(id, o.supplier_id)
      db.prepare('UPDATE supplier_bills SET amount_due=amount_due+?, batch_id=? WHERE id=?')
        .run(totalAmount, batchId, bill.id)
      db.prepare('INSERT INTO supplier_bill_payments(bill_id,kind,amount,day,tick,staff_id,note) VALUES(?,?,?,?,?,?,?)')
        .run(bill.id, 'inbound', totalAmount, ctx.day(), ctx.tick(),
          payload.staff_id ? clampInt(payload.staff_id) : null, `批次 RK${String(batchId).padStart(4, '0')} 入库形成应付`)
      billRefresh(bill.id)
    }

    // 采购单状态：全部交清（含少送/破损核销）→ received；否则保持 receiving 待补发
    const nowRows = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(id)
    const allDone = nowRows.every(x => x.received_qty >= x.qty)
    const recvTotal = nowRows.reduce((s, x) => s + x.received_qty, 0)
    db.prepare('UPDATE purchase_orders SET received_qty=?, status=?, arrived_tick=? WHERE id=?')
      .run(recvTotal, allDone ? 'received' : 'receiving', ctx.tick(), id)
    logPurchase(id, 'receive',
      `验收入库 ${totalQty} 件 / ¥${totalAmount}${damaged ? `，破损 ${damaged} 件不结算` : ''}${shortage ? `，少送 ${shortage} 件待补发` : ''}`,
      payload.staff_id ? clampInt(payload.staff_id) : null, { supplierId: o.supplier_id })
    return { batchId, totalQty, totalAmount, shortage, damaged, allDone }
    })
    return { ok: true, ...result }
  } catch (e) {
    return { ok: false, msg: e.message || '验收失败，本次入库未生效' }
  }
}

// 订单全部剩余未交部分按少送结案（供应商确认无法补发）：状态转 received，未交不挂账
export function closePurchaseShortage(id, { staffId = null, note = '' } = {}) {
  const o = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id)
  if (!o) return { ok: false, msg: '采购单不存在' }
  if (o.status !== 'receiving') return { ok: false, msg: '仅部分入库的采购单可做少送结案' }
  const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').all(id)
  let short = 0
  tx(() => {
    for (const it of items) {
      const gap = it.qty - it.received_qty
      if (gap > 0) {
        short += gap
        db.prepare('UPDATE purchase_order_items SET received_qty=qty WHERE id=?').run(it.id)
      }
    }
    db.prepare("UPDATE purchase_orders SET status='received' WHERE id=?").run(id)
    logPurchase(id, 'shortage', `确认少送 ${short} 件不再补发，按实收结案${note ? `：${note}` : ''}`, staffId, { supplierId: o.supplier_id })
  })
  return { ok: true, shortage: short }
}

// ---------------- 采购退货（退给供应商） ----------------
const RETURN_REASONS = { quality: '质量问题', damage: '运输破损', over: '多发退回', other: '其他' }

export function createPurchaseReturn(payload = {}) {
  const supplier = supplierById(num(payload.supplier_id))
  if (!supplier) return { ok: false, msg: '请选择有效供应商' }
  const m = materialById(num(payload.material_id))
  if (!m) return { ok: false, msg: '请选择退货物资' }
  const qty = clampInt(payload.qty, 0)
  if (qty <= 0) return { ok: false, msg: '退货数量需大于 0' }
  const st = stockStatus(m.id)
  if (st.onhand_qty < qty) return { ok: false, msg: `库存不足，当前在库 ${st.onhand_qty} ${m.unit}` }
  const reason = RETURN_REASONS[payload.reason] ? payload.reason : 'other'
  // 优先取原采购批次成本，否则用移动平均成本
  let unitCost = clampInt(payload.unit_cost, 0)
  if (!unitCost) {
    unitCost = num(db.prepare('SELECT unit_cost FROM stock_batches WHERE material_id=? AND qty_remain>0 ORDER BY id DESC LIMIT 1').get(m.id)?.unit_cost, st.avg_cost)
  }
  let id
  tx(() => {
    const r = db.prepare(`INSERT INTO purchase_returns(code,supplier_id,order_id,batch_id,material_id,qty,unit_cost,amount,reason,status,refund_status,staff_id,tick,day,note)
                          VALUES('',?,?,?,?,?,?,?,?,'submitted','none',?,?,?,?)`)
      .run(supplier.id, payload.order_id ? clampInt(payload.order_id) : null,
        payload.batch_id ? clampInt(payload.batch_id) : null,
        m.id, qty, unitCost, qty * unitCost, reason,
        payload.staff_id ? clampInt(payload.staff_id) : null, ctx.tick(), ctx.day(), String(payload.note || ''))
    id = Number(r.lastInsertRowid)
    codeOf('purchase_returns', 'RT', id)
    logPurchase(payload.order_id ? clampInt(payload.order_id) : null, 'return',
      `发起采购退货 ${m.name} ×${qty}（${RETURN_REASONS[reason]}），待供应商确认`,
      payload.staff_id ? clampInt(payload.staff_id) : null, { materialId: m.id, supplierId: supplier.id })
  })
  return { ok: true, id, code: 'RT' + String(id).padStart(4, '0') }
}

// 供应商确认退货：出库 + 冲减账单（未付款）或挂应收追偿（已付款）；refund_mode=deduct/cash
export function confirmPurchaseReturn(id, { refundMode = 'deduct', staffId = null, note = '' } = {}) {
  const r = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(id)
  if (!r) return { ok: false, msg: '退货单不存在' }
  if (r.status !== 'submitted') return { ok: false, msg: '该退货单已处理' }
  const st = stockStatus(r.material_id)
  if (st.onhand_qty < r.qty) return { ok: false, msg: `库存不足，当前在库 ${st.onhand_qty}，请先盘点校准` }

  return tx(() => {
    issueStock(r.material_id, r.qty, { kind: 'return_out', refType: 'return', refId: id, note: `采购退货 ${r.code}` })

    let refundStatus = 'deducted', cashBack = 0
    // 优先冲减该供应商未结账单（先关联原单，再取任意未结）
    let bill = r.order_id ? db.prepare('SELECT * FROM supplier_bills WHERE order_id=? AND status<>\'settled\'').get(r.order_id) : null
    if (!bill) {
      bill = db.prepare(`SELECT * FROM supplier_bills WHERE supplier_id=? AND status<>'settled'
                         ORDER BY (amount_due-amount_paid-amount_returned) DESC LIMIT 1`).get(r.supplier_id)
    }
    const remain = bill ? bill.amount_due - bill.amount_paid - bill.amount_returned : 0

    if (remain >= r.amount && refundMode !== 'cash') {
      // 未付足：直接冲减应付
      db.prepare('UPDATE supplier_bills SET amount_returned=amount_returned+? WHERE id=?').run(r.amount, bill.id)
      db.prepare('INSERT INTO supplier_bill_payments(bill_id,kind,amount,day,tick,staff_id,note) VALUES(?,?,?,?,?,?,?)')
        .run(bill.id, 'return', r.amount, ctx.day(), ctx.tick(), staffId, `退货 ${r.code} 冲减应付`)
      billRefresh(bill.id)
      refundStatus = 'deducted'
    } else if (bill && remain > 0 && refundMode !== 'cash') {
      // 部分已付：能冲多少冲多少，余额挂应收追偿（本模型不做应收收款流程，仅挂账进异常对账提示）
      db.prepare('UPDATE supplier_bills SET amount_returned=amount_returned+? WHERE id=?').run(remain, bill.id)
      db.prepare('INSERT INTO supplier_bill_payments(bill_id,kind,amount,day,tick,staff_id,note) VALUES(?,?,?,?,?,?,?)')
        .run(bill.id, 'return', remain, ctx.day(), ctx.tick(), staffId, `退货 ${r.code} 部分冲减应付，余 ¥${r.amount - remain} 待供应商退款`)
      billRefresh(bill.id)
      refundStatus = 'receivable'
      const receivable = r.amount - remain
      if (receivable > 0) {
        const fid = Number(db.prepare(`INSERT INTO reconcile_findings(code,kind,level,ref_type,ref_id,day,title,detail,expected,actual,status,tick,created_day)
                    VALUES('','supplier_refund','warn','return',?,?,?,?,?,'{}','{}','open',?,?)`)
          .run(r.id, ctx.day(), `退货 ${r.code} 已付款部分待供应商退款`,
            `退货金额 ¥${r.amount}，已冲减未付账单 ¥${remain}，余 ¥${receivable} 需供应商退款，请跟进追偿`,
            ctx.tick(), ctx.day()).lastInsertRowid)
        codeOf('reconcile_findings', 'RC', fid)
      }
    } else {
      // 现金退款（供应商当场退现）
      cashBack = r.amount
      setSetting('cash', Math.round(ctx.cash() + cashBack))
      ctx.logFinance?.(ctx.day(), '采购退款', cashBack, `采购退货 ${r.code} 供应商退现`)
      if (bill) {
        db.prepare('INSERT INTO supplier_bill_payments(bill_id,kind,amount,day,tick,staff_id,note) VALUES(?,?,?,?,?,?,?)')
          .run(bill.id, 'refund', cashBack, ctx.day(), ctx.tick(), staffId, `退货 ${r.code} 供应商退现`)
      }
      refundStatus = 'cash'
    }
    db.prepare("UPDATE purchase_returns SET status='confirmed', refund_status=?, handle_tick=?, note=? WHERE id=?")
      .run(refundStatus, ctx.tick(), note || r.note, id)
    logPurchase(r.order_id, 'return', `供应商确认退货，退款方式：${{ deducted: '冲减应付', receivable: '挂应收追偿', cash: '退现' }[refundStatus]}`,
      staffId, { materialId: r.material_id, supplierId: r.supplier_id })
    return { ok: true, refundStatus, cashBack }
  })
}

export function rejectPurchaseReturn(id, { staffId = null, note = '' } = {}) {
  const r = db.prepare('SELECT * FROM purchase_returns WHERE id=?').get(id)
  if (!r || r.status !== 'submitted') return { ok: false, msg: '退货单不存在或已处理' }
  if (!String(note).trim()) return { ok: false, msg: '驳回需填写说明' }
  db.prepare("UPDATE purchase_returns SET status='rejected', handle_tick=?, note=? WHERE id=?")
    .run(ctx.tick(), String(note).trim(), id)
  logPurchase(r.order_id, 'return', `供应商驳回退货：${note}`, staffId, { materialId: r.material_id, supplierId: r.supplier_id })
  return { ok: true }
}

// ---------------- 供应商账单结算 ----------------
export function paySupplierBill(billId, payload = {}) {
  const bill = db.prepare('SELECT * FROM supplier_bills WHERE id=?').get(billId)
  if (!bill) return { ok: false, msg: '账单不存在' }
  const remain = bill.amount_due - bill.amount_paid - bill.amount_returned
  if (remain <= 0) return { ok: false, msg: '账单已结清' }
  let amount = payload.amount === undefined ? remain : clampInt(payload.amount, 0)
  if (amount <= 0) return { ok: false, msg: '付款金额需大于 0' }
  amount = Math.min(amount, remain)
  if (ctx.cash() < amount) return { ok: false, msg: `资金不足，本次付款需 ¥${amount.toLocaleString()}` }
  return tx(() => {
    setSetting('cash', Math.round(ctx.cash() - amount))
    db.prepare('UPDATE supplier_bills SET amount_paid=amount_paid+? WHERE id=?').run(amount, billId)
    db.prepare('INSERT INTO supplier_bill_payments(bill_id,kind,amount,day,tick,staff_id,note) VALUES(?,?,?,?,?,?,?)')
      .run(billId, 'pay', -amount, ctx.day(), ctx.tick(),
        payload.staff_id ? clampInt(payload.staff_id) : null, payload.note || '供应商货款结算')
    const after = billRefresh(billId)
    ctx.logFinance?.(ctx.day(), '采购', -amount, `支付供应商货款 账单 ZD${String(billId).padStart(4, '0')}`)
    logPurchase(bill.order_id, 'pay', `支付供应商货款 ¥${amount}${after.status === 'settled' ? '，账单结清' : `，剩余应付 ¥${after.remain}`}`,
      payload.staff_id ? clampInt(payload.staff_id) : null, { supplierId: bill.supplier_id })
    return { ok: true, paid: amount, remain: after.remain, status: after.status }
  })
}

export function listBills({ status = 'all', supplierId = null } = {}) {
  const where = []
  const args = []
  if (status !== 'all') { where.push('b.status=?'); args.push(status) }
  if (supplierId) { where.push('b.supplier_id=?'); args.push(supplierId) }
  const sql = `SELECT b.*, s.name supplier_name,
      (b.amount_due-b.amount_paid-b.amount_returned) remain
    FROM supplier_bills b JOIN suppliers s ON s.id=b.supplier_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.id DESC LIMIT 200`
  return db.prepare(sql).all(...args).map(b => ({ ...b, over: b.remain < 0 }))
}

export function billDetail(id) {
  const bill = db.prepare(`SELECT b.*, s.name supplier_name, s.contact, s.phone,
      (b.amount_due-b.amount_paid-b.amount_returned) remain
    FROM supplier_bills b JOIN suppliers s ON s.id=b.supplier_id WHERE b.id=?`).get(id)
  if (!bill) return null
  const payments = db.prepare('SELECT * FROM supplier_bill_payments WHERE bill_id=? ORDER BY id').all(id)
  const batches = db.prepare('SELECT * FROM inbound_batches WHERE order_id=? ORDER BY id').all(bill.order_id)
  return { bill, payments, batches }
}

// ---------------- 商铺销售联动库存 ----------------
// 商铺物资目录（含每个物资本小时可支撑的销量）
function vendorDemand(vendorId) {
  return db.prepare(`SELECT vm.*, m.name material_name, m.unit, ms.onhand_qty, ms.alert_status
                     FROM vendor_materials vm
                     JOIN materials m ON m.id=vm.material_id
                     LEFT JOIN material_stock ms ON ms.material_id=m.id
                     WHERE vm.vendor_id=?`).all(vendorId)
}

// 引擎/会员消费调用：尝试卖出 qty 份商品，按物资目录逐项扣减库存。
// 任一物资不足 → 按可支撑的最大销量成交（全部物资均 0 库存则整单流失，计缺货损失）。
// probe=true 只探测可成交量不扣库存（供会员消费在收款前校验）。
// 返回 { sold, lost, cost }：lost=流失份数（销售额损失由调用方按售价核算）
export function consumeVendorSale(vendorId, qty, { source = 'guest', note = '', probe = false } = {}) {
  const wants = Math.max(0, Math.round(num(qty)))
  if (wants <= 0) return { ok: true, sold: 0, lost: 0, cost: 0 }
  const links = vendorDemand(vendorId)
  if (!links.length) return { ok: true, sold: wants, lost: 0, cost: 0, noCatalog: true } // 未配置物资目录的商铺不受库存约束
  const vendor = db.prepare('SELECT * FROM vendors WHERE id=?').get(vendorId)
  // 每个物资可支撑销量 = floor(在库 / 单耗)
  const support = links.map(l => ({
    link: l,
    servable: Math.floor(num(l.onhand_qty) / Math.max(1, l.qty_per_sale))
  }))
  let sold = Math.min(wants, ...support.map(s => s.servable))
  if (sold < 0) sold = 0
  if (probe) return { ok: true, sold, lost: wants - sold, cost: 0, probed: true }
  let cost = 0
  const alerted = []
  if (sold > 0) {
    tx(() => {
      for (const s of support) {
        const need = sold * s.link.qty_per_sale
        if (need <= 0) continue
        const r = issueStock(s.link.material_id, need, {
          kind: 'sale', refType: 'vendor', refId: vendorId, vendorId,
          note: `「${vendor?.name || '商铺'}」销售出库`
        })
        if (r.ok) cost += r.cost
        const after = stockStatus(s.link.material_id)
        if (after.alert_status !== 'ok') alerted.push({ material_id: s.link.material_id, status: after.alert_status, name: s.link.material_name })
      }
    })
  }
  const lost = wants - sold
  if (lost > 0 && vendor) {
    // 缺货流失：按首个（主）物资记录一份缺货损失流水，供看板统计与对账（不改变库存）
    const main = support[0].link
    db.prepare(`INSERT INTO stock_ledger(material_id,change_qty,balance_after,kind,ref_type,ref_id,vendor_id,unit_cost,day,tick,note)
                VALUES(?,0,?,'stockout_loss','vendor',?,?,0,?,?,?)`)
      .run(main.material_id, num(db.prepare('SELECT onhand_qty FROM material_stock WHERE material_id=?').get(main.material_id)?.onhand_qty),
        vendorId, vendorId, ctx.day(), ctx.tick(),
        `「${vendor.name}」缺货流失 ${lost} 份销售机会（${support.map(s => s.link.material_name).join('/')}）`)
    maybeStockoutEvent(vendor, support.map(s => ({ name: s.link.material_name, status: stockStatus(s.link.material_id).alert_status })), lost)
  }
  return { ok: true, sold, lost, cost, alerted }
}

// 缺货预警事件：同商铺同游戏日去重，避免每小时刷屏
function maybeStockoutEvent(vendor, mats, lost) {
  if (!cfg('invAlertEvent', 1)) return
  const out = mats.some(x => x.status === 'out')
  const today = ctx.day()
  const key = out ? 'stockout' : 'low'
  const dup = db.prepare(`SELECT id FROM purchase_logs WHERE action='${key === 'stockout' ? 'stockout' : 'stock_alert'}'
                          AND day=? AND note LIKE ? LIMIT 1`).get(today, `%${vendor.name}%`)
  if (dup) return
  db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
    .run(ctx.tick(), today, 'inventory',
      out ? `商铺「${vendor.name}」物资断供` : `商铺「${vendor.name}」物资低于安全库存`,
      out
        ? `「${vendor.name}」售卖物资已断货，本时段流失 ${lost} 份销售。请立即在采购库存模块补货，或调整商铺物资目录。`
        : `「${vendor.name}」部分物资低于安全库存，本时段流失 ${lost} 份销售，系统将自动生成补貨申购。`,
      -1, 'active')
  logPurchase(null, out ? 'stockout' : 'stock_alert',
    out ? `商铺「${vendor.name}」断货，流失 ${lost} 份销售` : `商铺「${vendor.name}」低库存，流失 ${lost} 份销售`,
    null, {})
}

// ---------------- 自动申购 / 自动审批 / 到期自动到货（引擎每小时调用） ----------------
// 低于安全库存的启用物资自动生成采购单（同供应商合并）；每个物资每天至多一单
function autoReorder() {
  if (!cfg('invAutoOrder', 1)) return { orders: 0 }
  const ms = listMaterials().filter(m => m.status === 'on' && m.onhand_qty < m.safety_stock)
  if (!ms.length) return { orders: 0 }
  // 供应商选择：该物资最近采购的供应商，否则取评级最高的活跃供应商
  const bySupplier = new Map()
  for (const m of ms) {
    const inPend = db.prepare(`SELECT 1 FROM purchase_order_items pi
                               JOIN purchase_orders po ON po.id = pi.order_id
                               WHERE pi.material_id=? AND po.status IN ('draft','pending','approved','receiving') LIMIT 1`).get(m.id)
    if (inPend) continue
    let sid = num(db.prepare(`SELECT po.supplier_id FROM purchase_order_items pi
                              JOIN purchase_orders po ON po.id=pi.order_id
                              WHERE pi.material_id=? AND po.status IN ('received','closed')
                              ORDER BY po.id DESC LIMIT 1`).get(m.id)?.supplier_id)
    if (!sid) {
      sid = num(db.prepare("SELECT id FROM suppliers WHERE status='active' ORDER BY rating DESC,id LIMIT 1").get()?.id)
    }
    if (!sid) continue
    if (!bySupplier.has(sid)) bySupplier.set(sid, [])
    bySupplier.get(sid).push({
      material_id: m.id,
      qty: Math.max(m.target_stock - m.onhand_qty, m.safety_stock),
      unit_cost: m.last_cost || m.std_cost
    })
  }
  let n = 0
  for (const [sid, items] of bySupplier) {
    const r = createPurchaseOrder({
      supplier_id: sid, items, source: 'auto',
      note: '库存低于安全库存，系统自动申购（运营与商铺协同补货）'
    })
    if (!r.ok) continue
    n++
    logPurchase(r.id, 'auto_order', `缺货预警触发自动申购，采购单 ${r.code} 进入待审批`, null, { supplierId: sid })
    if (cfg('invAutoApprove', 0)) {
      approvePurchaseOrder(r.id, { approve: true, note: '自动申购免审批配置，系统自动批准' })
    }
  }
  return { orders: n }
}

// 到期自动到货：已批准且到货日已到的采购单，按供应商评级决定是否少送（低评级小概率）
function autoArrive() {
  const orders = db.prepare(`SELECT * FROM purchase_orders WHERE status IN ('approved','receiving') AND arrive_day<=?`)
    .all(ctx.day())
  let received = 0
  for (const o of orders) {
    if (o.status === 'receiving') continue   // 部分入库等待人工处理剩余差异
    const items = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=? AND received_qty<qty').all(o.id)
    if (!items.length) continue
    const s = supplierById(o.supplier_id)
    // 评级 ≤2 的供应商有 20% 概率少送 10%；否则整单按时到货（验收差异仍可人工登记）
    const partial = (s?.rating || 3) <= 2 && Math.random() < 0.2
    const rows = items.map(it => {
      const open = it.qty - it.received_qty
      const recv = partial ? Math.max(1, Math.round(open * 0.9)) : open
      return { item_id: it.id, recv_qty: recv, damaged_qty: 0 }
    })
    const r = receivePurchase(o.id, { items: rows, source: 'auto' })
    if (r.ok) {
      received++
      if (r.shortage > 0) {
        db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
          .run(ctx.tick(), ctx.day(), 'inventory', `采购单 ${o.code} 到货存在少送`,
            `供应商「${s?.name}」批次到货少送 ${r.shortage} 件，已按实收入库并挂应付，剩余数量待补发或在采购单中做少送结案。`,
            0, 'active')
      }
    }
  }
  return { received }
}

// 过期批次核销（保质期到期当日自动报损：盘亏出库 + 财务损失）
function expireBatches() {
  const due = db.prepare('SELECT * FROM stock_batches WHERE qty_remain>0 AND expire_day>0 AND expire_day<=?').all(ctx.day())
  let loss = 0
  for (const b of due) {
    const m = materialById(b.material_id)
    tx(() => {
      const qty = b.qty_remain
      const r = issueStock(b.material_id, qty, { kind: 'adjust-', refType: 'expire', refId: b.id, note: `批次过期报损（保质期至第 ${b.expire_day} 天）` })
      if (r.ok) {
        loss += r.cost
        logPurchase(null, 'stock_alert', `物资「${m?.name}」过期报损 ${qty} ${m?.unit || ''}，成本 ¥${r.cost}`, null, { materialId: b.material_id })
      }
    })
  }
  if (loss > 0) {
    ctx.logFinance?.(ctx.day(), '损耗', -loss, '过期物资报损')
    db.prepare('INSERT INTO events(tick,day,type,title,desc,impact,status) VALUES(?,?,?,?,?,?,?)')
      .run(ctx.tick(), ctx.day(), 'inventory', '物资过期报损',
        `保质期巡检发现过期物资并自动报损，成本合计 ¥${loss}，已计损耗。请关注先进先出与安全库存设置。`, -1, 'active')
  }
  return { batches: due.length, loss }
}

// 引擎每小时入口（营业时段驱动）：自动到货 → 过期核销 → 自动申购
export function processInventory() {
  try {
    const arrive = autoArrive()
    const expired = expireBatches()
    const order = autoReorder()
    return { ...arrive, ...expired, orders: order.orders }
  } catch (e) {
    console.error('[inventory] 库存引擎处理失败:', e)
    return { received: 0, orders: 0, loss: 0 }
  }
}

// ---------------- 盘点 ----------------
export function createStocktake({ staffId = null, note = '' } = {}) {
  const counting = db.prepare("SELECT COUNT(*) n FROM stocktakes WHERE status='counting'").get().n
  if (counting) return { ok: false, msg: '已有进行中的盘点单，请先完成或作废' }
  let id
  tx(() => {
    const r = db.prepare("INSERT INTO stocktakes(code,status,staff_id,tick,day,note) VALUES('','counting',?,?,?,?)")
      .run(staffId, ctx.tick(), ctx.day(), String(note || ''))
    id = Number(r.lastInsertRowid)
    codeOf('stocktakes', 'PD', id)
    const ii = db.prepare('INSERT INTO stocktake_items(stocktake_id,material_id,book_qty,actual_qty,diff_qty,unit_cost) VALUES(?,?,?,0,0,?)')
    for (const m of db.prepare("SELECT id FROM materials WHERE status='on' ORDER BY id").all()) {
      const st = stockStatus(m.id)
      ii.run(id, m.id, st.onhand_qty, st.avg_cost)
    }
  })
  return { ok: true, id, code: 'PD' + String(id).padStart(4, '0') }
}

export function saveStocktakeCount(id, materialId, actualQty) {
  const head = db.prepare("SELECT * FROM stocktakes WHERE id=? AND status='counting'").get(id)
  if (!head) return { ok: false, msg: '盘点单不存在或已完成' }
  const it = db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id=? AND material_id=?').get(id, materialId)
  if (!it) return { ok: false, msg: '盘点明细不存在' }
  const actual = clampInt(actualQty, 0)
  db.prepare('UPDATE stocktake_items SET actual_qty=?, diff_qty=? WHERE id=?').run(actual, actual - it.book_qty, it.id)
  return { ok: true }
}

// 完成盘点：按差异逐物资盘盈（入库）/盘亏（出库），校准库存；差异成本入财务（盘亏损失/盘盈冲减）
export function finishStocktake(id, { staffId = null, note = '' } = {}) {
  const head = db.prepare("SELECT * FROM stocktakes WHERE id=? AND status='counting'").get(id)
  if (!head) return { ok: false, msg: '盘点单不存在或已完成' }
  const items = db.prepare('SELECT * FROM stocktake_items WHERE stocktake_id=?').all(id)
  return tx(() => {
    let qtyVar = 0, amountVar = 0, gain = 0, loss = 0
    for (const it of items) {
      const diff = it.actual_qty - it.book_qty
      if (diff === 0) continue
      const m = materialById(it.material_id)
      const unit = it.unit_cost || m.last_cost || m.std_cost
      qtyVar += Math.abs(diff)
      amountVar += diff * unit
      if (diff > 0) {
        receiveStock(it.material_id, diff, unit, { kind: 'adjust+', refType: 'stocktake', refId: id, expireDay: 0, note: `盘点盘盈 ${head.code}` })
        gain += diff * unit
      } else {
        // 盘亏：先按 FEFO 核销在库批次，批次不足（历史漂移）直接校准计数器，不阻塞整单
        const r = issueStock(it.material_id, -diff, { kind: 'adjust-', refType: 'stocktake', refId: id, note: `盘点盘亏 ${head.code}` })
        if (!r.ok) {
          const st = stockStatus(it.material_id)
          if (st.onhand_qty > 0) {
            db.prepare('UPDATE stock_batches SET qty_remain=0 WHERE material_id=? AND qty_remain>0').run(it.material_id)
          }
          db.prepare('UPDATE material_stock SET onhand_qty=?, total_out_qty=total_out_qty+? WHERE material_id=?')
            .run(it.actual_qty, Math.max(0, st.onhand_qty - it.actual_qty), it.material_id)
          refreshStock(it.material_id)
        }
        loss += -diff * unit
      }
    }
    db.prepare("UPDATE stocktakes SET status='done', variance_amount=?, variance_qty=?, finish_tick=?, note=? WHERE id=?")
      .run(amountVar, qtyVar, ctx.tick(), note || head.note, id)
    if (loss > 0) ctx.logFinance?.(ctx.day(), '损耗', -loss, `盘点盘亏 ${head.code}（${qtyVar} 项差异）`)
    if (gain > 0) ctx.logFinance?.(ctx.day(), '盘盈', gain, `盘点盘盈 ${head.code} 冲减管理成本`)
    logPurchase(null, 'stock_alert', `盘点 ${head.code} 完成：差异 ${qtyVar} 项，盘盈 ¥${gain} / 盘亏 ¥${loss}`, staffId, {})
    return { ok: true, qtyVar, gain, loss }
  })
}

export function cancelStocktake(id) {
  const head = db.prepare("SELECT * FROM stocktakes WHERE id=? AND status='counting'").get(id)
  if (!head) return { ok: false, msg: '盘点单不存在或已完成' }
  db.prepare("UPDATE stocktakes SET status='cancelled' WHERE id=?").run(id)
  return { ok: true }
}

export function listStocktakes({ limit = 50 } = {}) {
  return db.prepare('SELECT st.*, s.name staff_name FROM stocktakes st LEFT JOIN staff s ON s.id=st.staff_id ORDER BY st.id DESC LIMIT ?').all(limit)
}

export function stocktakeDetail(id) {
  const head = db.prepare('SELECT st.*, s.name staff_name FROM stocktakes st LEFT JOIN staff s ON s.id=st.staff_id WHERE st.id=?').get(id)
  if (!head) return null
  const items = db.prepare(`SELECT si.*, m.name material_name, m.unit, m.category FROM stocktake_items si
                            JOIN materials m ON m.id=si.material_id WHERE si.stocktake_id=? ORDER BY m.category,m.id`).all(id)
  return { head, items }
}

// ---------------- 查询 / 统计 / 对账 ----------------
export function purchaseOrderDetail(id) {
  const o = db.prepare(`SELECT po.*, s.name supplier_name, s.lead_days, s.contact, s.phone,
      v.name vendor_name, st.name creator_name, ap.name approver_name
    FROM purchase_orders po
    JOIN suppliers s ON s.id=po.supplier_id
    LEFT JOIN vendors v ON v.id=po.vendor_id
    LEFT JOIN staff st ON st.id=po.creator_staff_id
    LEFT JOIN staff ap ON ap.id=po.approver_id
    WHERE po.id=?`).get(id)
  if (!o) return null
  const items = db.prepare(`SELECT pi.*, m.name material_name, m.unit, (pi.qty-pi.received_qty) open_qty
                            FROM purchase_order_items pi JOIN materials m ON m.id=pi.material_id WHERE pi.order_id=?`).all(id)
  const batches = db.prepare('SELECT * FROM inbound_batches WHERE order_id=? ORDER BY id').all(id)
  const returns = db.prepare('SELECT * FROM purchase_returns WHERE order_id=? ORDER BY id').all(id)
  const logs = db.prepare('SELECT * FROM purchase_logs WHERE order_id=? ORDER BY id').all(id)
  const billed = db.prepare('SELECT * FROM supplier_bills WHERE order_id=?').get(id)
  return { order: o, items, batches, returns, logs, bill: billed }
}

export function listPurchaseOrders({ status = 'all', limit = 100 } = {}) {
  const sql = `SELECT po.*, s.name supplier_name, v.name vendor_name,
      (SELECT COALESCE(SUM(b.amount_due-b.amount_paid-b.amount_returned),0) FROM supplier_bills b WHERE b.order_id=po.id) payable_remain
    FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id
    LEFT JOIN vendors v ON v.id=po.vendor_id
    ${status === 'all' ? '' : 'WHERE po.status=?'} ORDER BY po.id DESC LIMIT ?`
  const rows = status === 'all' ? db.prepare(sql).all(limit) : db.prepare(sql).all(status, limit)
  return rows
}

export function listReturns({ status = 'all', limit = 100 } = {}) {
  const sql = `SELECT r.*, s.name supplier_name, m.name material_name, m.unit, st.name staff_name
    FROM purchase_returns r
    JOIN suppliers s ON s.id=r.supplier_id
    JOIN materials m ON m.id=r.material_id
    LEFT JOIN staff st ON st.id=r.staff_id
    ${status === 'all' ? '' : 'WHERE r.status=?'} ORDER BY r.id DESC LIMIT ?`
  return status === 'all' ? db.prepare(sql).all(limit) : db.prepare(sql).all(status, limit)
}

export function inventoryLogs({ day = null, vendorId = null, materialId = null, limit = 100 } = {}) {
  const where = [], args = []
  if (day) { where.push('l.day=?'); args.push(day) }
  if (vendorId) { where.push('l.vendor_id=?'); args.push(vendorId) }
  if (materialId) { where.push('l.material_id=?'); args.push(materialId) }
  const sql = `SELECT l.*, m.name material_name, m.unit, v.name vendor_name FROM stock_ledger l
    JOIN materials m ON m.id=l.material_id
    LEFT JOIN vendors v ON v.id=l.vendor_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY l.id DESC LIMIT ?`
  return db.prepare(sql).all(...args, limit)
}

export function inventoryStats() {
  const today = ctx.day()
  const mats = listMaterials()
  const low = mats.filter(m => m.low && !m.out).length
  const out = mats.filter(m => m.out).length
  const stockValue = mats.reduce((s, m) => s + m.onhand_qty * m.avg_cost, 0)
  const pendingPo = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) a FROM purchase_orders WHERE status='pending'").get()
  const inTransit = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_amount),0) a FROM purchase_orders WHERE status IN ('approved','receiving')").get()
  const payable = db.prepare("SELECT COALESCE(SUM(amount_due-amount_paid-amount_returned),0) n FROM supplier_bills WHERE status<>'settled'").get().n
  const overdueBills = db.prepare("SELECT COUNT(*) n FROM supplier_bills WHERE status<>'settled' AND due_day<?").get(today).n
  const soldToday = db.prepare("SELECT COALESCE(SUM(-change_qty),0) n, COALESCE(SUM(-change_qty*unit_cost),0) c FROM stock_ledger WHERE kind='sale' AND day=?").get(today)
  const lostTodayRow = db.prepare("SELECT COALESCE(SUM(CASE WHEN v.price IS NOT NULL THEN 1 ELSE 0 END),0) rows FROM stock_ledger l LEFT JOIN vendors v ON v.id=l.vendor_id WHERE l.kind='stockout_loss' AND l.day=?").get(today)
  const lostRows = db.prepare("SELECT l.vendor_id, l.change_qty, v.price, v.margin FROM stock_ledger l LEFT JOIN vendors v ON v.id=l.vendor_id WHERE l.kind='stockout_loss' AND l.day=?").all(today)
  const lostAmount = lostRows.reduce((s, r) => s + Math.round((-r.change_qty || 1) * num(r.price) * num(r.margin, 0.6)), 0)
  const pendingReturns = db.prepare("SELECT COUNT(*) n FROM purchase_returns WHERE status='submitted'").get().n
  const expiredToday = db.prepare("SELECT COALESCE(SUM(-change_qty*unit_cost),0) n FROM stock_ledger WHERE kind='adjust-' AND ref_type='expire' AND day=?").get(today).n
  return {
    sku: mats.length, low, out, stockValue,
    pendingOrders: pendingPo.n, pendingAmount: pendingPo.a,
    inTransitOrders: inTransit.n, inTransitAmount: inTransit.a,
    payable, overdueBills,
    soldQtyToday: soldToday.n, soldCostToday: soldToday.c,
    lostEventsToday: lostTodayRow.rows, lostAmountToday: lostAmount,
    pendingReturns, expiredToday
  }
}

// ---------------- 异常对账（供 flow.js 闭环巡检调用） ----------------
// ① 库存计数器 vs 批次剩余合计（漂移自愈）；② 账单流水 vs 账单字段（只告警）；③ 应付为负
export function runInventoryReconcile({ autoHeal = true } = {}) {
  const findings = [], healed = []
  tx(() => {
    // 1) 计数器漂移
    for (const m of db.prepare('SELECT * FROM materials').all()) {
      ensureStockRow(m.id)
      const st = db.prepare('SELECT * FROM material_stock WHERE material_id=?').get(m.id)
      const batchSum = num(db.prepare('SELECT COALESCE(SUM(qty_remain),0) n FROM stock_batches WHERE material_id=?').get(m.id).n)
      const ledger = db.prepare("SELECT COALESCE(SUM(change_qty),0) n FROM stock_ledger WHERE material_id=? AND kind<>'stockout_loss'").get(m.id).n
      if (batchSum !== st.onhand_qty) {
        if (autoHeal) refreshStock(m.id)
        findings.push({ kind: 'stock_counter', material: m.name, expected: batchSum, actual: st.onhand_qty, healed: autoHeal })
        if (autoHeal) healed.push(m.id)
      } else if (num(ledger) !== batchSum) {
        // 流水净额（全部流水均变更库存，含期初入库）理论上 = 在库；不一致只告警不擅改
        findings.push({ kind: 'stock_ledger', material: m.name, expected: batchSum, actual: num(ledger), healed: false })
      }
    }

    // 2) 账单与流水一致性
    for (const b of db.prepare('SELECT * FROM supplier_bills').all()) {
      const pay = db.prepare(`SELECT
          COALESCE(SUM(CASE WHEN kind='inbound' THEN amount END),0) inbound,
          COALESCE(SUM(CASE WHEN kind='pay' THEN -amount END),0) paid,
          COALESCE(SUM(CASE WHEN kind IN ('return','refund') THEN amount END),0) returned
        FROM supplier_bill_payments WHERE bill_id=?`).get(b.id)
      if (num(pay.inbound) !== b.amount_due || num(pay.paid) !== b.amount_paid || num(pay.returned) !== b.amount_returned) {
        findings.push({ kind: 'supplier_bill', bill: b.id, expected: { due: num(pay.inbound), paid: num(pay.paid), returned: num(pay.returned) }, actual: { due: b.amount_due, paid: b.amount_paid, returned: b.amount_returned }, healed: false })
      }
      const remain = b.amount_due - b.amount_paid - b.amount_returned
      if (remain < 0) findings.push({ kind: 'supplier_bill_negative', bill: b.id, expected: { remain: 0 }, actual: { remain }, healed: false })
    }
  })

  // 落库到统一巡检表（只新增 open 的项，自愈项记录后置 healed）
  for (const f of findings) {
    const refKey = f.kind === 'stock_counter' || f.kind === 'stock_ledger' ? f.material : 'ZD' + String(f.bill).padStart(4, '0')
    const exists = db.prepare("SELECT id FROM reconcile_findings WHERE kind=? AND title LIKE ? AND status='open' LIMIT 1")
      .get(f.kind, `%${refKey}%`)
    if (exists) continue
    const isBlock = f.kind === 'stock_counter' || f.kind === 'supplier_bill_negative'
    const title = f.kind === 'stock_counter' ? `物资「${f.material}」库存计数器与批次合计漂移`
      : f.kind === 'stock_ledger' ? `物资「${f.material}」库存流水净额与在库不一致`
      : f.kind === 'supplier_bill_negative' ? `账单 ${refKey} 冲减超额（应付为负）`
      : `账单 ${refKey} 收付流水与账单金额不一致`
    const id = Number(db.prepare(`INSERT INTO reconcile_findings(code,kind,level,ref_type,ref_id,day,title,detail,expected,actual,status,tick,created_day,heal_tick)
      VALUES('','${f.kind}','${isBlock ? 'block' : 'warn'}','inventory',NULL,?,?,?,?,?, 'open', ?, ?, ?)`)
      .run(ctx.day(), title,
        f.healed ? '计数器与批次合计不一致，已按批次事实源自动校正' : '资金/流水口径不一致，请人工核对（系统不擅自改写资金）',
        JSON.stringify(f.expected ?? {}), JSON.stringify(f.actual ?? {}),
        ctx.tick(), ctx.day(), f.healed ? ctx.tick() : 0).lastInsertRowid)
    codeOf('reconcile_findings', 'RC', id)
    if (f.healed) db.prepare("UPDATE reconcile_findings SET status='healed' WHERE id=?").run(id)
  }
  return { found: findings.length, healed: healed.length, blocks: findings.filter(f => f.kind === 'stock_counter' || f.kind === 'supplier_bill_negative').length }
}

function clampInt(v, min = -1e12, max = 1e12, d = 0) {
  const n = Math.round(num(v, d))
  return Math.max(min, Math.min(max, n))
}

export const INVENTORY_CONST = { RETURN_REASONS }
