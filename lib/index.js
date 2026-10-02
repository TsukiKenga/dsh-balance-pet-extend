// ============================================================================
// dsh-balance-pet-extend —— DSH 余额桌宠（宿主侧）
// ============================================================================
// 把一个 macOS 原生 Swift/AppKit 桌宠（VK-1 的 macOS 移植版）改写成
// DSH Web 插件：浏览器半区负责绘制/动画/交互，宿主半区负责取余额与投递素材。
//
// 与 dsh-whale-widget 的关系：两者互不依赖，可以共存。鲸鱼挂件固定在右下角，
// 本桌宠默认吸附左下角（与 macOS 原版一致），因此不会互相遮挡。
//
// 设计约束（照抄 dsh-whale-widget 踩过的坑）：
//   ① 桌面端（Electron）唯一可用的注入通道是 `webserver/index-inject` 的
//      **内联 script 行**；`script-src` 行一旦加载失败会 reject 掉整个 boot。
//      而这张注入表是宿主**启动时一次性收集**的，所以注册必须放在 apply() 最前面，
//      不能等 inject 里的服务就绪。
//   ② `deepseekAccount` 必须用 `ctx.get()` 读**可选服务**，绝不能写进 inject ——
//      老宿主没有这个服务，一旦进 inject 整个插件会永远不 apply。
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { costOfUsage, buildCustomPrices, sessionVerdict, money, addMoney } from './pricing.js'
import { TEMPLATES, autoQueryable, authHeader, fillUrl } from './providers.js'
import { holidaySet, staleness, parseHolidayInput, saveImported, clearImported, effectiveHolidays, HOLIDAY_FILE, BUILTIN_HOLIDAYS } from './holidays.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = path.resolve(HERE, '..')
const ASSET_DIR = path.join(PACKAGE_ROOT, 'assets')
const SPRITE_DIR = path.join(ASSET_DIR, 'sprites')

const ROUTE_PREFIX = '/dsh-pet'
const BALANCE_URL = 'https://api.deepseek.com/user/balance'
const BALANCE_TTL_MS = 25_000
const FETCH_TIMEOUT_MS = 8_000

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')

// —— 厂商模板见 lib/providers.js（kind:'balance' 金额类 / kind:'quota' 订阅额度类）——

const BUILTIN_SOURCE = 'deepseek'

// 可选余额来源注册表：与 dsh-whale-widget 共用同一份文件**约定**（不是代码依赖）
const REGISTRY_CANDIDATES = [
  path.join(DSH_HOME, '.dshw-api.json'),
  path.join(DSH_HOME, 'profiles', 'web', '.dshw-api.json'),
]

// JSON 取值：支持 a.b[0].c
function pickJson(obj, pathStr) {
  try {
    const parts = String(pathStr || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter((x) => x.length > 0)
    let cur = obj
    for (const p of parts) {
      if (cur === null || cur === undefined) return undefined
      cur = cur[p]
    }
    return cur
  } catch (err) { return undefined }
}

function readRegistry() {
  for (const p of REGISTRY_CANDIDATES) {
    try {
      const parsed = JSON.parse(fs.readFileSync(p, 'utf8'))
      if (parsed && Array.isArray(parsed.models)) return parsed
    } catch (err) { /* 换下一个候选 */ }
  }
  return { models: [] }
}

// 候选凭据名：注册表覆盖 → 模板 keyRefs（**DSH 官方名在前**）→ 模板 keyRef 兜底。
// 为什么是一串：DSH 自己的厂商目录用的环境变量名与 whale 的旧名不一致
// （如 DSH 用 KIMI_API_KEY，whale 用 KIMI_CODING_KEY），只认一个就会把已配的显示成未配。
function keyCandidates(tpl, reg) {
  const out = []
  const push = (x) => { const s = String(x || '').trim(); if (s && out.indexOf(s) < 0) out.push(s) }
  if (reg && reg.keyRef) push(reg.keyRef)
  for (const k of (tpl && tpl.keyRefs) || []) push(k)
  if (tpl && tpl.keyRef) push(tpl.keyRef)
  return out
}

// 凭据名探测（30 秒缓存，**不带重试** —— 探测要快，12 家 × 多个候选名不能每家等 700ms）
let credProbe = { at: 0, map: {} }
async function probeOne(ctx, keyRef) {
  if (!keyRef) return false
  const now = Date.now()
  if (now - credProbe.at > 30_000) credProbe = { at: now, map: {} }
  if (Object.prototype.hasOwnProperty.call(credProbe.map, keyRef)) return credProbe.map[keyRef]
  let ok = false
  try {
    const c = await ctx.credentials.resolve(keyRef)
    ok = !!(c && c.value)
  } catch (err) { ok = false }
  credProbe.map[keyRef] = ok
  return ok
}

// 依次探候选名，返回第一个命中的；都不命中则返回第一个名字（用于展示「未配置 X」）
async function pickKeyRef(ctx, tpl, reg) {
  const cands = keyCandidates(tpl, reg)
  for (const name of cands) {
    if (await probeOne(ctx, name)) return { hasKey: true, keyRef: name }
  }
  return { hasKey: false, keyRef: cands[0] || '' }
}

// 可选来源 = 内置 DeepSeek + 所有「只给一个 key 就能查」的模板（**自动发现，不用手工注册**）
//          + .dshw-api.json 里的条目（可覆盖名称/币种，也能带进需要 baseUrl 的模板）
async function listSources(ctx) {
  const out = []
  const seen = {}
  const ds = TEMPLATES.deepseek
  out.push({
    id: BUILTIN_SOURCE, name: ds.name, currency: ds.currency, kind: 'balance',
    builtin: true, provider: 'deepseek',
    // 内置源没有 API key 也能走 DSH 账号登录态，所以恒为「可用」
    hasKey: true,
  })
  seen[BUILTIN_SOURCE] = true

  for (const t of autoQueryable()) {
    if (seen[t.id]) continue
    seen[t.id] = true
    const k = await pickKeyRef(ctx, t, null)
    out.push({
      id: t.id, name: t.name, currency: t.currency, kind: t.kind, provider: t.id,
      hasKey: k.hasKey, keyRef: k.keyRef,
      // 尽力而为类（接口已下线/未收录）：前端要标出来，免得用户把失败当故障
      bestEffort: !!t.bestEffort, apiNote: t.apiNote || '',
    })
  }

  for (const m of readRegistry().models || []) {
    if (!m || !m.id) continue
    const tpl = TEMPLATES[m.provider]
    if (!tpl || tpl.kind === 'none') continue // 官方查不到的厂商不进菜单
    if (seen[m.id]) {
      const e = out.filter((x) => x.id === m.id)[0]
      if (e) {
        e.name = m.name || e.name
        e.currency = m.currency || e.currency
        e.fromRegistry = true
      }
      continue
    }
    // 需要 baseUrl 的模板（openai_compat / custom）只有在注册表给了地址时才算可用
    const hasEndpoint = !!(m.balance && m.balance.url) ||
      (tpl.kind === 'quota' ? !!(tpl.quota && tpl.quota.url) : !!(tpl.balance && tpl.balance.url && tpl.balance.url.indexOf('{base}') < 0))
    if (!hasEndpoint) continue
    seen[m.id] = true
    const k2 = await pickKeyRef(ctx, tpl, m)
    out.push({
      id: m.id, name: m.name || tpl.name, currency: m.currency || tpl.currency,
      kind: tpl.kind, provider: m.provider, fromRegistry: true,
      hasKey: k2.hasKey, keyRef: k2.keyRef,
    })
  }
  // 只把「确实配了凭据」的摆出来，没配的直接隐藏。
  // 列一堆点下去只会报「未配置」的条目，比不列更烦人。
  // （内置 DeepSeek 恒为 true：没有 API key 也能走 DSH 账号登录态。）
  return out.filter((s) => s.hasKey)
}

// ============================================================================
// 累计计费账本（落盘 $DSH_HOME/.dshpet-ledger.json，跨重启保留）
// ============================================================================
const LEDGER_FILE = path.join(DSH_HOME, '.dshpet-ledger.json')
function defaultLedger() {
  return { version: 1, enabled: true, since: null, models: {}, turns: 0, tokens: 0, lastSettledAt: null }
}
function readLedger() {
  try {
    const j = JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8'))
    if (j && typeof j === 'object') {
      return {
        version: 1,
        enabled: j.enabled !== false,
        since: isFinite(Number(j.since)) ? Number(j.since) : null,
        models: (j.models && typeof j.models === 'object' && !Array.isArray(j.models)) ? j.models : {},
        turns: Number(j.turns) || 0,
        tokens: Number(j.tokens) || 0,
        lastSettledAt: isFinite(Number(j.lastSettledAt)) ? Number(j.lastSettledAt) : null,
      }
    }
  } catch (err) { /* 首次运行或文件损坏 → 用默认 */ }
  return defaultLedger()
}
function writeLedger(l) {
  try { fs.writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2), 'utf8'); return true } catch (err) { return false }
}

