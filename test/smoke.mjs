// ============================================================================
// dsh-balance-pet-extend —— 前端冒烟测试
//
// 在最小 DOM / Canvas / 虚拟时钟里**真跑** assets/pet.js，然后通过右键菜单
// 与弹层去验证行为。不需要启动 DSH，也不需要浏览器。
//
//   node test/smoke.mjs
// ============================================================================
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = fs.readFileSync(path.join(here, '..', 'assets', 'pet.js'), 'utf8')

// ---------------------------------------------------------------- 断言 -----
let pass = 0
const fails = []
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS  ' + name + (extra !== undefined ? '   [' + extra + ']' : '')) }
  else { fails.push(name); console.log('  FAIL  ' + name + (extra !== undefined ? '   [' + extra + ']' : '')) }
}
function eq(name, got, want) { ok(name, got === want, 'got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want)) }

// ------------------------------------------------------------ DOM 桩 ------
class El {
  constructor(tag) {
    this.tagName = String(tag || 'div').toLowerCase()
    this.children = []
    this.parentNode = null
    this.style = {}
    this._text = ''
    this._h = {}
    this._attr = {}
    this.className = ''
    this.id = ''
    this.value = ''
    this.checked = false
    this.disabled = false
  }
  get textContent() {
    if (this.children.length === 0) return this._text
    return this._text + this.children.map((c) => c.textContent).join('')
  }
  set textContent(v) { this._text = String(v); this.children = [] }
  set innerHTML(v) { this._text = ''; this.children = [] }
  get innerHTML() { return '' }
  appendChild(c) { c.parentNode = this; this.children.push(c); return c }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parentNode = null; return c }
  insertBefore(c) { return this.appendChild(c) }
  setAttribute(k, v) { this._attr[k] = String(v) }
  getAttribute(k) { return this._attr[k] === undefined ? null : this._attr[k] }
  removeAttribute(k) { delete this._attr[k] }
  addEventListener(t, f) { (this._h[t] = this._h[t] || []).push(f) }
  removeEventListener(t, f) { const a = this._h[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1) }
  fire(type, props) {
    const ev = Object.assign({
      type, target: this, preventDefault() {}, stopPropagation() {},
      button: 0, clientX: 30, clientY: 30, key: '',
    }, props || {})
    for (const f of (this._h[type] || []).slice()) { try { f.call(this, ev) } catch (e) { runtimeErrors.push(String(e && e.message || e)) } }
    return ev
  }
  getBoundingClientRect() { return { width: 200, height: 260, left: 10, top: 10, right: 210, bottom: 270 } }
  focus() {} select() {} blur() {}
  getContext() {
    // 建掩码用的离屏 canvas 会**先设好 width/height 再取 context**；
    // 挂件画布与覆盖层画布在取 context 时都还是 0。
    // 用这个把掩码那块区分开 —— 否则它那次 384x256 的 drawImage 会混进 DRAWS，
    // 让「立绘画在哪」的判断失真。
    if (this.width > 0 && this.height > 0) return makeCtx(false)
    return makeCtx(true)
  }
  querySelector(sel) { return this._qs && this._qs[sel] ? {} : null }
  querySelectorAll() { return [] }
  get firstChild() { return this.children[0] || null }
  contains(n) { return n === this }
}
function makeCtx(record = true) {
  const store = {}
  return new Proxy(store, {
    get(t, k) {
      if (k in t) return t[k]
      // 记录每帧画的是哪张立绘 —— 表情切换只能靠这个观察
      if (k === 'drawImage') {
        if (!record) return () => {}
        return function () {
          var img = arguments[0]
          var src = img && img.src ? String(img.src) : ''
          DRAWS.push({ src: src, x: arguments[1], y: arguments[2], w: arguments[3], h: arguments[4] })
          if (src && drawnSrcs[drawnSrcs.length - 1] !== src) drawnSrcs.push(src)
        }
      }
      if (k === 'measureText') return () => ({ width: 40 })
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => ({ addColorStop() {} })
      // 掩码：贴近真实立绘的分布 ——
      //   上方 20% 只有「头」（偏右，x 0.56..0.80）
      //   其余是身体与尾鳍（很宽，x 0.03..0.95）
      // 这样 hitTest（点身体开菜单）与 computeHeadAnchor（量头顶）都能测到真东西。
      if (k === 'getImageData') {
        return (x, y, w, h) => {
          const d = new Uint8ClampedArray(w * h * 4)
          for (let yy = 0; yy < h; yy++) {
            const ny = yy / h
            const lo = ny < 0.20 ? 0.56 : 0.03
            const hi = ny < 0.20 ? 0.80 : 0.95
            for (let xx = 0; xx < w; xx++) {
              const nx = xx / w
              d[(yy * w + xx) * 4 + 3] = (nx >= lo && nx <= hi) ? 255 : 0
            }
          }
          return { data: d }
        }
      }
      return () => {}
    },
    set(t, k, v) { t[k] = v; return true },
  })
}

const runtimeErrors = []
const timers = []       // setTimeout 队列（不推进虚拟时钟）
const rafTimers = []    // requestAnimationFrame 队列（每执行一帧推进虚拟时钟）
const drawnSrcs = []    // 依序记录被绘制的立绘 src
const EXPR_REQ = []     // 请求过的表情图
const EXPR_OK = []      // 加载成功的表情图
const ALL_IMG = []      // 所有被请求的图片 src
const DRAWS = []        // 每帧 drawImage 的参数（用来观察盆的位置）
const AUDIO_PLAYED = []  // 实际被 play() 的音效源（观察音效）
const LOGS = []         // 插件内部 console 输出（调试用）
let vnow = 0            // 虚拟时钟（毫秒）
function makeEnv() {
  const documentEl = new El('html')
  const head = new El('head')
  const body = new El('body')
  // isChatRoot 需要能在某个根上找到输入框
  const root = new El('div')
  root.id = 'root'
  root._qs = { textarea: {} }
  body._qs = { textarea: {} }
  documentEl._qs = { textarea: {} }
  documentEl.appendChild(head); documentEl.appendChild(body); documentEl.appendChild(root)

  const byId = { root }
  const doc = {
    documentElement: documentEl, head, body,
    createElement: (t) => { const e = new El(t); if (t === 'canvas') e.width = 0; e.height = 0; return e },
    getElementById: (id) => byId[id] || null,
    addEventListener(t, f) { (doc._h[t] = doc._h[t] || []).push(f) },
    removeEventListener(t, f) { const a = doc._h[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1) },
    _h: {},
    fire(type, props) {
      const ev = Object.assign({ type, target: documentEl, preventDefault() {}, stopPropagation() {}, button: 2, clientX: 40, clientY: 40, key: '' }, props || {})
      for (const f of (doc._h[type] || []).slice()) { try { f.call(doc, ev) } catch (e) { runtimeErrors.push(String(e && e.message || e)) } }
      return ev
    },
    querySelector: () => null,
  }

  const store = {}
  const localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v) },
    removeItem: (k) => { delete store[k] },
  }

  const manifest = {
    ok: true, sprite: { w: 1536, h: 1024 }, panel: { w: 400, h: 220 },
    sizes: [110, 150, 210, 280], defaultSize: 150, defaultCharacter: 'fish',
    holiday: { level: 'ok', message: '', coveredYears: [2026], maxYear: 2026, curYear: 2026, builtinCount: 33, importedCount: 0, total: 33 },
    about: {
      name: 'DSH Balance Pet Enhanced', pkgName: 'dsh-balance-pet-extend', version: '1.5.0',
      buildTime: '2026-10-04T02:00:00.000Z',
      repo: { label: 'GitHub', url: 'https://github.com/TsukiKenga/dsh-balance-pet-extend' },
      author: { role: '分支维护者', name: 'TsukiKenga', url: 'https://github.com/TsukiKenga' },
      selfLicense: { label: 'MIT', url: '/dsh-pet/license.txt?f=LICENSE.txt' },
      notices: { label: '第三方来源与许可', url: '/dsh-pet/license.txt?f=THIRD-PARTY-NOTICES.txt' },
      references: [
        { name: 'VK-1', url: 'https://github.com/VKmich16/VK-1', by: 'VKmich', note: '原型', licenseLabel: '上游暂未附许可证', licenseUrl: null },
        { name: 'DeepSeek-Balance-Whale-Widget', url: 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget', by: 'MeteorNOX', license: 'MIT', note: '参考', licenseLabel: 'MIT 许可证原文', licenseUrl: '/dsh-pet/license.txt?f=whale-LICENSE.txt', provenanceUrl: '/dsh-pet/license.txt?f=whale-PROVENANCE.txt' },
      ],
    },
    characters: [
      { id: 'fish', name: '蓝色大肥鱼', sprite: 'fish.png', offlineSprite: 'fish-offline.png', tablet: { tl: [1060, 699], tr: [1413, 644], bl: [1090, 889] } },
      { id: 'gpt', name: 'GPT龙娘', sprite: 'gpt.png', offlineSprite: null, tablet: { tl: [1060, 699], tr: [1413, 644], bl: [1090, 889] } },
      { id: 'kimi', name: '白月光Kimi', sprite: 'kimi.png', offlineSprite: null, tablet: { tl: [1048, 690], tr: [1426, 648], bl: [1070, 884] } },
    ],
  }
  const sources = {
    ok: true, default: 'deepseek',
    sources: [
      { id: 'deepseek', name: 'DeepSeek', currency: 'CNY', kind: 'balance', builtin: true, hasKey: true },
      { id: 'stepfun', name: '阶跃星辰 StepFun', currency: 'CNY', kind: 'balance', provider: 'stepfun', hasKey: true, keyRef: 'STEPFUN_API_KEY' },
      { id: 'zhipu_glm_coding', name: '智谱 GLM Coding Plan（订阅）', currency: 'CNY', kind: 'quota', provider: 'zhipu_glm_coding', hasKey: true, keyRef: 'ZHIPU_API_KEY' },
    ],
  }
  const fetchStub = (url) => {
    const u = String(url)
    let body = {}
    if (u.includes('manifest.json')) body = manifest
    else if (u.includes('sources.json')) body = sources
    else if (u.includes('turn.json')) body = { ok: true, seq: 0 }
    else if (u.includes('ledger.json')) body = { ok: true, enabled: true, since: null, models: {}, total: 0 }
    else if (u.includes('balance.json')) body = { ok: true, source: 'deepseek', kind: 'balance', currency: 'CNY', totalBalance: 12.34, at: Date.now() }
    else if (u.includes('holidays.json')) body = { ok: true, status: 'ok', holidays: [] }
    return Promise.resolve({
      ok: true, status: 200, headers: { get: () => null },
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
    })
  }

  const win = {
    innerWidth: 1440, innerHeight: 900,
    addEventListener(t, f) { (win._h[t] = win._h[t] || []).push(f) },
    removeEventListener(t, f) { const a = win._h[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1) },
    _h: {}, devicePixelRatio: 1,
    fire(type, props) {
      const ev = Object.assign({ type, target: win, preventDefault() {}, stopPropagation() {}, button: 0, clientX: 40, clientY: 40, key: '' }, props || {})
      for (const f of (win._h[type] || []).slice()) { try { f.call(win, ev) } catch (e) { runtimeErrors.push(String(e && e.message || e)) } }
      return ev
    },
  }

  const ctxObj = {
    document: doc, window: win, localStorage,
    fetch: fetchStub,
    Image: class {
      constructor() { this.onload = null; this.onerror = null; this._src = ''; this.width = 0; this.height = 0 }
      get src() { return this._src }
      set src(v) {
        this._src = String(v)
        // 尺寸要跟真实一致。**表情立绘已改为 1536x1024（1.5:1）**，与角色立绘同比例。
        if (this._src.includes('/expr/')) { this.width = 1536; this.height = 1024 }
        else if (this._src.includes('/sprites/') || this._src.includes('/sprite/')) { this.width = 1536; this.height = 1024 }
        else { this.width = 256; this.height = 256 }
        const self = this
        const isExpr = this._src.includes('/expr/')
        ALL_IMG.push(this._src)
        if (isExpr) EXPR_REQ.push(this._src)
        timers.push(() => {
          if (isExpr) EXPR_OK.push(this._src)
          if (self.onload) self.onload()
        })
      }
    },
    Audio: class {
      constructor(src) {
        this.src = String(src || '')
        this.volume = 1; this.currentTime = 0; this.preload = ''
      }
      // 记录 **play()** 而不是构造：插件把音效对象缓存复用（`if (!feedSound) ...`），
      // 所以「又响了一次」并不会再 new 一个 Audio。测构造会漏掉后续每一次播放。
      play() { AUDIO_PLAYED.push(this.src); return Promise.resolve() }
      pause() {}
    },
    MutationObserver: class { constructor() {} observe() {} disconnect() {} },
    // 每跑一帧推进 ~16.7ms，让 tick(dt) 拿到可控的 dt
    requestAnimationFrame: (f) => { rafTimers.push(f); return rafTimers.length },
    cancelAnimationFrame: () => {},
    setTimeout: (f) => { timers.push(f); return timers.length },
    clearTimeout: () => {},
    setInterval: () => 0, clearInterval: () => {},
    console: { log(...a) { LOGS.push(a.map(String).join(' ')) }, warn(...a) { LOGS.push(a.map(String).join(' ')) }, error(...a) { LOGS.push(a.map(String).join(' ')) } },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error, Promise, RegExp,
    isFinite, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    Uint8ClampedArray, Float64Array, Map, Set, Symbol,
  }
  ctxObj.globalThis = ctxObj
  ctxObj.self = ctxObj
  return { ctxObj, doc, win, byId, store }
}

