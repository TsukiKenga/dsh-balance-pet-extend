// ============================================================================
// 计价 —— 口径照搬 dsh-whale-widget（峰谷时段 + 周末谷价 + 法定节假日 + 自定义单价）
// ============================================================================
// 抽成独立模块的唯一目的：这些是纯函数，单独放才能直接跑单元测试（apply() 内部的东西测不到）。
// 节假日清单**由调用方注入**（见 lib/holidays.js），本模块不碰文件系统 —— 保持可测。
// ============================================================================

export const PEAK_HOURS = [[9, 12], [14, 18]]
export const BASE_PRICE = { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] }
export const PRO_PRICE = { hit: [0.15, 0.3], miss: [4.5, 9.0], out: [13.5, 27.0] }
export const PRICING = {
  'deepseek-flash': BASE_PRICE,
  'deepseek-v4-flash-vision-exp': BASE_PRICE,
  'deepseek-v4-flash': BASE_PRICE,
  'deepseek-v4-pro': PRO_PRICE,
  _default: BASE_PRICE,
}
const WEEKEND_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000) // 北京 2026-08-23 00:00
const HOLIDAY_VALLEY_FROM_SEC = Math.floor(Date.UTC(2026, 8, 18, 16, 0, 0) / 1000) // 北京 2026-09-19 00:00

// holidays: { 'YYYY-MM-DD': 1 } —— 由 holidays.js 的 holidaySet() 提供；省略则视为无节假日
function isHolidayValley(bjDate, holidays) {
  try { return !!(holidays && holidays[bjDate.toISOString().slice(0, 10)]) } catch (err) { return false }
}

// 峰时段判定：周末（自 2026-08-23 起）与法定节假日全天按谷价
export function isPeakTime(timeSec, holidays) {
  if (!isFinite(Number(timeSec))) return false
  const n = Number(timeSec)
  const bj = new Date(n * 1000 + 8 * 3600 * 1000)
  if (n >= WEEKEND_VALLEY_FROM_SEC) {
    const dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  if (n >= HOLIDAY_VALLEY_FROM_SEC && isHolidayValley(bj, holidays)) return false
  const hour = bj.getUTCHours()
  for (const [start, end] of PEAK_HOURS) {
    if (hour >= start && hour < end) return true
  }
  return false
}

// 自定义单价来自 .dshw-api.json 的模型 price 字段；匹配键取 matchIds（与 whale 同约定）
export function buildCustomPrices(models) {
  const out = []
  try {
    for (const m of models || []) {
      if (!m || !m.price) continue
      const num = (v) => (isFinite(Number(v)) ? Number(v) : undefined)
      const hit = num(m.price.hit), miss = num(m.price.miss), o = num(m.price.out)
      if (hit === undefined && miss === undefined && o === undefined) continue
      const keys = (Array.isArray(m.matchIds) && m.matchIds.length) ? m.matchIds : [m.name, m.id]
      for (const k of keys) {
        const kk = String(k || '').toLowerCase().trim()
        if (!kk) continue
        out.push({
          key: kk,
          table: { hit: [hit || 0, hit || 0], miss: [miss || 0, miss || 0], out: [o || 0, o || 0] },
          meta: { cur: m.price.cur, rate: m.price.rate },
        })
      }
    }
  } catch (err) { /* 注册表坏了就只用内置价 */ }
  out.sort((a, b) => b.key.length - a.key.length) // 最长命中优先，避免短键误伤
  return out
}

export function priceFor(model, custom) {
  const m = String(model || '').toLowerCase()
  for (const c of custom || []) {
    if (c.key && m.indexOf(c.key) !== -1) return c
  }
  for (const key of Object.keys(PRICING)) {
    if (key === '_default') continue
    if (m.indexOf(key) !== -1) return { table: PRICING[key], meta: null }
  }
  return { table: PRICING._default, meta: null }
}

// 按一轮的 token usage 算钱（元）。reasoningTokens ⊆ outputTokens，故不重复计。
export function costOfUsage(model, usage, opts) {
  const o = opts || {}
  const input = Number(usage && usage.inputTokens) || 0
  const cache = Number(usage && usage.cacheReadTokens) || 0
  const output = Number(usage && usage.outputTokens) || 0
  const toks = input + cache + output
  const hit = priceFor(model, o.custom)
  const off = isPeakTime(o.atSec === undefined ? Math.floor(Date.now() / 1000) : o.atSec, o.holidays) ? 1 : 0
  const p = hit.table
  let cost = (cache / 1e6) * p.hit[off] + (input / 1e6) * p.miss[off] + (output / 1e6) * p.out[off]
  // 自定义单价若按美元填写，按用户填的汇率折算成元（账本统一按元记账）
  try {
    if (hit.meta && String(hit.meta.cur).toUpperCase() === 'USD' && Number(hit.meta.rate) > 0) {
      cost = cost * Number(hit.meta.rate)
    }
  } catch (err) {}
  return { cost, tokens: toks }
}

export function money(n) { return Number((Number(n) || 0).toFixed(6)) }
export function addMoney(a, b) { return money((Number(a) || 0) + (Number(b) || 0)) }

// 子代理会话判别：DSH 没给稳定契约，把已知可能的标记全兜一遍；
// 实际观察到的 session 字段会暴露到 /dsh-pet/sessions.json，供事后收紧判定。
const SUB_MARKERS = ['parentId', 'parentSessionId', 'parent', 'parentAgentId', 'forkedFrom',
  'isSubagent', 'isSubAgent', 'subagent', 'subAgent', 'childOf']
export function sessionVerdict(session) {
  try {
    if (!session || typeof session !== 'object') return { sub: false, why: 'no-session' }
    for (const k of SUB_MARKERS) {
      const v = session[k]
      if (v === true) return { sub: true, why: k }
      if (v && typeof v === 'object' && v.id) return { sub: true, why: k + '.id' }
      if (v && typeof v !== 'object') return { sub: true, why: k }
    }
    const kind = String(session.kind || session.type || '').toLowerCase()
    if (kind && (kind.indexOf('sub') >= 0 || kind.indexOf('child') >= 0)) return { sub: true, why: 'kind=' + kind }
    return { sub: false, why: 'none' }
  } catch (err) { return { sub: false, why: 'error' } }
}
