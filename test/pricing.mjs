// ============================================================================
// dsh-balance-pet-extend —— 宿主计价单元测试
//
// 只测 lib/pricing.js 的纯函数（不启动 DSH）：
//   · 已知模型：priceFor 命中内置价表 → known: true
//   · 未收录 / 未知模型：落到 _default 兜底价 → known: false，但 token 照常统计
//   · 自定义单价：命中注册表 price → known: true
//
//   node test/pricing.mjs
// ============================================================================
import { costOfUsage, priceFor, buildCustomPrices } from '../lib/pricing.js'
import { normalizePriceModels, mergePriceModels, builtinPriceRows } from '../lib/prices.js'
import { pickBalanceInfo } from '../lib/providers.js'

let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '   [' + extra + ']' : '')) }
  else { fails.push(name); console.log('  FAIL  ' + name + (extra !== undefined ? '   [' + extra + ']' : '')) }
}

const at = Math.floor(Date.UTC(2026, 9, 20, 3, 0, 0) / 1000) // 避开峰谷差异的随意时间
const usage = { inputTokens: 1_000_000, cacheReadTokens: 500_000, outputTokens: 200_000 }
const expectedTokens = 1_700_000

console.log('=== 已知模型 ===')
const known = costOfUsage('deepseek-v4-flash', usage, { atSec: at })
ok('内置价表里的模型标记为 known', known.known === true, 'known=' + known.known)
ok('token 数 = input + cache + output', known.tokens === expectedTokens, known.tokens)
ok('已知模型算出正金额', known.cost > 0, known.cost)

const pro = costOfUsage('deepseek-v4-pro', usage, { atSec: at })
ok('deepseek-v4-pro 也命中价表', pro.known === true, 'known=' + pro.known)
ok('pro 单价高于 flash', pro.cost > known.cost, known.cost + ' → ' + pro.cost)

console.log('')
console.log('=== 未收录 / 未知模型 ===')
const unknown = costOfUsage('totally-unknown-model-xyz', usage, { atSec: at })
ok('未收录模型标记为 known:false', unknown.known === false, 'known=' + unknown.known)
ok('未收录模型仍统计 token', unknown.tokens === expectedTokens, unknown.tokens)
ok('未收录模型按默认价算出金额（不是 0）', unknown.cost > 0, unknown.cost)
const empty = costOfUsage('', usage, { atSec: at })
ok('模型名为空也按未收录处理', empty.known === false && empty.tokens === expectedTokens,
  'known=' + empty.known + ' tokens=' + empty.tokens)

console.log('')
console.log('=== 自定义单价 ===')
const custom = buildCustomPrices([
  { id: 'my-model', name: 'my-model', matchIds: ['my-model'], price: { hit: 1, miss: 2, out: 3 } },
])
const cm = costOfUsage('my-model-v2', usage, { atSec: at, custom: custom })
ok('自定义单价命中后 known:true', cm.known === true, 'known=' + cm.known)
ok('自定义单价按命中/未命中/输出分别计价', cm.cost > 0, cm.cost)
ok('priceFor 直接查询自定义键', priceFor('my-model-v2', custom).known === true)

console.log('')
console.log('=== 手动价格表：校验 / 合并 ===')
const norm = normalizePriceModels([
  { id: 'mystery', name: 'Mystery', matchIds: ['mystery'], price: { hit: 0.2, miss: 1.2, out: 6 } },
  { id: 'mystery', name: 'Mystery Updated', price: { miss: 2 } },
  { id: 'usd-model', price: { hit: 0.1, miss: 1, out: 3, cur: 'USD', rate: 7.2 } },
])
ok('合法条目通过', !norm.error && norm.models.length === 2, norm.error || norm.models.length)
ok('同 id 后一条覆盖前一条', norm.models[0].name === 'Mystery Updated', norm.models[0].name)
ok('缺省价格字段补 0', norm.models[0].price.hit === 0 && norm.models[0].price.out === 0,
  JSON.stringify(norm.models[0].price))
ok('USD 价格保留汇率', norm.models[1].price.cur === 'USD' && norm.models[1].price.rate === 7.2,
  JSON.stringify(norm.models[1].price))
ok('没有价格字段被拒绝', !!normalizePriceModels([{ id: 'no-price' }]).error)
ok('条目不是数组被拒绝', !!normalizePriceModels({ models: [] }).error)
const onlyMatch = normalizePriceModels([{ matchIds: 'only-mid', price: { miss: 1 } }])
ok('只给 matchIds（甚至字符串）也能导入', !onlyMatch.error && onlyMatch.models[0].id === 'only-mid' &&
  onlyMatch.models[0].matchIds[0] === 'only-mid', onlyMatch.error || JSON.stringify(onlyMatch.models[0]))

const merged = mergePriceModels(
  [{ id: 'mystery', name: 'Old', matchIds: ['mystery'], price: { hit: 0, miss: 1, out: 2 } }],
  [{ id: 'mystery-new', name: 'New', matchIds: ['mystery'], price: { hit: 0, miss: 2, out: 3 } }]
)
ok('同 matchId 的旧条目被更新', merged.models.length === 1 && merged.models[0].name === 'New' &&
  merged.updated === 1 && merged.added === 0, JSON.stringify({ n: merged.models.length, a: merged.added, u: merged.updated }))
const mergedAdd = mergePriceModels([], [{ id: 'x', name: 'X', matchIds: ['x'], price: { miss: 1 } }])
ok('新条目计为新增', mergedAdd.added === 1 && mergedAdd.updated === 0, JSON.stringify(mergedAdd))
const priceRows = builtinPriceRows()
ok('内置价目表可列出', priceRows.length >= 2 && priceRows.some((r) => r.name === 'deepseek-flash'),
  priceRows.map((r) => r.name).join(','))

console.log('')
console.log('=== DeepSeek balance_infos 选择 ===')
ok('第一条是 0 时选后面的正数',
  pickBalanceInfo([
    { currency: 'CNY', total_balance: '0.00' },
    { currency: 'CNY', total_balance: '4.07' },
  ]).total_balance === '4.07')
ok('优先 CNY 正数', pickBalanceInfo([
  { currency: 'USD', total_balance: '1.00' },
  { currency: 'CNY', total_balance: '2.00' },
]).total_balance === '2.00')
ok('全是 0 时回退到 CNY', pickBalanceInfo([
  { currency: 'USD', total_balance: '0' },
  { currency: 'CNY', total_balance: '0' },
]).currency === 'CNY')
ok('空数组返回 null', pickBalanceInfo([]) === null)

console.log('')
console.log('结果: ' + pass + ' 通过 / ' + fails.length + ' 失败')
if (fails.length) { console.log('失败项:'); fails.forEach((f) => console.log('  - ' + f)) }
process.exit(fails.length ? 1 : 0)