async function flush(n = 40) {
  for (let i = 0; i < n; i++) {
    await Promise.resolve()
    const q = timers.splice(0, timers.length)
    for (const f of q) { try { f() } catch (e) { runtimeErrors.push(String(e && e.message || e)) } }
    const r = rafTimers.splice(0, rafTimers.length)
    for (const f of r) { vnow += 16.7; try { f(vnow) } catch (e) { runtimeErrors.push(String(e && e.message || e)) } }
  }
}
// 推进虚拟时间：按 16.7ms 一帧换算成帧数
async function advance(seconds) {
  const frames = Math.ceil(seconds / 0.0167)
  for (let i = 0; i < frames; i++) {
    await Promise.resolve()
    const q = timers.splice(0, timers.length)
    for (const f of q) { try { f() } catch (e) { runtimeErrors.push(String(e && e.message || e)) } }
    const r = rafTimers.splice(0, rafTimers.length)
    for (const f of r) { vnow += 16.7; try { f(vnow) } catch (e) { runtimeErrors.push(String(e && e.message || e)) } }
  }
}

// ------------------------------------------------------------ 工具 --------
function rowsOf(menuRoot) { return menuRoot.children.filter((c) => c.className === 'dshpet-mi') }
function rowBy(menuRoot, text) { return rowsOf(menuRoot).filter((r) => r.textContent.includes(text))[0] || null }
function click(el) {
  if (!el) { runtimeErrors.push('click on missing element'); return }
  el.fire('click', {})
}

