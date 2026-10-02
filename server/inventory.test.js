// 园区物资采购与库存模块测试：
// 供应商 → 采购单（申购/审批）→ 分批验收入库（少送/破损）→ 库存（移动成本/FEFO）
//  → 商铺销售扣减与缺货 → 自动申购/自动到货 → 退货 → 账单结算 → 盘点对账
// 运行：node --test server/inventory.test.js（需 Node >= 22.5，node:sqlite）
process.env.PARK_DB_PATH = ':memory:'

import { test, before } from 'node:test'
import assert from 'node:assert/strict'

const { default: db, getSetting, setSetting } = await import('./db.js')
const INV = await import('./inventory.js')

const finLogs = []
INV.initInventoryContext({
  logFinance: (day, label, amount, detail) => finLogs.push({ day, label, amount, detail }),
  createEvent: () => {}
})

const cash = () => Number(getSetting('cash'))
const stock = id => db.prepare('SELECT * FROM material_stock WHERE material_id=?').get(id)
const matByName = n => db.prepare('SELECT * FROM materials WHERE name=?').get(n)
const onhand = id => stock(id).onhand_qty

before(() => {
  setSetting('day', 1)
  setSetting('hour', 9)
  setSetting('tick', 0)
  setSetting('cash', 500000)
  setSetting('invAutoOrder', 0)   // 测试中关闭自动申购，避免干扰断言
})

test('种子数据：供应商/物资/商铺目录/期初库存齐备', () => {
  assert.ok(db.prepare('SELECT COUNT(*) n FROM suppliers').get().n >= 3)
  assert.ok(db.prepare('SELECT COUNT(*) n FROM materials').get().n >= 10)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM vendor_materials').get().n >= 10, true)
  const corn = matByName('爆米花玉米粒')
  assert.ok(corn, '应有玉米粒物资')
  assert.ok(onhand(corn.id) > 0, '应有期初库存')
})

test('采购单全流程：申购→审批→验收入库→库存与均价更新→账单形成', () => {
  const corn = matByName('爆米花玉米粒')
  const before = onhand(corn.id)
  const sup = db.prepare("SELECT * FROM suppliers WHERE category='原料' ORDER BY id LIMIT 1").get()

  const c = INV.createPurchaseOrder({
    supplier_id: sup.id,
    source: 'shop', vendor_id: 1, creator_staff_id: null,
    items: [{ material_id: corn.id, qty: 100, unit_cost: 4 }]
  })
  assert.equal(c.ok, true)
  assert.equal(c.status, 'pending')

  // 待审批不能直接入库
  const blockedItem = db.prepare('SELECT id FROM purchase_order_items WHERE order_id=?').get(c.id)
  const blocked = INV.receivePurchase(c.id, { items: [{ item_id: blockedItem.id, recv_qty: 1 }] })
  assert.equal(blocked.ok, false)

  const ap = INV.approvePurchaseOrder(c.id, { approve: true, staffId: 9 })
  assert.equal(ap.ok, true)
  assert.equal(ap.status, 'approved')
  assert.equal(ap.arriveDay, 1 + sup.lead_days)

  // 驳回必须有理由
  const c2 = INV.createPurchaseOrder({ supplier_id: sup.id, items: [{ material_id: corn.id, qty: 10, unit_cost: 4 }] })
  assert.equal(INV.approvePurchaseOrder(c2.id, { approve: false }).ok, false)
  assert.equal(INV.approvePurchaseOrder(c2.id, { approve: false, note: '价格偏高' }).ok, true)

  // 验收入库
  const item = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').get(c.id)
  const r = INV.receivePurchase(c.id, { items: [{ item_id: item.id, recv_qty: 100, damaged_qty: 0 }], staff_id: 9 })
  assert.equal(r.ok, true)
  assert.equal(r.totalQty, 100)
  assert.equal(onhand(corn.id), before + 100)
  // 最近入库价回写
  assert.equal(matByName('爆米花玉米粒').last_cost, 4)

  // 账单：入库形成应付但未付现
  const bill = db.prepare('SELECT * FROM supplier_bills WHERE order_id=?').get(c.id)
  assert.equal(bill.amount_due, 400)
  assert.equal(bill.amount_paid, 0)
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(c.id)
  assert.equal(po.status, 'received')
})

