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
// 余额桩：测试可以改这个值，再等自动轮询，验证真实扣费 / 充值路径。
let balanceYuan = 12.34
// 账本桩：结算页测试会临时换成带「未收录模型 token」的 payload
let ledgerStub = { ok: true, enabled: true, since: null, models: {}, total: 0 }
// 手动价格表桩
let priceStub = {
  ok: true,
  models: [{ id: 'mystery-model-x', name: 'Mystery Model X', matchIds: ['mystery-model-x'], price: { hit: 0.1, miss: 1, out: 5, cur: 'CNY' } }],
  builtin: [{ name: 'deepseek-flash', price: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] } }],
}
const PRICE_POSTS = []

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
  getBoundingClientRect() {
    // 用元素自己的 left/top（插件会把容器真实位置写进 style）。
    // 固定 10/10 会让 localPoint 在桌宠被拖到别处后算错，摸头/右键命中都会假失败。
    const left = this.style && this.style.left !== undefined && this.style.left !== '' ? (parseFloat(this.style.left) || 0) : 10
    const top = this.style && this.style.top !== undefined && this.style.top !== '' ? (parseFloat(this.style.top) || 0) : 10
    return { width: 200, height: 260, left, top, right: left + 200, bottom: top + 260 }
  }
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
      // 雷达名牌是纯 fillText + arc 画出来的，只能靠这两个记录来断言
      if (k === 'fillText') {
        if (!record) return () => {}
        return (text, x, y) => { TEXTS.push({ text: String(text), x: x, y: y }) }
      }
      if (k === 'arc') {
        if (!record) return () => {}
        return (x, y, r) => { ARCS.push({ x: x, y: y, r: r }) }
      }
      if (k === 'fillRect') {
        if (!record) return () => {}
        return function (x, y, w, h) { FILLS.push({ style: this.fillStyle, x: x, y: y, w: w, h: h }) }
      }
      // 形变 / 镜像只能从 canvas 的变换调用里观察：
      //   scale(-1, 1)          → 立绘整只镜像
      //   scale(sx, sy)         → 摸头的 petpet 弹性（sx>1、sy<1）
      //   transform(1,0,0,sy,..) → 铁锅回弹 / 平板跟随的竖直形变
      //   transform(a,b,c,d,..)  → 平板仿射矩阵；镜像后 c 由正变负
      //   scale(sx,sy) x>1,y<1  → 米饭盆拖动的流体压扁
      if (k === 'scale') {
        if (!record) return () => {}
        return (x, y) => { SCALES.push({ x: x, y: y }) }
      }
      if (k === 'transform') {
        if (!record) return () => {}
        return function (a, b, c, d) { TRANSFORMS.push([a, b, c, d]) }
      }
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
const AUDIO_VOLUMES = [] // 每次 play() 时的音量（观察独立音量）
const LOGS = []         // 插件内部 console 输出（调试用）
const TEXTS = []        // 被 fillText 画出的文字（雷达名牌读数）
const FILLS = []        // 被 fillRect 画出的矩形（平板背景色）
const ARCS = []         // 被 arc 画出的圆（雷达方向环）
const SCALES = []       // 被 scale() 施加的缩放（镜像 / 摸头弹性 / 拖盆流体压扁）
const TRANSFORMS = []   // 被 transform() 施加的矩阵（铁锅回弹 / 平板形变 / 拖盆剪切）
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
      refsTitle: '参考的开源项目（本插件基于其 Mac 分支改写）',
      references: [
        { name: 'VK-1', url: 'https://github.com/VKmich16/VK-1', by: 'VKmich', license: 'MIT', note: '最初的原作者（Windows 版桌宠）—— 表情系统、米饭盆充值玩法、铁锅扣头与火控雷达移植自这一版的「大肥鱼桌宠改」；米饭盆 / 铁锅 / 喂食与打击音效也取自该目录，均按 MIT 使用。', licenseLabel: 'MIT 许可证原文', licenseUrl: '/dsh-pet/license.txt?f=vk1-LICENSE.txt' },
        { name: 'DSH-DaFeiYu-Desktop-Pet', url: 'https://github.com/Andromedahk/DSH-DaFeiYu-Desktop-Pet', by: 'Andromedahk', note: 'fork 自 VK-1，Mac 版桌宠（Swift + AppKit），后被上游合并 —— 本插件基于这一版改写：四个角色、立绘、平板布局、扣费动画与「抱盆」离线态都来自这里。', licenseLabel: '上游未另行授予许可', licenseUrl: null },
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
  const fetchStub = (url, opts) => {
    const u = String(url)
    let body = {}
    if (u.includes('manifest.json')) body = manifest
    else if (u.includes('sources.json')) body = sources
    else if (u.includes('turn.json')) body = { ok: true, seq: 0 }
    else if (u.includes('ledger.json')) body = ledgerStub
    else if (u.includes('prices.json')) {
      if (opts && opts.method === 'POST') {
        let req = {}
        try { req = JSON.parse(opts.body || '{}') } catch (err) { req = {} }
        PRICE_POSTS.push(req)
        const models = req.action === 'clear' ? [] : (req.models || [])
        priceStub = { ok: true, models, builtin: priceStub.builtin, updatedAt: Date.now() }
        body = {
          ok: true, models, builtin: priceStub.builtin, updatedAt: Date.now(),
          added: models.length, updated: 0, action: req.action,
        }
      } else body = priceStub
    }
    else if (u.includes('balance.json')) body = { ok: true, source: 'deepseek', kind: 'balance', currency: 'CNY', totalBalance: balanceYuan, at: Date.now() }
    else if (u.includes('tariff.json')) body = {
      ok: true, peak: true, label: '梁文峰', nextLabel: '距谷时',
      nextAt: Math.floor(Date.now() / 1000) + 3661, remainSec: 3661,
    }
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
      play() { AUDIO_PLAYED.push(this.src); AUDIO_VOLUMES.push({ src: this.src, volume: this.volume }); return Promise.resolve() }
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
// 只跑微任务，不执行 timers：用于观察「打开后马上会被自动关闭」的弹层
async function flushMicro(n = 20) {
  for (let i = 0; i < n; i++) await Promise.resolve()
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
// 在测试 DOM 里按 class / 文本找后代（El 没有 querySelector）
function descByClass(root, cls) {
  if (!root || !root.children) return null
  for (const c of root.children) {
    if (c.className === cls) return c
    const found = descByClass(c, cls)
    if (found) return found
  }
  return null
}
function descByText(root, text) {
  if (!root || !root.children) return null
  for (const c of root.children) {
    if (c.textContent === text) return c
    const found = descByText(c, text)
    if (found) return found
  }
  return null
}
function click(el) {
  if (!el) { runtimeErrors.push('click on missing element' + (new Error().stack || '').split('\n').slice(2, 4).join(' @ ')); return }
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
  // 清掉上一次展开后残留在 DOM 里的行（display:none 时 children 还在），
  // 否则右键没命中时会把旧子菜单误当成主菜单。
  menuRoot.style.display = 'none'
  menuRoot.innerHTML = ''
  // 用**立绘实际所在的视口位置**右键，而不是固定坐标：桌宠被拖走 / 吸附到右下角后，
  // 固定点会落在空白处（旧版测试靠容器桩固定 10/10 才碰巧成立）。
  const pr = petRect()
  const rootNow = doc.body.children.filter((c) => c.id === 'dshpet-root')[0]
  const lx = rootNow ? (parseFloat(rootNow.style.left) || 0) : 0
  const ly = rootNow ? (parseFloat(rootNow.style.top) || 0) : 0
  var pts = pr
    ? [[pr.x + pr.w * 0.5, pr.y + pr.h * 0.62], [pr.x + pr.w * 0.5, pr.y + pr.h * 0.78]]
    : [[lx + 80, ly + 120], [lx + 80, ly + 90], [lx + 40, ly + 120]]
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
console.log('=== 声音：先选「是否分音效调节音量」 ===')
await openMenu()
click(rowBy(menuRoot, '声音'))
await flush(6)
let soundRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('有「分音效调节音量」开关', soundRows.some((s) => s.includes('分音效调节音量')), soundRows.join(' | '))
ok('默认按分音效显示（6 个音效都在）', ['受击（扣费）', '投喂米饭盆', '铁锅扣头', '取下铁锅', '回合结束喜报', '结算证书']
  .every((s) => soundRows.some((r) => r.includes(s))), soundRows.join(' | '))
ok('分音效模式不显示「全部音量」档位', !soundRows.some((s) => s.includes('0%（静音）')), soundRows.join(' | '))

// 关掉分音效 → 音量只剩全部档位，但**自定义音频栏仍然显示**
click(rowBy(menuRoot, '分音效调节音量')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
soundRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('关掉分音效后显示「全部音效音量」',
  menuRoot.children.some((c) => c.className === 'dshpet-mhead' && c.textContent.includes('全部音效音量')) &&
  soundRows.some((s) => s.includes('0%（静音）')), soundRows.join(' | '))
ok('自定义音频栏在不勾选时也显示（6 个音效）',
  menuRoot.children.some((c) => c.className === 'dshpet-mhead' && c.textContent.includes('单独音效（自定义音频）')) &&
  ['受击（扣费）', '投喂米饭盆', '铁锅扣头', '取下铁锅', '回合结束喜报', '结算证书']
    .every((s) => soundRows.some((r) => r.includes(s) && r.includes('（出厂）'))), soundRows.join(' | '))
// 全局模式下进一个音效：只有自定义音频，没有逐个音效的音量档位
click(rowBy(menuRoot, '受击（扣费）')); await flush(6)
const audioOnlyRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('全局模式下音效子菜单只保留自定义音频',
  audioOnlyRows.some((r) => r.includes('上传自定义音效')) && audioOnlyRows.some((r) => r.includes('试听')) &&
  !audioOnlyRows.some((r) => r.includes('25 %')) && !audioOnlyRows.some((r) => r.includes('自定义音量')),
  audioOnlyRows.join(' | '))
click(rowBy(menuRoot, '返回')); await flush(6)
ok('有音量分组标题', menuRoot.children.some((c) => c.className === 'dshpet-mhead'), menuRoot.children.filter((c) => c.className === 'dshpet-mhead').map((c) => c.textContent).join(','))
ok('有 5 个档位（含 0% 静音）', soundRows.some((s) => s.includes('0%（静音）')) && soundRows.some((s) => s.includes('100 %')), soundRows.join(' | '))
ok('有「自定义音量…」', !!rowBy(menuRoot, '自定义音量'))
click(rowBy(menuRoot, '0%（静音）'))
await flush(6)
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
ok('选 0% 后「开启音效」不再打勾', !rowsOf(menuRoot).some((r) => r.textContent.includes('✓ 开启音效')), rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
// 关闭后下方档位不可用，必须先重新勾选「开启音效」
click(rowBy(menuRoot, '开启音效')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
click(rowBy(menuRoot, '75 %')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
ok('选 75% 后打勾落在 75%', rowsOf(menuRoot).some((r) => r.textContent.includes('✓ 75 %')), rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
ok('选 75% 后「开启音效」恢复打勾', rowsOf(menuRoot).some((r) => r.textContent.includes('✓ 开启音效')))

// 切回分音效模式：后面要测每个音效的独立音量
click(rowBy(menuRoot, '分音效调节音量')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
soundRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('切回分音效模式后重新显示 6 个音效（带音量）', ['受击（扣费）', '投喂米饭盆', '铁锅扣头', '取下铁锅', '回合结束喜报', '结算证书']
  .every((s) => soundRows.some((r) => r.includes(s))) &&
  soundRows.some((s) => s.includes('受击（扣费）（75 %）')) &&
  !soundRows.some((s) => s.includes('0%（静音）')), soundRows.join(' | '))

console.log('')
console.log('=== 每个音效独立音量 / 自定义音效 ===')
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
const sound2 = rowsOf(menuRoot).map((r) => r.textContent)
ok('声音菜单有 6 个独立音效', ['受击（扣费）', '投喂米饭盆', '铁锅扣头', '取下铁锅', '回合结束喜报', '结算证书']
  .every((s) => sound2.some((r) => r.includes(s))), sound2.join(' | '))
click(rowBy(menuRoot, '受击（扣费）')); await flush(6)
const hitMenu = rowsOf(menuRoot).map((r) => r.textContent)
ok('单个音效菜单有音量档位 / 自定义 / 上传', hitMenu.some((r) => r.includes('25 %')) &&
  hitMenu.some((r) => r.includes('自定义音量')) && hitMenu.some((r) => r.includes('上传自定义音效')) &&
  hitMenu.some((r) => r.includes('恢复出厂音效')), hitMenu.join(' | '))
ok('默认显示当前是出厂音效', hitMenu.some((r) => r.includes('当前：出厂音效')), hitMenu.join(' | '))
click(rowBy(menuRoot, '25 %')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '测试一次扣费')); await advance(0.1)
const hitPlays = AUDIO_VOLUMES.filter((x) => x.src.includes('hit.mp3'))
ok('受击音效按自己的 25% 音量播放', hitPlays.length > 0 && Math.abs(hitPlays[hitPlays.length - 1].volume - 0.25) < 1e-9,
  hitPlays.length ? String(hitPlays[hitPlays.length - 1].volume) : '(无播放)')
// 还原 75%
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
click(rowBy(menuRoot, '受击（扣费）')); await flush(6)
click(rowBy(menuRoot, '75 %')); await flush(6)

console.log('')
console.log('=== 关闭音效后下方选项不可用 ===')
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
click(rowBy(menuRoot, '开启音效')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
const offCue = rowBy(menuRoot, '受击（扣费）')
ok('关闭后分音效条目不可点', !!offCue && offCue.style.cursor === 'default' &&
  String(offCue.style.opacity) === '.45', offCue ? offCue.style.opacity : '(missing)')
ok('关闭后有提示文案', rowsOf(menuRoot).some((r) => r.textContent.includes('音效已关闭')))
AUDIO_PLAYED.length = 0
await openMenu(); click(rowBy(menuRoot, '测试一次扣费')); await advance(0.1)
ok('关闭音效后扣费不播放受击音', !AUDIO_PLAYED.some((s) => s.includes('hit.mp3')), AUDIO_PLAYED.join(','))
// 重新开启
await openMenu(); click(rowBy(menuRoot, '声音')); await flush(6)
click(rowBy(menuRoot, '开启音效')); await flush(6)

console.log('')
console.log('=== 平板峰谷彩蛋（DSH 账户余额）===')
TEXTS.length = 0
await oneFrame()
ok('平板标题已改为「DSH 账户余额」', TEXTS.some((t) => t.text === 'DSH 账户余额'),
  [...new Set(TEXTS.map((t) => t.text))].join(' | '))
const tp = tabletPoint()
TEXTS.length = 0
FILLS.length = 0
if (tp) {
  doc.fire('pointerdown', { button: 0, clientX: tp.x, clientY: tp.y })
  win.fire('pointerup', { clientX: tp.x, clientY: tp.y })
  await flush(8)
  await advance(0.1)
}
ok('点击平板切换到梁文峰', TEXTS.some((t) => t.text === '梁文峰'),
  [...new Set(TEXTS.map((t) => t.text))].join(' | '))
ok('峰价为红色背景', FILLS.some((f) => f.style === '#c62828' && f.w > 300 && f.h > 150),
  FILLS.filter((f) => f.w > 300).map((f) => f.style).join(' | '))
ok('峰谷彩蛋带剩余时长', TEXTS.some((t) => /^距谷时 \d+:\d{2}:\d{2}$/.test(t.text)),
  [...new Set(TEXTS.map((t) => t.text))].join(' | '))
// 布局按需求收紧成两行：梁文峰 / 距谷时（不再有「峰谷时段」标题行）
TEXTS.length = 0
await oneFrame()
const tariffLines = TEXTS.map((t) => t.text)
ok('峰谷视图只有两行（没有「峰谷时段」标题）',
  tariffLines.includes('梁文峰') && tariffLines.some((s) => /^距谷时 \d+:\d{2}:\d{2}$/.test(s)) &&
  !tariffLines.includes('峰谷时段'), tariffLines.join(' | '))
// 默认显示 2.5 秒：1.2 秒时还在，2.5 秒后自动回余额
await advance(1.2)
const stillTariff = TEXTS.slice(-6).map((t) => t.text)
ok('默认 2.5 秒内仍显示峰谷', stillTariff.includes('梁文峰'), stillTariff.join(' | '))
await advance(1.6)
const tariffTail = TEXTS.slice(-4).map((t) => t.text)
ok('默认 2.5 秒后自动回到余额', !tariffTail.includes('梁文峰') && tariffTail.includes('12.34'),
  tariffTail.join(' | '))

console.log('')
console.log('=== 平板峰谷显示时长可调 ===')
await openMenu()
ok('菜单有「平板峰谷时长」', !!rowBy(menuRoot, '平板峰谷时长'), rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
ok('默认显示 2.5 秒', rowBy(menuRoot, '平板峰谷时长').textContent.includes('2.5 秒'),
  rowBy(menuRoot, '平板峰谷时长').textContent)
click(rowBy(menuRoot, '平板峰谷时长')); await flush(6)
const tariffRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('有 1 / 2 / 2.5 / 3 / 5 / 10 秒六档',
  ['1 秒', '2 秒', '2.5 秒', '3 秒', '5 秒', '10 秒'].every((s) => tariffRows.some((r) => r.includes(s))),
  tariffRows.join(' | '))
ok('当前 2.5 秒打勾', tariffRows.some((r) => r.includes('✓ 2.5 秒')), tariffRows.join(' | '))
click(rowBy(menuRoot, '5 秒')); await flush(6)
await openMenu()
ok('选 5 秒后菜单标题跟着变', rowBy(menuRoot, '平板峰谷时长').textContent.includes('5 秒'),
  rowBy(menuRoot, '平板峰谷时长').textContent)
// 自定义时长：小于 0.5 秒被拒绝，1.5 秒生效
click(rowBy(menuRoot, '平板峰谷时长')); await flush(6)
click(rowBy(menuRoot, '自定义时长')); await flush(6)
const tPrompt = doc.body.children.filter((c) => c.id === 'dshpet-prompt')[0]
const tBox = tPrompt && tPrompt.children[0]
const tInp = tBox && tBox.children.filter((c) => c.className === 'dshpet-prompt-row')[0].children[0]
const tMsg = tBox && tBox.children.filter((c) => c.className.indexOf('dshpet-hol-msg') === 0)[0]
const tOk = tBox && tBox.children.filter((c) => c.className.indexOf('dshpet-hol-actions') >= 0)[0].children[0]
tInp.value = '0.2'
click(tOk); await flush(4)
ok('时长小于 0.5 秒被拒绝', !!tMsg.textContent && /0\.5/.test(tMsg.textContent), tMsg.textContent)
tInp.value = '1.5'
click(tOk); await flush(4)
await openMenu()
ok('自定义 1.5 秒生效', rowBy(menuRoot, '平板峰谷时长').textContent.includes('1.5 秒'),
  rowBy(menuRoot, '平板峰谷时长').textContent)
// 关掉菜单，点平板验证自定义时长真的生效
doc.fire('pointerdown', { button: 0, clientX: 5, clientY: 5 })
await flush(4)
TEXTS.length = 0
const tp2 = tabletPoint()
if (tp2) {
  doc.fire('pointerdown', { button: 0, clientX: tp2.x, clientY: tp2.y })
  win.fire('pointerup', { clientX: tp2.x, clientY: tp2.y })
  await flush(8)
  await advance(0.3)
}
ok('自定义 1.5 秒时峰谷已显示', TEXTS.some((t) => t.text === '梁文峰'),
  [...new Set(TEXTS.map((t) => t.text))].join(' | '))
await advance(1.5)
const customTail = TEXTS.slice(-4).map((t) => t.text)
ok('自定义 1.5 秒后回到余额', !customTail.includes('梁文峰') && customTail.includes('12.34'),
  customTail.join(' | '))
// 恢复默认 2.5 秒
await openMenu(); click(rowBy(menuRoot, '平板峰谷时长')); await flush(6)
click(rowBy(menuRoot, '2.5 秒')); await flush(6)

console.log('')
console.log('=== 自定义扣费步长 ===')
await openMenu()
ok('菜单有「扣费步长」', !!rowBy(menuRoot, '扣费步长'))
ok('默认每 0.01 元提示一次', rowBy(menuRoot, '扣费步长').textContent.includes('0.01 元'))
click(rowBy(menuRoot, '扣费步长')); await flush(6)
const stepRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('步长有 0.01 / 0.05 / 0.10 / 0.50 / 1.00 五档',
  ['¥0.01', '¥0.05', '¥0.10', '¥0.50', '¥1.00'].every((s) => stepRows.some((r) => r.includes(s))), stepRows.join(' | '))
ok('有「自定义步长…」', !!rowBy(menuRoot, '自定义步长'))
click(rowBy(menuRoot, '¥0.10')); await flush(6)
await openMenu()
ok('选 0.10 后菜单标题跟着变', rowBy(menuRoot, '扣费步长').textContent.includes('0.10 元'),
  rowBy(menuRoot, '扣费步长').textContent)

// 一次测试扣费按一个步长提示
TEXTS.length = 0
AUDIO_PLAYED.length = 0
click(rowBy(menuRoot, '测试一次扣费')); await advance(0.1)
ok('测试扣费飘字是步长金额（-0.10）', TEXTS.some((t) => t.text === '-0.10'),
  [...new Set(TEXTS.map((t) => t.text))].join(' | '))
ok('测试扣费同时播放 hit.mp3', AUDIO_PLAYED.some((s) => s.includes('hit.mp3')), AUDIO_PLAYED.join(','))
ok('平板金额按步长递减（12.34 → 12.24）', TEXTS.some((t) => t.text === '12.24'),
  [...new Set(TEXTS.map((t) => t.text))].join(' | '))

// 自定义步长：0.02
await openMenu(); click(rowBy(menuRoot, '扣费步长')); await flush(6)
click(rowBy(menuRoot, '自定义步长')); await flush(6)
const stepPrompt = doc.body.children.filter((c) => c.id === 'dshpet-prompt')[0]
const stepBox = stepPrompt && stepPrompt.children[0]
const stepInp = stepBox && stepBox.children.filter((c) => c.className === 'dshpet-prompt-row')[0].children[0]
const stepMsg = stepBox && stepBox.children.filter((c) => c.className.indexOf('dshpet-hol-msg') === 0)[0]
const stepOk = stepBox && stepBox.children.filter((c) => c.className.indexOf('dshpet-hol-actions') >= 0)[0].children[0]
stepInp.value = '0'
click(stepOk); await flush(4)
ok('步长 0 被拒绝', !!stepMsg.textContent && doc.body.children.some((c) => c.id === 'dshpet-prompt'), stepMsg.textContent)
stepInp.value = '0.001'
click(stepOk); await flush(4)
ok('小于 0.01 元的步长被拒绝', !!stepMsg.textContent && /0\.01/.test(stepMsg.textContent), stepMsg.textContent)
stepInp.value = '0.02'
click(stepOk); await flush(4)
await openMenu()
ok('自定义步长 0.02 生效', rowBy(menuRoot, '扣费步长').textContent.includes('0.02 元'),
  rowBy(menuRoot, '扣费步长').textContent)

// 连续演示 10 次 = 0.20 元，飘字每拍一次
TEXTS.length = 0
click(rowBy(menuRoot, '演示连续扣费')); await flush(6)
click(rowBy(menuRoot, '扣 10 次')); await advance(2.0)
const stepFloats = [...new Set(TEXTS.filter((t) => t.text === '-0.02').map((t) => t.text))]
ok('连续演示按步长逐次飘字（-0.02）', stepFloats.length === 1 && TEXTS.filter((t) => t.text === '-0.02').length >= 6,
  TEXTS.filter((t) => t.text === '-0.02').length + ' 条')

// 还原成 0.01，避免影响后面的用例
await openMenu(); click(rowBy(menuRoot, '扣费步长')); await flush(6)
click(rowBy(menuRoot, '¥0.01')); await flush(6)

console.log('')
console.log('=== 功能开关（掉盆 / 摸头 / 受击动画）===')
await openMenu()
click(rowBy(menuRoot, '功能选择')); await flush(6)
const fxRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('功能开关有三项', ['充值后掉落米饭盆', '鼠标抚摸会开心', '扣费时播放音效与动画'].every((s) => fxRows.some((r) => r.includes(s))), fxRows.join(' | '))
click(rowBy(menuRoot, '扣费时播放音效与动画')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '功能选择')); await flush(6)
ok('关掉扣费动画后不再打勾', !rowsOf(menuRoot).some((r) => r.textContent.includes('✓ 扣费时播放音效与动画')),
  rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
TEXTS.length = 0
AUDIO_PLAYED.length = 0
await openMenu(); click(rowBy(menuRoot, '测试一次扣费')); await advance(0.1)
ok('关掉扣费动画后不飘字、不响', !TEXTS.some((t) => /^-0\.0\d$/.test(t.text)) && !AUDIO_PLAYED.some((s) => s.includes('hit.mp3')),
  TEXTS.map((t) => t.text).join(' | ') + ' / ' + AUDIO_PLAYED.join(','))
await openMenu(); click(rowBy(menuRoot, '功能选择')); await flush(6)
click(rowBy(menuRoot, '扣费时播放音效与动画')); await flush(6)   // 还原

// 掉盆关掉时，测试充值不再生成米饭盆
await openMenu(); click(rowBy(menuRoot, '功能选择')); await flush(6)
click(rowBy(menuRoot, '充值后掉落米饭盆')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '测试充值')); await flush(4)
click(rowBy(menuRoot, '掉 1 盆饭'))
DRAWS.length = 0
await advance(0.2)
ok('关掉掉盆后测试充值不生成米饭盆', !DRAWS.some((d) => d.src.includes('rice.png')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))
await openMenu(); click(rowBy(menuRoot, '功能选择')); await flush(6)
click(rowBy(menuRoot, '充值后掉落米饭盆')); await flush(6)   // 还原

console.log('')
console.log('=== 左右下角吸附 ===')
await openMenu(); click(rowBy(menuRoot, '松手吸附')); await flush(6)
const snapRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('吸附菜单有左下 / 右下 / 关闭三项', snapRows.some((r) => r.includes('左下角')) && snapRows.some((r) => r.includes('右下角')) && snapRows.some((r) => r.includes('关闭')),
  snapRows.join(' | '))
click(rowBy(menuRoot, '吸附到右下角')); await advance(0.3)
const rootSnap = doc.body.children.filter((c) => c.id === 'dshpet-root')[0]
ok('选右下角后真的吸附过去', parseFloat(rootSnap.style.left) > win.innerWidth * 0.5,
  'left=' + rootSnap.style.left)
// 右边 = 整只角色镜像：立绘 scale(-1,1)、平板四边形也翻到另一只手；文字仍然正着。
SCALES.length = 0
TRANSFORMS.length = 0
TEXTS.length = 0
const tpm = tabletPointMirrored()
if (tpm) {
  doc.fire('pointerdown', { button: 0, clientX: tpm.x, clientY: tpm.y })
  win.fire('pointerup', { clientX: tpm.x, clientY: tpm.y })
  await flush(8)
  await advance(0.1)
}
ok('右下角时整只立绘镜像（scale -1,1）', SCALES.some((s) => s.x === -1 && s.y === 1),
  SCALES.map((s) => s.x + ',' + s.y).join(' | '))
ok('右下角时平板几何也镜像（仿射矩阵 c 变负）', TRANSFORMS.some((m) => m[2] < -0.005),
  TRANSFORMS.slice(0, 12).map((m) => m.map((v) => v.toFixed(3)).join(',')).join(' | '))
ok('镜像后点平板仍然点得到（峰谷视图）', TEXTS.some((t) => t.text === '梁文峰'),
  [...new Set(TEXTS.map((t) => t.text))].join(' | '))
// 关闭吸附后松手不再自动回角
await openMenu(); click(rowBy(menuRoot, '松手吸附')); await flush(6)
click(rowBy(menuRoot, '关闭')); await flush(6)
await openMenu(); click(rowBy(menuRoot, '松手吸附')); await flush(6)
const snapOffRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('关闭吸附后不再勾选左 / 右下角', snapOffRows.some((r) => r.includes('✓ 关闭')) &&
  !snapOffRows.some((r) => r.includes('✓ 吸附到左') || r.includes('✓ 吸附到右')), snapOffRows.join(' | '))
await openMenu(); click(rowBy(menuRoot, '松手吸附')); await flush(6)
SCALES.length = 0
TRANSFORMS.length = 0
click(rowBy(menuRoot, '吸附到左下角')); await advance(0.3)
ok('回到左下角后取消镜像', !SCALES.some((s) => s.x === -1 && s.y === 1) &&
  TRANSFORMS.some((m) => m[2] > 0.005),
  SCALES.map((s) => s.x + ',' + s.y).join(' | ') + ' / ' +
  TRANSFORMS.slice(0, 12).map((m) => m.map((v) => v.toFixed(3)).join(',')).join(' | '))

console.log('')
console.log('=== 摸头手势（petpet 手部动画）===')
await advance(1.2)                  // 清掉点击造成的摸头封锁
const prPat = petRect()
DRAWS.length = 0
SCALES.length = 0
if (prPat) {
  // 在她身上来回划动：每帧都派发 pointermove
  for (let i = 0; i < 40; i++) {
    doc.fire('pointermove', {
      buttons: 0,
      clientX: prPat.x + prPat.w * (i % 2 ? 0.55 : 0.35),
      clientY: prPat.y + prPat.h * 0.72,
    })
    await advance(0.03)
  }
  await advance(0.1)
}
ok('摸头后画出手部素材', DRAWS.some((d) => d.src.includes('/pat/pat_hand_')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))
// 摸头时切的是 expression_22（上游 EXPR_NERVOUS），不是常态笑脸。
// 注意要先清空再取一帧：整段划动里前半段还没进入摸头状态，会把 expression_11 一起记进来。
DRAWS.length = 0
await oneFrame()
ok('摸头时立绘切到 expression_22', DRAWS.some((d) => d.src.includes('expression_22')) &&
  !DRAWS.some((d) => d.src.includes('expression_11')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))
ok('摸头有 petpet 弹性形变（横向变宽 + 竖向压扁）',
  SCALES.some((s) => s.x > 1.01 && s.y < 0.99),
  SCALES.slice(-12).map((s) => s.x.toFixed(3) + 'x' + s.y.toFixed(3)).join(' | '))
// 指针离开后手要收起
doc.fire('pointermove', { buttons: 0, clientX: 5, clientY: 5 })
await advance(0.4)
DRAWS.length = 0
await oneFrame()
ok('指针离开后手部动画收起', !DRAWS.some((d) => d.src.includes('/pat/pat_hand_')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))
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


// —— 三期测试用的小工具 ——
// advance(0.001) 只跑 ceil(0.001/0.0167)=1 帧，用来「取一帧画面」精确计数
async function oneFrame() { await advance(0.001) }

function lastRiceCenter() {
  // 盆画在窗口级覆盖层上，用的是**视口坐标**，所以 drawImage 的中心就是点击点。
  const d = DRAWS.filter((x) => x.src.includes('rice.png')).slice(-1)[0]
  return d ? { x: d.x + d.w / 2, y: d.y + d.h / 2, r: d.w / 2 } : null
}
function lastIronCenter() {
  const d = DRAWS.filter((x) => x.src.includes('iron_bowl.png')).slice(-1)[0]
  return d ? { x: d.x + d.w / 2, y: d.y + d.h / 2, r: d.w / 2 } : null
}
// 一帧里画了几个盆（去重：同一个盆只会出现一次）
function riceBowls() {
  const out = []
  for (const d of DRAWS) {
    if (!d.src.includes('rice.png')) continue
    const c = { x: d.x + d.w / 2, y: d.y + d.h / 2, r: d.w / 2 }
    if (!out.some((o) => Math.abs(o.x - c.x) < 2 && Math.abs(o.y - c.y) < 2)) out.push(c)
  }
  return out
}
// 雷达名牌的文字（要和挂件平板上的余额文字区分开）
function radarTexts() {
  return TEXTS.filter((t) => t.text === '白饭' || /kpx/.test(t.text) ||
    /px\/s/.test(t.text) || /^-?\d+ px$/.test(t.text))
}
// 立绘在**视口**里的矩形：画布绘制是局部坐标，加上容器 style.left/top 才是视口
function petRect() {
  const rootEl = doc.body.children.filter((c) => c.id === 'dshpet-root')[0]
  const px = rootEl ? (parseFloat(rootEl.style.left) || 0) : 0
  const py = rootEl ? (parseFloat(rootEl.style.top) || 0) : 0
  const d = DRAWS.filter((x) => x.src.includes('/sprite/') || x.src.includes('/expr/')).slice(-1)[0]
  return d ? { x: px + d.x, y: py + d.y, w: d.w, h: d.h } : null
}
// 鱼立绘平板四角 TL(1060,699) TR(1413,644) BL(1090,889) 的中心（按 1536 宽缩放）
function tabletPoint() {
  const pr = petRect()
  if (!pr) return null
  const s = pr.w / 1536
  return { x: pr.x + 1251.5 * s, y: pr.y + 766.5 * s }
}
// 镜像到右半边后，平板中心 x 变成 1536 - 1251.5（y 不变）
function tabletPointMirrored() {
  const pr = petRect()
  if (!pr) return null
  const s = pr.w / 1536
  return { x: pr.x + (1536 - 1251.5) * s, y: pr.y + 766.5 * s }
}
function spawnOne(amountLabel) {
  return openMenu().then(() => {
    click(rowBy(menuRoot, '测试充值'))
    return flush(2)
  }).then(() => {
    click(rowBy(menuRoot, amountLabel || '掉 1 盆饭'))
  })
}
// 拖盆：pointerdown 落在 document（捕获阶段），pointermove/up 落在 window
// （插件就是在 window 上挂的拖动监听，必须按真实链路派发）
async function dragBowl(from, to, steps = 5) {
  doc.fire('pointerdown', { button: 0, clientX: from.x, clientY: from.y })
  await flush(2)
  for (let i = 1; i <= steps; i++) {
    win.fire('pointermove', {
      clientX: from.x + (to.x - from.x) * i / steps,
      clientY: from.y + (to.y - from.y) * i / steps,
    })
    await flush(2)
  }
  // 到达目标后停一下，让形变衰减；再在同一点补一次 pointermove
  // 把「甩出速度」采样清零，避免松开时被残余速度带走。
  win.fire('pointermove', { clientX: to.x, clientY: to.y })
  await advance(0.45)
  win.fire('pointerup', { clientX: to.x, clientY: to.y })
  await flush(4)
}
// 把场上所有盆都拖给她吃掉，给后面的用例清场
async function eatAllBowls() {
  for (let guard = 0; guard < 24; guard++) {
    DRAWS.length = 0
    await oneFrame()
    const list = riceBowls()
    if (!list.length) break
    const pr = petRect()
    if (!pr) break
    await dragBowl(list[list.length - 1], { x: pr.x + pr.w * 0.5, y: pr.y + pr.h * 0.62 })
    await advance(0.7)
  }
}

ok('存在窗口级覆盖层 #dshpet-rice', doc.body.children.some((c) => c.id === 'dshpet-rice'))

// ① 掉盆 + 重力
await spawnOne()
DRAWS.length = 0
await advance(0.15)
const ys = DRAWS.filter((d) => d.src.includes('rice.png')).map((d) => d.y)
ok('掉下来一个米饭盆（有画 rice.png）', ys.length > 0, ys.length + ' 帧')
ok('盆在重力作用下下落（y 递增）', ys.length >= 2 && ys[ys.length - 1] > ys[0],
  ys.slice(0, 5).map((v) => Math.round(v)).join(' → '))

// ② 落定在**窗口底部**
await advance(3.0)
DRAWS.length = 0
await advance(0.4)
const ys2 = DRAWS.filter((d) => d.src.includes('rice.png')).map((d) => d.y)
ok('落定后位置不再变化（停住）', ys2.length >= 2 && Math.abs(ys2[ys2.length - 1] - ys2[0]) < 2,
  ys2.length ? (Math.round(ys2[0]) + ' → ' + Math.round(ys2[ys2.length - 1])) : '(无帧)')
const settled = DRAWS.filter((d) => d.src.includes('rice.png')).slice(-1)[0]
if (settled) {
  ok('盆落在整个窗口的底部（视口坐标）', Math.abs(settled.y + settled.h - win.innerHeight) <= 8,
    '底边 y=' + Math.round(settled.y + settled.h) + '  窗口高=' + win.innerHeight)
} else {
  ok('盆落在整个窗口的底部（视口坐标）', false, '没记录到盆的绘制')
}

// ③ 多盆并存 —— 上游：一笔充值一个盆，场上**可以同时有多个**
await spawnOne(); await advance(0.5)
await spawnOne(); await advance(0.5)
await spawnOne(); await advance(3.0)     // 等它们都落地
DRAWS.length = 0
await oneFrame()
const multi = riceBowls()
ok('多盆并存（一笔充值一个盆）', multi.length >= 4, '同一帧里有 ' + multi.length + ' 个盆')

// ④ 落点散布 + 盆间碰撞（不会叠成一堆）
const mxs = multi.map((c) => c.x)
ok('落点散布在整个窗口宽度内（不局限于挂件）',
  mxs.length >= 2 && Math.max(...mxs) - Math.min(...mxs) > win.innerWidth * 0.2,
  'span=' + Math.round(Math.max(...mxs) - Math.min(...mxs)) + 'px  of ' + win.innerWidth + 'px   落点=' +
  mxs.map((v) => Math.round(v)).join(','))
ok('落点都落在窗口内', mxs.every((v) => v >= 0 && v <= win.innerWidth))
let overlapped = 0
for (let i = 0; i < multi.length; i++) {
  for (let j = i + 1; j < multi.length; j++) {
    const dx = multi[i].x - multi[j].x, dy = multi[i].y - multi[j].y
    const rr = (multi[i].r + multi[j].r) * 0.9   // 留一点余量
    if (Math.sqrt(dx * dx + dy * dy) < rr) overlapped++
  }
}
ok('盆彼此有碰撞体积（不叠成一堆）', overlapped === 0, overlapped + ' 对重叠')

// 清场
await eatAllBowls()

// 白饭落地要有声音（以前只有铁锅落地才响）
AUDIO_PLAYED.length = 0
await spawnOne()
await advance(2.5)
ok('白饭落地会播放铁盆落地音效', AUDIO_PLAYED.some((s) => s.includes('pot_off.mp3')),
  AUDIO_PLAYED.join(','))
await eatAllBowls()

console.log('')
console.log('=== 拖动米饭盆的流体形变惯性 ===')
// 找一个落在她身体之外（不会一拿起就被投喂）的盆
let dragStart = null
for (let attempt = 0; attempt < 6 && !dragStart; attempt++) {
  await spawnOne()
  await advance(2.5)
  const b = lastRiceCenter()
  const pr = petRect()
  if (b && pr && (b.x + b.r < pr.x || b.x - b.r > pr.x + pr.w)) {
    // 还要保证「远离她」那一侧有足够拖动空间，否则目标点被窗口边缘夹住，
    // 实际位移太小 / 方向相反，形变测试会偶发失败。
    const cx = pr.x + pr.w / 2
    const away = b.x < cx ? -1 : 1
    const space = away < 0 ? b.x - 80 : win.innerWidth - 80 - b.x
    if (space > 140) dragStart = b
    else await eatAllBowls()
  } else await eatAllBowls()
}
const prInf = petRect()
if (dragStart) {
  const petCx = prInf ? prInf.x + prInf.w / 2 : win.innerWidth / 2
  // 朝「远离她」的一侧甩
  const dir = dragStart.x < petCx ? -1 : 1
  const tx = Math.max(50, Math.min(win.innerWidth - 50, dragStart.x + dir * 200))
  const ty = dragStart.y
  SCALES.length = 0
  TRANSFORMS.length = 0
  doc.fire('pointerdown', { button: 0, clientX: dragStart.x, clientY: dragStart.y })
  await flush(2)
  win.fire('pointermove', { clientX: tx, clientY: ty })
  await advance(0.15)
  DRAWS.length = 0
  await oneFrame()
  const moved = lastRiceCenter()
  ok('拖动时碗跟手（不再拖尾）', !!moved && Math.abs(moved.x - tx) < 6,
    moved ? '碗 x=' + Math.round(moved.x) + '  指针 x=' + Math.round(tx) : '(没画到碗)')
  const wantSign = tx > dragStart.x ? -1 : 1
  const shears = TRANSFORMS.filter((m) => m[0] === 1 && m[1] === 0 && m[3] === 1).map((m) => m[2])
  const squashes = SCALES.filter((s) => s.x > 1.005 && s.y < 0.995)
  ok('拖动时有流体形变（横向拉伸 + 竖向压扁 + 下半部分剪切）',
    shears.some((a) => Math.sign(a) === wantSign && Math.abs(a) > 0.02) && squashes.length > 0,
    '剪切 ' + shears.slice(-6).map((a) => a.toFixed(3)).join(' | ') +
    '　压扁 ' + squashes.slice(-6).map((s) => s.x.toFixed(3) + 'x' + s.y.toFixed(3)).join(' | '))
  // 停手：形变要回正
  win.fire('pointermove', { clientX: tx, clientY: ty })
  await advance(0.7)
  SCALES.length = 0
  TRANSFORMS.length = 0
  await advance(0.12)
  const shears2 = TRANSFORMS.filter((m) => m[0] === 1 && m[1] === 0 && m[3] === 1).map((m) => m[2])
  const squashes2 = SCALES.filter((s) => s.x > 1.005 && s.y < 0.995)
  ok('停手后流体形变回正', shears2.slice(-4).every((a) => Math.abs(a) < 0.02) && squashes2.length === 0,
    '剪切 ' + shears2.slice(-4).map((a) => a.toFixed(3)).join(' | ') +
    '　压扁 ' + squashes2.length + ' 次')
  win.fire('pointerup', { clientX: tx, clientY: ty })
  await flush(4)
} else {
  ok('拖动时碗跟手（不再拖尾）', false, '没找到不在她身上的米饭盆')
  ok('拖动时有流体形变（横向拉伸 + 竖向压扁 + 下半部分剪切）', false, '没找到不在她身上的米饭盆')
  ok('停手后流体形变回正', false, '没找到不在她身上的米饭盆')
}
await eatAllBowls()

console.log('')
console.log('=== 拖盆流体效果强度设置 ===')
await openMenu()
const fluidRow = rowBy(menuRoot, '拖盆流体效果')
ok('菜单有「拖盆流体效果」', !!fluidRow, rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
ok('默认强度是 1.6×', !!fluidRow && fluidRow.textContent.includes('1.6×'), fluidRow ? fluidRow.textContent : '(missing)')
click(fluidRow); await flush(6)
const fluidRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('有 关闭 / 弱 / 标准 / 强 / 超强 五档',
  ['关闭（无形变）', '弱（0.7×）', '标准（1×）', '强（1.6×）', '超强（2.4×）']
    .every((s) => fluidRows.some((r) => r.includes(s))), fluidRows.join(' | '))
ok('当前「强 1.6×」打勾', fluidRows.some((r) => r.includes('✓ 强（1.6×）')), fluidRows.join(' | '))
click(rowBy(menuRoot, '超强')); await flush(6)
await openMenu()
ok('切到超强后菜单显示 2.4×', rowBy(menuRoot, '拖盆流体效果').textContent.includes('2.4×'),
  rowBy(menuRoot, '拖盆流体效果').textContent)
// 自定义强度：>2.5 被拒绝，2.0 生效
click(rowBy(menuRoot, '拖盆流体效果')); await flush(6)
click(rowBy(menuRoot, '自定义强度')); await flush(6)
const fPrompt = doc.body.children.filter((c) => c.id === 'dshpet-prompt')[0]
const fBox = fPrompt && fPrompt.children[0]
const fInp = fBox && fBox.children.filter((c) => c.className === 'dshpet-prompt-row')[0].children[0]
const fMsg = fBox && fBox.children.filter((c) => c.className.indexOf('dshpet-hol-msg') === 0)[0]
const fOk = fBox && fBox.children.filter((c) => c.className.indexOf('dshpet-hol-actions') >= 0)[0].children[0]
fInp.value = '3'
click(fOk); await flush(4)
ok('强度超过 2.5× 被拒绝', !!fMsg.textContent && /2\.5/.test(fMsg.textContent), fMsg.textContent)
fInp.value = '2'
click(fOk); await flush(4)
await openMenu()
ok('自定义 2× 生效', rowBy(menuRoot, '拖盆流体效果').textContent.includes('2×'),
  rowBy(menuRoot, '拖盆流体效果').textContent)
// 关闭：拖动时不应产生流体形变
click(rowBy(menuRoot, '拖盆流体效果')); await flush(6)
click(rowBy(menuRoot, '关闭（无形变）')); await flush(6)
await openMenu()
ok('关闭后菜单显示「关闭」', rowBy(menuRoot, '拖盆流体效果').textContent.includes('关闭'),
  rowBy(menuRoot, '拖盆流体效果').textContent)

let offBowl = null
for (let attempt = 0; attempt < 6 && !offBowl; attempt++) {
  await spawnOne()
  await advance(2.5)
  const b = lastRiceCenter()
  const pr = petRect()
  if (b && pr && (b.x + b.r < pr.x || b.x - b.r > pr.x + pr.w)) offBowl = b
  else await eatAllBowls()
}
if (offBowl) {
  const prOff = petRect()
  const petCx2 = prOff ? prOff.x + prOff.w / 2 : win.innerWidth / 2
  const dir2 = offBowl.x < petCx2 ? -1 : 1
  const tx2 = Math.max(50, Math.min(win.innerWidth - 50, offBowl.x + dir2 * 200))
  SCALES.length = 0
  TRANSFORMS.length = 0
  doc.fire('pointerdown', { button: 0, clientX: offBowl.x, clientY: offBowl.y })
  await flush(2)
  win.fire('pointermove', { clientX: tx2, clientY: offBowl.y })
  await advance(0.15)
  const shearsOff = TRANSFORMS.filter((m) => m[0] === 1 && m[1] === 0 && m[3] === 1).map((m) => m[2])
  const squashesOff = SCALES.filter((s) => s.x > 1.005 && s.y < 0.995)
  ok('关闭后拖动没有流体形变', shearsOff.length === 0 && squashesOff.length === 0,
    '剪切 ' + shearsOff.length + ' 次 / 压扁 ' + squashesOff.length + ' 次')
  win.fire('pointerup', { clientX: tx2, clientY: offBowl.y })
  await flush(4)
} else {
  ok('关闭后拖动没有流体形变', false, '没找到不在她身上的米饭盆')
}
await eatAllBowls()
// 恢复默认强度
await openMenu(); click(rowBy(menuRoot, '拖盆流体效果')); await flush(6)
click(rowBy(menuRoot, '强（1.6×）')); await flush(6)

// ⑤ 【核心】拖动喂食 —— 上游：必须把盆**拖到**她身上才入账
await spawnOne()
await advance(2.5)
const toFeed = lastRiceCenter()
const pr0 = petRect()
AUDIO_PLAYED.length = 0
if (toFeed && pr0) {
  await dragBowl(toFeed, { x: pr0.x + pr0.w * 0.5, y: pr0.y + pr0.h * 0.62 })
  await flush(6)
}
ok('把盆拖到她身上会投喂（播放 feed.mp3）',
  AUDIO_PLAYED.some((s) => s.includes('feed.mp3')), AUDIO_PLAYED.join(',') || '(无音效)')

// ⑥ 投喂后空锅先掉到地上；第二次拖回她身上才会扣头
DRAWS.length = 0
await advance(3.5)
ok('投喂后掉下铁锅（画了 iron_bowl.png）', DRAWS.some((d) => d.src.includes('iron_bowl.png')),
  DRAWS.some((d) => d.src.includes('iron_bowl.png')) ? '有' : '无')
ok('空锅先落在地上，不自动扣头', !DRAWS.some((d) => d.src.includes('expression_21')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))
const ironPos = lastIronCenter()
const prPot = petRect()
AUDIO_PLAYED.length = 0
TRANSFORMS.length = 0
if (ironPos && prPot) {
  await dragBowl(ironPos, { x: prPot.x + prPot.w * 0.68, y: prPot.y + prPot.h * 0.12 })
  await advance(0.3)
}
ok('第二次拖回她身上才扣头（expression_21）', DRAWS.some((d) => d.src.includes('expression_21')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))
ok('铁锅扣头时有回弹形变（竖直压缩、水平不变）',
  TRANSFORMS.some((m) => Math.abs(m[0] - 1) < 1e-9 && Math.abs(m[1]) < 1e-9 &&
    Math.abs(m[2]) < 1e-9 && Math.abs(m[3] - 1) > 0.01),
  TRANSFORMS.slice(0, 10).map((m) => m.map((v) => v.toFixed(3)).join(',')).join(' | '))
ok('扣头播放对调后的 pot_off.mp3', AUDIO_PLAYED.some((s) => s.includes('pot_off.mp3')), AUDIO_PLAYED.join(','))

// 铁锅扣在**头**上（不是精灵的水平正中）
const potDraw = DRAWS.filter((d) => d.src.includes('iron_bowl.png')).slice(-1)[0]
const sprDraw = DRAWS.filter((d) => d.src.includes('/sprite/') || d.src.includes('/expr/')).slice(-1)[0]
const rootEl2 = doc.body.children.filter((c) => c.id === 'dshpet-root')[0]
const petX = rootEl2 ? (parseFloat(rootEl2.style.left) || 0) : 0
if (potDraw && sprDraw) {
  // 注意坐标空间：立绘是画布局部坐标，盆是视口坐标，差一个 state.x
  const frac = ((potDraw.x + potDraw.w / 2) - (petX + sprDraw.x)) / sprDraw.w
  ok('铁锅扣在头部锚点上（≈0.68，不再是 0.5）', frac > 0.62 && frac < 0.74,
    '锅心占立绘宽度 ' + frac.toFixed(3) + '（掩码里的头在 0.56~0.80）')
} else {
  ok('铁锅扣在头部锚点上（≈0.68，不再是 0.5）', false, '缺绘制记录')
}

// ⑦ 头上有锅时，从上方落下的米饭盆会被锅体弹开
console.log('')
console.log('=== 头上有锅时，饭盆落在锅上会被弹开 ===')
await spawnOne()
DRAWS.length = 0
await oneFrame()
const bowlFall = lastRiceCenter()
const potUnder = lastIronCenter()
const prUnder = petRect()
let bounceDx = 0
if (bowlFall && potUnder && prUnder) {
  // 先把桌宠（连同头上的锅）挪到盆的预计落点下方；不推进时间，盆还在顶部
  const cursorY = prUnder.y + prUnder.h * 0.62
  let cursorX = prUnder.x + prUnder.w * 0.5
  doc.fire('pointerdown', { button: 0, clientX: cursorX, clientY: cursorY })
  await flush(2)
  cursorX += (bowlFall.x - potUnder.x)
  win.fire('pointermove', { clientX: cursorX, clientY: cursorY })
  await flush(2)
  // 下落过程中持续把锅对准盆；接近锅顶时停手，让盆自己撞上去
  let stopped = false
  let impactPotX = 0
  for (let i = 0; i < 110; i++) {
    DRAWS.length = 0
    await advance(0.02)
    const b = lastRiceCenter()
    const p = lastIronCenter()
    if (!b || !p) break
    if (!stopped && b.y < p.y - p.r * 1.6) {
      cursorX += (b.x - p.x)
      win.fire('pointermove', { clientX: cursorX, clientY: cursorY })
    } else if (!stopped) {
      stopped = true
      impactPotX = p.x
      win.fire('pointerup', { clientX: cursorX, clientY: cursorY })
      await flush(2)
    } else {
      bounceDx = Math.max(bounceDx, Math.abs(b.x - impactPotX))
    }
  }
  if (!stopped) win.fire('pointerup', { clientX: cursorX, clientY: cursorY })
}
ok('头上有锅时饭盆会被弹开（横向偏移）', bounceDx > 8, '最大横向偏移 ' + bounceDx.toFixed(1) + 'px')
// 清掉这个测试盆（锅还留在头上，下一步再双击取锅）
await eatAllBowls()

// ⑧ 双击她的头 → 把铁锅敲掉（上游是**双击**，不是单击）
// 现在支持堆叠：一次只取最上面那口锅，所以连点几次把所有锅都取下来。
AUDIO_PLAYED.length = 0
const pr1 = petRect()
const pot1 = lastIronCenter()
DRAWS.length = 0
if (pr1) {
  // 点「锅下方一点」的头皮：直接用锅的实际位置反推，避免角色被移动 / 镜像后固定坐标打偏。
  // 偏移 > 锅半径，保证先命中头而不是把锅抓起来。
  const hx = pot1 ? pot1.x : (pr1.x + pr1.w * 0.5)
  const hy = pot1 ? (pot1.y + (pot1.r || 16) * 1.7) : (pr1.y + pr1.h * 0.2)
  for (let round = 0; round < 6; round++) {
    // 真实双击 = down/up + down/up
    for (let n = 0; n < 2; n++) {
      doc.fire('pointerdown', { button: 0, clientX: hx, clientY: hy })
      win.fire('pointerup', { clientX: hx, clientY: hy })
    }
    await flush(4)
    await advance(0.8)     // 铁锅是渐隐消失的
  }
}
ok('双击她的头能敲掉头上的铁锅', !DRAWS.some((d) => d.src.includes('expression_21')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))
ok('取锅播放对调后的 pot_land.mp3', AUDIO_PLAYED.some((s) => s.includes('pot_land.mp3')), AUDIO_PLAYED.join(','))

// ⑧ 火控雷达：落地满 BowlWaitSec(10s) → 锁定；再过 LockDelaySec(1s) → 加速吸附 → 自动喂
await eatAllBowls()
await advance(0.5)
TEXTS.length = 0
await spawnOne()
await advance(2.0)                 // 已经落地（约 1 秒落到底）
TEXTS.length = 0
await oneFrame()
ok('刚落地时还没有锁定（没有名牌）', radarTexts().length === 0, radarTexts().map((t) => t.text).join(' | '))

// 一小步一小步地等，直到名牌出现（BowlWaitSec 10 秒，留足余量）
let locked = false
for (let i = 0; i < 140 && !locked; i++) {
  TEXTS.length = 0
  ARCS.length = 0
  await advance(0.1)
  if (radarTexts().some((t) => /kpx/.test(t.text))) locked = true
}
const lockedTexts = radarTexts().map((t) => t.text)
ok('落地满 10 秒后出现火控雷达名牌（锁定）', locked, lockedTexts.join(' | ') || '(没出现)')
ok('名牌含类型「白饭」', lockedTexts.some((t) => t === '白饭'), lockedTexts.join(' | '))
ok('距离用 kpx（上游 FmtKpx）', lockedTexts.some((t) => /kpx/.test(t)), lockedTexts.join(' | '))
ok('接近率用 px/s（上游 FmtPxS）', lockedTexts.some((t) => /px\/s/.test(t)), lockedTexts.join(' | '))
ok('相对高度用 px（上游 FmtPx）', lockedTexts.some((t) => /^-?\d+ px$/.test(t)), lockedTexts.join(' | '))
ok('画了方向环（arc）', ARCS.length > 0, ARCS.length + ' 个圆')

// 锁定 1 秒 + 加速吸附 → 不用手拖，自动喂
AUDIO_PLAYED.length = 0
await advance(4.0)
ok('锁定后会被吸过去并自动投喂（播放 feed.mp3）',
  AUDIO_PLAYED.some((s) => s.includes('feed.mp3')), AUDIO_PLAYED.join(',') || '(无音效)')
await advance(1.0)                  // 等投喂淡出
DRAWS.length = 0
await oneFrame()
ok('吸走后场上没有米饭盆了', !DRAWS.some((d) => d.src.includes('rice.png')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))

// ⑨ 多个盆**一起**锁定（只要有一个满 10 秒，全部锁定）
await eatAllBowls()
await advance(0.5)
await spawnOne(); await advance(0.2)
await spawnOne()
// 等第一个满 10 秒（第二个此时才 ~9.8 秒，还没到自己满 10 秒）
let bothLocked = false
for (let i = 0; i < 140 && !bothLocked; i++) {
  TEXTS.length = 0
  await advance(0.1)
  const xs = [...new Set(radarTexts().filter((t) => t.text === '白饭').map((t) => Math.round(t.x)))]
  if (xs.length >= 2) bothLocked = true
}
ok('多个盆一起被锁定（各自都出现名牌）', bothLocked,
  '同一帧里的名牌横向位置 ' + [...new Set(radarTexts().filter((t) => t.text === '白饭').map((t) => Math.round(t.x)))].join(','))

// 清场
await advance(9.0)
await eatAllBowls()


console.log('')
console.log('=== 三期：火控雷达 ===')
await openMenu()
const radarRow = rowBy(menuRoot, '打开火控雷达')
ok('菜单有「打开火控雷达」', !!radarRow)
if (radarRow) { click(radarRow); await flush(6) }
await openMenu()
const radarRow2 = rowBy(menuRoot, '打开火控雷达')
if (radarRow2) click(radarRow2)   // 关掉，避免影响后续
await flush(6)
ok('开关火控雷达不报错', runtimeErrors.length === 0, runtimeErrors.slice(0, 2).join(' | '))

console.log('')
console.log('=== 火控雷达：自动拾取缩短到 3 秒 ===')
await eatAllBowls()
await advance(0.5)
await openMenu(); click(rowBy(menuRoot, '打开火控雷达')); await flush(6)
await openMenu()
ok('火控雷达已勾选', rowBy(menuRoot, '打开火控雷达').textContent.includes('✓'),
  rowBy(menuRoot, '打开火控雷达').textContent)
AUDIO_PLAYED.length = 0
await spawnOne()
let radarFedAt = -1
for (let i = 0; i < 80; i++) {
  await advance(0.1)
  if (AUDIO_PLAYED.some((s) => s.includes('feed.mp3'))) { radarFedAt = (i + 1) * 0.1; break }
}
ok('雷达开启后会自动拾取米饭盆', radarFedAt >= 0, radarFedAt < 0 ? '(8 秒内没被拾取)' : radarFedAt.toFixed(1) + ' 秒')
ok('雷达开启后不是刚落地就吸走（≥ 2 秒）', radarFedAt >= 2, radarFedAt.toFixed(1) + ' 秒')
ok('雷达开启后 8 秒内一定捡完（阈值 3 秒）', radarFedAt >= 0 && radarFedAt <= 8, radarFedAt.toFixed(1) + ' 秒')
// 关掉火控雷达，避免影响后续
await openMenu(); click(rowBy(menuRoot, '打开火控雷达')); await flush(6)

console.log('')
console.log('=== 测试充值：掉 1 / 3 / 10 盆饭 ===')
for (const preset of [['掉 1 盆饭', 1], ['掉 3 盆饭', 3], ['掉 10 盆饭', 10]]) {
  const label = preset[0]
  const count = preset[1]
  await eatAllBowls()
  await advance(0.5)
  await openMenu(); click(rowBy(menuRoot, '测试充值')); await flush(4)
  const row = rowBy(menuRoot, label)
  ok('测试充值菜单有「' + label + '」', !!row, rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
  if (row) click(row)
  await advance(0.3)
  DRAWS.length = 0
  await oneFrame()
  const n = DRAWS.filter((d) => d.src.includes('rice.png')).length
  ok(label + ' 真的掉下 ' + count + ' 个盆', n === count, '实际 ' + n + ' 个')
}
await eatAllBowls()

console.log('')
console.log('=== 自定义演示次数 / 测试充值金额 ===')
// 演示次数
await openMenu(); click(rowBy(menuRoot, '演示连续扣费')); await flush(6)
click(rowBy(menuRoot, '自定义次数')); await flush(6)
const demoPrompt = doc.body.children.filter((c) => c.id === 'dshpet-prompt')[0]
const demoBox = demoPrompt && demoPrompt.children[0]
const demoInp = demoBox && demoBox.children.filter((c) => c.className === 'dshpet-prompt-row')[0].children[0]
const demoMsg = demoBox && demoBox.children.filter((c) => c.className.indexOf('dshpet-hol-msg') === 0)[0]
const demoOk = demoBox && demoBox.children.filter((c) => c.className.indexOf('dshpet-hol-actions') >= 0)[0].children[0]
ok('演示次数弹层已打开', !!demoPrompt)
demoInp.value = '0'
click(demoOk); await flush(4)
ok('演示次数 0 被拒绝', !!demoMsg.textContent, demoMsg.textContent)
demoInp.value = '3'
click(demoOk); await flush(4)
ok('自定义演示 3 次被接受', !doc.body.children.some((c) => c.id === 'dshpet-prompt'))
TEXTS.length = 0
await advance(1.0)
ok('自定义演示真的跑了 3 拍', TEXTS.filter((t) => t.text === '-0.01').length >= 3,
  TEXTS.filter((t) => t.text === '-0.01').length + ' 条飘字')
await advance(1.0)   // 等演示结束、显示恢复

// 测试充值金额
await openMenu(); click(rowBy(menuRoot, '测试充值')); await flush(6)
click(rowBy(menuRoot, '自定义金额')); await flush(6)
const topPrompt = doc.body.children.filter((c) => c.id === 'dshpet-prompt')[0]
const topBox = topPrompt && topPrompt.children[0]
const topInp = topBox && topBox.children.filter((c) => c.className === 'dshpet-prompt-row')[0].children[0]
const topMsg = topBox && topBox.children.filter((c) => c.className.indexOf('dshpet-hol-msg') === 0)[0]
const topOk = topBox && topBox.children.filter((c) => c.className.indexOf('dshpet-hol-actions') >= 0)[0].children[0]
ok('测试充值金额弹层已打开', !!topPrompt)
topInp.value = '0'
click(topOk); await flush(4)
ok('测试充值 0 元被拒绝', !!topMsg.textContent, topMsg.textContent)
topInp.value = '7'
click(topOk); await flush(4)
DRAWS.length = 0
await advance(0.2)
ok('自定义测试充值掉下米饭盆', DRAWS.some((d) => d.src.includes('rice.png')))
await eatAllBowls()

console.log('')
console.log('=== 零余额冷脸 / 真实扣费按步长拆分 ===')
// 零余额 → 冷脸（expression_12）
balanceYuan = 0
await openMenu(); click(rowBy(menuRoot, '立即刷新余额'))
DRAWS.length = 0
await advance(0.3)
ok('余额归零切到冷脸（expression_12）', DRAWS.some((d) => d.src.includes('expression_12')),
  [...new Set(DRAWS.map((d) => d.src.split('/').pop()))].join(','))
// 恢复到 12.34，让后续用例有正常余额
balanceYuan = 12.34
await openMenu(); click(rowBy(menuRoot, '立即刷新余额')); await advance(0.4)
await eatAllBowls()

// 步长 0.10：真实下降 0.30 应当分 3 次提示，每次 -0.10
await openMenu(); click(rowBy(menuRoot, '扣费步长')); await flush(6)
click(rowBy(menuRoot, '¥0.10')); await flush(6)
balanceYuan = 12.04
await openMenu(); click(rowBy(menuRoot, '立即刷新余额'))
let maxFloats = 0
for (let i = 0; i < 24; i++) {
  TEXTS.length = 0
  await advance(0.1)
  maxFloats = Math.max(maxFloats, TEXTS.filter((t) => t.text === '-0.10').length)
}
ok('真实扣 0.30 按 0.10 拆成多次提示', maxFloats >= 3, '同一帧最多 ' + maxFloats + ' 条 -0.10')
ok('平板显示对齐到 12.04', TEXTS.some((t) => t.text === '12.04'),
  [...new Set(TEXTS.map((t) => t.text))].join(' | '))
// 还原 0.01
await openMenu(); click(rowBy(menuRoot, '扣费步长')); await flush(6)
click(rowBy(menuRoot, '¥0.01')); await flush(6)

console.log('')
console.log('=== 累计计费：未收录模型 token 留痕 ===')
ledgerStub = {
  ok: true, enabled: true, since: Date.now() - 3600e3, now: Date.now(),
  models: [
    { name: 'deepseek-v4-flash', amount: 1.23, tokens: 1200, unknown: false },
    { name: 'mystery-model-x', amount: 0.45, tokens: 12345, unknown: true },
  ],
  total: 1.68, turns: 2, tokens: 13545, unknownTokens: 12345,
  unknownModels: [{ name: 'mystery-model-x', tokens: 12345 }],
  lastSettledAt: null, currency: 'CNY',
}
await advance(15.2)   // 等一次账本轮询把新桩读进 ledgerCache
await openMenu()
await flush(20)   // 等 readLedger() 回填并重渲染菜单
const settleRow = rowBy(menuRoot, '结束计费并结算')
ok('账本里有两个回合时结算可用', !!settleRow && settleRow.style.cursor !== 'default',
  settleRow ? settleRow.style.cursor : '(missing)')
if (settleRow) click(settleRow)
// 结算页带 15s 自动关闭定时器；测试的 setTimeout 桩不按时间排队，
// 这里只跑微任务先看到它，再手动关（否则下一次 flush 会立刻触发自动关闭）。
await flushMicro(30)
const settleEl = doc.body.children.filter((c) => c.id === 'dshpet-settle')[0]
ok('结算页已打开', !!settleEl)
const settleText = settleEl ? settleEl.textContent : ''
ok('未收录模型显示 token 用量',
  settleText.includes('未收录') && settleText.includes('12,345') && settleText.includes('mystery-model-x'),
  settleText.replace(/\s+/g, ' ').slice(0, 220))
doc.fire('keydown', { key: 'Escape' })
await flushMicro(5)
ok('结算页可关闭', !doc.body.children.some((c) => c.id === 'dshpet-settle'))
ledgerStub = { ok: true, enabled: true, since: null, models: {}, total: 0 }

console.log('')
console.log('=== 模型价格表：导入 / 更新 ===')
priceStub = {
  ok: true,
  models: [
    { id: 'mystery-model-x', name: 'Mystery Model X', matchIds: ['mystery-model-x'], price: { hit: 0.1, miss: 1, out: 5, cur: 'CNY' } },
  ],
  builtin: [{ name: 'deepseek-flash', price: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] } }],
}
PRICE_POSTS.length = 0
await openMenu()
await flush(20)
const pRow = rowBy(menuRoot, '模型价格表')
ok('菜单有「模型价格表」', !!pRow, rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
ok('价格表条数显示正确', !!pRow && pRow.textContent.includes('1 条手动'), pRow ? pRow.textContent : '(missing)')
if (pRow) click(pRow)
await flush(6)
const pRows = rowsOf(menuRoot).map((r) => r.textContent)
ok('有导入 / 编辑 / 清空三项',
  ['导入价格表', '编辑当前价格表', '清空手动价格表'].every((s) => pRows.some((r) => r.includes(s))),
  pRows.join(' | '))
ok('列表里显示手动模型与价格', pRows.some((r) => r.includes('Mystery Model X') && r.includes('¥0.1')),
  pRows.join(' | '))
click(rowBy(menuRoot, '编辑当前价格表')); await flush(6)
const pe = doc.body.children.filter((c) => c.id === 'dshpet-price')[0]
ok('价格表编辑器已打开', !!pe)
const pta = pe && descByClass(pe, 'dshpet-price-ta')
ok('编辑器带 JSON 文本域', !!pta)
if (pta) {
  pta.value = JSON.stringify({
    models: [
      { id: 'mystery-model-x', name: 'Mystery Model X', matchIds: ['mystery-model-x'], price: { hit: 0.2, miss: 1.2, out: 6, cur: 'CNY' } },
      { id: 'another-unknown', name: 'Another Unknown', matchIds: ['another-unknown'], price: { hit: 0, miss: 2, out: 8, cur: 'USD', rate: 7.2 } },
    ],
  })
  const pActions = descByClass(pe, 'dshpet-hol-actions')
  const pSave = pActions && descByText(pActions, '保存')
  if (pSave) click(pSave)
}
await flush(20)
const lastPost = PRICE_POSTS[PRICE_POSTS.length - 1]
ok('保存走 replace 并带上两条价格',
  !!lastPost && lastPost.action === 'replace' && lastPost.models && lastPost.models.length === 2,
  JSON.stringify(lastPost).slice(0, 220))
ok('保存后编辑器关闭', !doc.body.children.some((c) => c.id === 'dshpet-price'))
await openMenu(); await flush(20)
ok('保存后菜单条数更新为 2', !!rowBy(menuRoot, '模型价格表') &&
  rowBy(menuRoot, '模型价格表').textContent.includes('2 条手动'),
  rowBy(menuRoot, '模型价格表') ? rowBy(menuRoot, '模型价格表').textContent : '(missing)')

console.log('')
console.log('=== 关于（含上游版本说明）===')
await openMenu()
const aboutRow = rowBy(menuRoot, '关于')
ok('菜单有「关于…」', !!aboutRow, rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
if (aboutRow) { click(aboutRow); await flush(8) }
const aboutEl = doc.body.children.filter((c) => c.id === 'dshpet-about')[0]
ok('关于对话框已打开', !!aboutEl)
const aboutBox = aboutEl && aboutEl.children[0]
const aboutText = aboutBox ? aboutBox.textContent : ''
ok('显示正式名 DSH Balance Pet Enhanced', aboutText.includes('DSH Balance Pet Enhanced'), aboutText.slice(0, 90))
ok('显示分支维护者', aboutText.includes('分支维护者') && aboutText.includes('TsukiKenga'))
ok('显示包名', aboutText.includes('dsh-balance-pet-extend'))
ok('显示本分支 GitHub 地址', aboutText.includes('github.com/TsukiKenga/dsh-balance-pet-extend'))
// 两个上游都要在，且关系必须写对：VKmich 是最初的原作者，Andromedahk 是 fork
ok('列出 Mac 分支上游（Andromedahk）', aboutText.includes('Andromedahk') && aboutText.includes('DSH-DaFeiYu-Desktop-Pet'))
ok('列出最初的原作者（VKmich）', aboutText.includes('VKmich') && aboutText.includes('VK-1'))
ok('写明 VKmich 是「最初的原作者」', /最初的原作者/.test(aboutText))
ok('写明 Andromedahk 是 fork 自 VK-1', /fork 自 VK-1/.test(aboutText))
ok('说明本插件基于该 Mac 分支改写', aboutText.includes('基于其 Mac 分支') || aboutText.includes('基于这一版改写'), aboutText.slice(-280))
ok('注明 Andromedahk 那支是 Mac 版', /Mac 版桌宠/.test(aboutText))
ok('注明 VKmich 那支是 Windows 版', /Windows 版桌宠/.test(aboutText))
// VK-1 必须排在 Andromedahk 之前（原作者在前）
ok('VK-1 排在 Andromedahk 之前', aboutText.indexOf('VKmich') < aboutText.indexOf('Andromedahk'),
  'VK-1@' + aboutText.indexOf('VKmich') + '  Andromedahk@' + aboutText.indexOf('Andromedahk'))
ok('保留 whale 参考项目', aboutText.includes('DeepSeek-Balance-Whale-Widget') && aboutText.includes('MeteorNOX'))
// 链接可点：本分支仓库 + 作者 + 两个上游 + whale = 5 个 https 外链
const aboutLinks = []
;(function collect(el) {
  for (const c of (el.children || [])) { if (c.tagName === 'a') aboutLinks.push(c); collect(c) }
})(aboutBox)
const httpsLinks = aboutLinks.filter((a) => /^https:/.test(String(a.href || '')))
ok('五个 GitHub 外链都可点（仓库+作者+三参考）', httpsLinks.length === 5, httpsLinks.map((l) => l.href).join(' | '))
ok('Andromedahk 链接正确', httpsLinks.some((l) => l.href === 'https://github.com/Andromedahk/DSH-DaFeiYu-Desktop-Pet'))
ok('VKmich 链接正确', httpsLinks.some((l) => l.href === 'https://github.com/VKmich16/VK-1'))
ok('whale 链接正确', httpsLinks.some((l) => l.href === 'https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget'))
ok('外链均为新窗口打开', httpsLinks.length > 0 && httpsLinks.every((l) => l.target === '_blank'))
// 许可证入口的文件名必须**按各自的项目**取，不能都指向 whale（曾经的写死 bug）
const licTexts = []
;(function collectLic(el) {
  for (const c of (el.children || [])) {
    if (String(c.className).indexOf('dshpet-about-reflink') >= 0) licTexts.push(c.textContent)
    collectLic(c)
  }
})(aboutBox)
const mitReaders = licTexts.filter((t) => t.indexOf('MIT 许可证原文') >= 0)
ok('VK-1 与 whale 各有独立的 MIT 许可证入口', mitReaders.length >= 2,
  mitReaders.length + ' 条：' + mitReaders.join(' / '))
ok('许可证入口不再写死 whale', !licTexts.some((t) => t.indexOf('素材来源说明') >= 0 && t.indexOf('MIT 许可证原文') >= 0 && licTexts.length < 2),
  licTexts.join(' | ').slice(0, 200))
// 关掉，避免影响后续
const aboutClose = aboutBox && aboutBox.children.filter((c) => String(c.className).indexOf('dshpet-about-actions') >= 0)[0]
if (aboutClose) { click(aboutClose.children[0]); await flush(4) }
ok('关于对话框可关闭', !doc.body.children.some((c) => c.id === 'dshpet-about'))

console.log('')
console.log('=== 回归：隐藏桌宠必须是可逆的 ===')
// 背景（用户报的真 bug）：隐藏后 container 变 display:none，桌宠自己的右键菜单
// 再也打不开；而「显示桌宠」原来**只**存在于那个菜单里 ⇒ 隐藏 = 单程票，
// 只能手动改 localStorage 才能恢复。
const rootEl = doc.body.children.filter((c) => c.id === 'dshpet-root')[0]
ok('找得到桌宠容器', !!rootEl)

// ① 隐藏**之前**菜单就得写明怎么恢复
await openMenu()
const hideRow = rowBy(menuRoot, '隐藏桌宠')
ok('菜单有「隐藏桌宠」', !!hideRow)
ok('「隐藏桌宠」上写明了恢复热键', !!hideRow && hideRow.textContent.includes('Ctrl+Shift+H'),
  hideRow ? hideRow.textContent : '(没有这一项)')
if (hideRow) { click(hideRow); await flush(6) }
ok('点「隐藏桌宠」后容器 display:none', rootEl.style.display === 'none', String(rootEl.style.display))

// ② 隐藏后右键**页面任意位置**要能唤出恢复菜单（不能只在角色像素上）
doc.fire('contextmenu', { button: 2, clientX: 900, clientY: 420 })
await flush(6)
ok('隐藏后右键页面任意位置能唤出菜单', menuRoot.style.display === 'block', String(menuRoot.style.display))
const showRow = rowBy(menuRoot, '显示桌宠')
ok('恢复菜单里有「显示桌宠」', !!showRow, rowsOf(menuRoot).map((r) => r.textContent).join(' | '))
if (showRow) { click(showRow); await flush(6) }
ok('点「显示桌宠」后容器恢复 display:block', rootEl.style.display === 'block', String(rootEl.style.display))

// ③ Ctrl+Shift+H 热键：任何时候都能切换（不必右键、不必知道菜单在哪）
doc.fire('keydown', { ctrlKey: true, shiftKey: true, key: 'h' })
await flush(4)
ok('Ctrl+Shift+H 能隐藏', rootEl.style.display === 'none', String(rootEl.style.display))
doc.fire('keydown', { ctrlKey: true, shiftKey: true, key: 'h' })
await flush(4)
ok('Ctrl+Shift+H 能把桌宠叫回来', rootEl.style.display === 'block', String(rootEl.style.display))

// ④ 不该误触发
doc.fire('keydown', { key: 'h' })
await flush(4)
ok('单独按 H 不会隐藏桌宠', rootEl.style.display === 'block', String(rootEl.style.display))
doc.fire('keydown', { ctrlKey: true, key: 'h' })
await flush(4)
ok('Ctrl+H 不会隐藏桌宠（必须带 Shift）', rootEl.style.display === 'block', String(rootEl.style.display))
doc.fire('keydown', { ctrlKey: true, shiftKey: true, altKey: true, key: 'h' })
await flush(4)
ok('Ctrl+Shift+Alt+H 不会隐藏桌宠', rootEl.style.display === 'block', String(rootEl.style.display))

// ⑤ 在输入框里打字时不能抢键
const fakeInput = doc.createElement('input')
doc.fire('keydown', { ctrlKey: true, shiftKey: true, key: 'h', target: fakeInput })
await flush(4)
ok('在输入框里按 Ctrl+Shift+H 不会抢键', rootEl.style.display === 'block', String(rootEl.style.display))

// ⑥ 恢复之后功能正常：可见时右键**空白处**仍然不该弹菜单（不能因为修 bug 就到处接管右键）
doc.fire('contextmenu', { button: 2, clientX: 900, clientY: 420 })
await flush(4)
ok('可见时右键空白处不会弹出菜单', menuRoot.style.display !== 'block', String(menuRoot.style.display))
// 而右键桌宠本体照常
await openMenu()
ok('恢复后桌宠本体的右键菜单正常', menuRoot.style.display === 'block' &&
  rowsOf(menuRoot).length > 10, rowsOf(menuRoot).length + ' 项')

// ⑦ 隐藏时唤出的恢复菜单，点空白处应当能关掉
click(hideRow || rowBy(menuRoot, '隐藏桌宠'))
await flush(6)
doc.fire('contextmenu', { button: 2, clientX: 700, clientY: 300 })
await flush(6)
ok('隐藏后能唤出恢复菜单（第二次）', menuRoot.style.display === 'block', String(menuRoot.style.display))
doc.fire('pointerdown', { button: 0, clientX: 200, clientY: 200 })
await flush(4)
ok('恢复菜单点空白处能关掉', menuRoot.style.display !== 'block', String(menuRoot.style.display))
// 收尾：把桌宠叫回来
doc.fire('keydown', { ctrlKey: true, shiftKey: true, key: 'h' })
await flush(4)
ok('收尾：桌宠已恢复显示', rootEl.style.display === 'block', String(rootEl.style.display))

console.log('')
console.log('运行期错误: ' + (runtimeErrors.length ? runtimeErrors.slice(0, 3).join(' | ') : '（无）'))
console.log('结果: ' + pass + ' 通过 / ' + fails.length + ' 失败')
if (fails.length) { console.log('失败项:'); fails.forEach((f) => console.log('  - ' + f)) }
process.exit(fails.length ? 1 : 0)
