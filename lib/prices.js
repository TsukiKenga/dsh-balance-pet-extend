// ============================================================================
// 手动模型价格表 —— 纯函数（校验 / 合并 / 内置表）
// ============================================================================
// 用户可以在右键「模型价格表」里导入 JSON，或直接编辑当前表。
// 表项格式与 .dshw-api.json 的 models[] 兼容：
//   { id, name, matchIds: [...], price: { hit, miss, out, cur, rate } }
// 单位：元 / 百万 token；cur=USD 时用 rate 折算成元。
// ============================================================================
import { PRICING } from './pricing.js'

export const PRICES_MAX_MODELS = 500
export const PRICE_KEYS = ['hit', 'miss', 'out']

export function sanitizePriceEntry(m) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null
  let matchIds = Array.isArray(m.matchIds) ? m.matchIds : (m.matchIds ? [m.matchIds] : [])
  matchIds = matchIds.map((x) => String(x || '').trim()).filter(Boolean).slice(0, 20)
  // id / name 可以省略：只给 matchIds 时用第一个当唯一键，导入更省事
  const id = String(m.id || m.name || matchIds[0] || '').trim().slice(0, 120)
  const name = String(m.name || id || '').trim().slice(0, 120)
  if (!matchIds.length && id) matchIds = [id]
  if (!id || !matchIds.length) return null
  const p = m.price || {}
  const price = {}
  for (const k of PRICE_KEYS) {
    const n = Number(p[k])
    if (isFinite(n) && n >= 0) price[k] = n
  }
  if (!Object.keys(price).length) return null
  for (const k of PRICE_KEYS) if (price[k] === undefined) price[k] = 0
  price.cur = String(p.cur || 'CNY').toUpperCase() === 'USD' ? 'USD' : 'CNY'
  const rate = Number(p.rate)
  if (price.cur === 'USD' && isFinite(rate) && rate > 0) price.rate = rate
  return { id, name, matchIds, price }
}

export function normalizePriceModels(input) {
  if (!Array.isArray(input)) return { error: 'models 必须是数组' }
  if (input.length > PRICES_MAX_MODELS) return { error: '条目太多（上限 ' + PRICES_MAX_MODELS + ' 条）' }
  const out = []
  const byId = {}
  for (let i = 0; i < input.length; i++) {
    const m = sanitizePriceEntry(input[i])
    if (!m) {
      return { error: '第 ' + (i + 1) + ' 条无效：需要 id 或 name、matchIds（可省略，默认用 id），以及至少一个 hit / miss / out 价格' }
    }
    const key = m.id.toLowerCase()
    if (Object.prototype.hasOwnProperty.call(byId, key)) out[byId[key]] = m
    else { byId[key] = out.length; out.push(m) }
  }
  return { models: out }
}

// 按 id / matchIds 合并：同键旧条目先删掉再放新条目，所以「更新已有模型」是覆盖而不是重复
export function mergePriceModels(existing, incoming) {
  const out = (existing || []).slice()
  let added = 0, updated = 0
  for (const m of incoming) {
    const keys = new Set([m.id.toLowerCase(), ...m.matchIds.map((x) => x.toLowerCase())])
    let replaced = false
    for (let i = out.length - 1; i >= 0; i--) {
      const e = out[i]
      const ekeys = [e.id.toLowerCase(), ...e.matchIds.map((x) => x.toLowerCase())]
      if (ekeys.some((k) => keys.has(k))) { out.splice(i, 1); replaced = true }
    }
    out.push(m)
    if (replaced) updated += 1
    else added += 1
  }
  return { models: out, added, updated }
}

export function builtinPriceRows() {
  return Object.keys(PRICING)
    .filter((k) => k !== '_default')
    .map((name) => ({ name, price: PRICING[name] }))
}