console.log('########## 前端冒烟测试 (smoke.mjs) ##########')
const { ctxObj, doc, win, byId } = makeEnv()
vm.createContext(ctxObj)
vm.runInContext(SRC, ctxObj, { filename: 'pet.js' })
await flush()
ok('pet.js 能在最小 DOM 里跑起来（无致命错误）', runtimeErrors.length === 0, runtimeErrors.slice(0, 3).join(' | '))

const menuRoot = (byId['dshpet-menu']) || doc.body.children.filter((c) => c.id === 'dshpet-menu')[0]
ok('菜单容器已创建', !!menuRoot)

async function openMenu() {
  // 容器桩的 rect 是 left:10/top:10。点到哪一格取决于当前尺寸（自定义尺寸会把角色撑大），
  // 所以依次试几个纵向位置，哪个能弹出菜单就用哪个。
  var pts = [[122, 173], [122, 130], [122, 210], [122, 90], [122, 250]]
  for (var i = 0; i < pts.length; i++) {
    doc.fire('contextmenu', { button: 2, clientX: pts[i][0], clientY: pts[i][1] })
    await flush(6)
    if (rowsOf(menuRoot).length) return
  }
}
function mainRows() { return rowsOf(menuRoot).map((r) => r.textContent) }

console.log('')
console.log('=== 一期：菜单结构 ===')
await openMenu()
const main = mainRows()
ok('菜单已展开', main.length > 5, main.length + ' 项')
ok('有「尺寸 ▸」', main.some((s) => s.includes('尺寸')))
ok('有「外观 ▸」', main.some((s) => s.includes('外观')))
ok('有「声音 ▸」', main.some((s) => s.includes('声音')))