// —— 角色表 ——
// sprite: assets/sprites 下的文件名
// tablet: 平板的三个角，坐标是**1536×1024 原图像素、左上角为原点**，直接照搬 macOS
//         原版 PetCharacter.swift 的 tabletCorners。第四个角（右下）代码用不到，
//         但 (400,220) 的仿射投影正好落在原版文档记录的 (1443,834) / (1430,836)。
// panel:  平板自身的逻辑尺寸（原版 tabletBounds = 400×220），文字按这个坐标系排版。
// 命中判定不在这里：原版用的是 spriteRect + PNG 自身的逐像素 alpha（阈值 8/255），
// 浏览器端照做即可，因此不需要按角色配点击区域。
const PANEL = { w: 400, h: 220 }
const TABLET_TRIO = { tl: [1060, 699], tr: [1413, 644], bl: [1090, 889] }
const TABLET_GEMINI = { tl: [1065, 699], tr: [1400, 646], bl: [1095, 889] }

const CHARACTERS = [
  { id: 'fish', name: '蓝色大肥鱼', sprite: 'fish.png', offlineSprite: 'fish-offline.png', tablet: TABLET_TRIO },
  { id: 'gpt', name: 'GPT龙娘', sprite: 'gpt.png', tablet: TABLET_TRIO },
  { id: 'claude', name: '大小姐Claude', sprite: 'claude.png', tablet: TABLET_TRIO },
  { id: 'gemini', name: '北美猫娘Gemini', sprite: 'gemini.png', tablet: TABLET_GEMINI },
]
const DEFAULT_CHARACTER = 'fish'

// —— 尺寸档：高度（CSS px），宽度按原图 1536:1024 比例展开 ——
const SIZES = [110, 150, 210, 280]
const DEFAULT_SIZE = 150
const SPRITE_W = 1536
const SPRITE_H = 1024

// ============================================================================
// 「关于」信息
// ============================================================================
const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8')) } catch (err) { return {} }
})()
// 构建时间 = 参与运行的那几个文件里最新的 mtime。
// 用 mtime 而不是写死常量：本插件是 link: 安装，源码改动立刻生效，
// 写死的时间会与实际运行的代码对不上。
const BUILD_TIME = (() => {
  let newest = 0
  for (const rel of ['lib/index.js', 'lib/pricing.js', 'lib/providers.js', 'lib/holidays.js', 'assets/pet.js', 'package.json']) {
    try {
      const st = fs.statSync(path.join(PACKAGE_ROOT, rel))
      if (st.mtimeMs > newest) newest = st.mtimeMs
    } catch (err) {}
  }
  return newest ? new Date(newest).toISOString() : null
})()
const ABOUT = {
  name: 'dsh-balance-pet-extend',
  pkgName: PKG.name || 'dsh-balance-pet',
  version: PKG.version || '0.0.0',
  buildTime: BUILD_TIME,
  author: { name: 'TsukiKenga', url: 'https://github.com/TsukiKenga' },
  // 本插件自己的许可
  selfLicense: { label: 'MIT', url: ROUTE_PREFIX + '/license.txt?f=LICENSE.txt' },
  notices: { label: '第三方来源与许可', url: ROUTE_PREFIX + '/license.txt?f=THIRD-PARTY-NOTICES.md' },
  references: [
    {
      name: 'VK-1', url: 'https://github.com/VKmich16/VK-1', by: 'VKmich',
      note: '本桌宠立绘与动画的原型',
      licenseLabel: '上游暂未附许可证',
      licenseUrl: null,
    },
    {
      name: 'DeepSeek-Balance-Whale-Widget',
      url: 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget',
      by: 'MeteorNOX', license: 'MIT',
      note: '计价口径与厂商模板参考',
      // 许可证原文随包分发，点开即可阅读（MIT 要求再分发时保留声明）
      licenseLabel: 'MIT 许可证原文',
      licenseUrl: ROUTE_PREFIX + '/license.txt?f=whale-LICENSE.txt',
      provenanceUrl: ROUTE_PREFIX + '/license.txt?f=whale-PROVENANCE.md',
    },
  ],
}

