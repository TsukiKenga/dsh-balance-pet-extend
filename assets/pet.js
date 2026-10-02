// ============================================================================
// dsh-balance-pet-extend —— 浏览器半区（桌宠绘制 / 动画 / 交互）
// ============================================================================
// 改写自 macOS 原生版桌宠（VK-1 的 macOS 移植版，Swift + AppKit）。
// 原版没有任何序列帧：每个角色就是**一张静态 1536×1024 PNG**，所有动画都是
// 过程式的（震动 / 红闪 / 飘字 / 充值光环）。所以这里用 <canvas> 逐帧重绘，
// 而不是 CSS 动画 —— 原版是把震动施加在**整个上下文**上的，精灵和文字一起抖，
// canvas 能一比一复刻这一点。
//
// 关键常量全部照搬原版，改之前先回去读 PetModel.swift / PetView.swift / PetLayout.swift。
// ============================================================================
(function () {
if (window.__dshBalancePet) return
window.__dshBalancePet = true

var PREFIX = '/dsh-pet'

// —— 原版常量（PetModel / PetView / PetLayout）——
var HIT_DURATION = 0.55      // shakeTime / flashTime 初值
var STEP_INTERVAL = 0.2      // 每 0.01 元的节拍
var FLOAT_LIFE = 0.95        // 飘字寿命
var TOPUP_DURATION = 0.9     // 充值光环时长
var MAX_PENDING_STEPS = 400  // 超过直接对齐，不放积压动画
var MAX_DEMO_STEPS = 200
var DEMO_RESTORE = 0.55      // 演示结束后停留时间
var ALPHA_MIN = 8 / 255      // 命中阈值（原版 alphaComponent > 8.0/255.0）
var MASK_W = 384, MASK_H = 256   // 命中掩码分辨率（原图 1/4）
var SNAP_DURATION = 0.16     // 吸附动画（原版 easeOut 0.16s）
var ANCHOR_MARGIN = 14       // 距屏幕边缘 14pt

var SIZE_PRESETS = [110, 150, 210, 280]
var POLL_OPTIONS = [10, 30, 60, 300]
var SOUND_POOL = 4
var SOUND_VOLUME = 0.7

// 平板文字（原版 PetView 的 panelHeight 比例）
var PANEL_TITLE_RATIO = 0.21     // "DSH 余额" 字号
var PANEL_CUR_RATIO = 0.27       // "¥ " 字号
var PANEL_AMOUNT_RATIO = 0.48    // 金额数字字号
var PANEL_ROW_RATIO = 0.32       // 金额行位置（自面板底部）
var PANEL_TITLE_Y_RATIO = 0.80   // 标题位置（自面板底部）
var PANEL_MAX_TEXT_RATIO = 0.90  // 金额行超过面板宽度 90% 就整体缩放
// 标题的上限比金额行更紧：右上角有状态点，标题铺满 90% 会压到它上面。
// 状态点中心 0.92、半径 15/2，标题右缘要停在它左边 → 上限取 0.76。
var PANEL_TITLE_MAX_RATIO = 0.76
var DOT_SIZE = 15, DOT_X_RATIO = 0.92, DOT_Y_RATIO = 0.77

var C_LABEL = 'rgb(158,184,227)'      // srgb(0.62,0.72,0.89)
var C_VALUE = 'rgb(240,247,255)'      // srgb(0.94,0.97,1)
var C_VALUE_OFF = 'rgb(173,186,207)'  // srgb(0.68,0.73,0.81)
var C_FLASH = 'rgba(255,26,36,'       // srgb(1,0.10,0.14)
var C_HIT = '#ff3b30'                 // systemRed
var C_TOPUP = '#34c759'               // systemGreen

// —— 喜报 / 累计计费结算（新增）——
var CELEBRATE_DURATION = 0.9     // 庆祝红闪时长（比扣费的 0.55 略长）
var CELEBRATE_SHAKE_SCALE = 0.45 // 庆祝震动幅度（比扣费轻）
var TURN_POLL_MS = 2000          // 每轮消耗轮询
var LEDGER_POLL_MS = 15000       // 累计账本轮询
var TURN_BUBBLE_MS = 6000        // 喜报气泡停留
var SETTLE_AUTOCLOSE_MS = 15000  // 结算页无操作自动关闭
var C_REPORT = '#e0161a'         // 喜报红
// Certificate.png 中部黄色区域（1671×941 上实测标定：避开顶部「喜 报」横幅与左右红幕布）
var CERT_W = 1671, CERT_H = 941
var CERT_BOX = { x: 352, y: 205, w: 978, h: 567 }
var C_CERT_INK = '#9c1608'       // 结算正文墨色（暗红，贴近「喜 报」用色）

var STORE_KEY = 'dshBalancePet.state.v1'

// —— 持久化状态 ——
var state = {
  character: 'fish',
  sizeIndex: 1,
  soundOn: true,
  snapOnRelease: true,
  pollSeconds: 30,
  hidden: false,
  source: 'deepseek',   // 平板显示哪个 API 的余额（右键菜单可切）
  x: null,
  y: null,
}
function loadState() {
  try {
    var raw = localStorage.getItem(STORE_KEY)
    if (!raw) return
    var o = JSON.parse(raw)
    if (!o || typeof o !== 'object') return
    if (typeof o.character === 'string') state.character = o.character
    if (typeof o.sizeIndex === 'number' && o.sizeIndex >= 0 && o.sizeIndex < SIZE_PRESETS.length) state.sizeIndex = o.sizeIndex
    if (typeof o.soundOn === 'boolean') state.soundOn = o.soundOn
    if (typeof o.snapOnRelease === 'boolean') state.snapOnRelease = o.snapOnRelease
    if (typeof o.pollSeconds === 'number') state.pollSeconds = clampPoll(o.pollSeconds)
    if (typeof o.source === 'string' && o.source) state.source = o.source
    if (typeof o.hidden === 'boolean') state.hidden = o.hidden
    if (typeof o.x === 'number' && isFinite(o.x)) state.x = o.x
    if (typeof o.y === 'number' && isFinite(o.y)) state.y = o.y
  } catch (err) {}
}
function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)) } catch (err) {}
}
function clampPoll(s) {
  s = Number(s)
  if (!isFinite(s)) return 30
  return Math.min(300, Math.max(10, s))
}

// —— 运行时 ——
var manifest = null
var charsById = {}
var sources = []       // 可选余额来源（宿主下发）
var sourceLabel = 'DSH 余额'
var images = {}     // filename -> HTMLImageElement
var masks = {}      // filename -> {data, w, h}
var sounds = []     // Audio pool
var soundIndex = 0

var container = null, canvas = null, ctx = null, menuEl = null
var W = 0, H = 0, side = 150, spriteRect = { x: 0, y: 0, w: 0, h: 0 }
var destroyed = false

// —— 余额 / 动画状态（照搬 PetModel）——
var realCents = null      // 最近一次服务器读数
var bookedCents = null    // 动画中的显示值
var pendingSteps = 0
var demoRemaining = 0
var demoOffset = 0
var demoRestoreTime = 0
var stepCooldown = 0
var shakeTime = 0
var topupTime = 0
var floating = []         // { text, color, age }
var connected = false
var lastError = null
var currency = 'CNY'
var animating = false
var lastFrame = 0
var snapAnim = null       // { fromX, fromY, toX, toY, t }
var dragging = null

// —— 轮询状态（照搬 PollSchedule）——
var inFlight = false
var nextPollAt = 0
var retryNotBefore = 0
var backoff = 30
var generation = 0
// 断线 → 恢复时的第一次读数直接对齐，不补播断线期间攒下的扣费动画
var previousWasDisconnected = false

// —— 喜报 / 累计计费 运行时 ——
var celebrateTime = 0          // >0 时角色红闪庆祝
var lastTurnSeq = null         // null = 还没拿到基线，首个回合不弹（避免刚进页面就弹历史）
var turnBubble = null          // { el, hideAt }
var turnSound = null, settleSound = null
var ledgerCache = null         // 最近一次 /ledger.json
var ledgerInFlight = false
var settleOverlay = null       // { root, timer }
var audioUnlocked = false

// —— 来源形态：金额类（balance）vs 订阅额度类（quota）——
var sourceKind = 'balance'
var quotaRemain = null         // 0..100（宿主已统一换算成「剩余 %」）
var quotaLabel = ''
// —— 节假日清单状态（宿主下发，用于过期/跨年提示）——
var holidayStatus = null
var holidayOverlay = null

function log() {
  try { console.log.apply(console, ['[dsh-pet]'].concat([].slice.call(arguments))) } catch (err) {}
}

// ============================================================================
// 布局
// ============================================================================
function layout() {
  side = SIZE_PRESETS[state.sizeIndex] || 150
  W = side * 1.5
  H = side * 1.55
  var sw = side * 0.94 * 1.5
  var sh = side * 0.94
  spriteRect = { x: (W - sw) / 2, y: H - 0.03 * side - sh, w: sw, h: sh }
}

// 原版：屏幕上大于等于 side 的那条带才接受点击（画布坐标里就是 y >= H - side）
function inBodyBand(yCanvas) { return yCanvas >= H - side }

// ============================================================================
// 素材
// ============================================================================
// key 用**裸文件名**（与 masks / hitTest 一致），url 才是请求地址。
// 之前按 url 缓存、按文件名取，结果精灵永远取不到 → 一直走"缺少角色图片"。
function loadImage(key, url) {
  return new Promise(function (resolve) {
    if (images[key]) return resolve(images[key])
    var img = new Image()
    img.onload = function () { images[key] = img; resolve(img) }
    img.onerror = function () { resolve(null) }
    img.src = url
  })
}

// 逐像素 alpha 掩码：命中判定用（原版读的是 PNG 自身的 alpha）
function buildMask(src, img) {
  return new Promise(function (resolve) {
    if (masks[src]) return resolve(masks[src])
    try {
      var c = document.createElement('canvas')
      c.width = MASK_W; c.height = MASK_H
      var g = c.getContext('2d')
      g.drawImage(img, 0, 0, MASK_W, MASK_H)
      var d = g.getImageData(0, 0, MASK_W, MASK_H).data
      masks[src] = { data: d, w: MASK_W, h: MASK_H }
      resolve(masks[src])
    } catch (err) {
      // 跨域/受污染的画布：退化成"整个 spriteRect 都可点"
      masks[src] = null
      resolve(null)
    }
  })
}

function activeChar() {
  if (!manifest) return null
  return charsById[state.character] || charsById[manifest.defaultCharacter] || null
}

function activeSpriteFile() {
  var ch = activeChar()
  if (!ch) return null
  // 原版：只有大肥鱼在未连接时换抱盆图，其他角色离线也保持原样
  if (ch.offlineSprite && !connected && ch.id === 'fish') return ch.offlineSprite
  return ch.sprite
}