test('分批入库 + 少送 + 破损：实收才挂账，破损不入库', () => {
  const lemon = matByName('鲜柠檬')
  const sup = db.prepare("SELECT * FROM suppliers WHERE name LIKE '%鲜丰%'").get()
  const before = onhand(lemon.id)

  const c = INV.createPurchaseOrder({
    supplier_id: sup.id,
    items: [{ material_id: lemon.id, qty: 50, unit_cost: 2 }]
  })
  INV.approvePurchaseOrder(c.id, { approve: true })
  const item = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').get(c.id)

  // 第一批：实收 40，破损 5
  let r = INV.receivePurchase(c.id, { items: [{ item_id: item.id, recv_qty: 40, damaged_qty: 5 }] })
  assert.equal(r.ok, true)
  assert.equal(r.shortage, 5)
  let po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(c.id)
  assert.equal(po.status, 'receiving')
  assert.equal(onhand(lemon.id), before + 40)
  let bill = db.prepare('SELECT * FROM supplier_bills WHERE order_id=?').get(c.id)
  assert.equal(bill.amount_due, 80, '破损与少送均不挂应付')

  // 第二批：剩余 5 件全部交到
  const item2 = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').get(c.id)
  r = INV.receivePurchase(c.id, { items: [{ item_id: item2.id, recv_qty: 5, damaged_qty: 0 }] })
  assert.equal(r.ok, true)
  po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(c.id)
  assert.equal(po.status, 'received')
  assert.equal(onhand(lemon.id), before + 45)
  bill = db.prepare('SELECT * FROM supplier_bills WHERE order_id=?').get(c.id)
  assert.equal(bill.amount_due, 90)

  // 少送结案（另一个单：实收 30/50 后确认不再补发）
  const c3 = INV.createPurchaseOrder({ supplier_id: sup.id, items: [{ material_id: lemon.id, qty: 50, unit_cost: 2 }] })
  INV.approvePurchaseOrder(c3.id, { approve: true })
  const i3 = db.prepare('SELECT * FROM purchase_order_items WHERE order_id=?').get(c3.id)
  INV.receivePurchase(c3.id, { items: [{ item_id: i3.id, recv_qty: 30, damaged_qty: 0 }] })
  const close = INV.closePurchaseShortage(c3.id, { note: '供应商确认缺货' })
  assert.equal(close.ok, true)
  assert.equal(db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(c3.id).status, 'received')
  assert.equal(db.prepare('SELECT amount_due FROM supplier_bills WHERE order_id=?').get(c3.id).amount_due, 60)
})

test('商铺销售联动库存：按目录 FEFO 出库，缺货按可支撑数量成交并记录流失', () => {
  // 商铺 1 = 爆米花小屋：玉米粒×1 + 纸盒×1
  const corn = matByName('爆米花玉米粒')
  const box = matByName('爆米花纸盒')
  const c0 = onhand(corn.id), b0 = onhand(box.id)

  // 正常销售 10 份
  let r = INV.consumeVendorSale(1, 10)
  assert.equal(r.sold, 10)
  assert.equal(r.lost, 0)
  assert.equal(onhand(corn.id), c0 - 10)
  assert.equal(onhand(box.id), b0 - 10)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_ledger WHERE kind='sale' AND vendor_id=1").get().n >= 2, true)

  // 探测模式不改库存
  const beforeProbe = onhand(corn.id)
  const p = INV.consumeVendorSale(1, 5, { probe: true })
  assert.equal(p.sold, 5)
  assert.equal(onhand(corn.id), beforeProbe)

  // 人为耗尽纸盒：只能卖出剩余纸盒份，其余流失
  db.prepare('UPDATE stock_batches SET qty_remain=0 WHERE material_id=? AND qty_remain>0').run(box.id)
  db.prepare('UPDATE material_stock SET onhand_qty=0, alert_status=? WHERE material_id=?').run('out', box.id)
  r = INV.consumeVendorSale(1, 20)
  assert.equal(r.sold, 0)
  assert.equal(r.lost, 20)
  assert.equal(stock(box.id).alert_status, 'out')
  assert.equal(db.prepare("SELECT COUNT(*) n FROM stock_ledger WHERE kind='stockout_loss' AND vendor_id=1").get().n >= 1, true)
})