const JSON_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
}

// 桌面端注入行：内联 script，自己建 <script src> 并吞掉 onerror。
// 路由在 → 正常加载；路由不在 → 静默失败，绝不连累宿主启动。
const DESKTOP_ROW_TEXT =
  '(function(){try{var d=document.body||document.head||document.documentElement;if(!d)return;' +
  'var s=document.createElement("script");s.src="' + ROUTE_PREFIX + '/pet.js";' +
  's.onerror=function(){};d.appendChild(s)}catch(e){}})()'

// —— 浏览器半区脚本：按 mtime 重读，改完硬刷新即生效 ——
const PETJS_CANDIDATES = [
  path.join(ASSET_DIR, 'pet.js'),
  path.join(PACKAGE_ROOT, 'pet.js'),
]
let petJsCache = null // { text, mtimeMs }
function loadPetJs() {
  for (const p of PETJS_CANDIDATES) {
    try {
      const st = fs.statSync(p)
      if (petJsCache && petJsCache.mtimeMs === st.mtimeMs) return petJsCache.text
      const text = fs.readFileSync(p, 'utf8')
      petJsCache = { text, mtimeMs: st.mtimeMs }
      return text
    } catch (err) { /* 换下一个候选 */ }
  }
  return petJsCache ? petJsCache.text : ''
}

// 素材名一律经 path.basename 收敛到 assets/sprites 之内，杜绝路径穿越；
// 可服务的文件集合完全由上面的 CHARACTERS 决定。