// 画布坐标 → 命中判定
function hitTest(cx, cy) {
  if (!inBodyBand(cy)) return false
  if (cx < spriteRect.x || cx > spriteRect.x + spriteRect.w) return false
  if (cy < spriteRect.y || cy > spriteRect.y + spriteRect.h) return false
  var f = activeSpriteFile()
  var m = f ? masks[f] : null
  if (!m) return true // 取不到掩码就整块可点（退化但可用）
  var nx = (cx - spriteRect.x) / spriteRect.w
  var ny = (cy - spriteRect.y) / spriteRect.h
  var px = Math.min(m.w - 1, Math.max(0, Math.floor(nx * m.w)))
  var py = Math.min(m.h - 1, Math.max(0, Math.floor(ny * m.h)))
  return m.data[(py * m.w + px) * 4 + 3] / 255 > ALPHA_MIN
}

// ============================================================================
// 绘制
// ============================================================================
function ensureCanvasSize() {
  var dpr = Math.min(3, window.devicePixelRatio || 1)
  var pw = Math.round(W * dpr), ph = Math.round(H * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw; canvas.height = ph
  }
  canvas.style.width = W + 'px'
  canvas.style.height = H + 'px'
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return dpr
}

function fenString(cents) {
  if (cents === null || cents === undefined || !isFinite(cents)) return '--'
  var neg = cents < 0
  var a = Math.abs(Math.round(cents))
  var yuan = Math.floor(a / 100)
  var frac = a % 100
  return (neg ? '-' : '') + yuan + '.' + (frac < 10 ? '0' : '') + frac
}

// 币种符号：原版只做人民币，现在来源可切，不能给美元硬套 ¥
function currencySymbol(cur) {
  var c = String(cur || '').toUpperCase()
  if (c === 'CNY' || c === 'RMB') return '¥'
  if (c === 'USD') return '$'
  if (c === 'EUR') return '€'
  if (c === 'JPY') return 'JP¥'
  return c ? c : '¥'
}

function displayedCents() {
  if (bookedCents === null) return null
  return Math.max(Math.min(0, bookedCents), bookedCents - demoOffset)
}

function draw() {
  if (!ctx) return
  var dpr = Math.min(3, window.devicePixelRatio || 1)
  ensureCanvasSize()
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, H)

  var ch = activeChar()
  var file = activeSpriteFile()
  var img = file ? images[file] : null

  // 震动：原版施加在**整个上下文**上，所以精灵和文字一起抖。
  // 这里不真的去 translate，而是把同一个偏移量分别喂给精灵和仿射矩阵 ——
  // 平板用的是 setTransform（绝对矩阵），先 translate 会被它整个顶掉。
  var shakeX = 0, shakeY = 0
  var shElapsed = 0, shAmp = 0, shDecay = 0
  if (shakeTime > 0) {
    // 扣费：原版参数，不动
    shElapsed = HIT_DURATION - shakeTime
    shAmp = Math.min(3.2, side * 0.025)
    shDecay = Math.max(0, shakeTime / HIT_DURATION)
  } else if (celebrateTime > 0) {
    // 喜报庆祝：曲线同源，但时长更长、幅度更轻（庆祝语气，不是挨打）
    shElapsed = CELEBRATE_DURATION - celebrateTime
    shAmp = Math.min(3.2, side * 0.025) * CELEBRATE_SHAKE_SCALE
    shDecay = Math.max(0, celebrateTime / CELEBRATE_DURATION)
  }
  if (shAmp > 0) {
    shakeX = Math.sin(shElapsed * 24) * shAmp * shDecay
    shakeY = Math.cos(shElapsed * 19) * shAmp * 0.875 * shDecay
  }

  var sx = spriteRect.x + shakeX
  var sy = spriteRect.y + shakeY

  if (img) {
    ctx.drawImage(img, sx, sy, spriteRect.w, spriteRect.h)
    // 红闪：source-atop 只覆盖不透明像素，保住精灵轮廓（原版 blendMode = .sourceAtop）
    var impact = Math.max(flashImpact(), celebrateImpact())
    if (impact > 0) {
      ctx.globalCompositeOperation = 'source-atop'
      ctx.fillStyle = C_FLASH + (0.45 * impact) + ')'
      ctx.fillRect(sx, sy, spriteRect.w, spriteRect.h)
      ctx.globalCompositeOperation = 'source-over'
    }
  } else {
    // 缺图兜底（原版行为）：圆角块 + 提示，保证右键菜单还够得着
    ctx.fillStyle = 'rgba(246,248,253,0.9)'
    roundRect(ctx, sx, sy, spriteRect.w, spriteRect.h, 12)
    ctx.fill()
    ctx.fillStyle = '#9fb0d9'
    ctx.font = 'bold ' + (side * 0.08) + 'px system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('缺少角色图片', sx + spriteRect.w / 2, sy + spriteRect.h / 2)
  }

  // 抱盆状态下完全不画平板（原版：标题/余额/状态点/飘字都没有）
  var offlineArt = !!(ch && ch.offlineSprite && ch.id === 'fish' && !connected)
  if (img && ch && !offlineArt) drawTablet(ch, shakeX, shakeY, dpr)

  // 光环与飘字用不带震动的基准变换
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawTopupRing()
  drawFloating()
}

function flashImpact() {
  if (shakeTime <= 0) return 0
  var elapsed = HIT_DURATION - shakeTime
  if (elapsed < 0.08) return Math.min(1, elapsed / 0.08)
  return Math.max(0, 1 - (elapsed - 0.08) / (HIT_DURATION - 0.08))
}

// 喜报庆祝的红闪：同一条曲线（快速起、线性落），只是把时间轴拉长到 0.9 秒
function celebrateImpact() {
  if (celebrateTime <= 0) return 0
  var elapsed = CELEBRATE_DURATION - celebrateTime
  if (elapsed < 0.10) return Math.min(1, elapsed / 0.10)
  return Math.max(0, 1 - (elapsed - 0.10) / (CELEBRATE_DURATION - 0.10))
}

// 平板仿射：把 400×220 的面板坐标直接映射到设备像素。
// 推导用原图左上角为原点、y 向下；已用原版文档记录的右下角 (1443,834)/(1430,836) 验证过。
// 注意要把 dpr、震动偏移一起揉进矩阵，否则 setTransform 会把它们抹掉。
function drawTablet(ch, shakeX, shakeY, dpr) {
  var panel = manifest.panel || { w: 400, h: 220 }
  var c = ctx
  var pw = panel.w, ph = panel.h
  var s = spriteRect.w / 1536
  var TL = ch.tablet.tl, TR = ch.tablet.tr, BL = ch.tablet.bl
  var a = (TR[0] - TL[0]) / pw * s
  var b = (TR[1] - TL[1]) / pw * s
  var cc = (BL[0] - TL[0]) / ph * s
  var d = (BL[1] - TL[1]) / ph * s
  var e = spriteRect.x + shakeX + TL[0] * s
  var f = spriteRect.y + shakeY + TL[1] * s
  c.setTransform(dpr * a, dpr * b, dpr * cc, dpr * d, dpr * e, dpr * f)

  // 金额类显示钱；订阅额度类没有金额，显示「剩余 %」（宿主已把各家的
  // 「已用 %」「剩余 %」两种语义统一成剩余百分比）
  var isQuota = sourceKind === 'quota'
  var value = isQuota
    ? (quotaRemain === null || !isFinite(quotaRemain) ? '--' : Math.round(quotaRemain) + '%')
    : fenString(displayedCents())
  var isConn = connected

  // 标题：DeepSeek 用原版的"DSH 余额"，其它来源显示该来源名。
  // 面板只有 400 宽，名字长了就等比缩小，别顶出平板。
  // 原版标题 y 自**面板底部**起算，面板坐标系 y 向下，所以这里翻过来。
  var titleSize = ph * PANEL_TITLE_RATIO
  var titleMax = pw * PANEL_TITLE_MAX_RATIO
  c.font = 'bold ' + titleSize + 'px system-ui, "Segoe UI", sans-serif'
  var titleW = c.measureText(sourceLabel).width
  if (titleW > titleMax) titleSize = titleSize * titleMax / titleW
  c.textAlign = 'center'
  c.textBaseline = 'middle'
  c.fillStyle = C_LABEL
  c.font = 'bold ' + titleSize + 'px system-ui, "Segoe UI", sans-serif'
  c.fillText(sourceLabel, pw / 2, ph - ph * PANEL_TITLE_Y_RATIO)

  // 金额行：币种符号与数字两个字号；整行超过面板宽度 90% 就整体缩放
  var amtSize = ph * PANEL_AMOUNT_RATIO
  var curSize = ph * PANEL_CUR_RATIO
  var curText = isQuota ? '剩余 ' : currencySymbol(currency) + ' '
  c.font = 'bold ' + amtSize + 'px ui-monospace, "SF Mono", Consolas, monospace'
  var amtW = c.measureText(value).width
  c.font = 'bold ' + curSize + 'px system-ui, "Segoe UI", sans-serif'
  var curW = c.measureText(curText).width
  var total = curW + amtW
  var maxW = pw * PANEL_MAX_TEXT_RATIO
  var scale = total > maxW ? maxW / total : 1

  var rowY = ph - ph * PANEL_ROW_RATIO
  c.save()
  c.translate((pw - total * scale) / 2, rowY)
  c.scale(scale, scale)
  c.textAlign = 'left'
  c.textBaseline = 'middle'
  c.fillStyle = C_LABEL
  c.font = 'bold ' + curSize + 'px system-ui, "Segoe UI", sans-serif'
  c.fillText(curText, 0, 0)
  c.fillStyle = isConn ? C_VALUE : C_VALUE_OFF
  c.font = 'bold ' + amtSize + 'px ui-monospace, "SF Mono", Consolas, monospace'
  c.fillText(value, curW, 0)
  c.restore()

  // 状态点：绿=已连接，黄=未连接且无错误，红=有错误
  c.beginPath()
  c.arc(pw * DOT_X_RATIO, ph - ph * DOT_Y_RATIO, DOT_SIZE / 2, 0, Math.PI * 2)
  c.fillStyle = lastError ? '#ff3b30' : (isConn ? '#34c759' : '#ffcc00')
  c.fill()

  c.setTransform(dpr, 0, 0, dpr, 0, 0)
}

function drawTopupRing() {
  if (topupTime <= 0) return
  var progress = 1 - topupTime / TOPUP_DURATION
  var inset = side * (0.03 + 0.06 * (1 - progress))
  var r = {
    x: spriteRect.x + inset, y: spriteRect.y + inset,
    w: spriteRect.w - inset * 2, h: spriteRect.h - inset * 2,
  }
  if (r.w <= 0 || r.h <= 0) return
  ctx.save()
  ctx.globalAlpha = Math.max(0, 0.8 * (1 - progress))
  ctx.strokeStyle = C_TOPUP
  ctx.lineWidth = side * 0.015
  roundRect(ctx, r.x, r.y, r.w, r.h, side * 0.05)
  ctx.stroke()
  ctx.restore()
}