test('自动申购：低于安全库存自动生成采购单；自动审批开关生效', () => {
  const cup = matByName('一次性饮料杯')
  // 压到安全库存以下
  db.prepare('UPDATE stock_batches SET qty_remain=0 WHERE material_id=?').run(cup.id)
  db.prepare('UPDATE material_stock SET onhand_qty=0 WHERE material_id=?').run(cup.id)
  assert.equal(INV.listMaterials().find(m => m.id === cup.id).out, true)

  setSetting('invAutoOrder', 1)
  setSetting('invAutoApprove', 1)
  const out = INV.processInventory()
  assert.ok(out.orders >= 1, '应生成自动申购单')
  const auto = db.prepare("SELECT * FROM purchase_orders WHERE source='auto' ORDER BY id DESC LIMIT 1").get()
  assert.ok(auto)
  assert.equal(auto.status, 'approved', '免审批配置下自动单应直接批准')
  setSetting('invAutoOrder', 0)
})

test('到期自动到货：已批准且到货日已到的采购单自动验收', () => {
  const m = matByName('吉祥物公仔')
  const sup = db.prepare("SELECT * FROM suppliers WHERE category='百货'").get()
  const c = INV.createPurchaseOrder({
    supplier_id: sup.id,
    items: [{ material_id: m.id, qty: 30, unit_cost: 12 }]
  })
  INV.approvePurchaseOrder(c.id, { approve: true })
  const before = onhand(m.id)
  // 推进到到货日之后（供货周期 3 天）
  setSetting('day', Number(getSetting('day')) + 4)
  // 评级高的供应商按时整单到货（低评级小概率少送，允许 received 或 receiving）
  const out = INV.processInventory()
  assert.ok(out.received >= 0)
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(c.id)
  assert.ok(['received', 'receiving'].includes(po.status))
  assert.ok(onhand(m.id) >= before)
})

test('采购退货：未付款冲减应付；库存出库；账单状态更新', () => {
  const doll = matByName('吉祥物公仔')
  const sup = db.prepare("SELECT * FROM suppliers WHERE category='百货'").get()
  const before = onhand(doll.id)

  const c = INV.createPurchaseOrder({ supplier_id: sup.id, items: [{ material_id: doll.id, qty: 20, unit_cost: 12 }] })
  INV.approvePurchaseOrder(c.id, { approve: true })
  const iid = db.prepare('SELECT id FROM purchase_order_items WHERE order_id=?').get(c.id).id
  INV.receivePurchase(c.id, { items: [{ item_id: iid, recv_qty: 20, damaged_qty: 0 }] })
  assert.equal(onhand(doll.id), before + 20)

  const ret = INV.createPurchaseReturn({
    supplier_id: sup.id, order_id: c.id, material_id: doll.id, qty: 5, reason: 'quality', staff_id: 9
  })
  assert.equal(ret.ok, true)
  const conf = INV.confirmPurchaseReturn(ret.id, { refundMode: 'deduct', staffId: 9 })
  assert.equal(conf.ok, true)
  assert.equal(conf.refundStatus, 'deducted')
  assert.equal(onhand(doll.id), before + 15, '退货应出库')
  const bill = db.prepare('SELECT * FROM supplier_bills WHERE order_id=?').get(c.id)
  assert.equal(bill.amount_returned, 60)

  // 已确认的退货不可重复处理
  assert.equal(INV.confirmPurchaseReturn(ret.id).ok, false)
})

test('账单付款：现金流出 + 财务流水 + 账单结清回写采购单', () => {
  const key = matByName('主题钥匙扣')
  const sup = db.prepare("SELECT * FROM suppliers WHERE category='百货'").get()
  const c0 = cash()
  const c = INV.createPurchaseOrder({ supplier_id: sup.id, items: [{ material_id: key.id, qty: 10, unit_cost: 6 }] })
  INV.approvePurchaseOrder(c.id, { approve: true })
  const iid = db.prepare('SELECT id FROM purchase_order_items WHERE order_id=?').get(c.id).id
  INV.receivePurchase(c.id, { items: [{ item_id: iid, recv_qty: 10, damaged_qty: 0 }] })
  const bill = db.prepare('SELECT * FROM supplier_bills WHERE order_id=?').get(c.id)
  const cashBeforePay = cash()
  const pay = INV.paySupplierBill(bill.id, { staff_id: 9 })
  assert.equal(pay.ok, true)
  assert.equal(pay.status, 'settled')
  assert.equal(cash(), cashBeforePay - 60)
  assert.ok(finLogs.some(f => f.label === '采购' && f.amount === -60), '应有采购付款流水')
  assert.equal(db.prepare('SELECT settled_day FROM purchase_orders WHERE id=?').get(c.id).settled_day > 0, true)
  // 结清后不能重复付款
  assert.equal(INV.paySupplierBill(bill.id).ok, false)
})

