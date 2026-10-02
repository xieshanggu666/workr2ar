<script setup>
import { ref, computed, reactive } from 'vue'
import { useParkStore } from '@/store/park'

const store = useParkStore()
const tab = ref('stock')
const tabs = [
  { k: 'stock', icon: '📦', label: '库存状态' },
  { k: 'orders', icon: '🛒', label: '采购单' },
  { k: 'bills', icon: '🧾', label: '供应商账单' },
  { k: 'returns', icon: '↩️', label: '采购退货' },
  { k: 'stocktake', icon: '🔍', label: '盘点对账' },
  { k: 'ledger', icon: '📜', label: '库存流水' },
  { k: 'suppliers', icon: '🤝', label: '供应商/物资' }
]

const st = computed(() => store.inventoryStats)
const supervisors = computed(() => store.staff.filter(s => s.role === '运营主管' && s.active))

// ---------------- 采购单新建 ----------------
const poOpen = ref(false)
const po = reactive({
  supplier_id: null, source: 'manual', vendor_id: null, creator_staff_id: null, note: '',
  items: [{ material_id: null, qty: 1, unit_cost: 0 }]
})
function openPO(autoVendor = null) {
  po.supplier_id = store.suppliers.find(s => s.status === 'active')?.id || null
  po.source = autoVendor ? 'shop' : 'manual'
  po.vendor_id = autoVendor || null
  po.creator_staff_id = store.staff[0]?.id || null
  po.note = ''
  po.items = [{ material_id: null, qty: 1, unit_cost: 0 }]
  poOpen.value = true
}
function addPOItem() { po.items.push({ material_id: null, qty: 1, unit_cost: 0 }) }
function removePOItem(i) { po.items.splice(i, 1) }
function onMatPick(row) {
  const m = store.materials.find(x => x.id === Number(row.material_id))
  if (m) row.unit_cost = m.last_cost || m.std_cost
}
const poTotal = computed(() => po.items.reduce((s, i) => s + (Number(i.qty) || 0) * (Number(i.unit_cost) || 0), 0))
function submitPO(draft = false) {
  const items = po.items.filter(i => i.material_id && Number(i.qty) > 0)
  if (!po.supplier_id || !items.length) return
  store.createPurchaseOrder({
    supplier_id: po.supplier_id, source: po.source, vendor_id: po.vendor_id,
    creator_staff_id: po.creator_staff_id, note: po.note, submit: !draft,
    items: items.map(i => ({ material_id: Number(i.material_id), qty: Number(i.qty), unit_cost: Number(i.unit_cost) }))
  })
  poOpen.value = false
}

// ---------------- 采购单详情 / 验收 ----------------
const detail = ref(null)
async function openDetail(id) { detail.value = await store.purchaseOrderDetail(id) }
function closeDetail() { detail.value = null }

const receiveRows = ref([])
function startReceive() {
  receiveRows.value = detail.value.items
    .filter(it => it.open_qty > 0)
    .map(it => ({ item_id: it.id, material_name: it.material_name, open_qty: it.open_qty, recv_qty: it.open_qty, damaged_qty: 0 }))
}
function submitReceive() {
  const r = store.receivePurchase(detail.value.order.id, {
    items: receiveRows.value.map(r => ({ item_id: r.item_id, recv_qty: Number(r.recv_qty), damaged_qty: Number(r.damaged_qty) })),
    staff_id: supervisors.value[0]?.id
  })
  if (r?.ok) { openDetail(detail.value.order.id) }
}
function doShortageClose() {
  if (!confirm('确认剩余少送数量不再补发，按实收结案？')) return
  store.closePurchaseShortage(detail.value.order.id, { staffId: supervisors.value[0]?.id }).then(() => openDetail(detail.value.order.id))
}
function doApprove(approve) {
  const note = approve ? '' : prompt('请填写驳回原因（商铺可据此调整申购）') || ''
  if (!approve && !note) return
  store.approvePurchaseOrder(detail.value.order.id, { approve, staff_id: supervisors.value[0]?.id, note })
    .then(() => openDetail(detail.value.order.id))
}
function doCancelPO() {
  if (!confirm('确认撤销该采购单？')) return
  store.cancelPurchaseOrder(detail.value.order.id, '运营手动撤销').then(closeDetail)
}

const PO_STATUS = {
  draft: ['草稿', 'tag'], pending: ['待审批', 'tag warn'], approved: ['待到货', 'tag blue'],
  receiving: ['部分入库', 'tag warn'], received: ['已入库', 'tag ok'], closed: ['已结清', 'tag ok'],
  rejected: ['已驳回', 'tag bad'], cancelled: ['已撤销', 'tag bad']
}

// ---------------- 退货 ----------------
const retOpen = ref(false)
const ret = reactive({ supplier_id: null, material_id: null, qty: 1, reason: 'quality', note: '', order_id: null, batch_id: null })
function openReturn(orderId = null, supplierId = null) {
  ret.supplier_id = supplierId || store.suppliers[0]?.id
  ret.material_id = null; ret.qty = 1; ret.reason = 'quality'; ret.note = ''
  ret.order_id = orderId; ret.batch_id = null
  retOpen.value = true
}
function submitReturn() {
  if (!ret.supplier_id || !ret.material_id || ret.qty < 1) return
  store.createPurchaseReturn({ ...ret, supplier_id: Number(ret.supplier_id), material_id: Number(ret.material_id), qty: Number(ret.qty), staff_id: supervisors.value[0]?.id })
    .then(r => { if (r?.ok) retOpen.value = false })
}
function confirmRet(r, mode) {
  const word = mode === 'cash' ? '要求供应商现金退款' : '冲减未结应付账单'
  if (!confirm(`确认供应商已处理退货并${word}？`)) return
  store.confirmPurchaseReturn(r.id, { refundMode: mode, staffId: supervisors.value[0]?.id })
}
function rejectRet(r) {
  const note = prompt('驳回原因')
  if (note) store.rejectPurchaseReturn(r.id, { staffId: supervisors.value[0]?.id, note })
}
const RETURN_REASON = { quality: '质量问题', damage: '运输破损', over: '多发退回', other: '其他' }