function drawFloating() {
  if (!floating.length) return
  var size = side * 0.080
  var yStart = H - side           // 原版自"脚下"起飘
  var yEnd = side * 0.10          // 到窗口顶部留 0.10*side
  ctx.save()
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = '900 ' + size + 'px ui-monospace, "SF Mono", Consolas, monospace'
  for (var i = 0; i < floating.length; i++) {
    var lb = floating[i]
    var progress = Math.min(1, lb.age / FLOAT_LIFE)
    var alpha = Math.max(0, 1 - Math.pow(progress, 1.6))
    if (alpha <= 0) continue
    var tw = ctx.measureText(lb.text).width
    var x = Math.max(0, Math.min(W - tw, W - 0.5 * side - tw / 2))
    var y = yStart + (yEnd - yStart) * progress
    ctx.globalAlpha = alpha
    ctx.shadowColor = 'rgba(0,0,0,' + (0.4 * alpha) + ')'
    ctx.shadowBlur = side * 0.022
    ctx.fillStyle = lb.color
    ctx.fillText(lb.text, x, y)
  }
  ctx.restore()
}

function roundRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2)
  c.beginPath()
  c.moveTo(x + r, y)
  c.arcTo(x + w, y, x + w, y + h, r)
  c.arcTo(x + w, y + h, x, y + h, r)
  c.arcTo(x, y + h, x, y, r)
  c.arcTo(x, y, x + w, y, r)
  c.closePath()
}

// ============================================================================
// 模型（PetModel.tick 的直译）
// ============================================================================
function forceSnapToReal() {
  bookedCents = realCents
  pendingSteps = 0
  demoRemaining = 0
  demoOffset = 0
  demoRestoreTime = 0
}

function appendLabel(text, color) {
  floating.push({ text: text, color: color, age: 0 })
  while (floating.length > 60) floating.shift()
  wake()
}

function playSound() {
  if (!state.soundOn) return
  try {
    if (!sounds.length) {
      for (var i = 0; i < SOUND_POOL; i++) {
        var a = new Audio(PREFIX + '/hit.mp3')
        a.preload = 'auto'
        a.volume = SOUND_VOLUME
        sounds.push(a)
      }
    }
    soundIndex = (soundIndex + 1) % sounds.length
    var s = sounds[soundIndex]
    try { s.pause(); s.currentTime = 0 } catch (err) {}
    var p = s.play()
    if (p && p.catch) p.catch(function () {})
  } catch (err) {}
}

function oneStep() {
  shakeTime = HIT_DURATION
  appendLabel('-0.01', C_HIT)
  playSound()
}

// 一次"扣费节拍"。真实扣费优先于演示（原版顺序，不要调换）
function tick(dt) {
  if (!isFinite(dt) || dt < 0) dt = 0
  dt = Math.min(dt, 0.1) // 唤醒/卡顿后只推进一步，不补播几百次

  if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - dt)
  if (celebrateTime > 0) celebrateTime = Math.max(0, celebrateTime - dt)
  if (topupTime > 0) topupTime = Math.max(0, topupTime - dt)
  if (demoRestoreTime > 0) {
    demoRestoreTime = Math.max(0, demoRestoreTime - dt)
    if (demoRestoreTime === 0) demoOffset = 0
  }

  for (var i = floating.length - 1; i >= 0; i--) {
    floating[i].age += dt
    if (floating[i].age >= FLOAT_LIFE) floating.splice(i, 1)
  }

  stepCooldown -= dt
  if (stepCooldown <= 1e-9) {
    var did = false
    if (pendingSteps > 0 && bookedCents !== null && realCents !== null && bookedCents > realCents) {
      bookedCents -= 1
      pendingSteps -= 1
      did = true
    } else if (demoRemaining > 0) {
      demoRemaining -= 1
      demoOffset += 1
      if (demoRemaining === 0) demoRestoreTime = DEMO_RESTORE
      did = true
    } else {
      pendingSteps = 0
    }
    if (did) {
      // 保留小数余量，否则 60Hz 下每拍会被拉长到 13 帧
      stepCooldown = Math.max(0, stepCooldown + STEP_INTERVAL)
      oneStep()
    }
  }

  if (snapAnim) {
    snapAnim.t += dt
    var p = Math.min(1, snapAnim.t / SNAP_DURATION)
    var e = 1 - Math.pow(1 - p, 3) // easeOut
    state.x = snapAnim.fromX + (snapAnim.toX - snapAnim.fromX) * e
    state.y = snapAnim.fromY + (snapAnim.toY - snapAnim.fromY) * e
    place()
    if (p >= 1) { snapAnim = null; saveState() }
    return true
  }

  return needsAnimation()
}

function needsAnimation() {
  return shakeTime > 0 || celebrateTime > 0 || topupTime > 0 || demoRestoreTime > 0 ||
    floating.length > 0 || pendingSteps > 0 || demoRemaining > 0 || !!snapAnim
}

function frame(ts) {
  if (destroyed) return
  if (!lastFrame) lastFrame = ts
  var dt = (ts - lastFrame) / 1000
  lastFrame = ts
  var busy = tick(dt)
  draw()
  if (busy) {
    requestAnimationFrame(frame)
  } else {
    animating = false
  }
}

function wake() {
  if (animating || destroyed) return
  animating = true
  lastFrame = 0
  requestAnimationFrame(frame)
}

// —— 应用一次服务器读数（PetModel.apply 的直译）——
function applyReading(cents, snap) {
  var previousReal = realCents
  realCents = cents
  if (snap || previousReal === null || bookedCents === null) {
    forceSnapToReal()
    wake()
    return
  }
  if (cents > previousReal) {
    // 充值：对齐 + 绿字，delta 是相对**上一次服务器读数**
    var delta = cents - previousReal
    forceSnapToReal()
    topupTime = TOPUP_DURATION
    appendLabel('+' + fenString(delta), C_TOPUP)
    wake()
    return
  }
  if (cents < bookedCents) {
    var steps = bookedCents - cents
    if (!isFinite(steps) || steps > MAX_PENDING_STEPS) {
      forceSnapToReal()
      wake()
      return
    }
    pendingSteps = steps
  } else {
    pendingSteps = 0
  }
  wake()
}

// ============================================================================
// 轮询（PollSchedule 的直译）
// ============================================================================
function pollOnce(snap, force) {
  if (inFlight) return Promise.resolve()
  var now = Date.now()
  if (now < retryNotBefore) return Promise.resolve()
  inFlight = true
  var myGen = generation
  var url = PREFIX + '/balance.json?source=' + encodeURIComponent(state.source)
  if (force) url += '&refresh=1'
  return fetch(url, { credentials: 'same-origin', cache: 'no-store' })
    .then(function (res) {
      if (res.status === 429) {
        var ra = parseRetryAfter(res.headers.get('Retry-After'))
        if (ra !== null && isFinite(ra) && ra >= 0) backoff = Math.max(10, ra)
        else backoff = Math.min(300, Math.max(state.pollSeconds, backoff * 2))
        retryNotBefore = Date.now() + backoff * 1000
        throw new Error('HTTP 429')
      }
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json()
    })
    .then(function (j) {
      if (myGen !== generation) return // 重新读凭据后旧结果丢弃
      if (!j || !j.ok) {
        connected = false
        previousWasDisconnected = true
        lastError = (j && j.error) || '余额获取失败'
        draw()
        return
      }
      connected = true
      lastError = null
      if (j.currency) currency = j.currency
      // 订阅额度类：没有金额，只有「剩余 %」，因此不参与扣费动画
      if (j.kind === 'quota') {
        sourceKind = 'quota'
        var rem = Number(j.remainPercent)
        quotaRemain = isFinite(rem) ? rem : null
        quotaLabel = String(j.label || '')
        previousWasDisconnected = false
        if (!animating) draw()
        return
      }
      sourceKind = 'balance'
      quotaRemain = null
      var cents = Math.round(Number(j.totalBalance) * 100)
      if (!isFinite(cents)) {
        connected = false; previousWasDisconnected = true; lastError = '余额数值异常'; draw(); return
      }
      // 断线后的第一次读数直接对齐，不补播积压动画
      applyReading(cents, snap || previousWasDisconnected)
      previousWasDisconnected = false
      if (!animating) draw()
    })
    .catch(function (err) {
      if (myGen !== generation) return
      connected = false
      previousWasDisconnected = true
      lastError = String((err && err.message) || err)
      if (!animating) draw()
    })
    .then(function () {
      inFlight = false
      if (myGen !== generation) return
      backoff = state.pollSeconds
      retryNotBefore = 0
      nextPollAt = Date.now() + state.pollSeconds * 1000
    })
}

function parseRetryAfter(v) {
  if (!v) return null
  v = String(v).trim()
  if (/^\d+$/.test(v)) return Math.min(86400, Number(v))
  var t = Date.parse(v)
  if (!isNaN(t)) return Math.min(86400, Math.max(0, (t - Date.now()) / 1000))
  return null
}

function pollLoop() {
  if (destroyed) return
  var now = Date.now()
  if (!inFlight && now >= nextPollAt && now >= retryNotBefore) {
    pollOnce(false)
  }
  setTimeout(pollLoop, 1000)
}

// —— 切换余额来源 ——
function applySourceMeta() {
  var found = null
  for (var i = 0; i < sources.length; i++) if (sources[i].id === state.source) found = sources[i]
  sourceLabel = (!found || found.builtin) ? 'DSH 余额' : String(found.name || 'DSH 余额')
}

function setSource(id) {
  if (!id || id === state.source) return
  state.source = id
  applySourceMeta()
  saveState()
  // 换来源 = 换币种 / 换量纲：动画状态全部清空，下一轮直接对齐，绝不能和旧来源的数字做差
  realCents = null
  bookedCents = null
  pendingSteps = 0
  demoRemaining = 0
  demoOffset = 0
  demoRestoreTime = 0
  floating = []
  shakeTime = 0
  topupTime = 0
  stepCooldown = 0
  connected = false
  lastError = null
  currency = 'CNY'
  sourceKind = 'balance'
  quotaRemain = null
  quotaLabel = ''
  previousWasDisconnected = true
  nextPollAt = 0
  draw()
  pollOnce(true, true)
}

// ============================================================================
// 定位与放置
// ============================================================================
function place() {
  if (!container) return
  var maxX = Math.max(0, window.innerWidth - W - ANCHOR_MARGIN)
  var maxY = Math.max(0, window.innerHeight - H - ANCHOR_MARGIN)
  var x = state.x === null ? ANCHOR_MARGIN : state.x
  var y = state.y === null ? (window.innerHeight - H - ANCHOR_MARGIN) : state.y
  x = Math.max(0, Math.min(maxX, x))
  y = Math.max(ANCHOR_MARGIN, Math.min(maxY, y))
  state.x = x; state.y = y
  container.style.left = Math.round(x) + 'px'
  container.style.top = Math.round(y) + 'px'
}