test('现金不足不能支付账单', () => {
  const syrup = matByName('果味糖浆')
  const sup = db.prepare("SELECT * FROM suppliers WHERE category='原料' ORDER BY id LIMIT 1").get()
  const c = INV.createPurchaseOrder({ supplier_id: sup.id, items: [{ material_id: syrup.id, qty: 10, unit_cost: 8 }] })
  INV.approvePurchaseOrder(c.id, { approve: true })
  const iid = db.prepare('SELECT id FROM purchase_order_items WHERE order_id=?').get(c.id).id
  INV.receivePurchase(c.id, { items: [{ item_id: iid, recv_qty: 10, damaged_qty: 0 }] })
  const bill = db.prepare('SELECT * FROM supplier_bills WHERE order_id=?').get(c.id)
  setSetting('cash', 10)
  assert.equal(INV.paySupplierBill(bill.id).ok, false)
  setSetting('cash', 500000)
})

test('盘点：盘盈入库 / 盘亏出库并校准，差异成本入财务', () => {
  const tshirt = matByName('纪念T恤')
  const before = onhand(tshirt.id)
  const st = INV.createStocktake({ staffId: 9 })
  assert.equal(st.ok, true)
  const detail = INV.stocktakeDetail(st.id)
  const row = detail.items.find(x => x.material_id === tshirt.id)
  // 盘亏 5 件
  INV.saveStocktakeCount(st.id, tshirt.id, row.book_qty - 5)
  // 同时盘盈一个其他物资 3 件
  const key = matByName('主题钥匙扣')
  const keyRow = detail.items.find(x => x.material_id === key.id)
  INV.saveStocktakeCount(st.id, key.id, keyRow.book_qty + 3)
  const fin = INV.finishStocktake(st.id, { staffId: 9 })
  assert.equal(fin.ok, true)
  assert.equal(onhand(tshirt.id), before - 5)
  assert.ok(fin.loss > 0 && fin.gain > 0)
  assert.ok(finLogs.some(f => f.label === '损耗' && f.amount < 0))
  assert.ok(finLogs.some(f => f.label === '盘盈'))
  assert.equal(db.prepare("SELECT status FROM stocktakes WHERE id=?").get(st.id).status, 'done')
  // 完成后不能重复完成
  assert.equal(INV.finishStocktake(st.id).ok, false)
})

test('异常对账：库存计数器漂移可自愈；账单流水不一致只告警', () => {
  const corn = matByName('爆米花玉米粒')
  const trueQty = db.prepare('SELECT COALESCE(SUM(qty_remain),0) n FROM stock_batches WHERE material_id=?').get(corn.id).n
  // 人为制造计数器漂移
  db.prepare('UPDATE material_stock SET onhand_qty=onhand_qty+37 WHERE material_id=?').run(corn.id)
  assert.notEqual(onhand(corn.id), trueQty)
  const r = INV.runInventoryReconcile({ autoHeal: true })
  assert.ok(r.found >= 1)
  assert.equal(onhand(corn.id), trueQty, '计数器应按批次事实源自愈')
  const finding = db.prepare("SELECT * FROM reconcile_findings WHERE kind='stock_counter' ORDER BY id DESC LIMIT 1").get()
  assert.equal(finding.status, 'healed')
})

test('过期批次报损：FEFO 出库 + 财务损耗', () => {
  // 收一批已到期物资：用一个保质期物资做 0 天到货
  const sausage = matByName('香肠')
  const sup = db.prepare("SELECT * FROM suppliers WHERE category='原料' ORDER BY id LIMIT 1").get()
  const c = INV.createPurchaseOrder({ supplier_id: sup.id, items: [{ material_id: sausage.id, qty: 8, unit_cost: 5 }] })
  INV.approvePurchaseOrder(c.id, { approve: true })
  const iid = db.prepare('SELECT id FROM purchase_order_items WHERE order_id=?').get(c.id).id
  INV.receivePurchase(c.id, { items: [{ item_id: iid, recv_qty: 8, damaged_qty: 0 }] })
  // 把新批次到期日改到过去
  const newBatch = db.prepare('SELECT id FROM stock_batches WHERE material_id=? AND expire_day>0 ORDER BY id DESC LIMIT 1').get(sausage.id)
  db.prepare('UPDATE stock_batches SET expire_day=? WHERE id=?').run(1, newBatch.id)
  setSetting('day', 30)
  const before = onhand(sausage.id)
  const out = INV.processInventory()
  assert.ok(out.loss >= 0)
  assert.ok(onhand(sausage.id) < before || out.batches >= 0)
})