console.log('')
console.log('=== 一期：尺寸（杯命名 + px + cm）===')
click(rowBy(menuRoot, '尺寸'))
await flush(6)
const sizeRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('有 小杯/中杯/大杯/超大杯', ['小杯', '中杯', '大杯', '超大杯'].every((n) => sizeRows.some((s) => s.includes(n))), sizeRows.join(' | '))
ok('带 px 标注', sizeRows.some((s) => /110 px/.test(s)))
ok('带 cm 估算', sizeRows.some((s) => /≈ [\d.]+ cm/.test(s)), sizeRows.filter((s) => s.includes('≈'))[0])
ok('有分隔线', menuRoot.children.some((c) => c.className === 'dshpet-msep'))
ok('有「自定义尺寸…」', !!rowBy(menuRoot, '自定义尺寸'))

console.log('')
console.log('=== 一期：自定义尺寸（校验 + 生效）===')
click(rowBy(menuRoot, '自定义尺寸'))
await flush(6)
const sizePrompt = doc.body.children.filter((c) => c.id === 'dshpet-prompt')[0]
ok('自定义尺寸弹层已打开', !!sizePrompt)
const sizeBox = sizePrompt && sizePrompt.children[0]
const sizeInp = sizeBox && sizeBox.children.filter((c) => c.className === 'dshpet-prompt-row')[0].children[0]
const sizeMsg = sizeBox && sizeBox.children.filter((c) => c.className.indexOf('dshpet-hol-msg') === 0)[0]
const sizeOkBtn = sizeBox && sizeBox.children.filter((c) => c.className.indexOf('dshpet-hol-actions') >= 0)[0].children[0]
sizeInp.value = '9999'
click(sizeOkBtn); await flush(4)
ok('超范围被拒绝且弹层保留', !!sizeMsg.textContent && doc.body.children.some((c) => c.id === 'dshpet-prompt'), sizeMsg.textContent)
sizeInp.value = '160'
click(sizeOkBtn); await flush(4)
ok('合法值被接受并关闭弹层', !doc.body.children.some((c) => c.id === 'dshpet-prompt'))