function snapToCorner() {
  snapAnim = {
    fromX: state.x === null ? ANCHOR_MARGIN : state.x,
    fromY: state.y === null ? (window.innerHeight - H - ANCHOR_MARGIN) : state.y,
    toX: ANCHOR_MARGIN,
    toY: window.innerHeight - H - ANCHOR_MARGIN,
    t: 0,
  }
  wake()
}

// ============================================================================
// 交互
// ============================================================================
function attachInteraction() {
  // 鼠标穿透：容器默认 pointer-events:none，只有落在不透明像素上才打开。
  // （canvas 自身永远 none，事件落在容器这个空盒子上。）
  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('contextmenu', onContextMenu, true)

  window.addEventListener('resize', onResize)
}

function localPoint(e) {
  var r = container.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top, rect: r }
}

function onPointerMove(e) {
  if (destroyed || !container || state.hidden) return
  if (dragging) return // 拖动中不切换穿透
  var p = localPoint(e)
  var inside = p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H
  var opaque = inside && hitTest(p.x, p.y)
  container.style.pointerEvents = opaque ? 'auto' : 'none'
}

function menuOpen() {
  return !!(menuEl && menuEl.root && menuEl.root.style.display === 'block')
}
var menuPos = { x: 0, y: 0 }
function isInMenu(target) {
  try { return !!(menuEl && menuEl.root && target && menuEl.root.contains(target)) } catch (err) { return false }
}

function onPointerDown(e) {
  if (destroyed || !container || state.hidden) return
  // 点在菜单上：**完全放行** —— 既不关菜单，也不触发拖动。
  // 曾经的写法是 `if (menuEl.sub) hideMenu()`：pointerdown 先于 click，菜单在
  // mousedown→mouseup 之间被 display:none 掉，元素不再渲染 ⇒ click 永远不派发，
  // 于是所有**子菜单项**（切换角色 / 尺寸 / 刷新间隔 / 演示连续扣费）全部点不动。
  if (isInMenu(e.target)) return
  if (menuOpen()) hideMenu()
  var p = localPoint(e)
  var inside = p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H
  if (!inside || !hitTest(p.x, p.y)) return

  if (e.button === 2 || e.ctrlKey) return // 右键交给 contextmenu

  // 原版：拖动要超过 2pt 才真的动，避免一次点击把摆好的位置蹭歪
  dragging = {
    startX: e.clientX, startY: e.clientY,
    origX: state.x, origY: state.y,
    moved: false,
  }
  container.style.pointerEvents = 'auto'
  window.addEventListener('pointermove', onDragMove, true)
  window.addEventListener('pointerup', onDragEnd, true)
  e.preventDefault()
}

function onDragMove(e) {
  if (!dragging) return
  var dx = e.clientX - dragging.startX
  var dy = e.clientY - dragging.startY
  if (!dragging.moved && Math.hypot(dx, dy) < 2) return
  dragging.moved = true
  snapAnim = null
  state.x = Math.max(0, Math.min(window.innerWidth - W, dragging.origX + dx))
  state.y = Math.max(0, Math.min(window.innerHeight - H, dragging.origY + dy))
  place()
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove, true)
  window.removeEventListener('pointerup', onDragEnd, true)
  var moved = dragging && dragging.moved
  dragging = null
  if (moved) {
    if (state.snapOnRelease) snapToCorner()
    else saveState()
  }
}

function onContextMenu(e) {
  if (destroyed || !container || state.hidden) return
  if (isInMenu(e.target)) { e.preventDefault(); return } // 菜单上再右键：只吞掉默认菜单
  var p = localPoint(e)
  var inside = p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H
  if (!inside || !hitTest(p.x, p.y)) return
  e.preventDefault()
  menuPos.x = e.clientX
  menuPos.y = e.clientY
  showMenu(e.clientX, e.clientY)
  // 菜单标签（累计计费是否勾选、结束计费的合计金额）依赖账本。先按缓存渲染保证响应快，
  // 账本回来时若菜单还开着就重渲染一次 —— 否则「刚结算完再打开」会看到过期的禁用态。
  readLedger().then(function () {
    if (menuOpen()) showMenu(menuPos.x, menuPos.y)
  })
}

function onResize() {
  layout()
  place()
  draw()
}

// ============================================================================
// 菜单
// ============================================================================
function hideMenu() {
  if (menuEl.root) menuEl.root.style.display = 'none'
}

function showMenu(cx, cy, sub) {
  var root = menuEl.root
  root.innerHTML = ''
  var items = (typeof sub === 'function' ? sub() : sub) || mainMenu()
  for (var i = 0; i < items.length; i++) {
    ;(function (it) {
      var row = document.createElement('div')
      row.className = 'dshpet-mi'
      row.textContent = it.label
      if (it.disabled) {
        row.style.opacity = '.45'
        row.style.cursor = 'default'
      } else {
        row.addEventListener('click', function (ev) {
          ev.stopPropagation()
          if (it.sub) { showMenu(cx, cy, it.sub()); return }
          hideMenu()
          try { it.run && it.run() } catch (err) {}
        })
      }
      root.appendChild(row)
    })(items[i])
  }
  root.style.display = 'block'
  root.style.left = '0px'
  root.style.top = '0px'
  var r = root.getBoundingClientRect()
  var x = Math.min(cx, window.innerWidth - r.width - 8)
  var y = Math.min(cy, window.innerHeight - r.height - 8)
  root.style.left = Math.max(8, x) + 'px'
  root.style.top = Math.max(8, y) + 'px'
}

function mainMenu() {
  var items = [
    { label: '切换角色 ▸', sub: function () {
      return ((manifest && manifest.characters) || []).map(function (c) {
        return {
          label: (c.id === state.character ? '✓ ' : '　') + c.name,
          run: function () { state.character = c.id; saveState(); refreshAssets() },
        }
      }).concat([{ label: '返回', sub: mainMenu }])
    } },
    { label: '余额来源 ▸', sub: function () {
      var list = sources.length ? sources : [{ id: 'deepseek', name: 'DeepSeek', builtin: true, hasKey: true }]
      return list.map(function (s) {
        // 宿主只下发**已配凭据**的来源，所以这里不需要再提示「未配置」。
        // 保留［额度］标记：那类显示的是订阅窗口百分比而不是钱。
        var mark = s.id === state.source ? '✓ ' : '　'
        var kind = s.kind === 'quota' ? '［额度］' : ''
        var best = s.bestEffort ? '［尽力而为］' : ''
        var name = s.builtin ? 'DSH 余额（DeepSeek）' : s.name
        return { label: mark + kind + best + name, run: function () { setSource(s.id) } }
      }).concat([{ label: '返回', sub: mainMenu }])
    } },
    { label: (ledgerCache && ledgerCache.enabled ? '✓ ' : '　') + '累计计费', run: function () {
      var on = !!(ledgerCache && ledgerCache.enabled)
      postLedger(on ? 'disable' : 'enable')
    } },
    { label: '结束计费并结算' +
        (ledgerCache && ledgerCache.total ? '（¥' + fenString(Math.round(ledgerCache.total * 100)) + '）' : ''),
      disabled: !(ledgerCache && ledgerCache.turns > 0),
      run: function () {
        postLedger('settle').then(function (p) {
          if (p && p.ok) showSettlement(p)
        })
      } },
    { label: (holidayStatus && holidayStatus.level !== 'ok' ? '⚠ ' : '') + '节假日清单…',
      run: function () { showHolidayPanel() } },
    { label: '尺寸 ▸', sub: function () {
      var names = ['小', '中', '大', '特大']
      return SIZE_PRESETS.map(function (px, i) {
        return {
          label: (i === state.sizeIndex ? '✓ ' : '　') + names[i] + '（' + px + '）',
          run: function () { state.sizeIndex = i; saveState(); layout(); place(); draw() },
        }
      }).concat([{ label: '返回', sub: mainMenu }])
    } },
    { label: (state.soundOn ? '✓ ' : '　') + '音效', run: function () { state.soundOn = !state.soundOn; saveState() } },
    { label: (state.snapOnRelease ? '✓ ' : '　') + '松手吸附左下角', run: function () { state.snapOnRelease = !state.snapOnRelease; saveState() } },
    { label: '刷新间隔 ▸', sub: function () {
      var names = { 10: '10 秒', 30: '30 秒', 60: '1 分钟', 300: '5 分钟' }
      return POLL_OPTIONS.map(function (s) {
        return {
          label: (s === state.pollSeconds ? '✓ ' : '　') + names[s],
          run: function () {
            state.pollSeconds = clampPoll(s); saveState()
            nextPollAt = Math.max(Date.now() + state.pollSeconds * 1000, retryNotBefore)
          },
        }
      }).concat([{ label: '返回', sub: mainMenu }])
    } },
    { label: '立即刷新余额', run: function () { pollOnce(true, true) } },
    { label: '网络自检…', run: function () { showSelfCheck() } },
    { label: '测试一次扣费', run: function () { playDemo(1) } },
    { label: '演示连续扣费 ▸', sub: function () {
      return [
        { label: '-0.05（5 次）', run: function () { playDemo(5) } },
        { label: '-0.10（10 次）', run: function () { playDemo(10) } },
        { label: '-0.20（20 次）', run: function () { playDemo(20) } },
        { label: '-0.50（50 次）', run: function () { playDemo(50) } },
        { label: '-1.00（100 次）', run: function () { playDemo(100) } },
        { label: '返回', sub: mainMenu },
      ]
    } },
    { label: '吸附回左下角', run: function () { snapToCorner() } },
    { label: state.hidden ? '显示桌宠' : '隐藏桌宠', run: function () { setHidden(!state.hidden) } },
    { label: '关于…', run: function () { showAbout() } },
  ]
  return items
}

function playDemo(times) {
  var n = Math.max(1, Math.min(MAX_DEMO_STEPS, Math.floor(times) || 1))
  demoRemaining = Math.min(MAX_DEMO_STEPS, demoRemaining + n)
  wake()
}

// ============================================================================
// 节假日清单：查看覆盖 / 粘贴导入 / 从 URL 导入 / 恢复内置
// ============================================================================
// 为什么需要它：法定节假日放假安排每年 11 月前后才由国务院发布，无法用算法推算。
// 所以把清单做成可导入的数据，并主动提示「已过期 / 该导入了」。
function closeHolidayPanel() {
  var o = holidayOverlay
  if (!o) return
  holidayOverlay = null
  try { document.removeEventListener('keydown', o.onKey, true) } catch (err) {}
  try { if (o.root.parentNode) o.root.parentNode.removeChild(o.root) } catch (err) {}
}