// ---------------- 账单 ----------------
const billDetail = ref(null)
async function openBill(id) { billDetail.value = await store.supplierBillDetail(id) }
function payBill(b) {
  const amount = Number(prompt(`支付供应商「${b.supplier_name}」账单 ZD${String(b.id).padStart(4, '0')}，本次支付金额（剩余应付 ¥${b.remain}）：`, b.remain))
  if (!Number.isFinite(amount) || amount <= 0) return
  store.paySupplierBill(b.id, { amount, staff_id: supervisors.value[0]?.id })
}

// ---------------- 盘点 ----------------
const stDetail = ref(null)
function newStocktake() {
  if (!confirm('创建一张新的全盘盘点单（账面数量自动快照）？')) return
  store.createStocktake({ staffId: supervisors.value[0]?.id }).then(async r => {
    if (r?.ok) await openStocktake(r.id)
  })
}
async function openStocktake(id) { stDetail.value = await store.stocktakeDetail(id) }
function closeStocktake() { stDetail.value = null }
function saveCount(row) { store.saveStocktakeCount(stDetail.value.head.id, row.material_id, Number(row.actual_qty)) }
function finishST() {
  if (!confirm('确认提交盘点？系统将按实盘数量生成盘盈/盘亏流水并校准库存（盘亏计损耗）。')) return
  store.finishStocktake(stDetail.value.head.id, { staffId: supervisors.value[0]?.id }).then(r => {
    if (r?.ok) { alert(`盘点完成：盘盈 ¥${r.gain}，盘亏 ¥${r.loss}`); openStocktake(stDetail.value.head.id) }
  })
}
function cancelST() {
  if (!confirm('作废该盘点单？')) return
  store.cancelStocktake(stDetail.value.head.id).then(closeStocktake)
}

// ---------------- 供应商 / 物资维护 ----------------
const supOpen = ref(false)
const sup = reactive({ name: '', contact: '', phone: '', category: '综合', lead_days: 2, rating: 3 })
function submitSup() {
  if (!sup.name) return
  store.createSupplier({ ...sup, lead_days: Number(sup.lead_days), rating: Number(sup.rating) }).then(r => { if (r?.ok) supOpen.value = false })
}
const matOpen = ref(false)
const mat = reactive({ name: '', category: '原料', unit: '份', std_cost: 0, safety_stock: 80, target_stock: 300, shelf_days: 0 })
function submitMat() {
  if (!mat.name) return
  store.createMaterial({ ...mat, std_cost: Number(mat.std_cost), safety_stock: Number(mat.safety_stock), target_stock: Number(mat.target_stock), shelf_days: Number(mat.shelf_days) })
    .then(r => { if (r?.ok) matOpen.value = false })
}
function updateThreshold(m) {
  store.updateMaterial(m.id, { safety_stock: Number(m.safety_stock), target_stock: Number(m.target_stock) })
}
function toggleMat(m) {
  store.updateMaterial(m.id, { status: m.status === 'on' ? 'off' : 'on' })
}
function toggleSupplier(s) {
  store.updateSupplier(s.id, { status: s.status === 'active' ? 'suspended' : 'active' })
}

// 商铺物资目录配置
const vmVendor = ref(null)
function openVendorMat(v) { vmVendor.value = v }
function addVm(materialId) {
  if (materialId) store.setVendorMaterial(vmVendor.value.id, Number(materialId), 1)
}
function setVmQty(link, qty) { store.setVendorMaterial(vmVendor.value.id, link.material_id, Number(qty)) }
function delVm(link) { store.removeVendorMaterial(vmVendor.value.id, link.material_id) }
const vendorLinks = computed(() => {
  if (!vmVendor.value) return []
  return store.materials
    .filter(m => m.vendors?.some(v => v.id === vmVendor.value.id))
    .map(m => ({ ...m, ...m.vendors.find(v => v.id === vmVendor.value.id) }))
})

const catIcon = c => ({ '原料': '🌽', '包装': '📦', '百货': '🧸' }[c] || '📦')
const alertTag = m => m.out ? ['断货', 'tag bad'] : m.low ? ['低库存', 'tag warn'] : ['正常', 'tag ok']
</script>