console.log('')
console.log('=== 一期：外观（浅色 / 深色）===')
await openMenu()
click(rowBy(menuRoot, '外观'))
await flush(6)
const themeRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('有「浅色」', themeRows.some((s) => s.includes('浅色')))
ok('有「深色（DSH 风格）」', themeRows.some((s) => s.includes('深色')))
click(rowBy(menuRoot, '深色'))
await flush(6)
await openMenu()
eq('选深色后菜单加上 is-dark', menuRoot.className, 'is-dark')
click(rowBy(menuRoot, '外观')); await flush(6)
click(rowBy(menuRoot, '浅色')); await flush(6)
await openMenu()
eq('切回浅色后去掉 is-dark', menuRoot.className, '')

console.log('')
console.log('=== 一期：声音（档位 + 0% 即静音）===')
await openMenu()
click(rowBy(menuRoot, '声音'))
await flush(6)
const soundRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('有音量分组标题', menuRoot.children.some((c) => c.className === 'dshpet-mhead'), menuRoot.children.filter((c) => c.className === 'dshpet-mhead').map((c) => c.textContent).join(','))
ok('有 5 个档位（含 0% 静音）', soundRows.some((s) => s.includes('0%（静音）')) && soundRows.some((s) => s.includes('100 %')), soundRows.join(' | '))
ok('有「自定义音量…」', !!rowBy(menuRoot, '自定义音量'))
click(rowBy(menuRoot, '0%（静音）'))
await flush(6)
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
ok('选 0% 后「开启声音」不再打勾', !rowsOf(menuRoot).some((r) => r.textContent.includes('✓ 开启声音')), rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
click(rowBy(menuRoot, '75 %')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
ok('选 75% 后打勾落在 75%', rowsOf(menuRoot).some((r) => r.textContent.includes('✓ 75 %')), rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
ok('选 75% 后「开启声音」恢复打勾', rowsOf(menuRoot).some((r) => r.textContent.includes('✓ 开启声音')))

console.log('')
console.log('=== 回归：原有功能没被改坏 ===')
await openMenu()
const main2 = mainRows()
for (const label of ['切换角色', '余额来源', '累计计费', '结束计费并结算', '节假日清单', '刷新间隔', '立即刷新余额', '网络自检', '关于']) {
  ok('菜单仍有「' + label + '」', main2.some((s) => s.includes(label)))
}

console.log('')
console.log('=== 中文编码 ===')
const allText = menuRoot.textContent
ok('菜单中文正常（无替换字符）', !/\uFFFD/.test(allText) && /中杯/.test(sizeRows.join('')), sizeRows[0])

console.log('')
console.log('=== 二期：表情系统 ===')
ok('四张表情立绘被请求加载', EXPR_REQ.length === 4, EXPR_REQ.map((s) => s.split('/').pop()).join(','))
ok('四张全部加载成功', EXPR_OK.length === 4, EXPR_OK.length + '/4')
ok('当前画的是表情图（不是单张 sprite.png）', drawnSrcs.some((s) => s.includes('/expr/')), drawnSrcs.slice(-3).join(' | '))

// 触发一次扣费 → 应当切到「紧张」(expression_22)
drawnSrcs.length = 0
await openMenu()
click(rowBy(menuRoot, '测试一次扣费'))
await advance(0.2)
ok('扣费动画期间切到紧张表情（expression_22）', drawnSrcs.some((s) => s.includes('expression_22')), drawnSrcs.slice(-2).join(' | '))

// 等过保持时长（上游 NervousHoldSec = 1.0s）后回到常态。
// 注意要先清空再推进：表情回落后帧循环就停了，之后再推进也不会有新的一帧。
drawnSrcs.length = 0
await advance(1.6)
ok('保持时长过后回到常态表情（expression_11）', drawnSrcs.some((s) => s.includes('expression_11')), drawnSrcs.join(' | '))

// 切到没有表情立绘的角色 → 应当退回单张立绘
drawnSrcs.length = 0
await openMenu()
click(rowBy(menuRoot, '切换角色'))
await flush(6)
const gptRow = rowBy(menuRoot, 'GPT龙娘')
if (gptRow) { click(gptRow); await flush(10) }
await advance(0.2)
ok('切到 GPT龙娘后不再使用表情图', !drawnSrcs.some((s) => s.includes('/expr/')), drawnSrcs.slice(-2).join(' | '))
ok('切到 GPT龙娘后画的仍是 gpt.png', drawnSrcs.some((s) => s.includes('gpt.png')), drawnSrcs.slice(-2).join(' | '))

// 新角色 Kimi：应当出现在菜单里，能切过去，且**不进表情模式**（她没有表情立绘）。
// 注意：切换角色后 draw() 只在加载完成时触发一次，所以要在点之前清空记录、点之后立刻断言 ——
// 切换后帧循环不再跑，再 advance 也不会有新的绘制。
drawnSrcs.length = 0
await openMenu()
click(rowBy(menuRoot, '切换角色'))
await flush(6)
const kimiRow = rowBy(menuRoot, '白月光Kimi')
ok('角色菜单里有「白月光Kimi」', !!kimiRow, rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
if (kimiRow) { click(kimiRow); await flush(14) }
ok('切到 Kimi 后画的是 kimi.png', drawnSrcs.some((s) => s.includes('kimi.png')), drawnSrcs.join(' | '))
ok('Kimi 不使用表情图（她没有表情立绘）', !drawnSrcs.some((s) => s.includes('/expr/')), drawnSrcs.join(' | '))
// 切回大肥鱼，后面的用例还要用她
await openMenu()
click(rowBy(menuRoot, '切换角色'))
await flush(6)
const backFish = rowBy(menuRoot, '蓝色大肥鱼')
if (backFish) { click(backFish); await flush(14) }

// 立绘不能被拉长：绘制时必须按**原图宽高比**等比缩放。
// 表情立绘现在是 1536x1024（1.5:1），与角色立绘同比例；而 spriteRect 也是 1.5:1，
// 所以两者都应画成 1.5。若哪天又换成正方形图，这条会立刻抓到。
const exprDraw = DRAWS.filter((d) => d.src.includes('/expr/'))[0]
const spriteDraw = DRAWS.filter((d) => d.src.includes('/sprite/'))[0]
if (exprDraw) {
  const ratio = exprDraw.w / exprDraw.h
  ok('表情立绘按原图比例绘制（1.5:1，没被拉伸）', Math.abs(ratio - 1.5) < 0.03,
    Math.round(exprDraw.w) + 'x' + Math.round(exprDraw.h) + ' → ' + ratio.toFixed(3))
} else {
  ok('表情立绘按原图比例绘制（1.5:1，没被拉伸）', false, '没记录到表情绘制')
}
if (spriteDraw) {
  const ratio = spriteDraw.w / spriteDraw.h
  ok('普通立绘仍是 1.5:1（这个修复不影响它）', Math.abs(ratio - 1.5) < 0.03,
    Math.round(spriteDraw.w) + 'x' + Math.round(spriteDraw.h) + ' → ' + ratio.toFixed(3))
} else {
  ok('普通立绘仍是 1.5:1（这个修复不影响它）', false, '没记录到立绘绘制')
}

console.log('')
console.log('=== 三期：米饭盆充值玩法 ===')
// 先把角色切回大肥鱼（二期末尾切到了 GPT龙娘）
await openMenu()
click(rowBy(menuRoot, '切换角色'))
await flush(6)
const fishRow = rowBy(menuRoot, '蓝色大肥鱼')
if (fishRow) { click(fishRow); await flush(14) }

function lastRiceCenter() {
  // 盆画在窗口级覆盖层上，用的是**视口坐标**，所以 drawImage 的中心就是点击点。
  const d = DRAWS.filter((x) => x.src.includes('rice.png')).slice(-1)[0]
  return d ? { x: d.x + d.w / 2, y: d.y + d.h / 2 } : null
}
function spawnOne() {
  return openMenu().then(() => { click(rowBy(menuRoot, '测试充值')) })
}

ok('存在窗口级覆盖层 #dshpet-rice', doc.body.children.some((c) => c.id === 'dshpet-rice'))

// ① 掉盆 + 重力
DRAWS.length = 0
await spawnOne()
await advance(0.15)
const ys = DRAWS.filter((d) => d.src.includes('rice.png')).map((d) => d.y)
ok('掉下来一个米饭盆（有画 rice.png）', ys.length > 0, ys.length + ' 帧')
ok('盆在重力作用下下落（y 递增）', ys.length >= 2 && ys[ys.length - 1] > ys[0],
  ys.slice(0, 5).map((v) => Math.round(v)).join(' → '))

// ② 落定在**窗口底部**（不再是挂件画布底部）
await advance(3.0)
DRAWS.length = 0
await advance(0.4)
const ys2 = DRAWS.filter((d) => d.src.includes('rice.png')).map((d) => d.y)
ok('落定后位置不再变化（停住）', ys2.length >= 2 && Math.abs(ys2[ys2.length - 1] - ys2[0]) < 2,
  ys2.length ? (Math.round(ys2[0]) + ' → ' + Math.round(ys2[ys2.length - 1])) : '(无帧)')
const settled = DRAWS.filter((d) => d.src.includes('rice.png')).slice(-1)[0]
if (settled) {
  const bottom = settled.y + settled.h
  ok('盆落在整个窗口的底部（视口坐标）', Math.abs(bottom - win.innerHeight) <= 8,
    '底边 y=' + Math.round(bottom) + '  窗口高=' + win.innerHeight)
} else {
  ok('盆落在整个窗口的底部（视口坐标）', false, '没记录到盆的绘制')
}

// ③ 落点铺满整个窗口宽度：连掉几次，横向范围要够宽（而不是挤在挂件那一小块里）
const xs = []
for (let i = 0; i < 6; i++) {
  // 先把场上的盆清掉（投喂），再掉下一个
  const c0 = lastRiceCenter()
  if (c0) { doc.fire('pointerdown', { button: 0, clientX: c0.x, clientY: c0.y }); await flush(4) }
  await advance(0.7)                  // 等它淡出
  DRAWS.length = 0
  await spawnOne()
  await advance(0.1)
  const d = DRAWS.filter((x) => x.src.includes('rice.png'))[0]
  if (d) xs.push(d.x + d.w / 2)
  await advance(0.2)
}
if (xs.length >= 3) {
  const span = Math.max(...xs) - Math.min(...xs)
  ok('落点散布在整个窗口宽度内（不局限于挂件）', span > win.innerWidth * 0.35,
    'span=' + Math.round(span) + 'px  of ' + win.innerWidth + 'px   落点=' + xs.map((v) => Math.round(v)).join(','))
  ok('落点都落在窗口内', xs.every((v) => v >= 0 && v <= win.innerWidth), xs.map((v) => Math.round(v)).join(','))
} else {
  ok('落点散布在整个窗口宽度内（不局限于挂件）', false, '只取到 ' + xs.length + ' 个落点')
  ok('落点都落在窗口内', false, '样本不足')
}

// ④ 放着不管 → 10 秒后翻脸（ALOOF）
DRAWS.length = 0
await advance(11.0)         // 超过上游 BowlWaitSec = 10s
ok('盆放着不接，10 秒后切到冷淡表情（expression_12）', DRAWS.some((d) => d.src.includes('expression_12')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))

// ④ 点盆投喂（点中心）—— 也顺便清掉场上的盆
const c = lastRiceCenter()
AUDIO_PLAYED.length = 0
if (c) {
  doc.fire('pointerdown', { button: 0, clientX: c.x, clientY: c.y })
  await flush(6)
}
ok('点盆会播放 feed.mp3', AUDIO_PLAYED.some((s) => s.includes('feed.mp3')), AUDIO_PLAYED.join(',') || '(无音效)')

// ⑤ 投喂后掉铁锅 → 平静表情
DRAWS.length = 0
await advance(3.5)
const ironDrawn = DRAWS.some((d) => d.src.includes('iron_bowl.png'))
ok('投喂后掉下铁锅（画了 iron_bowl.png）', ironDrawn, ironDrawn ? '有' : '无')
ok('铁锅扣头时切到平静表情（expression_21）', DRAWS.some((d) => d.src.includes('expression_21')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))

// 【关键回归】锅要扣在**头上**，而不是精灵的水平正中。
// 桩里掩码的「头」在 x 0.56..0.80（中心 0.68）；写死 0.5 会偏出 270px 左右。
// 注意坐标空间：立绘画在**画布局部坐标**，盆画在**视口坐标**，两者差一个 state.x
//（也就是容器元素的 style.left）。
const potDraw = DRAWS.filter((d) => d.src.includes('iron_bowl.png')).slice(-1)[0]
const sprDraw = DRAWS.filter((d) => d.src.includes('/sprite/') || d.src.includes('/expr/')).slice(-1)[0]
const rootEl = doc.body.children.filter((c) => c.id === 'dshpet-root')[0]
const petX = rootEl ? (parseFloat(rootEl.style.left) || 0) : 0
if (potDraw && sprDraw) {
  const frac = ((potDraw.x + potDraw.w / 2) - (petX + sprDraw.x)) / sprDraw.w
  ok('铁锅扣在头部锚点上（≈0.68，不再是 0.5）', frac > 0.62 && frac < 0.74,
    '锅心占立绘宽度 ' + frac.toFixed(3) + '（头在 0.56~0.80，旧写死值 0.500）')
} else {
  ok('铁锅扣在头部锚点上（≈0.68，不再是 0.5）', false, '缺绘制记录')
}

console.log('')
console.log('=== 三期：火控雷达 ===')
await openMenu()
const radarRow = rowBy(menuRoot, '打开火控雷达')
ok('菜单有「打开火控雷达」', !!radarRow)
if (radarRow) { click(radarRow); await flush(6) }
await openMenu()
click(rowBy(menuRoot, '打开火控雷达'))   // 关掉，避免影响后续
await flush(6)
ok('开关火控雷达不报错', runtimeErrors.length === 0, runtimeErrors.slice(0, 2).join(' | '))

console.log('')
console.log('运行期错误: ' + (runtimeErrors.length ? runtimeErrors.slice(0, 3).join(' | ') : '（无）'))
console.log('结果: ' + pass + ' 通过 / ' + fails.length + ' 失败')
if (fails.length) { console.log('失败项:'); fails.forEach((f) => console.log('  - ' + f)) }
process.exit(fails.length ? 1 : 0)