function holidayStatusText(st) {
  if (!st) return '（未取得状态）'
  var lines = []
  lines.push('已覆盖年份：' + (st.coveredYears && st.coveredYears.length ? st.coveredYears.join('、') : '无'))
  lines.push('共 ' + st.total + ' 天（内置 ' + st.builtinCount + ' ＋ 导入 ' + st.importedCount + '）')
  if (st.message) lines.push(st.message)
  return lines.join('\n')
}

function refreshHolidayStatus(st) {
  holidayStatus = st || holidayStatus
  if (!holidayOverlay) return
  var s = holidayOverlay.status
  s.textContent = holidayStatusText(holidayStatus)
  var lv = holidayStatus && holidayStatus.level
  s.className = 'dshpet-hol-status' + (lv === 'stale' ? ' is-stale' : (lv === 'warn' ? ' is-warn' : ''))
}

function showHolidayPanel() {
  closeHolidayPanel()
  var root = document.createElement('div')
  root.id = 'dshpet-holiday'
  var box = document.createElement('div')
  box.className = 'dshpet-hol-box'

  var title = document.createElement('div')
  title.className = 'dshpet-hol-title'
  title.textContent = '节假日清单'
  box.appendChild(title)

  var status = document.createElement('div')
  status.className = 'dshpet-hol-status'
  box.appendChild(status)

  var ta = document.createElement('textarea')
  ta.className = 'dshpet-hol-ta'
  ta.placeholder = '粘贴日期，一行一个（YYYY-MM-DD）；也支持 JSON：\n'
    + '["2027-01-01", …]   或   {"years":{"2027":["2027-01-01", …]}}'
  box.appendChild(ta)

  var urlRow = document.createElement('div')
  urlRow.className = 'dshpet-hol-row'
  var urlInput = document.createElement('input')
  urlInput.className = 'dshpet-hol-url'
  urlInput.placeholder = '或填一个 JSON 地址，从 URL 导入'
  var urlBtn = document.createElement('button')
  urlBtn.type = 'button'
  urlBtn.className = 'dshpet-hol-btn'
  urlBtn.textContent = '从 URL 导入'
  urlRow.appendChild(urlInput)
  urlRow.appendChild(urlBtn)
  box.appendChild(urlRow)

  var msg = document.createElement('div')
  msg.className = 'dshpet-hol-msg'
  box.appendChild(msg)

  var actions = document.createElement('div')
  actions.className = 'dshpet-hol-row dshpet-hol-actions'
  var saveBtn = document.createElement('button')
  saveBtn.type = 'button'; saveBtn.className = 'dshpet-hol-btn dshpet-hol-primary'; saveBtn.textContent = '保存导入'
  var resetBtn = document.createElement('button')
  resetBtn.type = 'button'; resetBtn.className = 'dshpet-hol-btn'; resetBtn.textContent = '恢复内置'
  var closeBtn = document.createElement('button')
  closeBtn.type = 'button'; closeBtn.className = 'dshpet-hol-btn'; closeBtn.textContent = '关闭'
  actions.appendChild(saveBtn); actions.appendChild(resetBtn); actions.appendChild(closeBtn)
  box.appendChild(actions)

  root.appendChild(box)
  ;(document.body || document.documentElement).appendChild(root)

  var o = { root: root, status: status, msg: msg, busy: false }
  holidayOverlay = o

  function say(text, isErr) {
    msg.textContent = text
    msg.className = 'dshpet-hol-msg' + (isErr ? ' is-err' : ' is-ok')
  }

  function post(payload, okText) {
    if (o.busy) return
    o.busy = true
    say('处理中…')
    fetch(PREFIX + '/holidays.json', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) { return r.json() })
      .then(function (j) {
        o.busy = false
        if (!j || !j.ok) { say((j && j.error) || '导入失败', true); return }
        refreshHolidayStatus(j.status)
        var extra = (j.skipped && j.skipped.length) ? '，忽略 ' + j.skipped.length + ' 条无法识别的' : ''
        say((okText || '已导入 ') + (j.imported !== undefined ? j.imported + ' 天' : '') + extra)
        readLedger()
      })
      .catch(function (err) { o.busy = false; say('请求失败: ' + String((err && err.message) || err), true) })
  }

  saveBtn.addEventListener('click', function () {
    var v = String(ta.value || '').trim()
    if (!v) { say('请先粘贴清单内容', true); return }
    var parsed
    try { parsed = JSON.parse(v) } catch (err) { parsed = v } // 不是 JSON 就当纯文本日期列表
    post({ action: 'import', holidays: parsed }, '已导入 ')
  })
  urlBtn.addEventListener('click', function () {
    var u = String(urlInput.value || '').trim()
    if (!u) { say('请先填 URL', true); return }
    post({ action: 'import', url: u }, '已从 URL 导入 ')
  })
  resetBtn.addEventListener('click', function () {
    post({ action: 'reset' }, '已恢复内置清单')
  })
  closeBtn.addEventListener('click', function () { closeHolidayPanel() })
  root.addEventListener('pointerdown', function (ev) {
    if (ev.target === root) closeHolidayPanel() // 点遮罩关闭
  })
  o.onKey = function (ev) { if (ev.key === 'Escape') closeHolidayPanel() }
  document.addEventListener('keydown', o.onKey, true)

  refreshHolidayStatus(holidayStatus)
  // 打开时拉一次最新状态，避免显示过期信息
  fetch(PREFIX + '/holidays.json', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (j) { if (j && j.ok) refreshHolidayStatus(j.status) })
    .catch(function () {})
}

// 启动时若清单过期/该更新了，弹一次提示（黄字，与喜报红区分开）
function maybeWarnHolidays() {
  var st = holidayStatus
  if (!st || st.level === 'ok') return
  setTimeout(function () {
    showTurnBubble(st.level === 'stale' ? '节假日清单已过期' : '节假日清单该更新了',
      '右键 →「节假日清单」导入新表', 'warn')
  }, 2500)
}

// ============================================================================
// 关于
// ============================================================================
var aboutOverlay = null
var aboutInfo = null
var licenseOverlay = null
var selfCheckOverlay = null

function closeAbout() {
  var o = aboutOverlay
  if (!o) return
  aboutOverlay = null
  try { document.removeEventListener('keydown', o.onKey, true) } catch (err) {}
  try { if (o.root.parentNode) o.root.parentNode.removeChild(o.root) } catch (err) {}
}

function aboutLink(url) {
  var a = document.createElement('a')
  a.href = String(url)
  a.textContent = String(url)
  a.target = '_blank'
  a.rel = 'noreferrer noopener'
  a.className = 'dshpet-about-link'
  return a
}

// 许可证 / 声明的**应用内阅读**入口。
// 为什么不能用 <a target="_blank"> 直接指到 /dsh-pet/license.txt：
// 桌面端（Electron）页面来源是 `dsh-app://app/`，相对路径会被解析成
// `dsh-app://app/dsh-pet/license.txt`，壳子不允许打开这种地址 ⇒ **点了没反应**。
// （https 外链不受影响，所以 GitHub 链接仍用普通 <a>。）
// 这里改成：点一下 → fetch 取回文本 → 直接在本弹层里显示。
function licenseAnchor(file, labelText) {
  var a = document.createElement('a')
  a.className = 'dshpet-about-link'
  a.setAttribute('role', 'button')
  a.textContent = String(labelText)
  a.addEventListener('click', function (ev) {
    ev.preventDefault()
    ev.stopPropagation()
    showLicenseViewer(file, labelText)
  })
  return a
}

function closeLicenseViewer() {
  var o = licenseOverlay
  if (!o) return
  licenseOverlay = null
  try { document.removeEventListener('keydown', o.onKey, true) } catch (err) {}
  try { if (o.root.parentNode) o.root.parentNode.removeChild(o.root) } catch (err) {}
}

function showLicenseViewer(file, title) {
  closeLicenseViewer()
  var root = document.createElement('div')
  root.id = 'dshpet-license'
  var box = document.createElement('div')
  box.className = 'dshpet-lic-box'
  var head = document.createElement('div')
  head.className = 'dshpet-lic-title'
  head.textContent = String(title || file)
  var pre = document.createElement('pre')
  pre.className = 'dshpet-lic-body'
  pre.textContent = '加载中…'
  var actions = document.createElement('div')
  actions.className = 'dshpet-hol-row dshpet-hol-actions'
  var close = document.createElement('button')
  close.type = 'button'
  close.className = 'dshpet-hol-btn dshpet-hol-primary'
  close.textContent = '关闭'
  actions.appendChild(close)
  box.appendChild(head)
  box.appendChild(pre)
  box.appendChild(actions)
  root.appendChild(box)
  ;(document.body || document.documentElement).appendChild(root)
  var o = { root: root }
  licenseOverlay = o
  close.addEventListener('click', function () { closeLicenseViewer() })
  root.addEventListener('pointerdown', function (ev) { if (ev.target === root) closeLicenseViewer() })
  o.onKey = function (ev) { if (ev.key === 'Escape') closeLicenseViewer() }
  document.addEventListener('keydown', o.onKey, true)

  fetch(PREFIX + '/license.txt?f=' + encodeURIComponent(file), { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.text() })
    .then(function (t) { pre.textContent = t || '（空文件）' })
    .catch(function (err) { pre.textContent = '读取失败: ' + String((err && err.message) || err) })
}

// ============================================================================
// 网络自检
// ============================================================================
// 为什么需要：Node 的 fetch 不使用 Windows 系统代理，境外接口在国内会**静默超时**。
// 与其让用户在来源之间逐个试，不如一次把每个已配来源的连通性、耗时、失败原因全列出来。
function closeSelfCheck() {
  var o = selfCheckOverlay
  if (!o) return
  selfCheckOverlay = null
  try { document.removeEventListener('keydown', o.onKey, true) } catch (err) {}
  try { if (o.root.parentNode) o.root.parentNode.removeChild(o.root) } catch (err) {}
}