export default {
  name: 'dsh-balance-pet',

  apply(root) {
    // ① 注入行必须最早注册（见文件头约束 ①）
    root.effect(() => {
      const off = root.on('webserver/index-inject', (table) => {
        try {
          if (!Array.isArray(table)) return
          for (const row of table) {
            if (!row) continue
            if (row.kind === 'script-src' && row.src === ROUTE_PREFIX + '/pet.js') return
            if (row.kind === 'script' && typeof row.text === 'string'
              && row.text.indexOf(ROUTE_PREFIX + '/pet.js') >= 0) return
          }
          table.push({ kind: 'script', placement: 'body', text: DESKTOP_ROW_TEXT })
        } catch (err) { /* 注入表结构变化时静默 */ }
      })
      return () => { try { off() } catch (err) {} }
    })

    // ② 其余逻辑等服务就绪。注意只 inject 必需的两个服务。
    root.inject(['webServer', 'credentials'], (ctx) => {
      const disposers = []

      // —— 轻量信任栅栏 ——
      // 路由本身已在 DSH 的浏览器会话鉴权之后（未带 cookie 会 401），这里再挡一层
      // DNS 重绑定：Host 必须是回环权威，或显式出现在 DSH_PET_TRUSTED_HOSTS 里。
      const trusted = String(process.env.DSH_PET_TRUSTED_HOSTS || '')
        .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

      function isLoopbackHostname(hn) {
        const h = String(hn || '').toLowerCase().replace(/^\[/, '').replace(/\]$/, '')
        if (!h) return false
        if (h === 'localhost' || h.endsWith('.localhost')) return true
        if (h === '::1') return true
        const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
        if (!m) return false
        if (Number(m[1]) !== 127) return false
        return [m[2], m[3], m[4]].every((x) => Number(x) <= 255)
      }

      function rejected(req, res) {
        try {
          const host = String(req.headers.host || '').toLowerCase()
          const authority = host || ''
          const hostname = authority.replace(/:\d+$/, '')
          if (isLoopbackHostname(hostname) || trusted.includes(authority)) return false
          res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end('forbidden host')
          return true
        } catch (err) { return false }
      }

      function registerRoute(route) {
        const inner = route && route.handler
        const wrapped = Object.assign({}, route, {
          handler: async (req, res) => {
            if (rejected(req, res)) return
            return inner(req, res)
          },
        })
        return ctx.webServer.register(wrapped)
      }

      // —— 余额 ——
      // 每个余额来源各自缓存 / 各自去重，切来源不会互相污染
      const balanceCache = new Map() // sourceId -> { at, payload }
      const balanceInFlight = new Map()

      function pickBalanceInfo(infos) {
        if (!Array.isArray(infos) || infos.length === 0) return null
        const num = (x) => (x && x.total_balance !== undefined ? Number(x.total_balance) : NaN)
        return (
          infos.find((x) => x && x.currency === 'CNY' && num(x) > 0) ||
          infos.find((x) => num(x) > 0) ||
          infos.find((x) => x && x.currency === 'CNY') ||
          infos[0]
        )
      }

      // DSH 账号登录态：token 注入、x-client-* 头、401 清理全部交给 deepseekAccount 服务，
      // 不要自己拼 HTTP。用 ctx.get 读可选服务（见文件头约束 ②）。
      async function fetchAccountBalance() {
        let account = null
        try { account = typeof ctx.get === 'function' ? ctx.get('deepseekAccount') : null } catch (err) { account = null }
        if (!account || typeof account.getBalance !== 'function') return null
        let result
        try {
          result = await account.getBalance({
            version: String(process.env.DSH_CLIENT_VERSION || process.env.DSH_VERSION || '') || 'unknown',
            locale: String(process.env.DSH_LOCALE || '') || 'zh_CN',
            timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
          })
        } catch (err) { return null }
        if (!result || result.status !== 'ready' || !Array.isArray(result.value) || result.value.length === 0) return null
        const accNum = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }
        const wallets = result.value.filter((w) => w && accNum(w.balance) !== null)
        if (wallets.length === 0) return null
        const currency = wallets.some((w) => String(w.currency || '').toUpperCase() === 'CNY')
          ? 'CNY'
          : String((wallets[0] && wallets[0].currency) || 'CNY').toUpperCase()
        const sumOf = (list) => (Array.isArray(list) ? list : [])
          .filter((w) => w && String(w.currency || 'CNY').toUpperCase() === currency && accNum(w.balance) !== null)
          .reduce((s, w) => s + Number(w.balance), 0)
        const recharge = sumOf(result.value)
        const bonus = sumOf(result.bonusWallets)
        return {
          ok: true,
          totalBalance: Number((recharge + bonus).toFixed(6)),
          rechargeBalance: Number(recharge.toFixed(6)),
          bonusBalance: Number(bonus.toFixed(6)),
          currency,
          balanceSource: 'account',
          updatedAt: new Date().toISOString(),
        }
      }

      // 统一的凭据读取（初次可能未就绪 → 短延迟重试一次）
      async function resolveKey(keyRef) {
        let cred = null
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            cred = await ctx.credentials.resolve(keyRef)
            break
          } catch (err) {
            if (attempt === 0) { await new Promise((r) => setTimeout(r, 700)); continue }
            // 凭据服务对「这个 key 没配」与「服务本身出问题」通常都是抛异常，无法区分。
            // 但绝大多数情况就是没配，所以主文案给可操作的「未配置 X」，把原始原因附在后面。
            return {
              error: {
                ok: false, code: 'NO_KEY',
                error: '未配置 ' + keyRef + '（凭据读取失败：' + String((err && err.message) || err).slice(0, 120) + '）',
              },
            }
          }
        }
        if (!cred || !cred.value) return { error: { ok: false, code: 'NO_KEY', error: '未配置 ' + keyRef } }
        return { key: String(cred.value) }
      }

      // DeepSeek：API key 第一优先，其次 DSH 账号登录态（两条路互不干扰）
      async function fetchDeepseekBalance() {
        const r = await resolveKey('DEEPSEEK_API_KEY')
        if (r.error) {
          if (r.error.code === 'CRED') return r.error
          const accountPayload = await fetchAccountBalance()
          if (accountPayload) return accountPayload
          return {
            ok: false, code: 'NO_KEY',
            error: '未配置 DEEPSEEK_API_KEY，且账号余额不可用（未登录 DeepSeek 账号，或该账号没有余额钱包）',
          }
        }
        let lastErr = null
        for (let attempt = 0; attempt < 2; attempt++) {
          let res
          try {
            res = await fetch(BALANCE_URL, {
              headers: { Authorization: 'Bearer ' + r.key },
              signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            })
          } catch (err) {
            lastErr = err
            if (attempt === 0) await new Promise((x) => setTimeout(x, 500))
            continue
          }
          if (!res.ok) {
            lastErr = new Error('HTTP ' + res.status)
            if (res.status < 500) break
            if (attempt === 0) await new Promise((x) => setTimeout(x, 500))
            continue
          }
          let data
          try { data = await res.json() } catch (err) {
            return { ok: false, code: 'PARSE', error: '余额接口返回不是合法 JSON' }
          }
          const info = pickBalanceInfo(data && data.balance_infos)
          if (!info || info.total_balance === undefined || !Number.isFinite(Number(info.total_balance))) {
            return { ok: false, code: 'SHAPE', error: '余额接口返回结构异常' }
          }
          return {
            ok: true,
            totalBalance: Number(info.total_balance),
            currency: String(info.currency || 'CNY'),
            balanceSource: 'apikey',
            updatedAt: new Date().toISOString(),
          }
        }
        const transient = !(lastErr && /^HTTP 4\d\d/.test(lastErr.message))
        return {
          ok: false, code: 'HTTP', transient,
          error: '余额接口请求失败: ' + String((lastErr && lastErr.message) || lastErr).slice(0, 200),
        }
      }

      // 找出某来源实际生效的配置：模板（决定怎么查）+ 注册表条目（可覆盖地址/字段）
      function resolveSource(sourceId) {
        const tpl = TEMPLATES[sourceId]
        const reg = (readRegistry().models || []).find((x) => x && x.id === sourceId) || null
        if (tpl) return { tpl, reg, keyCands: keyCandidates(tpl, reg) }
        if (reg && TEMPLATES[reg.provider]) {
          const t2 = TEMPLATES[reg.provider]
          return { tpl: t2, reg, keyCands: keyCandidates(t2, reg) }
        }
        return null
      }

      async function httpJson(url, key, auth) {
        let res
        try {
          res = await fetch(url, {
            headers: Object.assign({ Accept: 'application/json' }, authHeader(auth, key)),
            signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          })
        } catch (err) {
          // 网络层失败（超时/DNS/连不上）时给一条可操作的提示。
          // 实测：Node 的 fetch **不会**自动走 Windows 系统代理，必须显式给 HTTPS_PROXY
          // 且开 NODE_USE_ENV_PROXY=1（Node 24+）；否则国内网络下 api.openai.com 必然超时。
          const msg = String((err && err.message) || err).slice(0, 160)
          return {
            err: {
              ok: false, code: 'NET', transient: true,
              error: '接口请求失败: ' + msg
                + '　（国内网络访问境外接口通常需要代理：给 DSH 设 HTTPS_PROXY=http://127.0.0.1:端口 '
                + '与 NODE_USE_ENV_PROXY=1 后重启；Node 的 fetch 不会自动使用系统代理）',
            },
          }
        }
        if (!res.ok) {
          // 带上响应体片段。403 到底是「地区不支持」「key 无权限」还是「接口已下线」，
          // 全写在 body 里 —— 不带上，用户只能看到一个孤零零的状态码，无从判断。
          let snippet = ''
          try {
            const txt = await res.text()
            snippet = String(txt).replace(/\s+/g, ' ').trim().slice(0, 300)
          } catch (err) { /* body 读不出来就算了，状态码仍然有用 */ }
          return {
            err: {
              ok: false, code: 'HTTP',
              error: '接口返回 HTTP ' + res.status + (snippet ? '　' + snippet : ''),
            },
          }
        }
        try { return { data: await res.json() } } catch (err) {
          return { err: { ok: false, code: 'PARSE', error: '接口返回不是合法 JSON' } }
        }
      }

      // 金额类：url + json.remaining（可选 minus / scale），可选第二个 usage 请求
      async function fetchMoneySource(src, key) {
        const { tpl, reg } = src
        const base = (reg && reg.baseUrl) || ''
        const b = Object.assign({}, tpl.balance || {}, (reg && reg.balance) || {})
        const url = fillUrl(b.url, base)
        if (!url) return { ok: false, code: 'NOSRC', error: '该来源没有配置余额接口地址' }
        const j = b.json || {}
        const r1 = await httpJson(url, key, b.auth)
        if (r1.err) return r1.err
        let v = Number(pickJson(r1.data, j.remaining))
        if (j.minus) {
          const used = Number(pickJson(r1.data, j.minus))
          if (Number.isFinite(used)) v = v - used
        }
        // 兼容 whale 的写法：usage 是独立请求，取「已用」再从额度里减掉
        if (tpl.usage && (!b.json || !b.json.minus)) {
          const uUrl = fillUrl(tpl.usage.url, base)
          const uj = (tpl.usage.json || {})
          const r2 = await httpJson(uUrl, key, tpl.usage.auth)
          if (!r2.err) {
            const used = Number(pickJson(r2.data, uj.used)) * (Number(uj.scale) || 1)
            if (Number.isFinite(used)) v = v - used
          }
        }
        if (j.scale) v = v * Number(j.scale)
        if (!Number.isFinite(v)) {
          return { ok: false, code: 'SHAPE', error: '接口返回结构异常（取不到 ' + j.remaining + '）' }
        }
        return {
          ok: true, kind: 'balance',
          totalBalance: Number(v.toFixed(6)),
          currency: String((reg && reg.currency) || tpl.currency || 'CNY').toUpperCase(),
          balanceSource: tpl.id || src.reg.provider,
          sourceName: (reg && reg.name) || tpl.name,
          updatedAt: new Date().toISOString(),
        }
      }

      // 订阅额度类：查的是「窗口用量 %」，不是钱。统一换算成「剩余可用」语义的展示文本。
      async function fetchQuotaSource(src, key) {
        const { tpl, reg } = src
        const base = (reg && reg.baseUrl) || ''
        const q = Object.assign({}, tpl.quota || {}, (reg && reg.quota) || {})
        const url = fillUrl(q.url, base)
        if (!url) return { ok: false, code: 'NOSRC', error: '该来源没有配置额度接口地址' }
        const j = q.json || {}
        const r = await httpJson(url, key, q.auth)
        if (r.err) return r.err
        const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null }

        // 各家给的百分比语义不统一：sem='used' 的接口报「已用 %」，要翻成「剩余 %」
        const sem = tpl.sem === 'remain' ? 'remain' : 'used'
        const toRemain = (v) => {
          const n = Number(v)
          if (!Number.isFinite(n)) return null
          return Math.max(0, Math.min(100, sem === 'remain' ? n : 100 - n))
        }

        // 多窗口形态（OpenCode Go）
        if (Array.isArray(j.windows)) {
          const wins = []
          for (const w of j.windows) {
            const rem = toRemain(pickJson(r.data, w.percent))
            if (rem !== null) wins.push({ key: w.key, label: w.label, remainPercent: rem, resetAt: pickJson(r.data, w.resetAt) })
          }
          if (!wins.length) return { ok: false, code: 'SHAPE', error: '接口返回结构异常（没有可用的窗口用量）' }
          const main = wins[0]
          return {
            ok: true, kind: 'quota', windows: wins,
            remainPercent: main.remainPercent, percent: main.remainPercent,
            label: main.label, resetAt: main.resetAt,
            currency: String((reg && reg.currency) || tpl.currency || 'CNY').toUpperCase(),
            balanceSource: tpl.id, sourceName: (reg && reg.name) || tpl.name,
            updatedAt: new Date().toISOString(),
          }
        }
        // 单窗口形态
        let raw = num(pickJson(r.data, j.percent))
        let label = '本期'
        let remainFromRatio = null
        if (raw === null) {
          const remain = num(pickJson(r.data, j.remain))
          const total = num(pickJson(r.data, j.total))
          if (remain !== null && total) remainFromRatio = (remain / total) * 100
        }
        if (raw === null) raw = num(pickJson(r.data, j.remainPct))
        const remPct = remainFromRatio !== null ? Math.max(0, Math.min(100, remainFromRatio)) : toRemain(raw)
        if (remPct === null) return { ok: false, code: 'SHAPE', error: '接口返回结构异常（没有可用的用量百分比）' }
        const weeklyRaw = num(pickJson(r.data, j.weeklyRemainPct))
        const resetAt = pickJson(r.data, j.resetAt) !== undefined ? pickJson(r.data, j.resetAt) : pickJson(r.data, j.resetAtMs)
        const windows = [{ key: 'main', label: label, remainPercent: remPct, resetAt: resetAt }]
        if (weeklyRaw !== null) windows.push({ key: 'weekly', label: '周', remainPercent: toRemain(weeklyRaw), resetAt: null })
        return {
          ok: true, kind: 'quota', windows,
          remainPercent: remPct, percent: remPct, label: label, resetAt: resetAt,
          currency: String((reg && reg.currency) || tpl.currency || 'CNY').toUpperCase(),
          balanceSource: tpl.id, sourceName: (reg && reg.name) || tpl.name,
          updatedAt: new Date().toISOString(),
        }
      }

      // 按候选名依次取凭据（这里带重试：真正要发请求了，值得为「凭据服务刚起还没就绪」多等一次）
      async function resolveKeyAny(cands) {
        let lastErr = null
        for (const name of cands || []) {
          const r = await resolveKey(name)
          if (r.key) return r
          lastErr = r.error
        }
        return { error: lastErr || { ok: false, code: 'NO_KEY', error: '未配置 ' + ((cands && cands[0]) || 'API key') } }
      }

      async function fetchProviderBalance(sourceId) {
        const src = resolveSource(sourceId)
        if (!src) return { ok: false, code: 'NOSRC', error: '未知的余额来源: ' + sourceId }
        const { tpl } = src
        if (tpl.kind === 'none') {
          return { ok: false, code: 'NOSRC', error: (tpl.name || sourceId) + ' 官方没有「用 API key 查余额」的接口' + (tpl.apiNote ? '：' + tpl.apiNote : '') }
        }
        const r = await resolveKeyAny(src.keyCands)
        if (r.error) return r.error
        return tpl.kind === 'quota' ? fetchQuotaSource(src, r.key) : fetchMoneySource(src, r.key)
      }

      function fetchBalanceFor(sourceId) {
        if (!sourceId || sourceId === BUILTIN_SOURCE) return fetchDeepseekBalance()
        return fetchProviderBalance(sourceId)
      }

      function getBalance(sourceId, force) {
        const id = sourceId || BUILTIN_SOURCE
        const now = Date.now()
        const cached = balanceCache.get(id)
        if (!force && cached && now - cached.at < BALANCE_TTL_MS) {
          return Promise.resolve(cached.payload)
        }
        if (balanceInFlight.has(id)) return balanceInFlight.get(id)
        const p = fetchBalanceFor(id)
          .then((payload) => {
            // 成功才缓存；transient 失败保留上一次读数（前端据此显示"暂时失联"而不是余额归零）
            if (payload && payload.ok) balanceCache.set(id, { at: Date.now(), payload })
            if (payload && !payload.ok && payload.transient && cached) {
              return Object.assign({}, cached.payload, { stale: true, error: payload.error })
            }
            return payload
          })
          .catch((err) => ({ ok: false, code: 'EXC', error: String((err && err.message) || err).slice(0, 200) }))
          .finally(() => { balanceInFlight.delete(id) })
        balanceInFlight.set(id, p)
        return p
      }

      // ======================================================================
      // 每轮消耗 + 累计计费
      // ======================================================================
      let billing = readLedger()
      // 启动即自动开始计费（除非曾在右键菜单里关掉过）
      if (billing.enabled && !billing.since) {
        billing.since = Date.now()
        writeLedger(billing)
      }
      const turnAggs = new Map()     // sid -> { turn, cost, tokens, byModel, lastTs }
      const seenSessions = new Map() // sid -> { keys, sub, why, at }（诊断用）
      let lastTurn = null
      let lastTurnSeq = 0

      function noteSession(sid, session) {
        try {
          if (seenSessions.has(sid)) return
          const v = sessionVerdict(session)
          let keys = []
          try { keys = Object.keys(session || {}).slice(0, 60) } catch (err) {}
          seenSessions.set(sid, { keys, sub: v.sub, why: v.why, at: Date.now() })
        } catch (err) {}
      }

      // 自定义单价表：10 秒节流，避免每条 assistant/message 都重读一次注册表文件
      let customPriceCache = null
      let customPriceAt = 0
      function customs() {
        const now = Date.now()
        if (!customPriceCache || now - customPriceAt > 10000) {
          customPriceCache = buildCustomPrices(readRegistry().models)
          customPriceAt = now
        }
        return customPriceCache
      }

      function finalizeTurn(sid) {
        const agg = turnAggs.get(sid)
        turnAggs.delete(sid)
        if (!agg || !(agg.cost > 0)) return // 消耗为 0 的回合不记账也不提示
        const seen = seenSessions.get(sid)
        if (seen && seen.sub) return        // 子代理回合不计
        lastTurn = {
          seq: ++lastTurnSeq,
          turn: agg.turn,
          amount: money(agg.cost),
          tokens: agg.tokens,
          ts: agg.lastTs || Date.now(),
          currency: 'CNY',
        }
        if (billing.enabled) {
          if (!billing.since) billing.since = Date.now()
          for (const name of Object.keys(agg.byModel)) {
            billing.models[name] = addMoney(billing.models[name] || 0, agg.byModel[name])
          }
          billing.turns += 1
          billing.tokens += agg.tokens
          writeLedger(billing)
        }
      }

      function onSessionEvent(session, event) {
        try {
          const sid = (session && session.id) ? String(session.id) : 'default'
          noteSession(sid, session)
          const type = event && event.type
          const d = event && event.data
          if (!d || typeof d !== 'object') return
          if (type === 'turn/end') { finalizeTurn(sid); return }
          if (type !== 'assistant/message') return
          const turn = Number(d.turn)
          const usage = d.usage
          if (!usage || typeof usage !== 'object' || !isFinite(turn)) return
          let agg = turnAggs.get(sid)
          if (!agg || agg.turn !== turn) {
            if (agg) finalizeTurn(sid)
            agg = { turn, cost: 0, tokens: 0, byModel: {}, lastTs: Date.now() }
            turnAggs.set(sid, agg)
          }
          const model = (d.message && d.message.source && d.message.source.model) || ''
          const r = costOfUsage(model, usage, { custom: customs(), holidays: holidaySet() })
          agg.cost = addMoney(agg.cost, r.cost)
          agg.tokens += r.tokens
          const key = model || '未知'
          agg.byModel[key] = addMoney(agg.byModel[key] || 0, r.cost)
          agg.lastTs = Date.now()
        } catch (err) { /* 事件结构变化时绝不影响宿主 */ }
      }

      disposers.push(ctx.on('session/event', onSessionEvent))
      disposers.push(ctx.on('session/disposed', (session) => {
        try {
          const sid = (session && session.id) ? String(session.id) : 'default'
          turnAggs.delete(sid)
        } catch (err) {}
      }))

      function ledgerPayload() {
        const models = Object.keys(billing.models)
          .map((name) => ({ name, amount: money(billing.models[name]) }))
          .sort((a, b) => b.amount - a.amount)
        let total = 0
        for (const m of models) total = addMoney(total, m.amount)
        return {
          ok: true,
          enabled: billing.enabled,
          since: billing.since,
          now: Date.now(),
          models,
          total,
          turns: billing.turns,
          tokens: billing.tokens,
          lastSettledAt: billing.lastSettledAt,
          currency: 'CNY',
        }
      }

      // 结算：返回这一段的结果，并把账本清零、起点挪到现在
      function settleLedger() {
        const payload = ledgerPayload()
        billing.models = {}
        billing.turns = 0
        billing.tokens = 0
        billing.since = Date.now()
        billing.lastSettledAt = Date.now()
        writeLedger(billing)
        return payload
      }

      function setBillingEnabled(on) {
        billing.enabled = !!on
        if (billing.enabled && !billing.since) billing.since = Date.now()
        writeLedger(billing)
        return ledgerPayload()
      }

      function readBody(req, limit) {
        return new Promise((resolve) => {
          let buf = ''
          let n = 0
          req.on('data', (c) => {
            n += c.length
            if (n > (limit || 65536)) { try { req.destroy() } catch (err) {} resolve(''); return }
            buf += c
          })
          req.on('end', () => resolve(buf))
          req.on('error', () => resolve(''))
        })
      }

      // —— 路由 ——

      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/pet.js',
        handler: (req, res) => {
          try {
            const body = loadPetJs()
            res.writeHead(200, {
              'Content-Type': 'application/javascript; charset=utf-8',
              'Cache-Control': 'no-store',
            })
            res.end(body)
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('pet.js unavailable: ' + String((err && err.message) || err))
          }
        },
      }))

      // 可选余额来源列表（右键菜单用它渲染「余额来源」子菜单）
      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/sources.json',
        handler: async (req, res) => {
          let sources = []
          try { sources = await listSources(ctx) } catch (err) { sources = [] }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, sources, default: BUILTIN_SOURCE }))
        },
      }))

      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/balance.json',
        handler: async (req, res) => {
          let force = false
          let source = BUILTIN_SOURCE
          try {
            const u = new URL(req.url || '/', 'http://localhost')
            force = u.searchParams.get('refresh') === '1'
            source = u.searchParams.get('source') || BUILTIN_SOURCE
          } catch (err) { /* 用默认 */ }
          let payload
          try { payload = await getBalance(source, force) } catch (err) {
            payload = { ok: false, code: 'EXC', error: String((err && err.message) || err) }
          }
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify(payload || { ok: false, code: 'EMPTY' }))
        },
      }))

      // 角色/尺寸/平板几何：前端不再硬编码，改由宿主单一来源下发
      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/manifest.json',
        handler: (req, res) => {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: true,
            sprite: { w: SPRITE_W, h: SPRITE_H },
            panel: PANEL,
            sizes: SIZES,
            defaultSize: DEFAULT_SIZE,
            defaultCharacter: DEFAULT_CHARACTER,
            // 前端据此在启动时提示「节假日清单该更新了」
            holiday: staleness(),
            // 「关于」对话框的内容
            about: ABOUT,
            characters: CHARACTERS.map((c) => ({
              id: c.id,
              name: c.name,
              sprite: c.sprite,
              offlineSprite: c.offlineSprite || null,
              tablet: c.tablet,
            })),
          }))
        },
      }))

      // 素材逐个注册为 exact 路由 —— 只用 dsh-whale-widget 实测过的 kind:'exact'，
      // 不依赖未验证的 prefix 匹配语义。角色表是唯一事实来源，加角色不用改路由代码。
      const spriteFiles = []
      for (const c of CHARACTERS) {
        spriteFiles.push({ file: path.basename(c.sprite), abs: path.join(SPRITE_DIR, path.basename(c.sprite)) })
        if (c.offlineSprite) {
          spriteFiles.push({ file: path.basename(c.offlineSprite), abs: path.join(SPRITE_DIR, path.basename(c.offlineSprite)) })
        }
      }
      for (const s of spriteFiles) {
        disposers.push(registerRoute({
          kind: 'exact',
          path: ROUTE_PREFIX + '/sprite/' + s.file,
          handler: (req, res) => {
            try {
              const bytes = fs.readFileSync(s.abs)
              res.writeHead(200, {
                'Content-Type': 'image/png',
                // 素材随包发布、内容不变：允许长缓存，省掉每次进页面重下 ~10MB
                'Cache-Control': 'public, max-age=86400',
                'Content-Length': String(bytes.length),
              })
              res.end(bytes)
            } catch (err) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('sprite unavailable: ' + String((err && err.message) || err))
            }
          },
        }))
      }

      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/hit.mp3',
        handler: (req, res) => {
          try {
            const bytes = fs.readFileSync(path.join(ASSET_DIR, 'hit.mp3'))
            res.writeHead(200, {
              'Content-Type': 'audio/mpeg',
              'Cache-Control': 'public, max-age=86400',
              'Content-Length': String(bytes.length),
            })
            res.end(bytes)
          } catch (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('audio unavailable: ' + String((err && err.message) || err))
          }
        },
      }))

      // —— 每轮消耗：前端据此弹「喜报」气泡 ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/turn.json',
        handler: (req, res) => {
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: true,
            seq: lastTurnSeq,
            turn: lastTurn ? lastTurn.turn : null,
            amount: lastTurn ? lastTurn.amount : null,
            tokens: lastTurn ? lastTurn.tokens : 0,
            ts: lastTurn ? lastTurn.ts : null,
            currency: 'CNY',
          }))
        },
      }))

      // —— 累计计费账本：GET 读，POST 改（开/关、结算）——
      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/ledger.json',
        handler: async (req, res) => {
          try {
            if (req.method === 'POST') {
              const raw = await readBody(req)
              let body = {}
              try { body = JSON.parse(raw || '{}') } catch (err) { body = {} }
              const action = String(body && body.action || '')
              if (action === 'settle') {
                res.writeHead(200, JSON_HEADERS)
                res.end(JSON.stringify(settleLedger()))
                return
              }
              if (action === 'enable' || action === 'disable') {
                res.writeHead(200, JSON_HEADERS)
                res.end(JSON.stringify(setBillingEnabled(action === 'enable')))
                return
              }
              res.writeHead(400, JSON_HEADERS)
              res.end(JSON.stringify({ ok: false, error: 'unknown action: ' + action }))
              return
            }
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify(ledgerPayload()))
          } catch (err) {
            res.writeHead(200, JSON_HEADERS)
            res.end(JSON.stringify({ ok: false, error: String((err && err.message) || err) }))
          }
        },
      }))

      // —— 结算页素材 ——
      // —— 网络自检：把每个「已配凭据」的来源真打一遍，报告通不通、多快、失败原因 ——
      // 存在的意义：Node 的 fetch 不走系统代理，境外来源在国内必然超时；
      // 与其让用户在各个来源之间瞎试，不如一次把结果全列出来（含代理环境变量状态）。
      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/selfcheck.json',
        handler: async (req, res) => {
          const started = Date.now()
          let sources = []
          try { sources = await listSources(ctx) } catch (err) { sources = [] }
          const results = await Promise.all(sources.map(async (s) => {
            const t0 = Date.now()
            let p
            try { p = await getBalance(s.id, true) } catch (err) {
              p = { ok: false, error: String((err && err.message) || err) }
            }
            const ms = Date.now() - t0
            const kind = (p && p.kind) || s.kind
            let value = ''
            if (p && p.ok) {
              value = kind === 'quota'
                ? ('剩余 ' + Math.round(Number(p.remainPercent)) + '%')
                : ((String(p.currency).toUpperCase() === 'USD' ? '$' : '¥') + Number(p.totalBalance).toFixed(2))
            }
            return {
              id: s.id,
              name: s.builtin ? 'DSH 余额（DeepSeek）' : s.name,
              kind, ok: !!(p && p.ok), ms, value,
              error: (p && !p.ok) ? String(p.error || p.code || '').slice(0, 240) : '',
            }
          }))
          // 通的排前面，各自按耗时升序
          results.sort((a, b) => (a.ok === b.ok) ? (a.ms - b.ms) : (a.ok ? -1 : 1))
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({
            ok: true,
            elapsed: Date.now() - started,
            proxy: {
              httpsProxy: !!(process.env.HTTPS_PROXY || process.env.https_proxy),
              nodeUseEnvProxy: String(process.env.NODE_USE_ENV_PROXY || '') === '1',
            },
            passed: results.filter((r) => r.ok).length,
            total: results.length,
            results,
          }))
        },
      }))

      // —— 许可证 / 第三方声明：随包分发，About 里直接链过去打开原文 ——
      // 白名单文件名，杜绝路径穿越
      const LICENSE_FILES = {
        'LICENSE.txt': { file: 'LICENSE', type: 'text/plain; charset=utf-8', root: PACKAGE_ROOT },
        'THIRD-PARTY-NOTICES.md': { file: 'THIRD-PARTY-NOTICES.md', type: 'text/markdown; charset=utf-8', root: PACKAGE_ROOT },
        'whale-LICENSE.txt': { file: 'DeepSeek-Balance-Whale-Widget-LICENSE.txt', type: 'text/plain; charset=utf-8', root: path.join(PACKAGE_ROOT, 'licenses') },
        'whale-PROVENANCE.md': { file: 'DeepSeek-Balance-Whale-Widget-PROVENANCE.md', type: 'text/markdown; charset=utf-8', root: path.join(PACKAGE_ROOT, 'licenses') },
      }
      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/license.txt',
        handler: (req, res) => {
          try {
            const u = new URL(req.url || '/', 'http://localhost')
            const want = String(u.searchParams.get('f') || 'LICENSE.txt')
            const spec = LICENSE_FILES[want]
            if (!spec) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('unknown license file: ' + want)
              return
            }
            const text = fs.readFileSync(path.join(spec.root, path.basename(spec.file)), 'utf8')
            res.writeHead(200, { 'Content-Type': spec.type, 'Cache-Control': 'no-store' })
            res.end(text)
          } catch (err) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            res.end('license unavailable: ' + String((err && err.message) || err))
          }
        },
      }))

      const staticFiles = [
        { path: '/certificate.png', file: 'certificate.png', type: 'image/png' },
        { path: '/sound/turn.mp3', file: 'congrats-turn.mp3', type: 'audio/mpeg' },
        { path: '/sound/settle.mp3', file: 'congrats-settle.mp3', type: 'audio/mpeg' },
      ]
      for (const s of staticFiles) {
        disposers.push(registerRoute({
          kind: 'exact',
          path: ROUTE_PREFIX + s.path,
          handler: (req, res) => {
            try {
              const bytes = fs.readFileSync(path.join(ASSET_DIR, path.basename(s.file)))
              res.writeHead(200, {
                'Content-Type': s.type,
                'Cache-Control': 'public, max-age=86400',
                'Content-Length': String(bytes.length),
              })
              res.end(bytes)
            } catch (err) {
              res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
              res.end('asset unavailable: ' + String((err && err.message) || err))
            }
          },
        }))
      }

      // —— 诊断：观察到的会话字段（用来收紧子代理判别）——
      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/sessions.json',
        handler: (req, res) => {
          const out = []
          for (const [id, v] of seenSessions) out.push({ id, sub: v.sub, why: v.why, keys: v.keys, at: v.at })
          res.writeHead(200, JSON_HEADERS)
          res.end(JSON.stringify({ ok: true, count: out.length, sessions: out }, null, 2))
        },
      }))

      // —— 节假日清单：GET 读（含过期状态），POST 导入 / 从 URL 拉取 / 恢复内置 ——
      disposers.push(registerRoute({
        kind: 'exact',
        path: ROUTE_PREFIX + '/holidays.json',
        handler: async (req, res) => {
          const send = (obj, code) => {
            res.writeHead(code || 200, JSON_HEADERS)
            res.end(JSON.stringify(obj))
          }
          try {
            if (req.method === 'POST') {
              const raw = await readBody(req)
              let body = {}
              try { body = JSON.parse(raw || '{}') } catch (err) { body = {} }
              const action = String((body && body.action) || '')
              if (action === 'reset') {
                clearImported()
                return send({ ok: true, status: staleness(), holidays: effectiveHolidays() })
              }
              if (action === 'import') {
                let payload = body.holidays
                let source = 'manual'
                if (body.url) {
                  try {
                    const r = await fetch(String(body.url), { signal: AbortSignal.timeout(15000) })
                    if (!r.ok) throw new Error('HTTP ' + r.status)
                    const text = await r.text()
                    if (text.length > 512 * 1024) throw new Error('内容过大（>512KB）')
                    payload = JSON.parse(text)
                    source = String(body.url).slice(0, 200)
                  } catch (err) {
                    return send({ ok: false, error: '从 URL 拉取失败: ' + String((err && err.message) || err) })
                  }
                }
                const p = parseHolidayInput(payload)
                if (!p.ok) return send({ ok: false, error: p.error })
                const saved = saveImported(p.holidays, source)
                if (!saved.ok) return send({ ok: false, error: saved.error })
                return send({
                  ok: true, imported: p.holidays.length, skipped: p.skipped || [],
                  status: staleness(), holidays: effectiveHolidays(),
                })
              }
              return send({ ok: false, error: 'unknown action: ' + action }, 400)
            }
            send({
              ok: true,
              status: staleness(),
              builtin: BUILTIN_HOLIDAYS,
              holidays: effectiveHolidays(),
              file: HOLIDAY_FILE,
            })
          } catch (err) {
            send({ ok: false, error: String((err && err.message) || err) })
          }
        },
      }))

      // Web 形态的注入通道（桌面壳走 index-inject，见 apply 开头）
      disposers.push(ctx.webServer.tapIndex((html) => {
        if (typeof html !== 'string' || html.indexOf(ROUTE_PREFIX + '/pet.js') !== -1) return html
        const tag = '<script defer src="' + ROUTE_PREFIX + '/pet.js"></script>'
        if (html.indexOf('</body>') !== -1) return html.replace('</body>', tag + '</body>')
        return html + tag
      }))

      ctx.effect(() => () => {
        for (const d of disposers) { try { d() } catch (err) {} }
      })
    })
  },
}