<template>
  <div class="inv">
    <!-- 顶部 KPI -->
    <div class="kpis">
      <div class="card kpi"><em>库存货值</em><b class="money">¥{{ st.stockValue.toLocaleString() }}</b><span class="muted">{{ st.sku }} 种物资</span></div>
      <div class="card kpi" :class="{ alert: st.low }"><em>低库存</em><b class="warn">{{ st.low }}</b><span class="muted">低于安全库存</span></div>
      <div class="card kpi" :class="{ alert: st.out }"><em>断货</em><b class="bad">{{ st.out }}</b><span class="muted">今日缺货事件 {{ st.lostEventsToday }}</span></div>
      <div class="card kpi"><em>待审批采购</em><b>{{ st.pendingOrders }}</b><span class="money">¥{{ st.pendingAmount.toLocaleString() }}</span></div>
      <div class="card kpi"><em>在途订单</em><b>{{ st.inTransitOrders }}</b><span class="money">¥{{ st.inTransitAmount.toLocaleString() }}</span></div>
      <div class="card kpi" :class="{ alert: st.overdueBills }"><em>应付货款</em><b class="money neg">¥{{ st.payable.toLocaleString() }}</b><span class="muted" v-if="st.overdueBills">{{ st.overdueBills }} 张账单逾期</span></div>
      <div class="card kpi"><em>今日出库</em><b>{{ st.soldQtyToday }}</b><span class="muted">成本 ¥{{ st.soldCostToday.toLocaleString() }}</span></div>
      <div class="card kpi"><em>待确认退货</em><b>{{ st.pendingReturns }}</b><span class="muted" v-if="st.expiredToday">今日报损 ¥{{ st.expiredToday.toLocaleString() }}</span></div>
    </div>

    <div class="bar">
      <div class="tabs">
        <button v-for="t in tabs" :key="t.k" :class="{ on: tab === t.k }" @click="tab = t.k">{{ t.icon }} {{ t.label }}</button>
      </div>
      <div class="spacer"></div>
      <button class="primary" @click="openPO()">＋ 新建采购单</button>
    </div>

    <!-- 库存状态 -->
    <div v-if="tab === 'stock'" class="card">
      <h3>📦 物资库存状态（库存变化实时联动商铺销售、缺货预警与财务结算）</h3>
      <table>
        <thead><tr><th>物资</th><th>类别</th><th>单位</th><th>在库</th><th>安全库存</th><th>目标库存</th><th>均价(成本)</th><th>今日出库</th><th>状态</th><th>使用商铺</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="m in store.materials" :key="m.id" :class="{ lowrow: m.low, outrow: m.out }">
            <td><b>{{ m.name }}</b><br><span class="muted">{{ m.code }}</span></td>
            <td>{{ catIcon(m.category) }} {{ m.category }}</td>
            <td>{{ m.unit }}</td>
            <td><b :class="m.out ? 'bad' : m.low ? 'warn' : ''">{{ m.onhand_qty }}</b></td>
            <td><input class="mini" type="number" v-model.number="m.safety_stock" @change="updateThreshold(m)" /></td>
            <td><input class="mini" type="number" v-model.number="m.target_stock" @change="updateThreshold(m)" /></td>
            <td>¥{{ m.avg_cost }}<span class="muted" v-if="m.shelf_days"> · 保质{{ m.shelf_days }}天</span></td>
            <td>{{ m.out_today }}<span class="bad" v-if="m.lost_today"> / 缺{{ m.lost_today }}</span></td>
            <td><span :class="alertTag(m)[1]">{{ alertTag(m)[0] }}</span></td>
            <td>
              <span class="tag" v-for="v in m.vendors" :key="v.id">{{ v.name }}×{{ v.qty_per_sale }}</span>
              <span class="muted" v-if="!m.vendors.length">未配置</span>
            </td>
            <td><button class="ghost" @click="openPO(m.vendors?.[0]?.id || null)">补货</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 采购单 -->
    <div v-if="tab === 'orders'" class="card">
      <h3>🛒 采购单（商铺申购 → 运营审批 → 到货验收入库 → 财务结算）</h3>
      <table>
        <thead><tr><th>单号</th><th>供应商</th><th>来源</th><th>状态</th><th>数量</th><th>金额</th><th>已入</th><th>预计到货</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="o in store.purchaseOrders" :key="o.id">
            <td><b>{{ o.code }}</b></td>
            <td>{{ o.supplier_name }}</td>
            <td><span class="muted">{{ { manual: '运营', shop: '商铺申购', auto: '自动申购' }[o.source] }}</span><span v-if="o.vendor_name"> · {{ o.vendor_name }}</span></td>
            <td><span :class="PO_STATUS[o.status][1]">{{ PO_STATUS[o.status][0] }}</span><span v-if="o.reject_reason" class="muted"> {{ o.reject_reason }}</span></td>
            <td>{{ o.total_qty }}</td>
            <td class="money">¥{{ o.total_amount.toLocaleString() }}</td>
            <td>{{ o.received_qty }}</td>
            <td>第 {{ o.arrive_day }} 天</td>
            <td><button class="ghost" @click="openDetail(o.id)">详情</button></td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 供应商账单 -->
    <div v-if="tab === 'bills'" class="card">
      <h3>🧾 供应商账单（入库形成应付，付款才流出现金；退货可冲减或退现）</h3>
      <table>
        <thead><tr><th>账单</th><th>供应商</th><th>采购单</th><th>应付</th><th>已付</th><th>退货冲减</th><th>待付</th><th>状态</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="b in store.supplierBills" :key="b.id">
            <td>{{ b.code }}</td>
            <td>{{ b.supplier_name }}</td>
            <td class="muted">{{ b.order_id ? 'CG' + String(b.order_id).padStart(4, '0') : '-' }}</td>
            <td class="money">¥{{ b.amount_due.toLocaleString() }}</td>
            <td>¥{{ b.amount_paid.toLocaleString() }}</td>
            <td>¥{{ b.amount_returned.toLocaleString() }}</td>
            <td><b :class="b.remain > 0 ? 'money neg' : ''">¥{{ b.remain.toLocaleString() }}</b></td>
            <td><span :class="{ tag: true, ok: b.status === 'settled', warn: b.status === 'partial' }">{{ { open: '待付款', partial: '部分支付', settled: '已结清' }[b.status] }}</span></td>
            <td>
              <button class="ghost" @click="openBill(b.id)">明细</button>
              <button class="primary sm" v-if="b.remain > 0" @click="payBill(b)">付款</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 采购退货 -->
    <div v-if="tab === 'returns'" class="card">
      <div class="hrow"><h3>↩️ 采购退货与异常处理</h3><button class="primary" @click="openReturn()">＋ 新建退货</button></div>
      <table>
        <thead><tr><th>退货号</th><th>供应商</th><th>物资</th><th>数量</th><th>金额</th><th>原因</th><th>状态</th><th>退款</th><th>操作</th></tr></thead>
        <tbody>
          <tr v-for="r in store.purchaseReturns" :key="r.id">
            <td>{{ r.code }}</td>
            <td>{{ r.supplier_name }}</td>
            <td>{{ r.material_name }}</td>
            <td>{{ r.qty }} {{ r.unit }}</td>
            <td class="money">¥{{ r.amount.toLocaleString() }}</td>
            <td>{{ RETURN_REASON[r.reason] }}</td>
            <td><span :class="{ tag: true, warn: r.status === 'submitted', ok: r.status === 'confirmed', bad: r.status === 'rejected' }">
              {{ { submitted: '待确认', confirmed: '已确认', rejected: '已驳回' }[r.status] }}</span></td>
            <td>{{ { none: '-', deducted: '已冲应付', receivable: '挂应收', cash: '已退现' }[r.refund_status] }}</td>
            <td v-if="r.status === 'submitted'">
              <button class="succ sm" @click="confirmRet(r, 'deduct')">冲应付</button>
              <button class="sm" @click="confirmRet(r, 'cash')">退现</button>
              <button class="danger sm" @click="rejectRet(r)">驳回</button>
            </td>
            <td v-else class="muted">-</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 盘点对账 -->
    <div v-if="tab === 'stocktake'" class="grid2">
      <div class="card">
        <div class="hrow"><h3>🔍 库存盘点</h3><button class="primary" @click="newStocktake">＋ 新建盘点</button></div>
        <table>
          <thead><tr><th>单号</th><th>状态</th><th>差异项</th><th>差异成本</th><th>日期</th><th></th></tr></thead>
          <tbody>
            <tr v-for="s in store.stocktakes" :key="s.id">
              <td>{{ s.code }}</td>
              <td><span :class="{ tag: true, warn: s.status === 'counting', ok: s.status === 'done', bad: s.status === 'cancelled' }">
                {{ { counting: '盘点中', done: '已完成', cancelled: '已作废' }[s.status] }}</span></td>
              <td>{{ s.variance_qty }}</td>
              <td :class="s.variance_amount >= 0 ? 'money' : 'money neg'">¥{{ s.variance_amount }}</td>
              <td>第 {{ s.day }} 天</td>
              <td><button class="ghost" v-if="s.status === 'counting'" @click="openStocktake(s.id)">继续盘点</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <h3>🛡️ 异常对账</h3>
        <p class="muted small">系统每小时巡检库存：计数器漂移自动按批次事实源自愈；供应商账单资金口径不一致、退货挂应收等只告警不擅改，可在「客流调度闭环」页处理，也可手动触发巡检。</p>
        <button class="primary" @click="store.runInventoryReconcile()">立即巡检库存账实一致性</button>
        <div class="recon" v-if="store.reconcileList.filter(f => ['stock_counter','stock_ledger','supplier_bill','supplier_bill_negative','supplier_refund'].includes(f.kind)).length">
          <div class="recon-item" v-for="f in store.reconcileList.filter(f => ['stock_counter','stock_ledger','supplier_bill','supplier_bill_negative','supplier_refund'].includes(f.kind))" :key="f.id">
            <span :class="{ tag: true, bad: f.level === 'block', warn: f.level === 'warn' }">{{ f.level === 'block' ? '严重' : '预警' }}</span>
            <b>{{ f.title }}</b>
            <span class="muted small">{{ f.detail }}</span>
          </div>
        </div>
        <p class="muted small" v-else>暂无库存相关对账异常。</p>
      </div>
    </div>

    <!-- 库存流水 -->
    <div v-if="tab === 'ledger'" class="card">
      <h3>📜 库存流水（入/出/退货/盘盈盘亏逐条留痕）</h3>
      <table>
        <thead><tr><th>日</th><th>物资</th><th>类型</th><th>变动</th><th>结存</th><th>单价</th><th>商铺</th><th>备注</th></tr></thead>
        <tbody>
          <tr v-for="l in store.inventoryLedger" :key="l.id">
            <td>D{{ l.day }}</td>
            <td>{{ l.material_name }}</td>
            <td><span class="kind" :class="l.kind">{{ { inbound: '采购入库', sale: '销售出库', return_in: '退货入库', return_out: '采购退货', 'adjust+': '盘盈', 'adjust-': '盘亏', stockout_loss: '缺货流失' }[l.kind] || l.kind }}</span></td>
            <td :class="l.change_qty > 0 ? 'money' : l.change_qty < 0 ? 'money neg' : 'muted'">{{ l.change_qty > 0 ? '+' : '' }}{{ l.change_qty }}</td>
            <td>{{ l.balance_after }}</td>
            <td>¥{{ l.unit_cost }}</td>
            <td class="muted">{{ l.vendor_name || '-' }}</td>
            <td class="muted small">{{ l.note }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- 供应商 / 物资维护 -->
    <div v-if="tab === 'suppliers'" class="grid2">
      <div class="card">
        <div class="hrow"><h3>🤝 供应商</h3><button class="primary" @click="supOpen = true">＋ 新增</button></div>
        <table>
          <thead><tr><th>编号</th><th>名称</th><th>类别</th><th>周期</th><th>评级</th><th>在途应付</th><th>状态</th></tr></thead>
          <tbody>
            <tr v-for="s in store.suppliers" :key="s.id">
              <td>{{ s.code }}</td><td><b>{{ s.name }}</b><br><span class="muted small">{{ s.contact }} {{ s.phone }}</span></td>
              <td>{{ s.category }}</td><td>{{ s.lead_days }}天</td><td>{{ '⭐'.repeat(s.rating) }}</td>
              <td class="money neg" v-if="s.payable">¥{{ s.payable.toLocaleString() }}</td><td v-else class="muted">-</td>
              <td><button class="ghost sm" @click="toggleSupplier(s)">{{ s.status === 'active' ? '合作中 · 暂停' : '已暂停 · 恢复' }}</button></td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="card">
        <div class="hrow">
          <h3>🏷️ 物资目录</h3>
          <button class="primary" @click="matOpen = true">＋ 新增物资</button>
        </div>
        <table>
          <thead><tr><th>物资</th><th>类别</th><th>标准成本</th><th>最近进价</th><th>状态</th><th>商铺目录</th></tr></thead>
          <tbody>
            <tr v-for="m in store.materials" :key="m.id">
              <td>{{ catIcon(m.category) }} <b>{{ m.name }}</b></td>
              <td>{{ m.category }}</td><td>¥{{ m.std_cost }}</td><td>¥{{ m.last_cost }}</td>
              <td><button class="ghost sm" @click="toggleMat(m)">{{ m.status === 'on' ? '启用' : '停用' }}</button></td>
              <td><button class="ghost sm" @click="openVendorMat(m.vendors?.[0] ? null : store.vendors[0])">配置</button></td>
            </tr>
          </tbody>
        </table>
        <p class="muted small">为商铺配置消耗物资后，商铺销售将自动按 FEFO（先到期先出）扣减库存；全部关联物资耗尽时该商铺销售流失并触发缺货预警。</p>
        <div class="vmbox" v-if="vmVendor">
          <div class="hrow"><h3>🏪 {{ vmVendor.name }} 的物资目录</h3><button class="ghost sm" @click="vmVendor = null">关闭</button></div>
          <div v-for="l in vendorLinks" :key="l.material_id" class="vmrow">
            <span>{{ l.name }}</span>
            <span class="muted">每卖 1 份耗</span>
            <input class="mini" type="number" min="1" :value="l.qty_per_sale" @change="e => setVmQty(l, e.target.value)" />
            <span>{{ l.unit }}</span>
            <button class="danger ghost sm" @click="delVm(l)">移除</button>
          </div>
          <div class="vmrow">
            <select @change="e => { addVm(e.target.value); e.target.value = '' }">
              <option value="">＋ 添加物资…</option>
              <option v-for="m in store.materials.filter(x => !x.vendors?.some(v => v.id === vmVendor.id))" :key="m.id" :value="m.id">{{ m.name }}（在库 {{ m.onhand_qty }}）</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- 新建采购单弹层 -->
    <div class="modal" v-if="poOpen">
      <div class="modal-box card wide">
        <h3>🛒 新建采购单</h3>
        <div class="form">
          <div class="row2">
            <label>供应商
              <select v-model="po.supplier_id">
                <option v-for="s in store.suppliers.filter(s => s.status === 'active')" :key="s.id" :value="s.id">{{ s.name }}（周期 {{ s.lead_days }} 天）</option>
              </select>
            </label>
            <label>采购类型
              <select v-model="po.source">
                <option value="manual">运营统一采购</option>
                <option value="shop">商铺协同申购</option>
              </select>
            </label>
          </div>
          <label v-if="po.source === 'shop'">申购商铺
            <select v-model="po.vendor_id"><option v-for="v in store.vendors" :key="v.id" :value="v.id">{{ v.name }}</option></select>
          </label>
          <div class="items">
            <div class="ihead"><span>物资</span><span>数量</span><span>单价(¥)</span><span>小计</span><span></span></div>
            <div class="irow" v-for="(it, i) in po.items" :key="i">
              <select v-model="it.material_id" @change="onMatPick(it)">
                <option :value="null">选择物资…</option>
                <option v-for="m in store.materials.filter(m => m.status === 'on')" :key="m.id" :value="m.id">{{ m.name }}（在库{{ m.onhand_qty }} / 安全线{{ m.safety_stock }}）</option>
              </select>
              <input type="number" min="1" v-model.number="it.qty" />
              <input type="number" min="0" v-model.number="it.unit_cost" />
              <span class="money">¥{{ ((Number(it.qty)||0) * (Number(it.unit_cost)||0)).toLocaleString() }}</span>
              <button class="danger ghost sm" @click="removePOItem(i)" :disabled="po.items.length === 1">✕</button>
            </div>
            <button class="ghost sm" @click="addPOItem">＋ 添加明细</button>
          </div>
          <label>备注 <input v-model="po.note" placeholder="选填" /></label>
        </div>
        <div class="totalrow"><span>合计</span><b class="money">¥{{ poTotal.toLocaleString() }}</b></div>
        <div class="acts">
          <button class="primary" @click="submitPO(false)">提交审批</button>
          <button class="ghost" @click="submitPO(true)">暂存草稿</button>
          <button class="ghost" @click="poOpen = false">取消</button>
        </div>
      </div>
    </div>

    <!-- 采购单详情抽屉 -->
    <div class="modal" v-if="detail">
      <div class="modal-box card wide tall">
        <div class="hrow">
          <h3>{{ detail.order.code }} 采购单详情 <span :class="PO_STATUS[detail.order.status][1]">{{ PO_STATUS[detail.order.status][0] }}</span></h3>
          <button class="ghost" @click="closeDetail">✕</button>
        </div>
        <p class="muted small">供应商：{{ detail.order.supplier_name }}（{{ detail.order.contact }} {{ detail.order.phone }}）·
          来源：{{ { manual: '运营采购', shop: `商铺申购（${detail.order.vendor_name || ''}）`, auto: '缺货自动申购' }[detail.order.source] }} ·
          预计到货：第 {{ detail.order.arrive_day }} 天</p>
        <table>
          <thead><tr><th>物资</th><th>采购数</th><th>单价</th><th>金额</th><th>已入</th><th>待交</th></tr></thead>
          <tbody>
            <tr v-for="it in detail.items" :key="it.id">
              <td>{{ it.material_name }}</td><td>{{ it.qty }}</td><td>¥{{ it.unit_cost }}</td>
              <td class="money">¥{{ it.amount.toLocaleString() }}</td><td>{{ it.received_qty }}</td>
              <td :class="it.open_qty ? 'warn' : ''">{{ it.open_qty }}</td>
            </tr>
          </tbody>
        </table>

        <!-- 验收表单 -->
        <div v-if="['approved', 'receiving'].includes(detail.order.status) && receiveRows.length" class="recv">
          <h4>📥 到货验收（实收入库；少送待补发；破损不结算）</h4>
          <div v-for="r in receiveRows" :key="r.item_id" class="irow">
            <b>{{ r.material_name }}</b>
            <label class="muted small">实收 <input class="mini" type="number" min="0" :max="r.open_qty" v-model.number="r.recv_qty" /> / {{ r.open_qty }}</label>
            <label class="muted small">破损 <input class="mini" type="number" min="0" :max="r.open_qty" v-model.number="r.damaged_qty" /></label>
          </div>
          <div class="acts"><button class="succ" @click="submitReceive">确认验收入库</button></div>
        </div>
        <div v-if="detail.order.status === 'approved' && !receiveRows.length">
          <button class="succ" @click="startReceive">📥 开始验收入库</button>
        </div>
        <div v-if="detail.order.status === 'receiving' && !receiveRows.length" class="acts">
          <button class="succ" @click="startReceive">继续验收到货</button>
          <button class="ghost" @click="doShortageClose">少送结案</button>
        </div>

        <!-- 入库批次 -->
        <template v-if="detail.batches.length">
          <h4>入库批次</h4>
          <table>
            <thead><tr><th>批次</th><th>实收</th><th>金额</th><th>少送</th><th>破损</th><th>来源</th></tr></thead>
            <tbody>
              <tr v-for="b in detail.batches" :key="b.id">
                <td>{{ b.code }}</td><td>{{ b.total_qty }}</td><td class="money">¥{{ b.total_amount.toLocaleString() }}</td>
                <td :class="b.shortage_qty ? 'warn' : ''">{{ b.shortage_qty }}</td>
                <td :class="b.damaged_qty ? 'bad' : ''">{{ b.damaged_qty }}</td>
                <td class="muted">{{ b.source === 'auto' ? '到期自动到货' : '人工验收' }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- 账单/退货 -->
        <p v-if="detail.bill" class="muted small">账单 {{ detail.bill.code }}：应付 ¥{{ detail.bill.amount_due }}，已付 ¥{{ detail.bill.amount_paid }}，退货冲减 ¥{{ detail.bill.amount_returned }}（结算在「供应商账单」页）</p>
        <div v-if="detail.returns.length">
          <h4>关联退货</h4>
          <p class="small" v-for="r in detail.returns" :key="r.id">{{ r.code }} {{ r.material_id }} ×{{ r.qty }} ¥{{ r.amount }} · {{ { submitted: '待确认', confirmed: '已确认', rejected: '已驳回' }[r.status] }}</p>
        </div>

        <!-- 时间线 -->
        <div class="logs">
          <div v-for="l in detail.logs" :key="l.id" class="logline"><span class="muted">D{{ l.day }} {{ l.hour }}:00</span> {{ l.note }}</div>
        </div>

        <div class="acts">
          <button class="succ" v-if="detail.order.status === 'pending'" @click="doApprove(true)">审批通过</button>
          <button class="danger" v-if="detail.order.status === 'pending'" @click="doApprove(false)">驳回</button>
          <button class="ghost" v-if="['draft', 'pending', 'approved'].includes(detail.order.status)" @click="doCancelPO">撤销</button>
          <button class="ghost" v-if="['received', 'receiving'].includes(detail.order.status)" @click="openReturn(detail.order.id, detail.order.supplier_id)">采购退货</button>
        </div>
      </div>
    </div>

    <!-- 账单明细 -->
    <div class="modal" v-if="billDetail">
      <div class="modal-box card">
        <div class="hrow"><h3>{{ billDetail.bill.code }} 账单明细</h3><button class="ghost" @click="billDetail = null">✕</button></div>
        <p class="muted small">{{ billDetail.bill.supplier_name }} · 采购单 {{ billDetail.bill.order_id ? 'CG' + String(billDetail.bill.order_id).padStart(4, '0') : '-' }}</p>
        <div class="billtotals">
          <div><em>应付合计</em><b class="money">¥{{ billDetail.bill.amount_due.toLocaleString() }}</b></div>
          <div><em>已支付</em><b>¥{{ billDetail.bill.amount_paid.toLocaleString() }}</b></div>
          <div><em>退货冲减</em><b>¥{{ billDetail.bill.amount_returned.toLocaleString() }}</b></div>
          <div><em>待付</em><b class="money neg">¥{{ billDetail.bill.remain.toLocaleString() }}</b></div>
        </div>
        <h4>流水</h4>
        <div class="logs">
          <div class="logline" v-for="p in billDetail.payments" :key="p.id">
            <span class="muted">D{{ p.day }}</span>
            {{ { inbound: '入库形成应付', pay: '现金付款', return: '退货冲减', refund: '供应商退现' }[p.kind] }}
            <b :class="p.kind === 'pay' ? 'money neg' : 'money'">{{ p.kind === 'pay' ? '-' : '' }}¥{{ Math.abs(p.amount).toLocaleString() }}</b>
            <span class="muted small">{{ p.note }}</span>
          </div>
        </div>
        <div class="acts"><button class="primary" v-if="billDetail.bill.remain > 0" @click="payBill(billDetail.bill); billDetail = null">付款结算</button></div>
      </div>
    </div>

    <!-- 盘点弹层 -->
    <div class="modal" v-if="stDetail">
      <div class="modal-box card wide tall">
        <div class="hrow"><h3>{{ stDetail.head.code }} 库存盘点</h3><button class="ghost" @click="closeStocktake">✕</button></div>
        <table>
          <thead><tr><th>物资</th><th>账面</th><th>实盘</th><th>差异</th><th>成本差异</th></tr></thead>
          <tbody>
            <tr v-for="row in stDetail.items" :key="row.id" :class="{ diffrow: Number(row.actual_qty) - row.book_qty !== 0 }">
              <td>{{ row.material_name }} <span class="muted">({{ row.unit }})</span></td>
              <td>{{ row.book_qty }}</td>
              <td><input class="mini" type="number" min="0" :value="row.actual_qty || row.book_qty"
                @change="e => { row.actual_qty = Number(e.target.value); saveCount(row) }" :disabled="stDetail.head.status !== 'counting'" /></td>
              <td :class="(Number(row.actual_qty) - row.book_qty) > 0 ? 'money' : (Number(row.actual_qty) - row.book_qty) < 0 ? 'money neg' : ''">
                {{ (Number(row.actual_qty) - row.book_qty) || 0 }}
              </td>
              <td class="muted">¥{{ ((Number(row.actual_qty) - row.book_qty) * row.unit_cost) || 0 }}</td>
            </tr>
          </tbody>
        </table>
        <div class="acts" v-if="stDetail.head.status === 'counting'">
          <button class="succ" @click="finishST">完成盘点（盘盈入库/盘亏报损）</button>
          <button class="danger" @click="cancelST">作废</button>
        </div>
        <p class="muted small" v-else>盘点已{{ stDetail.head.status === 'done' ? '完成' : '作废' }}：差异 {{ stDetail.head.variance_qty }} 项 / 净成本 ¥{{ stDetail.head.variance_amount }}</p>
      </div>
    </div>

    <!-- 新建供应商 -->
    <div class="modal" v-if="supOpen">
      <div class="modal-box card">
        <h3>🤝 新增供应商</h3>
        <div class="form">
          <label>名称 <input v-model="sup.name" /></label>
          <div class="row2">
            <label>联系人 <input v-model="sup.contact" /></label>
            <label>电话 <input v-model="sup.phone" /></label>
          </div>
          <div class="row2">
            <label>类别 <select v-model="sup.category"><option>原料</option><option>包装</option><option>百货</option><option>综合</option></select></label>
            <label>评级 <select v-model.number="sup.rating"><option v-for="n in [5,4,3,2,1]" :key="n" :value="n">{{ '⭐'.repeat(n) }}</option></select></label>
          </div>
          <label>供货周期（游戏日） <input type="number" min="0" max="30" v-model.number="sup.lead_days" /></label>
        </div>
        <div class="acts"><button class="primary" @click="submitSup">保存</button><button class="ghost" @click="supOpen = false">取消</button></div>
      </div>
    </div>

    <!-- 新增物资 -->
    <div class="modal" v-if="matOpen">
      <div class="modal-box card">
        <h3>🏷️ 新增物资</h3>
        <div class="form">
          <label>名称 <input v-model="mat.name" /></label>
          <div class="row2">
            <label>类别 <select v-model="mat.category"><option>原料</option><option>包装</option><option>百货</option></select></label>
            <label>单位 <input v-model="mat.unit" placeholder="份/箱/件/瓶" /></label>
          </div>
          <div class="row2">
            <label>标准成本 ¥ <input type="number" min="0" v-model.number="mat.std_cost" /></label>
            <label>保质期（天，0=永久） <input type="number" min="0" v-model.number="mat.shelf_days" /></label>
          </div>
          <div class="row2">
            <label>安全库存 <input type="number" min="0" v-model.number="mat.safety_stock" /></label>
            <label>目标库存 <input type="number" min="0" v-model.number="mat.target_stock" /></label>
          </div>
        </div>
        <div class="acts"><button class="primary" @click="submitMat">保存</button><button class="ghost" @click="matOpen = false">取消</button></div>
      </div>
    </div>

    <!-- 新建退货 -->
    <div class="modal" v-if="retOpen">
      <div class="modal-box card">
        <h3>↩️ 新建采购退货</h3>
        <div class="form">
          <label>供应商 <select v-model="ret.supplier_id"><option v-for="s in store.suppliers" :key="s.id" :value="s.id">{{ s.name }}</option></select></label>
          <label>物资 <select v-model="ret.material_id"><option v-for="m in store.materials" :key="m.id" :value="m.id">{{ m.name }}（在库 {{ m.onhand_qty }}）</option></select></label>
          <div class="row2">
            <label>数量 <input type="number" min="1" v-model.number="ret.qty" /></label>
            <label>原因 <select v-model="ret.reason"><option value="quality">质量问题</option><option value="damage">运输破损</option><option value="over">多发退回</option><option value="other">其他</option></select></label>
          </div>
          <label>说明 <input v-model="ret.note" /></label>
        </div>
        <div class="acts"><button class="primary" @click="submitReturn">提交退货</button><button class="ghost" @click="retOpen = false">取消</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inv { display: flex; flex-direction: column; gap: 14px; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.kpi { display: flex; flex-direction: column; gap: 4px; padding: 14px; }
.kpi em { font-style: normal; font-size: 12px; color: var(--muted); }
.kpi b { font-size: 22px; }
.kpi.alert { border-color: rgba(255,107,107,.5); box-shadow: 0 0 0 1px rgba(255,107,107,.25) inset; }
.bar { display: flex; align-items: center; gap: 10px; }
.spacer { flex: 1; }
.tabs { display: flex; gap: 4px; flex-wrap: wrap; }
.tabs button { font-size: 13px; }
.tabs button.on { background: var(--panel2); border-color: var(--accent); color: var(--accent); }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; color: var(--muted); font-weight: 500; font-size: 12px; padding: 8px 10px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td { padding: 8px 10px; border-bottom: 1px solid rgba(42,52,84,.5); vertical-align: middle; }
tr.lowrow { background: rgba(255,209,102,.05); }
tr.outrow { background: rgba(255,107,107,.07); }
tr.diffrow { background: rgba(102,166,255,.07); }
.tag.ok { color: var(--green); border-color: rgba(109,213,160,.4); background: rgba(109,213,160,.1); }
.tag.warn { color: var(--accent2); border-color: rgba(255,209,102,.4); background: rgba(255,209,102,.1); }
.tag.bad { color: var(--red); border-color: rgba(255,107,107,.4); background: rgba(255,107,107,.1); }
.tag.blue { color: var(--blue); border-color: rgba(102,166,255,.4); background: rgba(102,166,255,.1); }
.warn { color: var(--accent2); font-weight: 600; }
.bad { color: var(--red); font-weight: 600; }
.sm { padding: 4px 9px; font-size: 12px; }
.mini { width: 74px; padding: 4px 7px; }
.hrow { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.hrow h3 { margin-bottom: 0; }
.grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.small { font-size: 12px; }
.kind { font-size: 11px; padding: 2px 8px; border-radius: 20px; background: var(--panel2); border: 1px solid var(--border); color: var(--muted); }
.kind.inbound, .kind.adjust\:+, .kind.return_in { color: var(--green); border-color: rgba(109,213,160,.4); }
.kind.sale, .kind.adjust\:-, .kind.return_out { color: var(--red); border-color: rgba(255,107,107,.35); }
.kind.stockout_loss { color: var(--accent2); }
.recon { display: flex; flex-direction: column; gap: 8px; margin-top: 12px; }
.recon-item { display: flex; flex-direction: column; gap: 3px; background: var(--panel2); border: 1px solid var(--border); border-radius: 10px; padding: 9px 12px; }
.modal { position: fixed; inset: 0; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; z-index: 60; padding: 20px; }
.modal-box { width: min(520px, 94vw); max-height: 88vh; overflow: auto; }
.modal-box.wide { width: min(880px, 96vw); }
.modal-box.tall { width: min(940px, 97vw); }
.form { display: flex; flex-direction: column; gap: 10px; margin: 12px 0; }
.form label { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--muted); }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.acts { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.items { display: flex; flex-direction: column; gap: 8px; background: var(--panel2); border-radius: 10px; padding: 10px; }
.ihead, .irow { display: grid; grid-template-columns: 2fr 90px 100px 1fr 34px; gap: 8px; align-items: center; }
.ihead { font-size: 11px; color: var(--muted); padding: 0 2px; }
.irow input, .irow select { width: 100%; }
.totalrow { display: flex; justify-content: flex-end; gap: 12px; font-size: 15px; margin: 8px 0; }
.logs { display: flex; flex-direction: column; gap: 5px; margin: 10px 0; max-height: 180px; overflow: auto; }
.logline { font-size: 12px; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 4px 0; border-bottom: 1px dashed rgba(42,52,84,.5); }
.recv { background: var(--panel2); border-radius: 10px; padding: 12px; margin: 10px 0; }
.recv h4, h4 { font-size: 13px; margin: 12px 0 8px; color: var(--text); }
.billtotals { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 10px 0; }
.billtotals div { background: var(--panel2); border-radius: 10px; padding: 10px; text-align: center; display: flex; flex-direction: column; gap: 4px; }
.billtotals em { font-style: normal; font-size: 11px; color: var(--muted); }
.vmbox { margin-top: 12px; border-top: 1px solid var(--border); padding-top: 10px; display: flex; flex-direction: column; gap: 8px; }
.vmrow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>