function showSelfCheck() {
  closeSelfCheck()
  var root = document.createElement('div')
  root.id = 'dshpet-self'
  var box = document.createElement('div')
  box.className = 'dshpet-lic-box'
  var head = document.createElement('div')
  head.className = 'dshpet-lic-title'
  head.textContent = '网络自检'
  var summary = document.createElement('div')
  summary.className = 'dshpet-self-summary'
  summary.textContent = '正在逐个检测已配置的来源…'
  var body = document.createElement('div')
  body.className = 'dshpet-self-body'
  var actions = document.createElement('div')
  actions.className = 'dshpet-hol-row dshpet-hol-actions'
  var again = document.createElement('button')
  again.type = 'button'
  again.className = 'dshpet-hol-btn'
  again.textContent = '重新检测'
  var close = document.createElement('button')
  close.type = 'button'
  close.className = 'dshpet-hol-btn dshpet-hol-primary'
  close.textContent = '关闭'
  actions.appendChild(again)
  actions.appendChild(close)
  box.appendChild(head)
  box.appendChild(summary)
  box.appendChild(body)
  box.appendChild(actions)
  root.appendChild(box)
  ;(document.body || document.documentElement).appendChild(root)
  var o = { root: root }
  selfCheckOverlay = o
  close.addEventListener('click', function () { closeSelfCheck() })
  root.addEventListener('pointerdown', function (ev) { if (ev.target === root) closeSelfCheck() })
  o.onKey = function (ev) { if (ev.key === 'Escape') closeSelfCheck() }
  document.addEventListener('keydown', o.onKey, true)

  function run() {
    summary.textContent = '正在逐个检测已配置的来源…'
    body.textContent = ''
    again.disabled = true
    fetch(PREFIX + '/selfcheck.json?refresh=1', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        again.disabled = false
        if (!j || !j.ok) { summary.textContent = '自检失败: ' + ((j && j.error) || '未知错误'); return }
        var px = j.proxy || {}
        summary.textContent = '通过 ' + j.passed + ' / ' + j.total + '，总耗时 ' + j.elapsed + ' ms'
          + '　（HTTPS_PROXY ' + (px.httpsProxy ? '已设' : '未设')
          + '　NODE_USE_ENV_PROXY ' + (px.nodeUseEnvProxy ? '已开' : '未开') + '）'
        for (var i = 0; i < j.results.length; i++) {
          var r = j.results[i]
          var row = document.createElement('div')
          row.className = 'dshpet-self-row' + (r.ok ? ' is-ok' : ' is-err')
          var mark = document.createElement('span')
          mark.className = 'dshpet-self-mark'
          mark.textContent = r.ok ? '✓' : '✗'
          var nm = document.createElement('span')
          nm.className = 'dshpet-self-name'
          nm.textContent = r.name + (r.kind === 'quota' ? '［额度］' : '')
          var val = document.createElement('span')
          val.className = 'dshpet-self-val'
          val.textContent = r.ok ? (r.value + '　' + r.ms + 'ms') : (r.ms + 'ms　' + r.error)
          row.appendChild(mark)
          row.appendChild(nm)
          row.appendChild(val)
          body.appendChild(row)
        }
        if (!j.total) body.textContent = '（没有已配置的来源）'
      })
      .catch(function (err) {
        again.disabled = false
        summary.textContent = '自检请求失败: ' + String((err && err.message) || err)
      })
  }
  again.addEventListener('click', run)
  run()
}

function showAbout() {
  closeAbout()
  var info = aboutInfo || {}
  var root = document.createElement('div')
  root.id = 'dshpet-about'
  var box = document.createElement('div')
  box.className = 'dshpet-about-box'

  var title = document.createElement('div')
  title.className = 'dshpet-about-title'
  title.textContent = '关于'
  box.appendChild(title)

  // 一行「键：值」，值可以是字符串，也可以是若干节点（用来放链接）
  function kv(key, nodes) {
    var row = document.createElement('div')
    row.className = 'dshpet-about-row'
    var k = document.createElement('span')
    k.className = 'dshpet-about-k'
    k.textContent = key
    var v = document.createElement('span')
    v.className = 'dshpet-about-v'
    var list = Array.isArray(nodes) ? nodes : [nodes]
    for (var i = 0; i < list.length; i++) {
      var it = list[i]
      if (it === null || it === undefined) continue
      if (typeof it === 'string') {
        var s = document.createElement('span')
        s.textContent = it
        v.appendChild(s)
      } else {
        v.appendChild(it)
      }
    }
    row.appendChild(k)
    row.appendChild(v)
    box.appendChild(row)
    return v
  }

  kv('名称', info.name || 'dsh-balance-pet-extend')
  kv('版本', info.version || '—')
  kv('构建时间', info.buildTime ? fmtTime(Date.parse(info.buildTime)) : '—')
  if (info.pkgName) kv('包名', info.pkgName)

  var au = info.author || {}
  kv('作者', [au.name || '—', '　', au.url ? aboutLink(au.url) : ''])
  // 许可证原文随包分发，这里给的是**可点开直接阅读**的入口（应用内显示，不依赖浏览器）
  if (info.selfLicense) kv('许可', [(info.selfLicense.label || 'MIT') + '　', licenseAnchor('LICENSE.txt', 'MIT 许可证原文')])
  if (info.notices) kv('第三方声明', [licenseAnchor('THIRD-PARTY-NOTICES.md', '第三方来源与许可')])

  var refs = info.references || []
  if (refs.length) {
    var sep = document.createElement('div')
    sep.className = 'dshpet-about-sep'
    sep.textContent = '参考的开源项目'
    box.appendChild(sep)
    for (var r = 0; r < refs.length; r++) {
      var ref = refs[r]
      var head = document.createElement('div')
      head.className = 'dshpet-about-refname'
      head.textContent = ref.name + (ref.by ? '　By ' + ref.by : '') + (ref.license ? '　' + ref.license + ' 许可证' : '')
      box.appendChild(head)
      var lk = document.createElement('div')
      lk.className = 'dshpet-about-reflink'
      lk.appendChild(aboutLink(ref.url))
      box.appendChild(lk)
      // 许可证：有原文链接就链过去（可点开阅读），没有就如实写出状态
      if (ref.licenseUrl) {
        var lic = document.createElement('div')
        lic.className = 'dshpet-about-reflink'
        var lab = document.createElement('span')
        lab.textContent = (ref.license ? ref.license + ' 许可证原文：' : '许可证：')
        lic.appendChild(lab)
        lic.appendChild(licenseAnchor('whale-LICENSE.txt', '点此阅读'))
        if (ref.provenanceUrl) {
          var lab2 = document.createElement('span')
          lab2.textContent = '　素材来源说明：'
          lic.appendChild(lab2)
          lic.appendChild(licenseAnchor('whale-PROVENANCE.md', '点此阅读'))
        }
        box.appendChild(lic)
      } else if (ref.licenseLabel) {
        var lic2 = document.createElement('div')
        lic2.className = 'dshpet-about-refnote'
        lic2.textContent = '许可证：' + ref.licenseLabel
        box.appendChild(lic2)
      }
      if (ref.note) {
        var nt = document.createElement('div')
        nt.className = 'dshpet-about-refnote'
        nt.textContent = ref.note
        box.appendChild(nt)
      }
    }
  }

  var actions = document.createElement('div')
  actions.className = 'dshpet-about-actions'
  var ok = document.createElement('button')
  ok.type = 'button'
  ok.className = 'dshpet-hol-btn dshpet-hol-primary'
  ok.textContent = '关闭'
  actions.appendChild(ok)
  box.appendChild(actions)

  root.appendChild(box)
  ;(document.body || document.documentElement).appendChild(root)

  var o = { root: root }
  aboutOverlay = o
  ok.addEventListener('click', function () { closeAbout() })
  root.addEventListener('pointerdown', function (ev) {
    if (ev.target === root) closeAbout()
  })
  o.onKey = function (ev) { if (ev.key === 'Escape') closeAbout() }
  document.addEventListener('keydown', o.onKey, true)
}

// ============================================================================
// 喜报（每轮消耗）+ 累计计费结算
// ============================================================================
// 结算页的一行：左模型名、右金额。用 createElement + textContent，
// 不拼 HTML —— 既不解析也不存在转义/注入问题。
function certRow(name, amountText) {
  var row = document.createElement('div')
  row.className = 'dshpet-cert-row'
  var a = document.createElement('span')
  a.textContent = String(name === null || name === undefined ? '' : name)
  var b = document.createElement('span')
  b.textContent = String(amountText === null || amountText === undefined ? '' : amountText)
  row.appendChild(a)
  row.appendChild(b)
  return row
}

// 自动播放策略：回合结束音不是手势触发的，先借一次用户手势把音频解锁。
// （桌宠原有的扣费音也没做这件事，这里一并补上。）
function unlockAudio() {
  try {
    if (!audioUnlocked) {
      audioUnlocked = true
      var a = new Audio(PREFIX + '/hit.mp3')
      a.volume = 0
      var p = a.play()
      if (p && p.catch) p.catch(function () {})
      setTimeout(function () { try { a.pause() } catch (e) {} }, 80)
    }
  } catch (err) {}
  document.removeEventListener('pointerdown', unlockAudio, true)
  document.removeEventListener('keydown', unlockAudio, true)
}

function playSoundFile(which) {
  try {
    if (which === 'turn') {
      if (!turnSound) { turnSound = new Audio(PREFIX + '/sound/turn.mp3'); turnSound.preload = 'auto' }
      try { turnSound.currentTime = 0 } catch (e) {}
      var p = turnSound.play()
      if (p && p.catch) p.catch(function () {})
      return
    }
    // 结算音 13.5 MB：**绝不预加载**，只在结算页真的打开时才创建并拉取
    if (!settleSound) { settleSound = new Audio(PREFIX + '/sound/settle.mp3'); settleSound.preload = 'none' }
    try { settleSound.currentTime = 0 } catch (e) {}
    var p2 = settleSound.play()
    if (p2 && p2.catch) p2.catch(function () {})
  } catch (err) {}
}

// —— 喜报气泡：DOM 挂在角色上方，不被画布裁切 ——
function showTurnBubble(text1, text2, modifier) {
  if (!container) return
  if (!turnBubble) {
    var el = document.createElement('div')
    el.id = 'dshpet-turn'
    // 与结算页一致：用 createElement + textContent 构造，不拼 HTML
    var l1 = document.createElement('div')
    l1.className = 'dshpet-turn-t1'
    var l2 = document.createElement('div')
    l2.className = 'dshpet-turn-t2'
    el.appendChild(l1)
    el.appendChild(l2)
    container.appendChild(el)
    turnBubble = { el: el, timer: null }
  }
  var b = turnBubble
  b.el.className = modifier ? ('is-' + modifier) : ''
  b.el.children[0].textContent = text1
  b.el.children[1].textContent = text2
  b.el.style.display = 'block'
  b.el.style.opacity = '1'
  clearTimeout(b.timer)
  b.timer = setTimeout(function () {
    if (!turnBubble) return
    turnBubble.el.style.opacity = '0'
    setTimeout(function () { if (turnBubble) turnBubble.el.style.display = 'none' }, 450)
  }, TURN_BUBBLE_MS)
}

function onNewTurn(t) {
  var cents = Math.round(Number(t.amount) * 100)
  if (!isFinite(cents) || cents <= 0) return // 消耗为 0 的回合不提示也不记账
  var sym = currencySymbol(String(t.currency || 'CNY').toUpperCase())
  showTurnBubble('喜报', '您本次消耗了 ' + sym + fenString(cents))
  celebrateTime = CELEBRATE_DURATION // 红闪庆祝（复用原版的 source-atop 红叠加）
  wake()
  playSoundFile('turn')
}

