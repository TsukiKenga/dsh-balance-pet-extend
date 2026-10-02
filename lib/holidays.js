// ============================================================================
// 法定节假日清单 —— 数据与代码分离，可导入、可检测过期
// ============================================================================
// 为什么仍然需要「一张表」：中国的法定节假日**放假安排**（哪天放、哪天调休上班）
// 是国务院每年 11 月前后以通知形式发布的**行政决定**，不是天文可推算量。
// 清明/端午/中秋等虽由历法确定日期，但「实际放哪几天、哪个周末补班」仍取决于通知。
// 所以没有任何算法能替代这张表 —— 能做的是把维护成本降到最低：
//   ① 数据落在 $DSH_HOME/.dshpet-holidays.json，改数据不用改代码、不用重装
//   ② 提供一键导入（粘贴 JSON / 从 URL 拉取），带校验
//   ③ 自动检测「已过期」与「该发下一年的通知了」，并在界面提示
//
// 生效集合 = 内置默认 ∪ 用户导入（并集，导入只会**增加**；要撤销用「恢复内置」清空文件）
// ============================================================================

import fs from 'node:fs'
import path from 'node:path'

const DSH_HOME = process.env.DSH_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '.', '.dsh')
export const HOLIDAY_FILE = path.join(DSH_HOME, '.dshpet-holidays.json')

// 内置默认：2026 年（与 dsh-whale-widget 同源）
export const BUILTIN_HOLIDAYS = [
  '2026-01-01', '2026-01-02', '2026-01-03',
  '2026-02-15', '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19',
  '2026-02-20', '2026-02-21', '2026-02-22', '2026-02-23',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19', '2026-06-20', '2026-06-21',
  '2026-09-25', '2026-09-26', '2026-09-27',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04',
  '2026-10-05', '2026-10-06', '2026-10-07',
]

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false
  const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10))
  if (m < 1 || m > 12 || d < 1 || d > 31) return false
  const dt = new Date(Date.UTC(y, m - 1, d))
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d
}

// 接受多种输入形态：
//   ["2027-01-01", ...]
//   { holidays: [...] }
//   { years: { "2027": [...] } }
//   "2027-01-01\n2027-01-02"（文本框里一行一个，允许逗号/空格分隔）
export function parseHolidayInput(input) {
  try {
    let arr = null
    if (Array.isArray(input)) arr = input
    else if (input && typeof input === 'object') {
      if (Array.isArray(input.holidays)) arr = input.holidays
      else if (input.years && typeof input.years === 'object') {
        arr = []
        for (const y of Object.keys(input.years)) {
          const v = input.years[y]
          if (Array.isArray(v)) for (const d of v) arr.push(String(d))
        }
      }
    } else if (typeof input === 'string') {
      arr = input.split(/[\s,;]+/).filter(Boolean)
    }
    if (!arr) return { ok: false, error: '无法识别的格式：需要日期数组、{holidays:[…]}、{years:{…}} 或一行一个的文本' }
    const out = []
    const bad = []
    for (const raw of arr) {
      const s = String(raw).trim()
      if (!s) continue
      if (!isValidDate(s)) { bad.push(s); continue }
      if (out.indexOf(s) < 0) out.push(s)
    }
    if (out.length === 0) return { ok: false, error: '没有解析出任何合法日期（需要 YYYY-MM-DD）' + (bad.length ? '；无法识别的样例: ' + bad.slice(0, 3).join(', ') : '') }
    out.sort()
    return { ok: true, holidays: out, skipped: bad }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

function readFile() {
  try {
    const j = JSON.parse(fs.readFileSync(HOLIDAY_FILE, 'utf8'))
    const p = parseHolidayInput(j && (j.holidays || j))
    if (p.ok) return { holidays: p.holidays, meta: j || {} }
  } catch (err) { /* 没有文件或坏了 → 只用内置 */ }
  return { holidays: [], meta: {} }
}

// 生效集合：内置 ∪ 文件
export function effectiveHolidays() {
  const f = readFile()
  const set = {}
  for (const d of BUILTIN_HOLIDAYS) set[d] = 1
  for (const d of f.holidays) set[d] = 1
  return Object.keys(set).sort()
}

export function holidaySet() {
  const set = {}
  for (const d of effectiveHolidays()) set[d] = 1
  return set
}

export function importedCount() { return readFile().holidays.length }

export function saveImported(holidays, source) {
  const body = {
    version: 1,
    updatedAt: new Date().toISOString(),
    source: String(source || 'manual').slice(0, 200),
    holidays: holidays.slice().sort(),
  }
  try {
    fs.writeFileSync(HOLIDAY_FILE, JSON.stringify(body, null, 2), 'utf8')
    return { ok: true, count: body.holidays.length }
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

export function clearImported() {
  try { fs.rmSync(HOLIDAY_FILE, { force: true }); return { ok: true } } catch (err) {
    return { ok: false, error: String((err && err.message) || err) }
  }
}

// 北京时间的「现在」：年 / 月
function beijingNow(nowMs) {
  const d = new Date((nowMs === undefined ? Date.now() : nowMs) + 8 * 3600 * 1000)
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1 }
}

// 过期检测：
//   stale  —— 当前年份根本没有覆盖（已经在按峰价错算了）
//   warn   —— 当年已覆盖，但已到 11 月而次年没有 → 该去导入了
//   ok     —— 次年已有数据或还没到提示时点
export function staleness(nowMs) {
  const hol = effectiveHolidays()
  const years = {}
  for (const d of hol) years[d.slice(0, 4)] = 1
  const covered = Object.keys(years).map(Number).sort((a, b) => a - b)
  const maxYear = covered.length ? covered[covered.length - 1] : 0
  const { year, month } = beijingNow(nowMs)
  const curCovered = !!years[String(year)]
  const nextCovered = !!years[String(year + 1)]
  let level = 'ok'
  let message = ''
  if (!curCovered) {
    level = 'stale'
    message = '节假日清单没有覆盖 ' + year + ' 年 —— 今年的法定节假日会被按峰价计价，请导入新清单'
  } else if (!nextCovered && month >= 11) {
    level = 'warn'
    message = '已是 ' + month + ' 月，' + (year + 1) + ' 年的放假安排通常已发布，清单里还没有 —— 建议导入'
  }
  return {
    level, message, curYear: year, month,
    maxYear, coveredYears: covered,
    curCovered, nextCovered,
    builtinCount: BUILTIN_HOLIDAYS.length,
    importedCount: importedCount(),
    total: hol.length,
    file: HOLIDAY_FILE,
  }
}