function pollTurn() {
  return fetch(PREFIX + '/turn.json', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (j) {
      if (!j || !j.ok) return
      var seq = Number(j.seq) || 0
      // 首帧只取基线：刚打开页面时不要把历史回合当成"刚发生"
      if (lastTurnSeq === null) { lastTurnSeq = seq; return }
      if (seq > lastTurnSeq) { lastTurnSeq = seq; onNewTurn(j) }
    })
    .catch(function () {})
}

function turnLoop() {
  if (destroyed) return
  if (started && manifest) pollTurn()
  setTimeout(turnLoop, TURN_POLL_MS)
}

// —— 累计账本 ——
function readLedger() {
  if (ledgerInFlight) return Promise.resolve(ledgerCache)
  ledgerInFlight = true
  return fetch(PREFIX + '/ledger.json', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (j) { if (j && j.ok) ledgerCache = j; return ledgerCache })
    .catch(function () { return ledgerCache })
    .then(function (v) { ledgerInFlight = false; return v })
}

function postLedger(action) {
  return fetch(PREFIX + '/ledger.json', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: action }),
  })
    .then(function (r) { return r.json() })
    .then(function (j) { if (j && j.ok) ledgerCache = j; return j })
    .catch(function () { return null })
}

function ledgerLoop() {
  if (destroyed) return
  if (started && manifest) readLedger()
  setTimeout(ledgerLoop, LEDGER_POLL_MS)
}

// —— 结算页 ——
function fmtTime(ms) {
  try {
    var d = new Date(Number(ms) || Date.now())
    var p = function (n) { return (n < 10 ? '0' : '') + n }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
  } catch (err) { return '--' }
}

function closeSettlement() {
  var o = settleOverlay
  if (!o) return
  settleOverlay = null
  try { clearTimeout(o.timer) } catch (err) {}
  try { document.removeEventListener('keydown', o.onKey, true) } catch (err) {}
  try { window.removeEventListener('resize', o.onResize) } catch (err) {}
  try { if (o.root.parentNode) o.root.parentNode.removeChild(o.root) } catch (err) {}
  try { if (settleSound) settleSound.pause() } catch (err) {}
}

function layoutSettlement() {
  var o = settleOverlay
  if (!o) return
  var vw = window.innerWidth, vh = window.innerHeight
  var w = Math.min(vw * 0.92, (vh * 0.92) * CERT_W / CERT_H)
  var h = w * CERT_H / CERT_W
  o.box.style.width = w + 'px'
  o.box.style.height = h + 'px'
  var bx = CERT_BOX.x / CERT_W * w, by = CERT_BOX.y / CERT_H * h
  var bw = CERT_BOX.w / CERT_W * w, bh = CERT_BOX.h / CERT_H * h
  o.body.style.left = bx + 'px'
  o.body.style.top = by + 'px'
  o.body.style.width = bw + 'px'
  o.body.style.height = bh + 'px'
  var base = Math.max(8, bw / 34)
  // 标题与正文用**同一套缩放**：标题只比正文大一档，且允许换行。
  // 之前是「把标题逐档缩到一行放得下」—— 标题串长（带完整起止时间）时会被压得极小，
  // 而下面的行仍按 base 渲染，于是第一行明显比其它行小。改成整体一起缩放就不会脱节。
  function applyFont(size) {
    o.body.style.fontSize = size + 'px'
    o.title.style.fontSize = (size * 1.15) + 'px'
  }
  applyFont(base)
  // 内容（含换行后的标题）若超出黄区高度，就**整体**缩一档再试，保证各行的相对大小不变
  var guard = 0
  while (o.body.scrollHeight > bh && base > 9 && guard++ < 80) {
    base -= 0.5
    applyFont(base)
  }
  // 落款贴右下角（不强制落在黄区内）
  o.sign.style.fontSize = Math.max(9, w / 48) + 'px'
  o.sign.style.right = (w * 0.045) + 'px'
  o.sign.style.bottom = (h * 0.045) + 'px'
}

function showSettlement(p) {
  if (!p || !p.ok) return
  closeSettlement()
  var models = (p.models || [])
  var root = document.createElement('div')
  root.id = 'dshpet-settle'
  var box = document.createElement('div')
  box.className = 'dshpet-cert'
  var bodyEl = document.createElement('div')
  bodyEl.className = 'dshpet-cert-body'

  var title = document.createElement('div')
  title.className = 'dshpet-cert-title'
  title.textContent = '恭喜您在 ' + fmtTime(p.since) + ' 至 ' + fmtTime(p.now) + ' 中共消耗了：'
  bodyEl.appendChild(title)

  if (!models.length) {
    var none = document.createElement('div')
    none.className = 'dshpet-cert-row'
    none.textContent = '（这段时间没有产生消耗）'
    bodyEl.appendChild(none)
  }
  for (var i = 0; i < models.length; i++) {
    bodyEl.appendChild(certRow(models[i].name, '¥' + fenString(Math.round(Number(models[i].amount) * 100))))
  }
  var tot = certRow('合计', '¥' + fenString(Math.round(Number(p.total) * 100)))
  tot.className = 'dshpet-cert-total'
  bodyEl.appendChild(tot)

  var sign = document.createElement('div')
  sign.className = 'dshpet-cert-sign'
  // 全部走 createElement + textContent：不解析 HTML，也就没有转义/注入问题
  sign.textContent = 'Deepseek Harness\n' + fmtTime(p.now).slice(0, 10)

  var x = document.createElement('button')
  x.className = 'dshpet-cert-x'
  x.type = 'button'
  x.textContent = '×'
  x.title = '关闭（ESC）'

  box.appendChild(bodyEl)
  box.appendChild(sign)
  box.appendChild(x)
  root.appendChild(box)
  ;(document.body || document.documentElement).appendChild(root)

  var o = { root: root, box: box, body: bodyEl, title: title, sign: sign, timer: null }
  var armAuto = function () {
    clearTimeout(o.timer)
    o.timer = setTimeout(closeSettlement, SETTLE_AUTOCLOSE_MS)
  }
  var cancelAuto = function () { clearTimeout(o.timer); o.timer = null }

  // 关闭语义（按需求）：ESC / 点 × → 立刻关闭；按其它键 / 点其它地方 → 只取消自动关闭
  o.onKey = function (ev) {
    if (ev.key === 'Escape') { closeSettlement(); return }
    cancelAuto()
  }
  o.onResize = function () { layoutSettlement() }
  document.addEventListener('keydown', o.onKey, true)
  window.addEventListener('resize', o.onResize)
  root.addEventListener('pointerdown', function (ev) {
    if (ev.target === x) return
    cancelAuto()
  })
  x.addEventListener('pointerdown', function (ev) { ev.stopPropagation() })
  x.addEventListener('click', function (ev) { ev.stopPropagation(); closeSettlement() })

  settleOverlay = o
  layoutSettlement()
  armAuto()
  playSoundFile('settle')
}

// ============================================================================
// 挂载
// ============================================================================
function injectCss() {
  if (document.getElementById('dshpet-css')) return
  var st = document.createElement('style')
  st.id = 'dshpet-css'
  st.textContent =
    '#dshpet-root{position:fixed;left:14px;top:14px;pointer-events:none;user-select:none;' +
      '-webkit-user-select:none;z-index:9998;font-family:inherit}' +
    '#dshpet-canvas{display:block;pointer-events:none;-webkit-user-drag:none}' +
    '#dshpet-menu{position:fixed;display:none;min-width:184px;box-sizing:border-box;background:rgba(255,255,255,.97);' +
      'border:1px solid rgba(32,49,112,.35);border-radius:10px;padding:5px;z-index:10001;color-scheme:light;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.18);font-size:12.5px;color:#203170}' +
    '.dshpet-mi{padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}' +
    '.dshpet-mi:hover{background:rgba(32,49,112,.10)}' +
    // 喜报气泡：挂在角色上方，白描边保证在浅色主题下也读得清
    '#dshpet-turn{position:absolute;left:50%;bottom:100%;transform:translateX(-50%);margin-bottom:6px;' +
      'pointer-events:none;text-align:center;white-space:nowrap;display:none;opacity:0;' +
      'transition:opacity .45s ease;z-index:3}' +
    // 喜报两行的字号/字重完全一致（「喜报」不再比正文大），只靠文字本身区分
    '.dshpet-turn-t1{color:#e0161a;font-weight:800;font-size:18px;line-height:1.3;' +
      'text-shadow:0 1px 0 #fff,0 -1px 0 #fff,1px 0 0 #fff,-1px 0 0 #fff,0 0 8px rgba(255,255,255,.95)}' +
    '.dshpet-turn-t2{color:#e0161a;font-weight:800;font-size:18px;line-height:1.3;' +
      'text-shadow:0 1px 0 #fff,0 -1px 0 #fff,1px 0 0 #fff,-1px 0 0 #fff,0 0 8px rgba(255,255,255,.95)}' +
    // 结算页
    '#dshpet-settle{position:fixed;inset:0;z-index:30000;background:rgba(0,0,0,.6);display:flex;' +
      'align-items:center;justify-content:center}' +
    '.dshpet-cert{position:relative;background-image:url(' + PREFIX + '/certificate.png);' +
      'background-size:100% 100%;background-repeat:no-repeat;border-radius:6px;' +
      'box-shadow:0 14px 50px rgba(0,0,0,.55)}' +
    '.dshpet-cert-body{position:absolute;overflow:hidden;color:#9c1608;font-weight:800;' +
      'font-family:system-ui,"Segoe UI",sans-serif;line-height:1.3}' +
    '.dshpet-cert-title{font-weight:900;white-space:normal;line-height:1.28;margin-bottom:.45em}' +
    '.dshpet-cert-row{display:flex;justify-content:space-between;gap:1.4em;font-weight:700;line-height:1.42}' +
    '.dshpet-cert-total{display:flex;justify-content:space-between;gap:1.4em;font-weight:900;' +
      'border-top:2px solid rgba(156,22,8,.65);margin-top:.3em;padding-top:.3em}' +
    '.dshpet-cert-sign{position:absolute;text-align:right;color:#9c1608;font-weight:800;' +
      'font-family:system-ui,"Segoe UI",sans-serif;line-height:1.35;white-space:pre-line}' +
    '.dshpet-cert-x{position:absolute;top:10px;right:10px;width:36px;height:36px;border:none;' +
      'border-radius:50%;background:rgba(0,0,0,.42);color:#fff;font-size:24px;line-height:1;' +
      'cursor:pointer;padding:0 0 3px;z-index:2}' +
    '.dshpet-cert-x:hover{background:rgba(0,0,0,.62)}' +
    // 提示气泡的「警告」配色（节假日清单过期）——只换颜色，字号沿用喜报那一套
    '#dshpet-turn.is-warn .dshpet-turn-t1{color:#d97706}' +
    '#dshpet-turn.is-warn .dshpet-turn-t2{color:#b45309}' +
    // 节假日清单面板
    '#dshpet-holiday{position:fixed;inset:0;z-index:31000;background:rgba(0,0,0,.6);display:flex;' +
      'align-items:center;justify-content:center}' +
    '.dshpet-hol-box{width:min(560px,92vw);box-sizing:border-box;background:#fff;color:#203170;' +
      'border-radius:12px;padding:16px 18px;box-shadow:0 14px 50px rgba(0,0,0,.5);color-scheme:light;' +
      'font-family:system-ui,"Segoe UI",sans-serif;font-size:13px}' +
    '.dshpet-hol-title{font-size:15px;font-weight:800;margin-bottom:8px}' +
    '.dshpet-hol-status{white-space:pre-line;line-height:1.5;background:rgba(32,49,112,.06);' +
      'border-radius:8px;padding:8px 10px;margin-bottom:10px}' +
    '.dshpet-hol-status.is-stale{background:rgba(220,38,38,.10);color:#b91c1c}' +
    '.dshpet-hol-status.is-warn{background:rgba(217,119,6,.12);color:#b45309}' +
    '.dshpet-hol-ta{width:100%;box-sizing:border-box;height:112px;resize:vertical;border-radius:8px;' +
      'border:1px solid rgba(32,49,112,.3);padding:8px;font-family:ui-monospace,Consolas,monospace;' +
      'font-size:12px;color:#203170;margin-bottom:8px}' +
    '.dshpet-hol-row{display:flex;gap:8px;align-items:center;margin-bottom:8px}' +
    '.dshpet-hol-url{flex:1;box-sizing:border-box;border-radius:8px;border:1px solid rgba(32,49,112,.3);' +
      'padding:6px 8px;font-size:12px;color:#203170}' +
    '.dshpet-hol-btn{border:1px solid rgba(32,49,112,.35);background:#fff;color:#203170;border-radius:8px;' +
      'padding:6px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap}' +
    '.dshpet-hol-btn:hover{background:rgba(32,49,112,.08)}' +
    '.dshpet-hol-primary{background:#203170;color:#fff;border-color:#203170}' +
    '.dshpet-hol-primary:hover{background:#2b3f8f}' +
    '.dshpet-hol-actions{justify-content:flex-end;margin-bottom:0}' +
    '.dshpet-hol-msg{min-height:18px;font-size:12px;margin-bottom:6px}' +
    '.dshpet-hol-msg.is-ok{color:#15803d}.dshpet-hol-msg.is-err{color:#b91c1c}' +
    // 关于对话框
    '#dshpet-about{position:fixed;inset:0;z-index:31200;background:rgba(0,0,0,.6);display:flex;' +
      'align-items:center;justify-content:center}' +
    '.dshpet-about-box{width:min(600px,92vw);max-height:86vh;overflow-y:auto;box-sizing:border-box;' +
      'background:#fff;color:#203170;border-radius:12px;padding:16px 18px;' +
      'box-shadow:0 14px 50px rgba(0,0,0,.5);color-scheme:light;' +
      'font-family:system-ui,"Segoe UI",sans-serif;font-size:13px}' +
    '.dshpet-about-title{font-size:16px;font-weight:800;margin-bottom:10px}' +
    '.dshpet-about-row{display:flex;gap:10px;padding:4px 0;align-items:baseline}' +
    '.dshpet-about-k{flex:0 0 62px;color:#6b7ba8;font-weight:600}' +
    '.dshpet-about-v{flex:1;word-break:break-all;font-weight:600}' +
    '.dshpet-about-link{color:#1d4ed8;text-decoration:none;font-weight:600}' +
    '.dshpet-about-link:hover{text-decoration:underline}' +
    '.dshpet-about-sep{margin-top:12px;padding-top:10px;border-top:1px solid rgba(32,49,112,.18);' +
      'font-weight:800;color:#203170}' +
    '.dshpet-about-refname{margin-top:8px;font-weight:700}' +
    '.dshpet-about-reflink{margin-top:2px;word-break:break-all}' +
    '.dshpet-about-refnote{margin-top:2px;color:#6b7ba8;line-height:1.5}' +
    '.dshpet-about-actions{display:flex;justify-content:flex-end;margin-top:14px}' +
    // 许可证阅读弹层（应用内显示，不依赖浏览器打开）
    '#dshpet-license{position:fixed;inset:0;z-index:31400;background:rgba(0,0,0,.6);display:flex;' +
      'align-items:center;justify-content:center}' +
    '.dshpet-lic-box{width:min(760px,92vw);max-height:86vh;display:flex;flex-direction:column;' +
      'box-sizing:border-box;background:#fff;color:#203170;border-radius:12px;padding:16px 18px;' +
      'box-shadow:0 14px 50px rgba(0,0,0,.5);color-scheme:light;' +
      'font-family:system-ui,"Segoe UI",sans-serif;font-size:13px}' +
    '.dshpet-lic-title{font-size:15px;font-weight:800;margin-bottom:10px}' +
    '.dshpet-lic-body{flex:1;overflow:auto;margin:0 0 10px;padding:10px 12px;border-radius:8px;' +
      'background:rgba(32,49,112,.05);white-space:pre-wrap;word-break:break-word;' +
      'font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.55;' +
      'max-height:60vh;color:#203170}' +
    // 网络自检
    '.dshpet-self-summary{font-size:12px;color:#6b7ba8;margin-bottom:10px;line-height:1.5}' +
    '.dshpet-self-body{overflow:auto;max-height:56vh;margin-bottom:10px}' +
    '.dshpet-self-row{display:flex;gap:8px;align-items:baseline;padding:5px 8px;border-radius:6px;' +
      'font-size:12.5px;line-height:1.5}' +
    '.dshpet-self-row.is-ok{background:rgba(21,128,61,.08)}' +
    '.dshpet-self-row.is-err{background:rgba(185,28,28,.08)}' +
    '.dshpet-self-mark{flex:0 0 14px;font-weight:800}' +
    '.dshpet-self-row.is-ok .dshpet-self-mark{color:#15803d}' +
    '.dshpet-self-row.is-err .dshpet-self-mark{color:#b91c1c}' +
    '.dshpet-self-name{flex:0 0 auto;font-weight:700;min-width:150px}' +
    '.dshpet-self-val{flex:1;word-break:break-word;font-family:ui-monospace,Consolas,monospace;' +
      'font-size:11.5px;color:#3b4a7a}'
  ;(document.head || document.documentElement).appendChild(st)
}

function buildDom() {
  if (container) return
  injectCss()
  container = document.createElement('div')
  container.id = 'dshpet-root'
  canvas = document.createElement('canvas')
  canvas.id = 'dshpet-canvas'
  container.appendChild(canvas)
  ;(document.body || document.documentElement).appendChild(container)

  menuEl = { root: document.createElement('div'), sub: null }
  menuEl.root.id = 'dshpet-menu'
  ;(document.body || document.documentElement).appendChild(menuEl.root)

  ctx = canvas.getContext('2d')
  layout()
  place()
}

function setHidden(h) {
  state.hidden = !!h
  saveState()
  if (container) container.style.display = state.hidden ? 'none' : 'block'
  if (menuEl.root) menuEl.root.style.display = 'none'
}

function refreshAssets() {
  var ch = activeChar()
  if (!ch) return
  var files = [ch.sprite]
  if (ch.offlineSprite) files.push(ch.offlineSprite)
  return Promise.all(files.map(function (f) {
    return loadImage(f, PREFIX + '/sprite/' + f).then(function (img) {
      if (img) return buildMask(f, img)
    })
  })).then(function () { draw() })
}

function start() {
  buildDom()
  setHidden(state.hidden)
  attachInteraction()
  // 角色表 / 平板角点 / 尺寸档 / 可选余额来源全部由宿主下发，前端不硬编码
  Promise.all([
    fetch(PREFIX + '/manifest.json', { credentials: 'same-origin', cache: 'no-store' }).then(function (r) { return r.json() }),
    fetch(PREFIX + '/sources.json', { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.json() })
      .catch(function () { return null }),
  ])
    .then(function (res) {
      var j = res[0]
      if (!j || !j.ok) throw new Error('manifest 不可用')
      manifest = j
      holidayStatus = j.holiday || null
      aboutInfo = j.about || null
      charsById = {}
      ;(j.characters || []).forEach(function (c) { charsById[c.id] = c })
      if (!charsById[state.character]) state.character = j.defaultCharacter || 'fish'
      var n = (j.sizes && j.sizes.length) || SIZE_PRESETS.length
      if (!(state.sizeIndex >= 0 && state.sizeIndex < n)) state.sizeIndex = 1

      var sj = res[1]
      sources = (sj && sj.ok && sj.sources && sj.sources.length)
        ? sj.sources
        : [{ id: 'deepseek', name: 'DeepSeek', builtin: true }]
      var known = false
      for (var i = 0; i < sources.length; i++) if (sources[i].id === state.source) known = true
      if (!known) state.source = (sj && sj.default) || 'deepseek' // 存过的来源没了 → 回到内置
      applySourceMeta()

      layout()
      place()
      return refreshAssets()
    })
    .then(function () {
      draw()
      pollOnce(true)   // 首轮直接对齐，不播动画
      pollLoop()
      turnLoop()       // 每轮消耗（喜报气泡）
      ledgerLoop()     // 累计账本（菜单里的合计金额）
      maybeWarnHolidays() // 节假日清单过期 / 该更新时提示一次
    })
    .catch(function (err) { log('start failed', err) })
}

// —— 只在主聊天界面挂载 ——
// 挂件脚本会被注入到 DSH 的每个 index 页面（含插件市场等 SPA 视图）。在主界面以外的
// 页面往 body 插节点会干扰 React 渲染，所以先确认存在 composer 再初始化。
function isChatRoot(r) {
  if (!r || !r.querySelector) return false
  return !!(
    r.querySelector('textarea') ||
    r.querySelector('[contenteditable="true"]') ||
    r.querySelector('[data-composer-input]') ||
    r.querySelector('[data-composer-seat],[data-composer-card]') ||
    r.querySelector('[role="textbox"][aria-multiline="true"]')
  )
}

var started = false
var lastCheck = 0
function tryStart() {
  if (started || destroyed) return
  var now = Date.now()
  if (now - lastCheck < 200) return
  lastCheck = now
  try {
    if (isChatRoot(document.getElementById('root')) || isChatRoot(document.body)) {
      started = true
      try { start() } catch (err) { log('start failed', err) }
    }
  } catch (err) {}
}

loadState()
// 音频解锁：回合结束音不是手势触发的，拿到一次用户手势就先把音频放开
try {
  document.addEventListener('pointerdown', unlockAudio, true)
  document.addEventListener('keydown', unlockAudio, true)
} catch (err) {}
tryStart()
try {
  var mo = new MutationObserver(function () { tryStart() })
  mo.observe(document.documentElement, { childList: true, subtree: true })
} catch (err) {}
setTimeout(tryStart, 300)
setTimeout(tryStart, 1200)
setTimeout(tryStart, 3000)
})()
