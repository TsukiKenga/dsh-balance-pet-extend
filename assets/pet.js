// ============================================================================
// dsh-balance-pet-extend —— 浏览器半区（桌宠绘制 / 动画 / 交互）
// ============================================================================
// 改写自 macOS 原生版桌宠（DSH-DaFeiYu-Desktop-Pet，fork 自 VK-1，Swift + AppKit）。
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
var STEP_INTERVAL = 0.2      // 每「一个扣费步长」的节拍
var FLOAT_LIFE = 0.95        // 飘字寿命
var TOPUP_DURATION = 0.9     // 充值光环时长
var MAX_PENDING_CUES = 400   // 积压超过这么多「步」就直接对齐，不放积压动画
var MAX_DEMO_STEPS = 200

// —— 金额单位 ——
// 余额来源下发的是元（浮点）。为了支持任意扣费步长（可以小于 1 分，例如 0.001），
// 内部统一用**万分之一元**的整数记账，避免 0.1 + 0.2 这类浮点误差滚进动画。
// 显示仍按 2 位小数；只有步长或飘字需要时才显示 3~4 位。
var MONEY_UNITS = 10000
var DEFAULT_STEP = 0.01
var STEP_PRESETS = [0.01, 0.05, 0.1, 0.5, 1]
function toUnits(yuan) {
  var n = Number(yuan)
  return isFinite(n) ? Math.round(n * MONEY_UNITS) : NaN
}
function fromUnits(u) { return u / MONEY_UNITS }
function clampStep(yuan) {
  var n = Number(yuan)
  if (!isFinite(n)) return DEFAULT_STEP
  // 余额显示精度回到 0.01 元：步长最小 1 分，并且只保留两位小数。
  n = Math.round(n * 100) / 100
  if (n < 0.01) n = DEFAULT_STEP
  if (n > 100) n = 100
  return n
}
function stepUnits() { return Math.max(100, toUnits(state.stepYuan)) }
// 金额显示：统一到 0.01 元（两位小数）。内部仍用万分之一元整数记账。
function moneyString(units) {
  if (units === null || units === undefined || !isFinite(units)) return '--'
  var neg = units < 0
  var cents = Math.round(Math.abs(Math.round(units)) / 100)
  var whole = Math.floor(cents / 100)
  var frac = cents % 100
  return (neg ? '-' : '') + whole + '.' + (frac < 10 ? '0' : '') + frac
}
function stepLabel() { return moneyString(stepUnits()) }
var DEMO_RESTORE = 0.55      // 演示结束后停留时间
var ALPHA_MIN = 8 / 255      // 命中阈值（原版 alphaComponent > 8.0/255.0）
var MASK_W = 384, MASK_H = 256   // 命中掩码分辨率（原图 1/4）
// 立绘原图尺寸。平板角点（宿主下发的 tablet.tl/tr/bl）是按这个坐标系标定的，
// 镜像时要用「原图宽度 - x」来反射，而不是用画布宽度。
var SPRITE_W = 1536
var SPRITE_H = 1024
var SNAP_DURATION = 0.16     // 吸附动画（原版 easeOut 0.16s）
var ANCHOR_MARGIN = 14       // 距屏幕边缘 14pt

var SIZE_PRESETS = [110, 150, 210, 280]
// 尺寸命名沿用上游 VK-1 v2 的「杯」体系（上游是 中杯/大杯/超大杯 三档，
// 本插件多留了一档小号，所以补一个「小杯」，命名风格保持一致）。
var SIZE_NAMES = ['小杯', '中杯', '大杯', '超大杯']
// 厘米换算：浏览器**拿不到显示器的物理 DPI**，只能按 CSS 的标称 96 DPI 估算。
// 上游是 WinForms，可以用 Graphics.DpiY 拿真实 DPI 把像素反算成厘米；
// 这里给的是估算值，所以菜单里一律写成「≈ N cm」而不是精确值。
var CSS_DPI = 96
function pxToCm(px) { return Math.round(px / CSS_DPI * 2.54 * 10) / 10 }
// 音量档位（沿用上游 VolumeSteps）。0% 即静音 —— 与上游一致：
// 「0 % IS mute」，所以音量归零时开关也必须跟着变。
var VOLUME_STEPS = [0, 25, 50, 75, 100]
// 菜单调色板，两套值直接取自上游 PetColors（浅色是 DSH 菜单壳色，深色是 DSH 界面风）
var MENU_THEMES = {
  light: { bg: '#f8f9fa', ink: '#0f1115', head: '#81858c', hover: '#e9ecf2', border: '#e9ecf2', sep: '#ebeef2', accent: '#4176e6' },
  dark: { bg: '#2c2c2e', ink: '#f9fafb', head: '#adb2b8', hover: '#3a3d42', border: '#42444a', sep: '#36373a', accent: '#7aaaff' },
}
function menuTheme() { return MENU_THEMES[state.theme === 'dark' ? 'dark' : 'light'] }

// ============================================================================
// 表情系统（来自上游 VK-1 v2）
// ============================================================================
// 上游只提供了**大肥鱼**这一只角色的四张表情立绘，所以表情只在这只角色上启用；
// 其余角色保持单张立绘不变（这是有意的，不给他们编造表情）。
var EXPR_CHARACTER = 'fish'
var EXPR_HAPPY = 0     // expression_11 开口笑 —— 常态
// 上游 UpdateExpression：_patActive 时 want = EXPR_NERVOUS，也就是**摸头时是这张**。
// 表情编号沿用上游的命名（NERVOUS），别因为「摸头应该开心」就换回 11 —— 上游就是让她害羞。
var EXPR_NERVOUS = 1   // expression_22 闭眼 / 脸红 —— 摸头、扣费动画播放中
var EXPR_ALOOF = 2     // expression_12 鼓嘴 —— 米饭盆超时没接 / 余额归零
var EXPR_CALM = 3      // expression_21 面无表情 —— 铁锅扣在头上
// 下标即表情编号，顺序照抄上游（不是文件名顺序）
var EXPR_FILES = ['expression_11.png', 'expression_22.png', 'expression_12.png', 'expression_21.png']
var NERVOUS_HOLD_SEC = 1.0   // 上游 NervousHoldSec：最后一次扣费后继续皱眉的时长
var BOWL_WAIT_SEC = 10.0     // 上游 BowlWaitSec：盆放多久没接就翻脸

var exprImages = []
var hasExpressions = false
var exprIdx = EXPR_HAPPY
var nervousT = 0
var bowlWait = 0
// 三期（米饭盆玩法）会去驱动这三个标志；二期先把状态机接好
var exprBowlAlive = false    // 场上有未接的米饭盆
var exprBowlLocked = false   // 盆已被锁定（正在被吸走）
var exprPotOnHead = false    // 铁锅扣在头上

// —— 「回弹」形变（上游 HeadSquash）——
// 铁锅扣到头上、以及被双击取下时，整张立绘沿竖直方向压缩一下再弹回。
// 参数与上游逐条对齐：时长 0.5 s、振幅 0.16、cos(2.2πu) 的过冲会先压后拉。
// 锚点是**脚底**（spriteRect 下沿），所以看起来像被从上面按了一下。
var HEAD_SQUASH_DUR = 0.5
var HEAD_SQUASH_AMP = 0.16
var HEAD_SQUASH_WOBBLE = 2.2
// 计时器从「时长」开始 = 没有动画；触发时置 0。
var headSquashT = HEAD_SQUASH_DUR

// ============================================================================
// 摸头手势（来自上游 VK-1 v3「petpet」）
// ============================================================================
// 规则与上游一致：指针在**她身上**持续划动，累计走过 PAT_MOVE_MIN_PX、
// 且持续 PAT_START_DELAY_MS 之后才算摸头；不是「停在她身上」也不是「点一下」。
// 按键按下（拖动 / 拿盆 / 右键菜单）一律打断并短暂封锁，避免和拖拽打架。
var PAT_FILES = ['pat_hand_0.png', 'pat_hand_1.png', 'pat_hand_2.png', 'pat_hand_3.png', 'pat_hand_4.png']
var PAT_FRAME_MS = 40          // 上游 PAT_FRAME_MS
var PAT_MOVE_MIN_PX = 24       // 划动累计距离阈值
var PAT_START_DELAY_MS = 500   // 达到距离后还要持续多久
var PAT_END_DELAY_MS = 150     // 停顿多久算结束
var PAT_SETTLE_MS = 1000       // 拖动 / 吸附结束后多久内不许摸
var PAT_MOVE_MAX_STEP = 120    // 单帧位移超过这个值视为指针跳跃，不计入
var PAT_MOVE_DECAY = 0.12      // 停顿时累计距离的衰减（px/ms）
// 手掌在每一帧里的位置（上游 PatPalmX / PatPalmY）—— 掌心要落在她头顶
var PAT_PALM_X = [0.319, 0.356, 0.318, 0.425, 0.298]
var PAT_PALM_Y = [0.511, 0.720, 0.835, 0.744, 0.608]
var PAT_PALM_BIAS_X = 0.393
var PAT_PALM_BIAS_Y = -0.206
// —— petpet 的「弹性」形变（上游 PatGeometry 逐行照抄）——
// 出处是 https://benisland.neocities.org/petpet/ （aDu/pet-pet-gif）的原始公式：
//   width  = 0.80 + j * 0.02      height = 0.80 - j * 0.05      offsetY = 0.12 + j * 0.05
// 上游把它实现成按**帧号**取值的表（j 已展开），这里保持同一份数：
// 第 0 帧原样，越往后越扁越宽、同时向下沉，第 5 帧弹回原样 —— 视觉上就是「弹性」。
var PETPET_W = [0.80, 0.82, 0.84, 0.86, 0.88]
var PETPET_H = [0.80, 0.75, 0.70, 0.65, 0.60]
var PETPET_OFFSET_Y = [0.12, 0.17, 0.22, 0.27, 0.32]

var patImages = []
var patReady = false
var patActive = false
var patT = 0                   // ms into the current cycle
var patAccum = 0               // 已累计的划动距离
var patMoveMs = 0              // 达到阈值后持续的时间
var patIdleMs = 0
var patLastX = 0, patLastY = 0, patSeen = false
var patMoved = false
var patBlocked = false
var patBlockMs = 0
var patWaitingPotOff = false
var patPointerOn = false
var patHeartT = 0
var POLL_OPTIONS = [10, 30, 60, 300]
var SOUND_POOL = 4

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
// 正文整体下移的比例（相对整张证书高度）——「往下挪一点」，同时把高度减掉同样多，
// 这样内容底部仍与黄区底边对齐，不会溢出。
var CERT_BODY_DROP = 0.022
var C_CERT_INK = '#000'          // 结算正文墨色（黑）

var STORE_KEY = 'dshBalancePet.state.v1'
// 六个音效槽：受击 / 投喂 / 铁锅扣头 / 取锅 / 回合结束 / 结算
var CUE_IDS = ['hit', 'feed', 'land', 'off', 'turn', 'settle']
var CUE_LABELS = {
  hit: '受击（扣费）',
  feed: '投喂米饭盆',
  land: '铁锅扣头',
  off: '取下铁锅',
  turn: '回合结束喜报',
  settle: '结算证书',
}
// 单击平板后的峰谷视图显示时长（秒）。默认 2.5 秒，右键菜单可改（含自定义）。
var DEFAULT_TARIFF_SECONDS = 2.5
var TARIFF_SECONDS_PRESETS = [1, 2, 2.5, 3, 5, 10]
var TARIFF_SECONDS_MIN = 0.5
var TARIFF_SECONDS_MAX = 60

// —— 拖盆流体形变的强度（倍率，0 = 关闭）——
// 默认「强 1.6×」：比 1× 明显得多；右键菜单可切 关闭 / 弱 / 标准 / 强 / 超强或自定义。
var DEFAULT_FLUID_INTENSITY = 1.6
var FLUID_INTENSITY_PRESETS = [
  { v: 0, label: '关闭（无形变）' },
  { v: 0.7, label: '弱（0.7×）' },
  { v: 1, label: '标准（1×）' },
  { v: 1.6, label: '强（1.6×）' },
  { v: 2.4, label: '超强（2.4×）' },
]
var FLUID_INTENSITY_MAX = 2.5

// —— 持久化状态 ——
var state = {
  character: 'fish',
  sizeIndex: 1,
  sizePx: 0,           // >0 表示用了「自定义尺寸」，此时忽略 sizeIndex
  soundOn: true,
  volume: 80,          // 旧版总音量：同时作为所有音效的初始值
  // 声音菜单的第一层选择：true = 分音效调节（显示每个音效），false = 只显示全部音效音量
  soundPerCue: true,
  // 每个音效自己的音量 0..100；缺省 = volume
  cueVolume: { hit: 80, feed: 80, land: 80, off: 80, turn: 80, settle: 80 },
  // 每个音效的自定义文件元信息（真正的 Blob 在 IndexedDB 里）
  cueCustom: {},
  theme: 'light',      // 菜单配色：light | dark
  snapOnRelease: true,
  snapCorner: 'left',  // 松手吸附到左下角 left / 右下角 right
  pollSeconds: 30,
  hidden: false,
  source: 'deepseek',   // 平板显示哪个 API 的余额（右键菜单可切）
  stepYuan: DEFAULT_STEP, // 每扣多少钱提示一次（最小 0.01 元）
  // 单击平板后峰谷视图显示多久（秒），默认 2.5
  tariffSeconds: DEFAULT_TARIFF_SECONDS,
  // 拖饭盆的流体形变强度（倍率，0 = 关闭），默认强
  fluidIntensity: DEFAULT_FLUID_INTENSITY,
  fxBowlDrop: true,     // 充值后掉米饭盆，手动拖取
  fxPat: true,          // 鼠标抚摸会开心
  fxHurt: true,         // 扣费时播放音效与动画
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
    if (typeof o.sizePx === 'number' && isFinite(o.sizePx) && o.sizePx >= 0) state.sizePx = Math.round(o.sizePx)
    if (typeof o.soundOn === 'boolean') state.soundOn = o.soundOn
    if (typeof o.soundPerCue === 'boolean') state.soundPerCue = o.soundPerCue
    if (typeof o.volume === 'number' && isFinite(o.volume)) {
      state.volume = Math.max(0, Math.min(100, Math.round(o.volume)))
      // 旧状态没有 cueVolume：用总音量补齐
      for (var ci = 0; ci < CUE_IDS.length; ci++) state.cueVolume[CUE_IDS[ci]] = state.volume
    }
    if (o.cueVolume && typeof o.cueVolume === 'object') {
      for (var cj = 0; cj < CUE_IDS.length; cj++) {
        var cid = CUE_IDS[cj]
        var cv = Number(o.cueVolume[cid])
        if (isFinite(cv)) state.cueVolume[cid] = Math.max(0, Math.min(100, Math.round(cv)))
      }
    }
    if (o.cueCustom && typeof o.cueCustom === 'object') {
      for (var ck = 0; ck < CUE_IDS.length; ck++) {
        var id = CUE_IDS[ck]
        var m = o.cueCustom[id]
        if (m && typeof m === 'object' && typeof m.name === 'string') {
          state.cueCustom[id] = {
            name: m.name.slice(0, 80),
            type: String(m.type || '').slice(0, 80),
            size: Number(m.size) || 0,
          }
        }
      }
    }
    if (o.theme === 'dark' || o.theme === 'light') state.theme = o.theme
    if (typeof o.snapOnRelease === 'boolean') state.snapOnRelease = o.snapOnRelease
    if (o.snapCorner === 'left' || o.snapCorner === 'right') state.snapCorner = o.snapCorner
    if (typeof o.pollSeconds === 'number') state.pollSeconds = clampPoll(o.pollSeconds)
    if (typeof o.source === 'string' && o.source) state.source = o.source
    if (typeof o.stepYuan === 'number' && isFinite(o.stepYuan)) state.stepYuan = clampStep(o.stepYuan)
    if (typeof o.tariffSeconds === 'number' && isFinite(o.tariffSeconds)) state.tariffSeconds = clampTariffSeconds(o.tariffSeconds)
    if (typeof o.fluidIntensity === 'number' && isFinite(o.fluidIntensity)) state.fluidIntensity = clampFluidIntensity(o.fluidIntensity)
    if (typeof o.fxBowlDrop === 'boolean') state.fxBowlDrop = o.fxBowlDrop
    if (typeof o.fxPat === 'boolean') state.fxPat = o.fxPat
    if (typeof o.fxHurt === 'boolean') state.fxHurt = o.fxHurt
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
// 平板峰谷视图时长：0.5 ~ 60 秒，保留一位小数
function clampTariffSeconds(s) {
  s = Number(s)
  if (!isFinite(s)) return DEFAULT_TARIFF_SECONDS
  s = Math.round(s * 10) / 10
  if (s < TARIFF_SECONDS_MIN) s = TARIFF_SECONDS_MIN
  if (s > TARIFF_SECONDS_MAX) s = TARIFF_SECONDS_MAX
  return s
}
// 拖盆流体强度：0 ~ 2.5 倍，保留一位小数（0 = 关闭）
function clampFluidIntensity(v) {
  v = Number(v)
  if (!isFinite(v)) return DEFAULT_FLUID_INTENSITY
  v = Math.round(v * 10) / 10
  if (v < 0) v = 0
  if (v > FLUID_INTENSITY_MAX) v = FLUID_INTENSITY_MAX
  return v
}

// —— 运行时 ——
var manifest = null
var charsById = {}
var sources = []       // 可选余额来源（宿主下发）
var sourceLabel = 'DSH 账户余额'
var images = {}     // filename -> HTMLImageElement
var masks = {}      // filename -> {data, w, h}

var container = null, canvas = null, ctx = null, menuEl = null
var W = 0, H = 0, side = 150, spriteRect = { x: 0, y: 0, w: 0, h: 0 }
var destroyed = false

// —— 余额 / 动画状态（照搬 PetModel）——
var realUnits = null      // 最近一次服务器读数（万分之一元）
var bookedUnits = null    // 动画中的显示值
var pendingUnits = 0      // 还没通过动画扣掉的差额
var demoRemaining = 0
var demoOffsetUnits = 0
var lastCueUnits = 0      // 最近一次提示的金额（飘字 / 演示用）
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
var ledgerCache = null         // 最近一次 /ledger.json
var ledgerInFlight = false
var settleOverlay = null       // { root, timer }
var audioUnlocked = false

// —— 来源形态：金额类（balance）vs 订阅额度类（quota）——
var sourceKind = 'balance'
var quotaRemain = null         // 0..100（宿主已统一换算成「剩余 %」）
var quotaLabel = ''
// —— 平板峰谷彩蛋（只对 DSH 账户余额 / DeepSeek 生效）——
var tariffT = 0                // >0：平板显示峰谷彩蛋的剩余秒数（点击后 state.tariffSeconds 秒）
var tariff = null              // { peak, label, nextLabel, nextAt, beijing }
var tariffLoading = false
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
  // 自定义尺寸优先；否则用预设档位
  side = state.sizePx > 0 ? state.sizePx : (SIZE_PRESETS[state.sizeIndex] || 150)
  W = side * 1.5
  H = side * 1.55
  var sw = side * 0.94 * 1.5
  var sh = side * 0.94
  spriteRect = { x: (W - sw) / 2, y: H - 0.03 * side - sh, w: sw, h: sh }
}

// 原版：屏幕上大于等于 side 的那条带才接受点击（画布坐标里就是 y >= H - side）
function inBodyBand(yCanvas) { return yCanvas >= H - side }

// ============================================================================
// 整只角色的镜像 / 弹性形变
// ============================================================================
// 上游 _snapRight：站在屏幕右半边时，立绘、平板几何、摸头的手全部镜像。
// 文字（平板读数、飘字）不镜像 —— 镜像过去的字是反的，没法读。
function isMirrored() { return state.snapCorner === 'right' }

// 铁锅扣头 / 取下时的竖直压缩量（>0 压扁，<0 拉长）。上游公式：
//   cos(u * 2.2π) * (1 - u) * 0.16
function headSquashAmount() {
  if (headSquashT >= HEAD_SQUASH_DUR) return 0
  var u = headSquashT / HEAD_SQUASH_DUR
  return Math.cos(u * Math.PI * HEAD_SQUASH_WOBBLE) * (1 - u) * HEAD_SQUASH_AMP
}

// 摸头当前帧的形变（相对第 0 帧归一化：只有「变化量」有意义，0.8 的基准不能直接乘）
function patSquashAmount() {
  var i = patFrameIndex()
  if (!(i >= 0 && i < PETPET_W.length)) i = 0
  return {
    x: PETPET_W[i] / PETPET_W[0],
    y: PETPET_H[i] / PETPET_H[0],
    shift: (PETPET_OFFSET_Y[i] - PETPET_OFFSET_Y[0]) * spriteRect.h,
  }
}

// 这一帧要用哪个形变：摸头（弹性）压过铁锅回弹（上游同优先级）。
// 返回 null = 不做形变。x/y 是缩放，shift 是「往下沉」的像素量（只折进竖直锚点）。
function currentSquash() {
  // 手部素材没加载成功时不形变 —— 否则会看到她被一只看不见的手按下去（上游同样要求 _patReady）
  if (patActive && patReady) return patSquashAmount()
  var h = headSquashAmount()
  if (Math.abs(h) > 0.002) return { x: 1, y: 1 - h, shift: 0 }
  return null
}

// 形变的两个锚点：竖直在脚底，水平在她自己的中线（上游同）。
function squashAnchorX() { return spriteRect.x + spriteRect.w / 2 }
function squashAnchorY(sq) { return spriteRect.y + spriteRect.h + ((sq && sq.shift) || 0) }


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

// 载入四张表情立绘。**四张全成功才启用** —— 上游同样的取舍：
// 半套会让角色在表情与单图之间闪，比不加还难看。
function loadExpressionArt() {
  if (!(state.character === EXPR_CHARACTER)) { hasExpressions = false; return Promise.resolve(false) }
  if (hasExpressions) return Promise.resolve(true)
  return Promise.all(EXPR_FILES.map(function (f) {
    return new Promise(function (res) {
      var img = new Image()
      img.onload = function () { res(img) }
      img.onerror = function () { res(null) }
      img.src = PREFIX + '/expr/' + f
    })
  })).then(function (list) {
    var got = list.filter(function (x) { return !!x }).length
    if (got !== EXPR_FILES.length) {
      hasExpressions = false
      log('表情立绘只加载到 ' + got + '/' + EXPR_FILES.length + '，保持单图模式')
      return false
    }
    exprImages = list
    hasExpressions = true
    exprIdx = EXPR_HAPPY
    draw()
    return true
  })
}

// 当前该用哪张表情图；不给用时返回 null（走单张立绘那条路）
function expressionFile() {
  if (!hasExpressions) return null
  var ch = activeChar()
  if (!ch || ch.id !== EXPR_CHARACTER) return null
  // 未连接时用的是「抱盆」那张独立立绘，优先于表情
  if (ch.offlineSprite && !connected) return null
  return EXPR_FILES[exprIdx] || null
}

function setExpression(i) {
  if (i === exprIdx) return
  exprIdx = i
  draw()
}

// 表情状态机。优先级与上游逐条对齐：
//   摸头（压过一切）  >  余额归零  >  铁锅在头上（且场上无盆）  >  正在扣费（含结束后 1 秒保持）  >  盆超时未接  >  常态
function updateExpression(dt) {
  if (!hasExpressions) return
  var ch = activeChar()
  if (!ch || ch.id !== EXPR_CHARACTER) { setExpression(EXPR_HAPPY); return }

  // 「有扣费正在播」看的是**动画本身**，不是欠了多少钱 —— 上游特意踩过这个坑。
  // 关掉「扣费动画」后自然也不该再切紧张脸。
  var cueRunning = state.fxHurt && (shakeTime > 0 || demoRestoreTime > 0)
  if (exprBowlAlive && !cueRunning && !exprBowlLocked) bowlWait += dt
  else if (!exprBowlAlive) bowlWait = 0

  var zeroBalance = connected && sourceKind === 'balance' &&
    realUnits !== null && realUnits <= 50   // 上游 ZeroBalEps = 0.005 元

  var want
  if (patActive) {
    // 上游 UpdateExpression 的原文就是 `if (_patActive) want = EXPR_NERVOUS;`
    // —— 摸头时她切到 expression_22（闭眼 / 脸红），不是常态笑脸。
    // 优先级仍然最高：玩家正在跟她互动，这张脸是对玩家的回应。
    want = EXPR_NERVOUS
  } else if (zeroBalance) {
    // 余额归零：上游 v3 的规则是「always ALOOF」，压过铁锅的冷脸。
    want = EXPR_ALOOF
  } else if (exprPotOnHead && !exprBowlAlive) {
    want = EXPR_CALM
  } else if (cueRunning) {
    want = EXPR_NERVOUS
    nervousT = NERVOUS_HOLD_SEC
  } else if (nervousT > 0) {
    want = EXPR_NERVOUS
  } else if (bowlWait >= BOWL_WAIT_SEC) {
    want = EXPR_ALOOF
  } else {
    want = EXPR_HAPPY
  }
  setExpression(want)
}

// ============================================================================
// 米饭盆充值玩法（来自上游 VK-1 v2 / 大肥鱼桌宠改_D-16BVM）
// ============================================================================
// 上游是整屏覆盖层：盆在屏幕上飞、撞屏幕边缘弹、被火控雷达锁定后吸走。
// 这里同样用**全屏覆盖层**：盆可以落在**整个 DSH 窗口底部的任意位置**。
// 重力 / 弹性 / 反弹次数 / 空气阻力 / 滑动摩擦这些参数照抄上游。
//
// 与上游一致的玩法要点（逐条对照过 dsh_pet.ps1）：
//   · 场上**可以有多个盆**（一笔充值一个盆），盆之间有碰撞体积、落点会错开
//   · 盆可以**拖**：按住拖到她身上就喂；也可以甩出去，松手时带出速度
//   · 铁盆同理；只有**下落**能扣在头上，摔到已有锅上会叠起来
//   · 一个盆落地满 BowlWaitSec(10s) 没被领取 → **所有盆一起锁定**；
//     再过 LockDelaySec(1s) 开始按 SuckAccel 加速吸向她，吸到就自动喂
//   · 名牌只认米饭盆（铁盆永远不会被锁定）
//
// 坐标约定：**盆 / 爱心 / 铁锅 / 雷达名牌全部用视口坐标**（相对窗口左上角），
// 画在独立的 #dshpet-rice 覆盖层上；只有挂件本身用画布局部坐标。
var RICE_GRAVITY = 2100        // 上游 RiceGravity（px/s²）
var RICE_RESTITUTION = 0.5     // 上游 RiceRestitution
var RICE_MAX_BOUNCES = 3       // 上游 RiceMaxBounces
var RICE_AIR_DRAG = 0.30       // 上游 RiceAirDrag
var RICE_SLIDE_FRICTION = 1.40 // 上游 RiceSlideFriction
var RICE_SLIDE_STOP = 14       // 上游 RiceSlideStop（px/s，低于它就停下）
var HEART_LIFE = 1.5
var FEED_FADE = 0.5
// 铁锅堆叠：相邻两个锅的**可见锅体**间距 = 锅高的 2/3（稍微重叠，像一摞碗）。
// iron_bowl.png 是 2880×2880 的方图，锅体只占中间约 34.7% 的高度；
// 若按整张方图算间距，看起来就会是一段一段悬空的（用户反馈的 bug）。
var IRON_VISIBLE_H = 0.3472
var IRON_STACK_GAP = 2 / 3
function ironStackStep(r) { return r * 2 * IRON_VISIBLE_H * IRON_STACK_GAP }
// 只有「下落」才能扣在头上：锅的向下速度低于这个值视为「放上去」，不算
var IRON_SEAT_MIN_FALL = 30    // px/s

// —— 火控雷达的锁定与吸附（上游常量，按 side 折算成这里的尺度）——
// 上游是 340 px 的中杯：SuckAccel 960、SuckMaxSpeed 2400 → 每单位 side 为 2.82 / 7.06
var LOCK_DELAY_SEC = 1.0       // 上游 LockDelaySec：锁定后多久开始吸附
// 打开火控雷达时，自动拾取时长缩短到 3 秒（从盆落稳算起）：
// 锁定阈值直接按 3 秒算，并且不再额外等 LockDelaySec，3 秒到就开始吸。
var RADAR_BOWL_WAIT_SEC = 3.0
function bowlWaitSec() { return radarOn ? RADAR_BOWL_WAIT_SEC : BOWL_WAIT_SEC }
function lockDelaySec() { return radarOn ? 0 : LOCK_DELAY_SEC }
function suckAccel() { return side * 2.82 }
function suckMaxSpeed() { return side * 7.06 }
// 名牌方括号边长 S = 1.33 × 盆的绘制直径（上游 ComputeBlip: S = 1.33 * bowlDia）
function bracketS(b) { return 1.33 * b.r * 2 }

var riceImg = null
var ironImg = null
var bowls = []           // 场上所有盆（米饭盆 + 多个可堆叠的铁锅）
var hearts = []          // 投喂时飘起的像素爱心
var radarOn = false      // 「打开火控雷达」：提前亮出名牌，并把自动拾取缩短到 3 秒
var potPendT = 0         // 投喂后延迟一小会儿再把锅丢下来
var potPendN = 0         // 排队等待掉落的锅（一次投喂一个）
var riceSpawnSeq = 0     // 落点分槽：连续几笔充值不会全挤在一处
var riceEl = null        // 全屏覆盖层画布
var riceCtx = null
// 拖动中的盆 + 采样出的「甩出速度」（上游 _throwVX/_throwVY：
// 手拿着盆时 VX/VY 是停留的，接近率必须从光标轨迹采样，否则读数会冻住）
var heldBowl = null
var throwVX = 0, throwVY = 0
var lastPtrX = 0, lastPtrY = 0, lastPtrT = 0
var lastHeadClick = 0    // 双击头部拿铁盆用的时间戳

function viewW() { return Math.max(1, window.innerWidth) }
function viewH() { return Math.max(1, window.innerHeight) }
// 地面 = 窗口底边往上留一点，让盆看着是落在地上而不是贴着边缘
function riceGroundY() { return viewH() - Math.max(4, side * 0.03) }
// 角色头部在**视口坐标**里的位置（盆/锅/爱心/雷达都以它为参照）
//
// 头的水平位置**从立绘的 alpha 掩码里量出来**，不写死。
// 起因：换过一版立绘后角色在画布里的位置变了（头从水平居中挪到了约 0.66 处），
// 写死 0.5 会把锅扣在她左边的头发上。量法：取最上面那一段不透明像素
//（头顶 + 发饰）的水平中心当作「头」。掩码是 384x256（原图 1/4），够精细。
// 拿不到掩码时退回居中的经验值。
var HEAD_BAND = 0.10              // 取最上方 10% 高度来找头顶
var HEAD_ANCHOR_FALLBACK = { x: 0.5, y: 0.06 }
var headAnchor = { x: HEAD_ANCHOR_FALLBACK.x, y: HEAD_ANCHOR_FALLBACK.y }

function computeHeadAnchor() {
  var m = masks[activeSpriteFile()]
  if (!m || !m.data) {
    headAnchor = { x: HEAD_ANCHOR_FALLBACK.x, y: HEAD_ANCHOR_FALLBACK.y }
    return
  }
  var bandY = Math.max(1, Math.round(m.h * HEAD_BAND))
  var lo = m.w, hi = -1
  for (var y = 0; y < bandY; y++) {
    for (var x = 0; x < m.w; x++) {
      if (m.data[(y * m.w + x) * 4 + 3] > 40) {
        if (x < lo) lo = x
        if (x > hi) hi = x
      }
    }
  }
  if (hi < 0) {
    headAnchor = { x: HEAD_ANCHOR_FALLBACK.x, y: HEAD_ANCHOR_FALLBACK.y }
    return
  }
  headAnchor = { x: ((lo + hi) / 2) / m.w, y: HEAD_ANCHOR_FALLBACK.y }
  log('头顶锚点 x=' + headAnchor.x.toFixed(3) + '（量自立绘最上方 ' + (HEAD_BAND * 100) + '%）')
}

function headPoint() {
  var bx = (typeof state.x === 'number') ? state.x : ANCHOR_MARGIN
  var by = (typeof state.y === 'number') ? state.y : 0
  // 头顶锚点是在**未镜像**的立绘上量出来的；镜像后她的头到了另一边。
  var hx = headAnchor.x
  if (isMirrored()) hx = 1 - hx
  var lx = spriteRect.x + spriteRect.w * hx
  var ly = spriteRect.y + spriteRect.h * headAnchor.y
  // 形变中的她整体在动，头顶（挂锅 / 冒爱心的参照点）必须跟着走 ——
  // 上游 DrawRiceArt 同样只让「已经成为她一部分」的锅跟随形变。
  var sq = currentSquash()
  if (sq) {
    var ax = squashAnchorX(), ay = squashAnchorY(sq)
    lx = ax + (lx - ax) * sq.x
    ly = ay + (ly - ay) * sq.y
  }
  return { x: bx + lx, y: by + ly }
}

function loadTopupArt() {
  function one(url) {
    return new Promise(function (res) {
      var img = new Image()
      img.onload = function () { res(img) }
      img.onerror = function () { res(null) }
      img.src = url
    })
  }
  return Promise.all([one(PREFIX + '/rice.png'), one(PREFIX + '/iron_bowl.png')])
    .then(function (list) {
      riceImg = list[0]; ironImg = list[1]
      return true
    })
}

// 摸头手部 5 帧。**五帧全到齐才启用** —— 缺帧会在循环里闪空。
function loadPatArt() {
  return Promise.all(PAT_FILES.map(function (f) {
    return new Promise(function (res) {
      var img = new Image()
      img.onload = function () { res(img) }
      img.onerror = function () { res(null) }
      img.src = PREFIX + '/pat/' + f
    })
  })).then(function (list) {
    var got = 0
    for (var i = 0; i < list.length; i++) if (list[i]) got++
    patImages = list
    patReady = got === PAT_FILES.length
    log(patReady ? 'pat hand loaded: ' + got + ' frames' : 'pat hand not used: ' + got + '/' + PAT_FILES.length)
    return patReady
  })
}

function playFeedSound() { playCue('feed') }

// 场上有活着的米饭盆吗（**铁盆不算**）—— 表情机与名牌都用这个判据。
// 上游 anyBowl 同样排除铁盆：锅在头上不该把「盆没接」的计时算进去。
function anyRiceBowl() {
  for (var i = 0; i < bowls.length; i++) {
    if (!bowls[i].iron && !bowls[i].fed) return true
  }
  return false
}
function ironBowl() {
  var any = null
  for (var i = 0; i < bowls.length; i++) {
    var b = bowls[i]
    if (!b.iron || b.fed) continue
    if (b.onHead) return b
    if (!any) any = b
  }
  return any
}
function liveBowls() {
  var out = []
  for (var i = 0; i < bowls.length; i++) {
    if (!bowls[i].fed) out.push(bowls[i])
  }
  return out
}

function newBowl(props) {
  var b = {
    x: 0, y: 0, vx: 0, vy: 0, r: 10,
    bounces: 0, fed: false, fedT: 0,
    iron: false, onHead: false, homing: false, autoEmpty: false,
    born: 0, restT: 0, grounded: false, amount: 0,
    locked: false, lockT: 0, sucking: false, suckSpeed: 0,
    dragging: false, grabX: 0, grabY: 0, targetX: 0, targetY: 0,
    deform: 0, deformV: 0, shear: 0, shearV: 0,
    prevTargetX: 0, prevTargetY: 0, targetVx: 0, targetVy: 0,
  }
  for (var k in props) { if (Object.prototype.hasOwnProperty.call(props, k)) b[k] = props[k] }
  return b
}

function spawnRice(amount) {
  if (!riceImg) return
  var r = Math.max(10, side * 0.13)
  // 落点在**整个窗口宽度**里随机（网页版的有意差异：盆活动在整个窗口底部，
  // 不局限于屏幕角落；见 README「与原版的差异」）。分成几个槽轮转 + 槽内抖动，
  // 这样连续几笔充值不会恰好挤在同一点 —— 与上游「落点会错开」的观感一致。
  var lo = r + side * 0.02, hi = viewW() - r - side * 0.02
  var SLOTS = 6
  var slot = riceSpawnSeq++ % SLOTS
  var startX = hi > lo ? lo + (hi - lo) * ((slot + 0.15 + Math.random() * 0.7) / SLOTS) : viewW() * 0.5
  // 一笔充值一个盆 —— 场上**可以同时有多个**（上游同）
  bowls.push(newBowl({
    x: startX,
    y: -r,
    // 保留一点横向漂移，落点仍是随机散布
    vx: (Math.random() - 0.5) * side * 1.6,
    vy: 40,
    r: r,
    amount: amount || 0,
  }))
  wake()
}

function spawnIronPot() {
  // 上游 v3：铁盆**可以叠**（每吃掉一个米饭盆掉一个），但场上最多留 5 个，
  // 免得一直挂机时堆成一堵墙。
  if (!ironImg) return
  var n = 0
  for (var i = 0; i < bowls.length; i++) if (bowls[i].iron && !bowls[i].fed) n++
  if (n >= 5) return
  var rp = Math.max(12, side * 0.19)
  var hp = headPoint()
  var dir = Math.random() < 0.5 ? -1 : 1
  bowls.push(newBowl({
    // 吃完后的空锅从桌宠身上**抛到随机位置**，先落在地上；
    // 想扣头要再把它拖回来（见 updateBowls 的拖动判定）。
    x: hp.x,
    y: hp.y - rp * 0.6,
    r: rp,
    iron: true,
    autoEmpty: true,
    vx: dir * side * (0.55 + Math.random() * 0.7),
    vy: -side * (0.55 + Math.random() * 0.5),
  }))
  wake()
}

// 把一口铁锅扣到头上（拖上去 / 落下都能走这里）
function seatIronOnHead(r, hp, slot) {
  if (!r || r.fed) return
  r.onHead = true
  r.homing = false
  r.autoEmpty = false
  r.headSlot = slot
  r.dragging = false
  r.x = hp.x
  r.y = hp.y - slot * ironStackStep(r.r)
  r.vx = 0
  r.vy = 0
  if (heldBowl === r) heldBowl = null
  // 锅落头：她缩一下再弹回来（上游 AttachIronPot 里的 _headSquashT = 0）
  headSquashT = 0
  playCue('land')
  wake()
}
// 堆叠时只取**最上面**那一个；下面的锅会在下一帧自动补位（落点每帧重算）。
// 上游的行为是「铁盆**渐隐消失**」，不是把它弹飞 —— 所以复用「投喂后淡出」那条通道。
function knockPotOff() {
  var top = null
  for (var i = 0; i < bowls.length; i++) {
    var q = bowls[i]
    if (!q.iron || !q.onHead || q.fed) continue
    if (!top || q.y < top.y) top = q
  }
  if (!top) return
  top.onHead = false
  top.fed = true          // fed + fedT 就是「渐隐后被移除」
  top.fedT = 0
  top.vx = 0; top.vy = 0
  if (heldBowl === top) heldBowl = null
  exprPotOnHead = false
  // 取下也要回弹一次（上游 KnockPotOff 同）
  headSquashT = 0
  playCue('off')
  wake()
}

// 盆是不是碰到她了 —— 在盆的圆上采 9 个点，任一落在立绘不透明像素上就算碰到。
// 上游：「碰到头发 / 头饰也算」。
function bowlOnPet(b) {
  var bx = (typeof state.x === 'number') ? state.x : ANCHOR_MARGIN
  var by = (typeof state.y === 'number') ? state.y : 0
  var m = masks[activeSpriteFile()]
  if (!m || !m.data) {
    return b.x + b.r > bx + spriteRect.x && b.x - b.r < bx + spriteRect.x + spriteRect.w &&
           b.y + b.r > by + spriteRect.y && b.y - b.r < by + spriteRect.y + spriteRect.h
  }
  for (var i = 0; i < 9; i++) {
    var a = (i / 9) * Math.PI * 2
    var sx = b.x + (i === 0 ? 0 : Math.cos(a) * b.r * 0.8)
    var sy = b.y + (i === 0 ? 0 : Math.sin(a) * b.r * 0.8)
    var nx = Math.round((sx - bx - spriteRect.x) / spriteRect.w * m.w)
    var ny = Math.round((sy - by - spriteRect.y) / spriteRect.h * m.h)
    // 镜像后取样要翻到原图的另一侧，否则「碰到头发」会判在她的反方向。
    if (isMirrored()) nx = m.w - 1 - nx
    if (nx < 0 || ny < 0 || nx >= m.w || ny >= m.h) continue
    if (m.data[(ny * m.w + nx) * 4 + 3] > 8) return true
  }
  return false
}

// 投喂某一个盆（多盆之后必须按对象投喂，不能再用「场上的那个盆」）
function feedBowl(b) {
  if (!b || b.fed || b.iron) return
  b.fed = true
  b.fedT = 0
  b.dragging = false
  b.locked = false
  b.sucking = false
  if (heldBowl === b) heldBowl = null
  // 锅只在米饭盆被投喂后才出现；连续投喂会排队掉多个，形成堆叠。
  potPendN += 1
  potPendT = potPendT > 0 ? Math.min(potPendT, 0.25) : 1.2
  spawnHearts()
  playFeedSound()
  wake()
}

// 盆与盆之间的碰撞：等质量、沿法线交换法向速度（带弹性）。
// 上游：「它们彼此有碰撞体积、落点会错开，不会叠成一堆」。
function separateBowls() {
  for (var i = 0; i < bowls.length; i++) {
    for (var j = i + 1; j < bowls.length; j++) {
      var a = bowls[i], b = bowls[j]
      if (a.fed || b.fed || a.onHead || b.onHead || a.dragging || b.dragging) continue
      var dx = b.x - a.x, dy = b.y - a.y
      var d = Math.sqrt(dx * dx + dy * dy)
      var minD = a.r + b.r
      if (d >= minD || d < 1e-6) continue
      var nx = dx / d, ny = dy / d
      var push = (minD - d) / 2
      a.x -= nx * push; a.y -= ny * push
      b.x += nx * push; b.y += ny * push
      var vn = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny
      if (vn < 0) {
        var imp = -(1 + RICE_RESTITUTION) * vn / 2
        a.vx -= imp * nx; a.vy -= imp * ny
        b.vx += imp * nx; b.vy += imp * ny
      }
    }
  }
}

// ============================================================================
// 拖动的「流体感」形变 / 头上铁锅的碰撞体积
// ============================================================================
// 有饭的米饭盆拖动时位置跟手，但整只盆像装了半碗水的软体：
//   · 横向拖动 → 下半部分被甩在后面（剪切 shear）
//   · 速度越快 → 横向拉宽、竖向压扁（squash & stretch）
// 两个量都用阻尼弹簧驱动：手停下后半碗水还会来回晃几下再稳住。
// 铁锅不参与（扣头需要精确落点）。
var DEFORM_SPRING = 200        // 压扁 / 拉宽弹簧刚度（1/s²）
var DEFORM_DAMP = 13           // 阻尼比约 0.46，会回弹 1~2 下
var DEFORM_MAX = 0.20          // 最大横向拉伸 / 纵向压缩
var SHEAR_SPRING = 150         // 剪切弹簧刚度（下半部分左右拖尾）
var SHEAR_DAMP = 10            // 阻尼比约 0.41
var SHEAR_MAX = 0.42           // 最大剪切量（相对盆高）
function stepDragBowl(r, dt) {
  var tx = (typeof r.targetX === 'number') ? r.targetX : r.x
  var ty = (typeof r.targetY === 'number') ? r.targetY : r.y
  // 位置直接跟手：流体感只体现在形变上，不再让盆落在指针后面
  r.x = tx
  r.y = ty
  // 指针速度做一点平滑，避免只挪一帧时形变一闪而过；手停下后速度自然衰减到 0
  var instVx = 0, instVy = 0
  if (typeof r.prevTargetX === 'number' && dt > 1e-6) {
    instVx = (tx - r.prevTargetX) / dt
    instVy = (ty - (typeof r.prevTargetY === 'number' ? r.prevTargetY : ty)) / dt
  }
  r.prevTargetX = tx
  r.prevTargetY = ty
  var keep = Math.pow(0.0005, dt)
  r.targetVx = (r.targetVx || 0) * keep + instVx * (1 - keep)
  r.targetVy = (r.targetVy || 0) * keep + instVy * (1 - keep)
  var speed = Math.sqrt(r.targetVx * r.targetVx + r.targetVy * r.targetVy)
  // 强度倍率来自右键菜单（默认 1.6×，可关 / 可自定义）
  var boost = clampFluidIntensity(state.fluidIntensity)
  var speedRef = side * 5
  var wantDeform = Math.min(1, speed / speedRef) * DEFORM_MAX * boost
  // 向右拖 → 下半部分向左拖尾（负剪切）
  var wantShear = Math.max(-1, Math.min(1, -r.targetVx / speedRef)) * SHEAR_MAX * boost
  // 允许自定义到 2.5×，但要挡住离谱的极限形变
  if (wantDeform > 0.45) wantDeform = 0.45
  if (wantShear > 0.9) wantShear = 0.9
  if (wantShear < -0.9) wantShear = -0.9
  var n = Math.max(1, Math.ceil(dt / 0.016))
  var h = dt / n
  for (var i = 0; i < n; i++) {
    var da = (wantDeform - r.deform) * DEFORM_SPRING - r.deformV * DEFORM_DAMP
    r.deformV += da * h
    r.deform += r.deformV * h
    var sa = (wantShear - r.shear) * SHEAR_SPRING - r.shearV * SHEAR_DAMP
    r.shearV += sa * h
    r.shear += r.shearV * h
  }
}
// 松手 / 投喂后形变快速衰减，不要一直歪着
function settleBowlDeform(r, dt) {
  if (!r.deform && !r.deformV && !r.shear && !r.shearV) return
  var k = Math.max(0, 1 - dt * 12)
  r.deform *= k
  r.deformV *= k
  r.shear *= k
  r.shearV *= k
  if (Math.abs(r.deform) < 0.002) { r.deform = 0; r.deformV = 0 }
  if (Math.abs(r.shear) < 0.002) { r.shear = 0; r.shearV = 0 }
}

// 头上铁锅的碰撞体积：可见锅体约为 2r 宽、0.694r 高（iron_bowl.png 中间 34.7%）。
// 碗从上方落下时按宽扁的 AABB 处理 —— 顶面反弹、侧面推开，并带一点横向滑开，
// 这样「在锅上方松手」会看到碗被弹走，而不是穿过锅落到她头上。
var POT_HIT_HALF_W = 0.86
var POT_HIT_HALF_H = 0.3472
function bounceRiceOffPot(r, p) {
  var hw = p.r * POT_HIT_HALF_W
  var hh = p.r * POT_HIT_HALF_H
  var dx = r.x - p.x, dy = r.y - p.y
  var ox = hw + r.r - Math.abs(dx)
  var oy = hh + r.r - Math.abs(dy)
  if (ox <= 0 || oy <= 0) return false
  if (oy <= ox) {
    // 竖向分离：从上面落下 → 顶面弹起。下落中的碗即使这一帧已经陷过锅心，也按顶面算，
    // 避免低帧率时直接穿到锅下面去。
    var signY = (dy < 0 || r.vy >= 0) ? -1 : 1
    r.y = p.y + signY * (hh + r.r)
    if ((signY < 0 && r.vy > 0) || (signY > 0 && r.vy < 0)) r.vy = -r.vy * RICE_RESTITUTION
    // 锅沿是圆的：落点偏离中心时往旁边滑；正中落下也给一点随机侧向，免得卡在锅上
    var edge = hw > 1 ? Math.max(-1, Math.min(1, dx / hw)) : 0
    r.vx += edge * side * 0.9
    if (Math.abs(r.vx) < side * 0.25) r.vx += (dx >= 0 ? 1 : -1) * side * 0.35
    r.grounded = false
  } else {
    // 侧向分离：被锅沿推开
    var signX = dx < 0 ? -1 : 1
    r.x = p.x + signX * (hw + r.r)
    if ((signX < 0 && r.vx > 0) || (signX > 0 && r.vx < 0)) r.vx = -r.vx * RICE_RESTITUTION
    r.vx += signX * side * 0.6
  }
  // 被锅弹开不算「落地未接」，别让它在锅上越弹越接近翻脸计时
  r.restT = 0
  return true
}

function updateBowls(dt) {
  if (potPendT > 0) {
    potPendT -= dt
    if (potPendT <= 0) {
      if (potPendN > 0) {
        spawnIronPot()
        potPendN -= 1
        potPendT = potPendN > 0 ? 0.25 : 0
      }
    }
  }
  var hp = headPoint()

  // —— 头上堆叠的锅：每帧按槽位重排位置 ——
  // 取锅时中间那口消失后，上面的会自动往下补位，不会留下一个空洞。
  var worn = []
  for (var wi = 0; wi < bowls.length; wi++) {
    var wq = bowls[wi]
    if (wq.iron && wq.onHead && !wq.fed) worn.push(wq)
  }
  worn.sort(function (a, b) { return (a.headSlot || 0) - (b.headSlot || 0) })
  for (var ws = 0; ws < worn.length; ws++) {
    var wp = worn[ws]
    // 头上的锅跟随当前尺寸档（改大小后不用重新喂一遍）
    wp.r = Math.max(12, side * 0.19)
    wp.headSlot = ws
    wp.x = hp.x
    wp.y = hp.y - ws * ironStackStep(wp.r)
  }
  exprPotOnHead = worn.length > 0

  // —— 锁定判定 ——
  // 「只要有一个米饭盆落地满 BowlWaitSec 没被领取，**所有**盆一起锁定」。
  // 上游的例子：第 1 个盆满 10 秒时，刚掉下来 2 秒的那个也一起被锁。
  // 打开火控雷达时阈值缩短到 3 秒（bowlWaitSec），便于快速验证名牌与吸附。
  var trigger = false
  var waitSec = bowlWaitSec()
  for (var i = 0; i < bowls.length; i++) {
    var q = bowls[i]
    if (q.iron || q.fed || q.dragging || q.locked) continue
    if (q.restT >= waitSec) trigger = true
  }
  if (trigger) {
    for (var i = 0; i < bowls.length; i++) {
      var q = bowls[i]
      if (!q.iron && !q.fed) { q.locked = true; q.lockT = 0; q.suckSpeed = 0 }
    }
    exprBowlLocked = true
    wake()
  }

  for (var i = bowls.length - 1; i >= 0; i--) {
    var r = bowls[i]
    if (r.fed) {
      r.fedT += dt
      settleBowlDeform(r, dt)
      if (r.fedT >= FEED_FADE) {
        bowls.splice(i, 1)
        if (heldBowl === r) heldBowl = null
      }
      continue
    }
    r.born += dt
    // 不是拿在手上的盆：形变快速归零（松手后不会一直歪着）
    if (!r.dragging) settleBowlDeform(r, dt)

    // —— 手拿着：米饭盆跟手 + 流体形变，铁锅保持精确跟手；碰到她就喂 ——
    if (r.dragging) {
      r.restT = 0
      if (r.iron) {
        // 空锅要能精确放到头顶，所以仍然是「跟手」
        if (typeof r.targetX === 'number') { r.x = r.targetX; r.y = r.targetY }
      } else {
        // 有饭的米饭盆：位置跟手，绕手握点做阻尼摆动（下半部分左右摇）
        stepDragBowl(r, dt)
      }
      if (!r.iron && bowlOnPet(r)) { feedBowl(r); continue }
      // 空锅第二次被拖回她身上时，直接扣到头上（不必松手让它再落一次）
      if (r.iron) {
        var dragSeatY = hp.y - worn.length * ironStackStep(r.r)
        var nearHead = Math.abs(r.x - hp.x) <= spriteRect.w * 0.32 &&
          r.y >= dragSeatY - r.r * 1.6 && r.y <= dragSeatY + r.r * 1.4
        if (nearHead || bowlOnPet(r)) {
          seatIronOnHead(r, hp, worn.length)
          continue
        }
      }
      continue
    }

    // —— 扣在头上：位置已经由上面的堆叠重排写好，这里只跳过物理 ——
    if (r.onHead) continue

    // —— 自动掉落的锅：边落边横向追着她的头，避免她走动后锅落在空地上 ——
    if (r.iron && r.homing && r.y < hp.y) {
      // 直接对齐头顶：自动掉的锅不该因为她在移动就落到地上
      r.x = hp.x
      r.vx = 0
    }

    // —— 铁锅落到头顶高度、且横向也在头附近 → 扣上 ——
    // 只有**下落**（vy >= IRON_SEAT_MIN_FALL）才算，松手「放」在她头上不算；
    // 刚吃完掉下来的空锅 autoEmpty 不会自动扣头，必须先被拖一次。
    // 有堆叠时目标高度是最上面那口锅的锅沿。
    if (r.iron && !r.autoEmpty && r.vy >= IRON_SEAT_MIN_FALL) {
      var seatY = hp.y - worn.length * ironStackStep(r.r)
      if ((r.y + r.r * 0.35) >= seatY && r.y <= seatY + r.r * 1.5 &&
          Math.abs(r.x - hp.x) <= spriteRect.w * 0.30) {
        seatIronOnHead(r, hp, worn.length)
        continue
      }
    }

    // —— 吸附：锁定满 LockDelaySec 后开始，按 SuckAccel 加速朝她飞 ——
    // 打开火控雷达时不等这 1 秒（lockDelaySec 返回 0），落地满 3 秒就开始吸。
    if (r.locked) {
      r.lockT += dt
      if (r.lockT >= lockDelaySec()) r.sucking = true
    }
    if (r.sucking) {
      var dx = hp.x - r.x, dy = hp.y - r.y
      var d = Math.sqrt(dx * dx + dy * dy) || 1e-6
      if (d < r.r + side * 0.05) { feedBowl(r); continue }
      // 直接沿「朝她」的方向推进（上游 Radarsuck：Speed 加速、step = Speed·dt）。
      // 之前是把加速度累加到 vx/vy 上再走物理：速度会冲过头、绕着她打转，
      // 距离一直收敛不到喂食阈值 —— 雷达开启后 3 秒吸附会永远吃不到。
      // 雷达开启时直接用最高速：3 秒一到就落到她身上，不去等加速段。
      r.suckSpeed = radarOn
        ? suckMaxSpeed()
        : Math.min(suckMaxSpeed(), (r.suckSpeed || 0) + suckAccel() * dt)
      var step = r.suckSpeed * dt
      if (step >= d) { feedBowl(r); continue }
      r.x += (dx / d) * step
      r.y += (dy / d) * step
      r.vx = (dx / d) * r.suckSpeed
      r.vy = (dy / d) * r.suckSpeed
      r.grounded = false
      continue
    }

    // —— 重力 + 空气阻力 ——
    r.vy += RICE_GRAVITY * dt
    var drag = Math.max(0, 1 - RICE_AIR_DRAG * dt)
    r.vx *= drag
    r.vy *= drag
    r.x += r.vx * dt
    r.y += r.vy * dt

    // 左右墙 = 窗口左右边
    var vw = viewW()
    if (r.x - r.r < 0) { r.x = r.r; r.vx = Math.abs(r.vx) * RICE_RESTITUTION }
    if (r.x + r.r > vw) { r.x = vw - r.r; r.vx = -Math.abs(r.vx) * RICE_RESTITUTION }

    // 地面 = 窗口底边：弹几下之后转为滑动，最后停住
    var floor = riceGroundY()
    var wasGrounded = r.grounded
    r.grounded = false
    if (r.y + r.r > floor) {
      r.y = floor - r.r
      r.grounded = true
      // 铁锅第一次落到窗口底部：播放「扣头」音效（对调后的 pot_off）
      if (r.iron && !wasGrounded && Math.abs(r.vy) > 90) playCue('land')
      if (Math.abs(r.vy) > 90 && r.bounces < RICE_MAX_BOUNCES) {
        r.vy = -Math.abs(r.vy) * RICE_RESTITUTION
        r.bounces += 1
      } else {
        r.vy = 0
        // 滑动摩擦
        var f = RICE_SLIDE_FRICTION * dt * 60
        if (Math.abs(r.vx) <= RICE_SLIDE_STOP) r.vx = 0
        else r.vx -= Math.sign(r.vx) * Math.min(Math.abs(r.vx), f * 8)
      }
    }

    // —— 头上的铁锅是实体：米饭盆落在上面会被弹开（从最上面那口锅开始判） ——
    if (!r.iron && worn.length) {
      for (var pk = worn.length - 1; pk >= 0; pk--) {
        if (bounceRiceOffPot(r, worn[pk])) break
      }
    }

    // 「落地后 10 秒」—— 只在地面上待着时才累计（被拿起来就清零）
    if (r.grounded && Math.abs(r.vx) < RICE_SLIDE_STOP * 4) r.restT += dt
    else r.restT = 0
  }

  separateBowls()

  // 表情机用的两个开关
  exprBowlAlive = anyRiceBowl()
  var ib = ironBowl()
  exprPotOnHead = !!(ib && ib.onHead)
  // 米饭盆全被吃光 → 解除锁定
  if (!exprBowlAlive) exprBowlLocked = false
}

// 兼容旧调用：喂「最靠前的一个米饭盆」（菜单以外的内部路径还会用到）
function feedRice() {
  for (var i = 0; i < bowls.length; i++) {
    if (!bowls[i].iron && !bowls[i].fed) { feedBowl(bowls[i]); return }
  }
}

function spawnHearts() {
  // 爱心从**她的头**上飘起来（视口坐标），而不是从盆的位置
  var hp = headPoint()
  for (var i = 0; i < 5; i++) {
    hearts.push({
      x: hp.x + (Math.random() - 0.5) * side * 0.28,
      y: hp.y + (Math.random() - 0.5) * side * 0.1,
      vx: (Math.random() - 0.5) * side * 0.5,
      vy: -side * (0.45 + Math.random() * 0.35),
      age: 0,
      size: Math.max(7, side * 0.075) * (0.75 + Math.random() * 0.5),
    })
  }
}

function updateHearts(dt) {
  for (var i = hearts.length - 1; i >= 0; i--) {
    var h = hearts[i]
    h.age += dt
    h.x += h.vx * dt
    h.y += h.vy * dt
    h.vy += side * 0.35 * dt          // 轻微下坠，飘得更自然
    if (h.age >= HEART_LIFE) hearts.splice(i, 1)
  }
}

// 像素爱心（方块拼的，与上游一致）
var HEART_MASK = [
  '01100110',
  '11111111',
  '11111111',
  '11111111',
  '01111110',
  '00111100',
  '00011000',
]
function drawHeartsOn(c) {
  if (!hearts.length) return
  for (var i = 0; i < hearts.length; i++) {
    var h = hearts[i]
    var t = h.age / HEART_LIFE
    c.save()
    c.globalAlpha = Math.max(0, 1 - t * t)
    var px = h.size / 8
    c.fillStyle = '#ff4d6d'
    for (var ry = 0; ry < HEART_MASK.length; ry++) {
      for (var rx = 0; rx < 8; rx++) {
        if (HEART_MASK[ry].charAt(rx) === '1') {
          c.fillRect(h.x + (rx - 4) * px, h.y + (ry - 3.5) * px, px + 0.6, px + 0.6)
        }
      }
    }
    c.restore()
  }
}

function drawRiceOn(c) {
  // 多盆：先画所有盆（被吃的那个淡出），再画名牌 —— 名牌要盖在盆上面
  for (var i = 0; i < bowls.length; i++) {
    var r = bowls[i]
    var img = r.iron ? ironImg : riceImg
    if (!img) continue
    var size = r.r * 2
    c.save()
    if (r.fed) c.globalAlpha = Math.max(0, 1 - r.fedT / FEED_FADE)
    // 拖动流体感：横向拉伸 + 竖向压扁，再叠一点「下半部分拖尾」的剪切。
    // 绕手握点做；铁锅保持原样（扣头需要稳定落点）。
    var deform = r.iron ? 0 : (r.deform || 0)
    var shear = r.iron ? 0 : (r.shear || 0)
    if (deform || shear) {
      var px = r.x + (r.dragging ? (r.grabX || 0) : 0)
      var py = r.y + (r.dragging ? (r.grabY || 0) : 0)
      c.translate(px, py)
      if (shear) c.transform(1, 0, shear, 1, 0, 0)
      if (deform) c.scale(1 + deform, 1 - deform * 0.65)
      c.translate(-px, -py)
    }
    c.drawImage(img, r.x - r.r, r.y - r.r, size, size)
    c.restore()
  }
  // 名牌只认米饭盆：铁盆永远不会被锁定（上游同）。radarOn 是菜单里手动提前亮出来看。
  for (var j = 0; j < bowls.length; j++) {
    var b = bowls[j]
    if (b.iron || b.fed) continue
    if (b.locked || radarOn) drawRadar(c, b)
  }
  // 摸头的手画在最上层（全屏覆盖层，不会被挂件画布裁切）
  drawPatHand(c)
}

// 全屏覆盖层：清空后重画盆 / 爱心 / 雷达名牌。
// 每帧都清一遍 —— 否则上一帧的盆会留在画面上擦不掉。
function drawRiceLayer() {
  if (!riceCtx || !riceEl) return
  if (!bowls.length && !hearts.length && !patActive) {
    // 没东西可画时也要清掉残留（比如盆刚被投喂淡出）
    if (riceEl._dirty !== false) {
      riceCtx.setTransform(1, 0, 0, 1, 0, 0)
      riceCtx.clearRect(0, 0, riceEl.width, riceEl.height)
      riceEl._dirty = false
    }
    return
  }
  var dpr = Math.min(3, window.devicePixelRatio || 1)
  var pw = Math.round(viewW() * dpr), ph = Math.round(viewH() * dpr)
  if (riceEl.width !== pw || riceEl.height !== ph) {
    riceEl.width = pw
    riceEl.height = ph
    riceEl.style.width = viewW() + 'px'
    riceEl.style.height = viewH() + 'px'
  }
  riceCtx.setTransform(dpr, 0, 0, dpr, 0, 0)
  riceCtx.clearRect(0, 0, viewW(), viewH())
  riceEl._dirty = true
  drawRiceOn(riceCtx)
  drawHeartsOn(riceCtx)
}

// 火控雷达目标名牌（《战争雷霆》风格）—— 几何**逐条照抄上游** ComputeBlip / DrawRadar：
//   · 参照点 = 角色的**头**（GirlRefScreen）
//   · 方括号边长 S = 1.33 × 盆的绘制直径；四角臂长 0.30 S，纯平色、**没有外发光**
//     （上游专门注释过：设计稿里的 1px 光晕是截图 JPEG 伪影，试过、不对、已移除）
//   · 类型字 0.40 S 居中在括号上方；数字字 0.30 S
//   · 距离在括号右侧（左边缘 x1 + 0.08 S），接近率在右下（底边贴 y1）
//   · 相对高度右对齐在 x1 + 0.11 S、顶边 y1 + 0.09 S
//   · 方向环：圆心 (cx, y1 + 0.70 S)，半径 0.185 S，描边 0.075 S；
//     指针从环外缘沿方位角伸出 0.15 S
//   · 上游**刻意不做屏幕边缘避让**（贴边裁掉可以接受，缩小字号会看不清）
function fmtKpx(v) {
  if (!isFinite(v)) return '--'
  if (v < 0) v = 0
  return (v / 1000).toFixed(1) + ' kpx'
}
function fmtPxS(v) {
  if (!isFinite(v)) return '--'
  var r = Math.round(v)
  if (r === 0) r = 0                     // 消掉 -0
  return r + ' px/s'
}
function fmtPx(v) {
  if (!isFinite(v)) return '--'
  var r = Math.round(v)
  if (r === 0) r = 0
  return r + ' px'
}

function drawRadar(c, b) {
  var S = bracketS(b)
  var cx = b.x, cy = b.y
  var x0 = cx - S / 2, x1 = cx + S / 2
  var y0 = cy - S / 2, y1 = cy + S / 2
  var stroke = Math.max(1, 0.075 * S)
  var green = '#00ff08'                  // 上游是纯平的 (0,255,8)

  c.save()
  c.strokeStyle = green
  c.fillStyle = green
  c.textBaseline = 'middle'

  // —— 四角方括号：横臂 + 竖臂，用矩形填充（上游 FillRectangle，无圆角、无光晕）——
  var len = 0.30 * S
  c.fillRect(x0, y0, len, stroke); c.fillRect(x1 - len, y0, len, stroke)
  c.fillRect(x0, y1 - stroke, len, stroke); c.fillRect(x1 - len, y1 - stroke, len, stroke)
  c.fillRect(x0, y0, stroke, len); c.fillRect(x1 - stroke, y0, stroke, len)
  c.fillRect(x0, y1 - len, stroke, len); c.fillRect(x1 - stroke, y1 - len, stroke, len)

  // —— 读数：与上游同一套换算 ——
  var hp = headPoint()
  var dx = cx - hp.x, dy = cy - hp.y
  var dist = Math.sqrt(dx * dx + dy * dy) || 1e-6
  var ux = dx / dist, uy = dy / dist
  // 手拿着盆时 VX/VY 是停留的（留着松手用），接近率必须取光标轨迹采样值，
  // 否则「拿在手里不动」会一直报着停下前的那个读数（上游踩过这个坑）。
  var vx = b.dragging ? throwVX : b.vx
  var vy = b.dragging ? throwVY : b.vy
  var closure = -(vx * ux + vy * uy)     // 正 = 正在靠近
  var alt = -dy                          // 正 = 盆比她的头高
  var dirDeg = Math.atan2(uy, ux) * 180 / Math.PI

  var typeH = Math.max(11, 0.40 * S)
  var numH = Math.max(11, 0.30 * S)
  var gapX = 0.08 * S

  // 类型：居中在括号上方
  c.font = '700 ' + typeH + 'px ui-monospace,Consolas,monospace'
  c.textAlign = 'center'
  c.fillText('白饭', cx, y0 - 0.06 * S - typeH / 2)
  // 数字：统一左对齐
  c.textAlign = 'left'
  c.font = '700 ' + numH + 'px ui-monospace,Consolas,monospace'
  c.fillText(fmtKpx(dist), x1 + gapX, y0 + numH / 2)
  c.fillText(fmtPxS(closure), x1 + gapX, y1 - numH / 2)
  // 相对高度：右对齐在括号右下方
  c.textAlign = 'right'
  c.fillText(fmtPx(alt), x1 + 0.11 * S, y1 + 0.09 * S + numH / 2)

  // —— 方向环 + 指针 ——
  var ringR = 0.185 * S
  var ringStroke = 0.075 * S
  var rcx = cx, rcy = y1 + 0.70 * S
  c.lineWidth = ringStroke
  c.beginPath()
  c.arc(rcx, rcy, ringR - ringStroke / 2, 0, Math.PI * 2)
  c.stroke()
  var ang = dirDeg * Math.PI / 180
  c.beginPath()
  c.moveTo(rcx + Math.cos(ang) * (ringR + ringStroke * 0.5),
           rcy + Math.sin(ang) * (ringR + ringStroke * 0.5))
  c.lineTo(rcx + Math.cos(ang) * (ringR + 0.15 * S),
           rcy + Math.sin(ang) * (ringR + 0.15 * S))
  c.stroke()
  c.restore()
}

// 画布坐标 → 命中判定
function hitTest(cx, cy) {  if (!inBodyBand(cy)) return false
  if (cx < spriteRect.x || cx > spriteRect.x + spriteRect.w) return false
  if (cy < spriteRect.y || cy > spriteRect.y + spriteRect.h) return false
  var f = activeSpriteFile()
  var m = f ? masks[f] : null
  if (!m) return true // 取不到掩码就整块可点（退化但可用）
  var nx = (cx - spriteRect.x) / spriteRect.w
  var ny = (cy - spriteRect.y) / spriteRect.h
  // 立绘镜像时，画面上左半边其实来自原图右半边 —— 掩码要按镜像后的坐标取样。
  if (isMirrored()) nx = 1 - nx
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

function currencySymbol(cur) {
  var c = String(cur || '').toUpperCase()
  if (c === 'CNY' || c === 'RMB') return '¥'
  if (c === 'USD') return '$'
  if (c === 'EUR') return '€'
  if (c === 'JPY') return 'JP¥'
  return c ? c : '¥'
}

function displayedUnits() {
  if (bookedUnits === null) return null
  return Math.max(Math.min(0, bookedUnits), bookedUnits - demoOffsetUnits)
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
  // 表情启用时用表情图顶掉单张立绘（只有大肥鱼有表情）
  var ef = expressionFile()
  if (ef && exprImages[exprIdx]) img = exprImages[exprIdx]

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

  // 这一帧的形变（摸头弹性 / 铁锅回弹）与「是否镜像到右半边」。
  // 形变锚点：竖直在脚底（摸头时再往下沉一点），水平在她的中线。
  var sq = currentSquash()
  var mir = isMirrored()
  var ax = squashAnchorX()
  var ay = squashAnchorY(sq)

  if (img) {
    // 按**原图宽高比**等比缩放，而不是硬铺满 spriteRect。
    // 原因：spriteRect 是按立绘 1536x1024（1.5:1）算出来的，而早期版本的表情立绘是
    // 1024x1024 正方形 —— 铺满会把角色横向拉长 1.5 倍（这就是「大肥鱼被拉长」的原因）。
    // 现在表情图也是 1536x1024，但这段仍然按原图比例算：以后换成别的比例也不会拉伸。
    // 这里以**高度**为基准对齐：角色在两种图里高度一致，换表情不会跳大小。
    // 对 1536x1024 的立绘本身，这个式子算出来正好等于 spriteRect，是恒等变换。
    var dw = spriteRect.w, dh = spriteRect.h, dx = sx, dy = sy
    if (img.width > 0 && img.height > 0) {
      var k = spriteRect.h / img.height
      dh = spriteRect.h
      dw = img.width * k
      dx = sx + (spriteRect.w - dw) / 2
      dy = sy + (spriteRect.h - dh) / 2
    }
    ctx.save()
    if (sq) {
      ctx.translate(ax, ay)
      ctx.scale(sq.x, sq.y)
      ctx.translate(-ax, -ay)
    }
    if (mir) {
      // 绕立绘自身的中线翻转。平板的四边形、命中掩码、头顶锚点各自走同一套镜像，
      // 所以「她转过身」之后手里的平板仍然在她手上。
      ctx.translate(dx + dw / 2, 0)
      ctx.scale(-1, 1)
      ctx.translate(-(dx + dw / 2), 0)
    }
    ctx.drawImage(img, dx, dy, dw, dh)
    // 红闪：source-atop 只覆盖不透明像素，保住精灵轮廓（原版 blendMode = .sourceAtop）
    var impact = Math.max(flashImpact(), celebrateImpact())
    if (impact > 0) {
      ctx.globalCompositeOperation = 'source-atop'
      ctx.fillStyle = C_FLASH + (0.45 * impact) + ')'
      ctx.fillRect(dx, dy, dw, dh)
      ctx.globalCompositeOperation = 'source-over'
    }
    ctx.restore()
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
  if (img && ch && !offlineArt) drawTablet(ch, shakeX, shakeY, dpr, sq)

  // 光环与飘字用不带震动的基准变换
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  drawTopupRing()
  drawFloating()

  // 米饭盆 / 爱心 / 雷达画在**独立的窗口级覆盖层**上（视口坐标）
  drawRiceLayer()
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

// 平板四角在**画布坐标**里的位置。镜像时 x 按原图宽度翻（上游 _sprNormalSourceW - x），
// 并且顶点顺序会反转 —— 所以这里返回的是「面板的左上 / 右上 / 左下 / 右下」（A/B/C/D），
// 不是原图里 TL/TR/BL 的固定角色。镜像后继续用 TL 当左上角，整个面板会歪到腿上去。
function tabletQuad(ch) {
  var s = spriteRect.w / SPRITE_W
  var mir = isMirrored()
  function m(p) { return [mir ? SPRITE_W - p[0] : p[0], p[1]] }
  var TL = m(ch.tablet.tl), TR = m(ch.tablet.tr), BL = m(ch.tablet.bl)
  // 第四个角由平行四边形补出来（角色表只存三个角）
  var BR = [TR[0] + BL[0] - TL[0], TR[1] + BL[1] - TL[1]]
  var A, B, C, D
  if (mir) {
    // 镜像后的环是 TR', TL', BR', BL'：面板的左上角是 TR'，左下角是 BR'
    A = TR; B = TL; C = BR; D = BL
  } else {
    A = TL; B = TR; C = BL; D = BR
  }
  return {
    A: { x: spriteRect.x + A[0] * s, y: spriteRect.y + A[1] * s },
    B: { x: spriteRect.x + B[0] * s, y: spriteRect.y + B[1] * s },
    C: { x: spriteRect.x + C[0] * s, y: spriteRect.y + C[1] * s },
    D: { x: spriteRect.x + D[0] * s, y: spriteRect.y + D[1] * s },
  }
}

// 平板仿射：把 400×220 的面板坐标直接映射到设备像素。
// 推导用原图左上角为原点、y 向下；已用原版文档记录的右下角 (1443,834)/(1430,836) 验证过。
// 注意要把 dpr、震动偏移、形变一起揉进矩阵，否则 setTransform 会把它们抹掉。
function drawTablet(ch, shakeX, shakeY, dpr, sq) {
  var panel = manifest.panel || { w: 400, h: 220 }
  var c = ctx
  var pw = panel.w, ph = panel.h
  var q = tabletQuad(ch)
  var A = q.A, B = q.B, C = q.C
  var a = (B.x - A.x) / pw
  var b = (B.y - A.y) / pw
  var cc = (C.x - A.x) / ph
  var d = (C.y - A.y) / ph
  var e = A.x + shakeX
  var f = A.y + shakeY
  c.setTransform(dpr, 0, 0, dpr, 0, 0)
  // 平板只跟随**竖直**形变（上游 SquashY）：横向张开会把整个面板拉宽，字会跟着变形。
  // 形变必须放在 setTransform 之后作为 transform 叠上去，否则会被矩阵抹掉。
  if (sq) {
    var ay = squashAnchorY(sq)
    c.transform(1, 0, 0, sq.y, 0, ay * (1 - sq.y))
  }
  c.transform(a, b, cc, d, e, f)

  // 金额类显示钱；订阅额度类没有金额，显示「剩余 %」（宿主已把各家的
  // 「已用 %」「剩余 %」两种语义统一成剩余百分比）
  var isQuota = sourceKind === 'quota'
  var showTariff = tariffT > 0 && !isQuota && isDeepseekSource()
  var isConn = connected
  var value = isQuota
    ? (quotaRemain === null || !isFinite(quotaRemain) ? '--' : Math.round(quotaRemain) + '%')
    : moneyString(displayedUnits())

  if (showTariff) {
    // 点击平板后显示 state.tariffSeconds 秒（默认 2.5）：背景峰价红 / 谷价绿。
    // 布局按需求改成**两行**：第一行 梁文峰 / 梁文谷，第二行 距峰时 / 距谷时 + 剩余时长。
    // 没有「峰谷时段」标题行了 —— 面板只放这两行。
    if (tariff && tariffRemainSec() <= 0) ensureTariff(true)
    var peakNow = !!(tariff && tariff.peak)
    var bg = tariff ? (peakNow ? '#c62828' : '#2e7d32') : '#455a64'
    c.fillStyle = bg
    c.fillRect(0, 0, pw, ph)

    var tName = tariff ? tariff.label : '峰谷时段'
    var tNext = tariff ? (tariff.nextLabel + ' ' + fmtDuration(tariffRemainSec())) : '正在读取…'
    var nameSize = ph * 0.34
    var subSize = ph * 0.185
    // 两行的中线：上 0.38、下 0.72（面板坐标 y 向下）
    var nameY = ph * 0.38
    var nextY = ph * 0.72
    var maxTextW = pw * PANEL_MAX_TEXT_RATIO

    c.textAlign = 'center'
    c.textBaseline = 'middle'

    // 第一行：梁文峰（峰价）/ 梁文谷（谷价）
    c.fillStyle = '#ffffff'
    c.font = 'bold ' + nameSize + 'px system-ui, "Segoe UI", sans-serif'
    var nameW = c.measureText(tName).width
    var nameScale = nameW > maxTextW ? maxTextW / nameW : 1
    c.save()
    c.translate(pw / 2, nameY)
    c.scale(nameScale, nameScale)
    c.fillText(tName, 0, 0)
    c.restore()

    // 第二行：距峰时 / 距谷时 + 倒计时
    c.fillStyle = 'rgba(255,255,255,0.90)'
    c.font = 'bold ' + subSize + 'px ui-monospace, "SF Mono", Consolas, monospace'
    var nextW = c.measureText(tNext).width
    var nextScale = nextW > maxTextW ? maxTextW / nextW : 1
    c.save()
    c.translate(pw / 2, nextY)
    c.scale(nextScale, nextScale)
    c.fillText(tNext, 0, 0)
    c.restore()

    c.beginPath()
    c.arc(pw * DOT_X_RATIO, ph - ph * DOT_Y_RATIO, DOT_SIZE / 2, 0, Math.PI * 2)
    c.fillStyle = 'rgba(255,255,255,0.92)'
    c.fill()
    c.setTransform(dpr, 0, 0, dpr, 0, 0)
    return
  }

  // 标题：内置来源显示「DSH 账户余额」，其它来源显示该来源名。
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

  var rowY = ph - ph * PANEL_ROW_RATIO
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

// 画布局部坐标是否落在平板四边形里（点击平板切换峰谷彩蛋用）。
// 与 drawTablet 共用 tabletQuad：镜像 / 换角色 / 改尺寸后都不会「看得到却点不到」。
function pointInTablet(cx, cy) {
  var ch = activeChar()
  if (!ch || !ch.tablet) return false
  var q = tabletQuad(ch)
  var pts = [[q.A.x, q.A.y], [q.B.x, q.B.y], [q.D.x, q.D.y], [q.C.x, q.C.y]]
  var inside = false
  for (var i = 0, j = 3; i < 4; j = i++) {
    var xi = pts[i][0], yi = pts[i][1]
    var xj = pts[j][0], yj = pts[j][1]
    if (((yi > cy) !== (yj > cy)) && (cx < (xj - xi) * (cy - yi) / (yj - yi) + xi)) inside = !inside
  }
  return inside
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
  bookedUnits = realUnits
  pendingUnits = 0
  demoRemaining = 0
  demoOffsetUnits = 0
  demoRestoreTime = 0
}

function appendLabel(text, color) {
  floating.push({ text: text, color: color, age: 0 })
  while (floating.length > 60) floating.shift()
  wake()
}

// ============================================================================
// 音效：每个音效独立音量 + 可选自定义音频
// ============================================================================
var CUE_FILES = {
  hit: PREFIX + '/hit.mp3',
  feed: PREFIX + '/sound/feed.mp3',
  // 按用户要求：扣头 / 取下两个音效对调
  land: PREFIX + '/sound/pot_off.mp3',
  off: PREFIX + '/sound/pot_land.mp3',
  turn: PREFIX + '/sound/turn.mp3',
  settle: PREFIX + '/sound/settle.mp3',
}
// 浏览器 / Electron(Chromium) 能直接解码的常见格式。
// accept 只负责在文件选择器里过滤；真正的校验在 isSupportedAudioFile()。
var AUDIO_ACCEPT = 'audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/ogg,audio/mp4,audio/aac,audio/flac,audio/webm,.mp3,.wav,.ogg,.m4a,.aac,.flac,.webm,.opus'
var AUDIO_EXTS = ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm', 'opus']
var AUDIO_MIME = {
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
  aac: 'audio/aac', flac: 'audio/flac', webm: 'audio/webm', opus: 'audio/ogg',
}
var AUDIO_MAX_BYTES = 20 * 1024 * 1024
var customUrls = {}      // cue -> objectURL / dataURL
var cuePools = {}        // "cue|src" -> pool
var audioDbPromise = null

function cueVolume(name) {
  var v = state.cueVolume && state.cueVolume[name]
  if (!isFinite(v)) v = state.volume
  return Math.max(0, Math.min(100, Math.round(Number(v) || 0)))
}

function allCuesAt(v) {
  for (var i = 0; i < CUE_IDS.length; i++) if (cueVolume(CUE_IDS[i]) !== v) return false
  return true
}

function cueSource(name) {
  return customUrls[name] || CUE_FILES[name]
}

function resetCuePool(name) {
  for (var key in cuePools) {
    if (!Object.prototype.hasOwnProperty.call(cuePools, key)) continue
    if (key.indexOf(name + '|') !== 0) continue
    var pool = cuePools[key]
    for (var i = 0; i < pool.length; i++) {
      try { pool[i].pause() } catch (err) {}
    }
    delete cuePools[key]
  }
}

function playCue(name) {
  if (!state.soundOn) return
  var vol = cueVolume(name)
  if (!(vol > 0)) return
  var src = cueSource(name)
  if (!src) return
  try {
    var key = name + '|' + src
    var pool = cuePools[key]
    if (!pool) {
      pool = cuePools[key] = []
      var slots = name === 'hit' ? SOUND_POOL : (name === 'settle' ? 1 : 2)
      for (var i = 0; i < slots; i++) {
        var a = new Audio(src)
        // 结算音很大：只在真的播放时拉取，绝不预加载
        a.preload = (name === 'settle' && !customUrls[name]) ? 'none' : 'auto'
        pool.push(a)
      }
      pool._i = 0
    }
    pool._i = (pool._i + 1) % pool.length
    var s = pool[pool._i]
    s.volume = vol / 100
    try { s.pause(); s.currentTime = 0 } catch (err) {}
    var p = s.play()
    if (p && p.catch) p.catch(function () {})
  } catch (err) {}
}

function playSound() { playCue('hit') }

// 关闭「开启音效」时，正在播放的长音效（尤其是用户上传的自定义音频）也要立即停住；
// 只把标志置 false 不会让已经 play() 的 <audio> 停下来。
function stopAllCues() {
  for (var key in cuePools) {
    if (!Object.prototype.hasOwnProperty.call(cuePools, key)) continue
    var pool = cuePools[key]
    for (var i = 0; i < pool.length; i++) {
      try { pool[i].pause(); pool[i].currentTime = 0 } catch (err) {}
    }
  }
}

function audioExt(name) {
  var m = /\.([a-z0-9]+)$/i.exec(String(name || ''))
  return m ? m[1].toLowerCase() : ''
}

// 只有浏览器能直接解码的格式才接受。MIME 可能为空（拖拽 / 系统不识别），
// 所以先看扩展名，再用 canPlayType 复核。
function audioFileProblem(file) {
  if (!file) return '没有选择文件'
  if (file.size > AUDIO_MAX_BYTES) return '文件过大（上限 20 MB）'
  var ext = audioExt(file.name)
  if (AUDIO_EXTS.indexOf(ext) < 0) return '不支持的格式：.' + (ext || '?') + '（支持 mp3 / wav / ogg / m4a / aac / flac / webm / opus）'
  var mime = String(file.type || AUDIO_MIME[ext] || '')
  try {
    var probe = new Audio()
    if (typeof probe.canPlayType === 'function' && mime) {
      var can = probe.canPlayType(mime)
      if (!can) return '当前客户端不能解码 ' + mime
    }
  } catch (err) {}
  return ''
}

function setCueVolume(name, v) {
  var pct = Math.max(0, Math.min(100, Math.round(Number(v) || 0)))
  state.cueVolume[name] = pct
  saveState()
  // 结算音 13.5 MB，改音量时不要为了试听把它整段拉下来
  if (pct > 0 && name !== 'settle') playCue(name)
}

function setVolume(v) {
  var pct = Math.max(0, Math.min(100, Math.round(Number(v) || 0)))
  state.volume = pct
  // 旧版总音量保留为「一键设置全部音效」；之后每个音效各自的音量仍然独立。
  for (var i = 0; i < CUE_IDS.length; i++) state.cueVolume[CUE_IDS[i]] = pct
  // 与上游一致：0% 就是静音，所以开关必须跟着走，否则菜单会出现「声音开着但没声」
  state.soundOn = pct > 0
  if (!state.soundOn) stopAllCues()
  saveState()
  // 放一小段，让新音量立刻听得出来
  if (state.soundOn) playCue('turn')
}

// —— 自定义音效的持久化（IndexedDB 存 Blob；失败时退回内存 dataURL）——
function openAudioDb() {
  if (audioDbPromise) return audioDbPromise
  audioDbPromise = new Promise(function (resolve) {
    try {
      if (!window.indexedDB) return resolve(null)
      var req = window.indexedDB.open('dshpet-audio', 1)
      req.onupgradeneeded = function () {
        try { req.result.createObjectStore('clips', { keyPath: 'cue' }) } catch (err) {}
      }
      req.onsuccess = function () { resolve(req.result) }
      req.onerror = function () { resolve(null) }
      req.onblocked = function () { resolve(null) }
    } catch (err) { resolve(null) }
  })
  return audioDbPromise
}

function idbReq(mode, fn) {
  return openAudioDb().then(function (db) {
    if (!db) return null
    return new Promise(function (resolve) {
      try {
        var tx = db.transaction(['clips'], mode)
        var store = tx.objectStore('clips')
        var req = fn(store)
        req.onsuccess = function () { resolve(req.result || null) }
        req.onerror = function () { resolve(null) }
      } catch (err) { resolve(null) }
    })
  })
}

function loadCustomClips() {
  return openAudioDb().then(function (db) {
    if (!db) {
      // 没有 IndexedDB（无痕模式等）：清掉悬空的自定义元信息，避免菜单显示「自定义」却没有文件
      var had = false
      for (var i = 0; i < CUE_IDS.length; i++) {
        if (state.cueCustom[CUE_IDS[i]]) { delete state.cueCustom[CUE_IDS[i]]; had = true }
      }
      if (had) saveState()
      return
    }
    return Promise.all(CUE_IDS.map(function (cue) {
      return idbReq('readonly', function (store) { return store.get(cue) }).then(function (rec) {
        if (!rec || !rec.blob) {
          if (state.cueCustom[cue]) { delete state.cueCustom[cue]; saveState() }
          return
        }
        try {
          if (customUrls[cue]) URL.revokeObjectURL(customUrls[cue])
          customUrls[cue] = URL.createObjectURL(rec.blob)
          state.cueCustom[cue] = {
            name: String(rec.name || ('自定义' + cue)).slice(0, 80),
            type: String(rec.type || rec.blob.type || '').slice(0, 80),
            size: Number(rec.size) || rec.blob.size || 0,
          }
        } catch (err) {}
      })
    })).then(function () {
      saveState()
    })
  }).catch(function () {})
}

function applyCustomBlob(cue, blob, name) {
  return idbReq('readwrite', function (store) {
    return store.put({ cue: cue, blob: blob, name: name, type: blob.type || '', size: blob.size })
  }).then(function (saved) {
    var url = ''
    try { url = URL.createObjectURL(blob) } catch (err) { return false }
    if (customUrls[cue]) { try { URL.revokeObjectURL(customUrls[cue]) } catch (err) {} }
    customUrls[cue] = url
    state.cueCustom[cue] = {
      name: String(name || '').slice(0, 80),
      type: String(blob.type || '').slice(0, 80),
      size: blob.size,
    }
    saveState()
    resetCuePool(cue)
    return true
  }).catch(function () { return false })
}

function useCustomCue(cue, file) {
  var problem = audioFileProblem(file)
  if (problem) { showToast(problem, false); return Promise.resolve(false) }
  // 选中文件后先进入「截取片段」编辑器；也可以直接使用完整音频。
  openTrimEditor(cue, file)
  return Promise.resolve(true)
}

// —— 截取音频片段 ——
// 选中文件后不能直接整段使用：先给一个 0 ~ duration 的起点/终点选择器，
// 保存时用 Web Audio 解码并按采样点裁成 WAV，这样每个音效都能只用其中一段。
var trimOverlay = null

function readFileBuffer(file) {
  return new Promise(function (resolve, reject) {
    try {
      var fr = new FileReader()
      fr.onload = function () { resolve(fr.result) }
      fr.onerror = function () { reject(new Error('读取文件失败')) }
      fr.readAsArrayBuffer(file)
    } catch (err) { reject(err) }
  })
}

function decodeAudioFile(file) {
  var AC = (typeof window !== 'undefined') && (window.AudioContext || window.webkitAudioContext)
  if (!AC) return Promise.reject(new Error('当前环境不支持 Web Audio'))
  return readFileBuffer(file).then(function (buf) {
    return new Promise(function (resolve, reject) {
      var ctx
      try { ctx = new AC() } catch (err) { reject(err); return }
      var done = false
      function ok(b) {
        if (done) return
        done = true
        try { ctx.close() } catch (err) {}
        resolve(b)
      }
      function bad(err) {
        if (done) return
        done = true
        try { ctx.close() } catch (e) {}
        reject(err || new Error('无法解码音频'))
      }
      try {
        var ret = ctx.decodeAudioData(buf, ok, bad)
        if (ret && typeof ret.then === 'function') ret.then(ok, bad)
      } catch (err) { bad(err) }
    })
  })
}

function encodeWav(buffer, startSec, endSec) {
  var rate = buffer.sampleRate
  var channels = Math.max(1, buffer.numberOfChannels)
  var start = Math.max(0, Math.floor(startSec * rate))
  var end = Math.min(buffer.length, Math.ceil(endSec * rate))
  if (end <= start) end = Math.min(buffer.length, start + 1)
  var frames = Math.max(1, end - start)
  var bytesPerSample = 2
  var dataSize = frames * channels * bytesPerSample
  var ab = new ArrayBuffer(44 + dataSize)
  var dv = new DataView(ab)
  var off = 0
  function str(s) { for (var i = 0; i < s.length; i++) dv.setUint8(off++, s.charCodeAt(i)) }
  function u32(v) { dv.setUint32(off, v, true); off += 4 }
  function u16(v) { dv.setUint16(off, v, true); off += 2 }
  str('RIFF'); u32(36 + dataSize); str('WAVE')
  str('fmt '); u32(16); u16(1); u16(channels); u32(rate); u32(rate * channels * bytesPerSample)
  u16(channels * bytesPerSample); u16(16)
  str('data'); u32(dataSize)
  var data = []
  for (var c = 0; c < channels; c++) data.push(buffer.getChannelData(c))
  for (var i = 0; i < frames; i++) {
    for (var ch = 0; ch < channels; ch++) {
      var s = data[ch][start + i] || 0
      s = Math.max(-1, Math.min(1, s))
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
      off += 2
    }
  }
  return new Blob([ab], { type: 'audio/wav' })
}

function trimAudioFile(file, startSec, endSec) {
  return decodeAudioFile(file).then(function (buffer) {
    return encodeWav(buffer, startSec, endSec)
  })
}

function closeTrimEditor() {
  var o = trimOverlay
  if (!o) return
  trimOverlay = null
  try { if (o.previewTimer) clearInterval(o.previewTimer) } catch (err) {}
  try { if (o.audio) o.audio.pause() } catch (err) {}
  try { document.removeEventListener('keydown', o.onKey, true) } catch (err) {}
  try { if (o.url) URL.revokeObjectURL(o.url) } catch (err) {}
  try { if (o.root.parentNode) o.root.parentNode.removeChild(o.root) } catch (err) {}
}

function openTrimEditor(cue, file) {
  closeTrimEditor()
  var url = ''
  try { url = URL.createObjectURL(file) } catch (err) { showToast('无法读取这个文件', false); return }
  var root = document.createElement('div')
  root.id = 'dshpet-trim'
  var box = document.createElement('div')
  box.className = 'dshpet-trim-box'

  var title = document.createElement('div')
  title.className = 'dshpet-trim-title'
  title.textContent = '截取音效片段 · ' + CUE_LABELS[cue]
  var sub = document.createElement('div')
  sub.className = 'dshpet-trim-sub'
  sub.textContent = file.name + '（可拖动起点 / 终点，只保存选中的那一段）'

  var audio = document.createElement('audio')
  audio.className = 'dshpet-trim-audio'
  audio.controls = true
  audio.preload = 'metadata'
  audio.src = url

  function rangeRow(labelText) {
    var row = document.createElement('div')
    row.className = 'dshpet-trim-row'
    var lab = document.createElement('span')
    lab.className = 'dshpet-trim-label'
    lab.textContent = labelText
    var inp = document.createElement('input')
    inp.type = 'range'
    inp.className = 'dshpet-trim-range'
    inp.min = '0'; inp.max = '1'; inp.step = '0.01'; inp.value = '0'
    var val = document.createElement('span')
    val.className = 'dshpet-trim-time'
    val.textContent = '0.00 s'
    row.appendChild(lab); row.appendChild(inp); row.appendChild(val)
    box.appendChild(row)
    return { inp: inp, val: val }
  }

  box.appendChild(title); box.appendChild(sub); box.appendChild(audio)
  var startRow = rangeRow('起点')
  var endRow = rangeRow('终点')
  var msg = document.createElement('div')
  msg.className = 'dshpet-trim-msg'
  box.appendChild(msg)

  var actions = document.createElement('div')
  actions.className = 'dshpet-trim-actions'
  var previewBtn = document.createElement('button')
  previewBtn.type = 'button'; previewBtn.className = 'dshpet-hol-btn'; previewBtn.textContent = '试听片段'
  var fullBtn = document.createElement('button')
  fullBtn.type = 'button'; fullBtn.className = 'dshpet-hol-btn'; fullBtn.textContent = '使用完整音频'
  var saveBtn = document.createElement('button')
  saveBtn.type = 'button'; saveBtn.className = 'dshpet-hol-btn dshpet-hol-primary'; saveBtn.textContent = '保存片段'
  var cancelBtn = document.createElement('button')
  cancelBtn.type = 'button'; cancelBtn.className = 'dshpet-hol-btn'; cancelBtn.textContent = '取消'
  actions.appendChild(previewBtn); actions.appendChild(fullBtn); actions.appendChild(saveBtn); actions.appendChild(cancelBtn)
  box.appendChild(actions)
  root.appendChild(box)
  ;(document.body || document.documentElement).appendChild(root)

  var o = { root: root, audio: audio, url: url, previewTimer: 0 }
  trimOverlay = o
  var duration = 0

  function fmt(sec) { return (Math.round(sec * 100) / 100).toFixed(2) + ' s' }
  function readRange() {
    var a = Number(startRow.inp.value) || 0
    var b = Number(endRow.inp.value) || 0
    if (b < a + 0.05) b = Math.min(duration, a + 0.05)
    if (b <= a) b = Math.min(duration, a + 0.05)
    return { start: a, end: b }
  }
  function sync() {
    var r = readRange()
    if (Number(startRow.inp.value) !== r.start) startRow.inp.value = String(r.start)
    if (Number(endRow.inp.value) !== r.end) endRow.inp.value = String(r.end)
    startRow.val.textContent = fmt(r.start)
    endRow.val.textContent = fmt(r.end)
    msg.textContent = '已选 ' + fmt(r.start) + ' ~ ' + fmt(r.end) + '（' + fmt(Math.max(0, r.end - r.start)) + '）'
    msg.className = 'dshpet-trim-msg is-ok'
  }
  function stopPreview() {
    if (o.previewTimer) { clearInterval(o.previewTimer); o.previewTimer = 0 }
    try { audio.pause() } catch (err) {}
  }
  startRow.inp.addEventListener('input', sync)
  endRow.inp.addEventListener('input', sync)
  audio.addEventListener('loadedmetadata', function () {
    duration = isFinite(audio.duration) ? audio.duration : 0
    if (!(duration > 0)) { msg.textContent = '读不到音频时长，可以直接使用完整音频'; msg.className = 'dshpet-trim-msg is-err'; return }
    startRow.inp.max = String(duration); endRow.inp.max = String(duration)
    startRow.inp.value = '0'; endRow.inp.value = String(duration)
    sync()
  })
  audio.addEventListener('error', function () {
    msg.textContent = '浏览器无法解码这个文件，请换 mp3 / wav / ogg / m4a 等格式'
    msg.className = 'dshpet-trim-msg is-err'
  })

  previewBtn.addEventListener('click', function () {
    var r = readRange()
    if (!(duration > 0)) return
    stopPreview()
    try { audio.currentTime = r.start } catch (err) { return }
    var p = audio.play()
    if (p && p.catch) p.catch(function () {})
    o.previewTimer = setInterval(function () {
      if (audio.paused) { stopPreview(); return }
      if (audio.currentTime >= r.end - 0.01) stopPreview()
    }, 40)
  })

  fullBtn.addEventListener('click', function () {
    stopPreview()
    applyCustomBlob(cue, file, file.name).then(function (ok) {
      if (!ok) { msg.textContent = '保存失败'; msg.className = 'dshpet-trim-msg is-err'; return }
      closeTrimEditor()
      showToast('已应用完整音频：' + file.name, true)
      playCue(cue)
    })
  })

  saveBtn.addEventListener('click', function () {
    var r = readRange()
    if (!(duration > 0)) { msg.textContent = '读不到音频时长，只能使用完整音频'; msg.className = 'dshpet-trim-msg is-err'; return }
    if (!(r.end > r.start + 0.04)) { msg.textContent = '片段太短了，至少 0.05 秒'; msg.className = 'dshpet-trim-msg is-err'; return }
    saveBtn.disabled = true
    msg.textContent = '正在裁剪…'
    msg.className = 'dshpet-trim-msg'
    stopPreview()
    var base = String(file.name || 'custom').replace(/\.[a-z0-9]+$/i, '')
    trimAudioFile(file, r.start, r.end).then(function (blob) {
      return applyCustomBlob(cue, blob, base + '-片段.wav')
    }).then(function (ok) {
      saveBtn.disabled = false
      if (!ok) { msg.textContent = '裁剪后保存失败'; msg.className = 'dshpet-trim-msg is-err'; return }
      closeTrimEditor()
      showToast('已应用片段：' + fmt(r.start) + ' ~ ' + fmt(r.end), true)
      playCue(cue)
    }).catch(function (err) {
      saveBtn.disabled = false
      msg.textContent = '无法裁剪：' + String((err && err.message) || err) + '（可改用完整音频）'
      msg.className = 'dshpet-trim-msg is-err'
    })
  })

  cancelBtn.addEventListener('click', closeTrimEditor)
  o.onKey = function (ev) { if (ev.key === 'Escape') closeTrimEditor() }
  document.addEventListener('keydown', o.onKey, true)
  sync()
}

function restoreFactoryCue(cue) {
  return idbReq('readwrite', function (store) { return store.delete(cue) })
    .then(function () {
      if (customUrls[cue]) { try { URL.revokeObjectURL(customUrls[cue]) } catch (err) {} }
      delete customUrls[cue]
      delete state.cueCustom[cue]
      saveState()
      resetCuePool(cue)
      showToast('已恢复出厂音效', true)
      return true
    })
}

function pickCustomCue(cue) {
  try {
    var inp = document.createElement('input')
    inp.type = 'file'
    inp.accept = AUDIO_ACCEPT
    inp.style.display = 'none'
    inp.setAttribute('data-dshpet-cue', cue)
    inp.addEventListener('change', function () {
      var f = inp.files && inp.files[0]
      if (f) useCustomCue(cue, f)
      try { if (inp.parentNode) inp.parentNode.removeChild(inp) } catch (err) {}
    })
    ;(document.body || document.documentElement).appendChild(inp)
    inp.click()
  } catch (err) { showToast('当前环境不能打开文件选择器', false) }
}

function previewCue(cue) {
  if (cue === 'settle' && !customUrls[cue]) {
    showToast('结算音效 13.5 MB，默认不预加载 / 不试听', false)
    return
  }
  if (!state.soundOn) { showToast('声音已关闭', false); return }
  if (!(cueVolume(cue) > 0)) { showToast('这个音效的音量是 0%', false); return }
  playCue(cue)
}

function oneStep(amountUnits) {
  lastCueUnits = amountUnits
  if (!state.fxHurt) return
  shakeTime = HIT_DURATION
  appendLabel('-' + moneyString(amountUnits), C_HIT)
  playSound()
}

// 一次"扣费节拍"。真实扣费优先于演示（原版顺序，不要调换）
function tick(dt) {
  if (!isFinite(dt) || dt < 0) dt = 0
  dt = Math.min(dt, 0.1) // 唤醒/卡顿后只推进一步，不补播几百次

  if (shakeTime > 0) shakeTime = Math.max(0, shakeTime - dt)
  if (celebrateTime > 0) celebrateTime = Math.max(0, celebrateTime - dt)
  if (topupTime > 0) topupTime = Math.max(0, topupTime - dt)
  if (nervousT > 0) nervousT = Math.max(0, nervousT - dt)
  if (tariffT > 0) tariffT = Math.max(0, tariffT - dt)
  // 铁锅回弹的计时：到 HEAD_SQUASH_DUR 就停住（停住 = 不再形变）
  if (headSquashT < HEAD_SQUASH_DUR) {
    headSquashT += dt
    if (headSquashT > HEAD_SQUASH_DUR) headSquashT = HEAD_SQUASH_DUR
  }
  updateBowls(dt)
  updateHearts(dt)
  updatePat(dt)
  updateExpression(dt)
  if (demoRestoreTime > 0) {
    demoRestoreTime = Math.max(0, demoRestoreTime - dt)
    if (demoRestoreTime === 0) demoOffsetUnits = 0
  }

  for (var i = floating.length - 1; i >= 0; i--) {
    floating[i].age += dt
    if (floating[i].age >= FLOAT_LIFE) floating.splice(i, 1)
  }

  stepCooldown -= dt
  if (stepCooldown <= 1e-9) {
    var did = false
    if (pendingUnits > 0 && bookedUnits !== null && realUnits !== null && bookedUnits > realUnits) {
      // 每一步最多扣「步长」；余额只掉了不足一步时，最后一步按实际差额提示一次，
      // 这样显示值不会停在半路，也不会漏掉小于步长的扣费。
      var take = Math.min(stepUnits(), pendingUnits, bookedUnits - realUnits)
      bookedUnits -= take
      pendingUnits -= take
      lastCueUnits = take
      did = true
    } else if (demoRemaining > 0) {
      demoRemaining -= 1
      demoOffsetUnits += stepUnits()
      lastCueUnits = stepUnits()
      if (demoRemaining === 0) demoRestoreTime = DEMO_RESTORE
      did = true
    } else {
      pendingUnits = 0
    }
    if (did) {
      // 保留小数余量，否则 60Hz 下每拍会被拉长到 13 帧
      stepCooldown = Math.max(0, stepCooldown + STEP_INTERVAL)
      oneStep(lastCueUnits)
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
    floating.length > 0 || pendingUnits > 0 || demoRemaining > 0 || !!snapAnim ||
    // 表情状态机也得算「还忙」：紧张表情的最后 1 秒保持靠 tick 倒数，
    // 漏掉这一项的话扣费动画一停、帧循环就断，表情会永远卡在紧张上。
    nervousT > 0 || tariffT > 0 || exprBowlAlive || bowls.length > 0 || hearts.length > 0 || potPendT > 0 ||
    headSquashT < HEAD_SQUASH_DUR ||
    patActive || patWaitingPotOff || patBlocked || patAccum > 0 || patMoveMs > 0
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
function applyReading(units, snap) {
  var previousReal = realUnits
  realUnits = units
  if (snap || previousReal === null || bookedUnits === null) {
    forceSnapToReal()
    wake()
    return
  }
  if (units > previousReal) {
    // 充值：对齐 + 绿字，delta 是相对**上一次服务器读数**
    var delta = units - previousReal
    forceSnapToReal()
    topupTime = TOPUP_DURATION
    appendLabel('+' + moneyString(delta), C_TOPUP)
    // 充值就掉一个米饭盆（上游的核心玩法）。关掉「充值掉盆」后，钱直接入账，
    // 不再需要手动拖取 —— 与上游同一个语义。
    if (state.fxBowlDrop) spawnRice(fromUnits(delta))
    wake()
    return
  }
  if (units < bookedUnits) {
    var diff = bookedUnits - units
    // 积压的「步数」太多（例如换了来源/长时间没开页面）就直接对齐，不补播几百次
    if (!isFinite(diff) || diff > stepUnits() * MAX_PENDING_CUES) {
      forceSnapToReal()
      wake()
      return
    }
    pendingUnits = diff
  } else {
    pendingUnits = 0
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
      var units = toUnits(j.totalBalance)
      if (!isFinite(units)) {
        connected = false; previousWasDisconnected = true; lastError = '余额数值异常'; draw(); return
      }
      // 断线后的第一次读数直接对齐，不补播积压动画
      applyReading(units, snap || previousWasDisconnected)
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
  sourceLabel = (!found || found.builtin) ? 'DSH 账户余额' : String(found.name || 'DSH 账户余额')
}

function setSource(id) {
  if (!id || id === state.source) return
  state.source = id
  applySourceMeta()
  saveState()
  // 换来源 = 换币种 / 换量纲：动画状态全部清空，下一轮直接对齐，绝不能和旧来源的数字做差
  realUnits = null
  bookedUnits = null
  pendingUnits = 0
  demoRemaining = 0
  demoOffsetUnits = 0
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
  tariffT = 0
  tariff = null
  previousWasDisconnected = true
  nextPollAt = 0
  draw()
  pollOnce(true, true)
}

// —— 平板峰谷彩蛋 ——
// 只对内置「DSH 账户余额」或明确是 DeepSeek 的来源生效。
function isDeepseekSource() {
  var found = null
  for (var i = 0; i < sources.length; i++) if (sources[i].id === state.source) found = sources[i]
  if (!found) return state.source === 'deepseek'
  if (found.builtin) return true
  var id = String(found.id || '').toLowerCase()
  var provider = String(found.provider || '').toLowerCase()
  var name = String(found.name || '').toLowerCase()
  return id.indexOf('deepseek') >= 0 || provider.indexOf('deepseek') >= 0 || name.indexOf('deepseek') >= 0
}

function tariffRemainSec() {
  if (!tariff || !isFinite(Number(tariff.nextAt))) return 0
  return Math.max(0, Math.floor(Number(tariff.nextAt) - Date.now() / 1000))
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.floor(Number(sec) || 0))
  var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60
  return (h > 0 ? h + ':' : '') + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s
}

// 宿主 /tariff.json 不可用时（例如刚更新插件、还没重启 DSH）的本地兜底。
// 只按「工作日 9–12 / 14–18 峰价，周末谷价」估算，不含法定节假日；
// 宿主路由可用时以宿主为准（它会带上假日表）。
var WEEKEND_VALLEY_FROM = Math.floor(Date.UTC(2026, 7, 22, 16, 0, 0) / 1000)
function fallbackPeak(sec) {
  var bj = new Date(sec * 1000 + 8 * 3600 * 1000)
  if (sec >= WEEKEND_VALLEY_FROM) {
    var dow = bj.getUTCDay()
    if (dow === 0 || dow === 6) return false
  }
  var hour = bj.getUTCHours()
  return (hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)
}
function fallbackTariff() {
  var now = Math.floor(Date.now() / 1000)
  var peak = fallbackPeak(now)
  var nextAt = now + 6 * 3600
  for (var t = now + 60; t <= now + 14 * 86400; t += 60) {
    if (fallbackPeak(t) !== peak) { nextAt = t; break }
  }
  var bj = new Date((now + 8 * 3600) * 1000)
  var pad = function (n) { return String(n).padStart(2, '0') }
  return {
    ok: true,
    fallback: true,
    now: now,
    peak: peak,
    label: peak ? '梁文峰' : '梁文谷',
    nextLabel: peak ? '距谷时' : '距峰时',
    nextAt: nextAt,
    remainSec: Math.max(0, nextAt - now),
    beijing: pad(bj.getUTCHours()) + ':' + pad(bj.getUTCMinutes()) + ':' + pad(bj.getUTCSeconds()),
  }
}

function ensureTariff(force) {
  if (!(tariffT > 0) || !isDeepseekSource() || tariffLoading) return
  if (!force && tariff && tariffRemainSec() > 0) return
  tariffLoading = true
  fetch(PREFIX + '/tariff.json', { credentials: 'same-origin', cache: 'no-store' })
    .then(function (r) { return r.json() })
    .then(function (j) {
      tariffLoading = false
      if (j && j.ok) tariff = j
      else tariff = fallbackTariff()
      wake()
    })
    .catch(function () {
      tariffLoading = false
      tariff = fallbackTariff()
      wake()
    })
}

function toggleTariff() {
  if (!isDeepseekSource()) return
  // 显示 state.tariffSeconds 秒（默认 2.5）：到点自动回余额，不需要再点一次。
  // 时长可在右键菜单「平板峰谷时长」里改（0.5 ~ 60 秒）。
  tariffT = clampTariffSeconds(state.tariffSeconds)
  ensureTariff(true)
  wake()
  draw()
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

function cornerName() { return state.snapCorner === 'right' ? '右下角' : '左下角' }

// 她在屏幕的哪一半 → 哪一侧的镜像。上游 SyncSideToPosition：**拖动过程中越过中线就翻**，
// 而不是等松手才翻 —— 松手瞬间突然换一张脸像穿帮，拖过去时「转身」才自然。
// 返回 true 表示这一帧换了边（需要重绘）。
function syncSideToPosition() {
  var want = (state.x + W / 2) > (window.innerWidth / 2) ? 'right' : 'left'
  if (state.snapCorner === want) return false
  state.snapCorner = want
  return true
}


function snapToCorner() {
  var toX = state.snapCorner === 'right'
    ? Math.max(0, window.innerWidth - W - ANCHOR_MARGIN)
    : ANCHOR_MARGIN
  snapAnim = {
    fromX: state.x === null ? ANCHOR_MARGIN : state.x,
    fromY: state.y === null ? (window.innerHeight - H - ANCHOR_MARGIN) : state.y,
    toX: toX,
    toY: window.innerHeight - H - ANCHOR_MARGIN,
    t: 0,
  }
  patBlocked = true
  patBlockMs = PAT_SETTLE_MS
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
  // 隐藏后的第二条退路：Ctrl+Shift+H 随时切换显示 / 隐藏。
  // 它必须挂在 document 上、且**不看桌宠是否可见** —— 存在的意义正是桌宠不可见时。
  document.addEventListener('keydown', onHideHotkey, true)

  window.addEventListener('resize', onResize)
}

// Ctrl+Shift+H：显示 / 隐藏桌宠。隐藏之后页面里没有任何可点的东西了，
// 这条热键是唯一「安静」的恢复方式（不必右键、不必知道菜单在哪）。
function onHideHotkey(e) {
  if (destroyed) return
  if (!e.ctrlKey || !e.shiftKey || e.altKey || e.metaKey) return
  var k = String(e.key || '').toLowerCase()
  if (k !== 'h' && e.code !== 'KeyH') return
  // 正在输入框里打字时不要抢键（自定义尺寸 / 备注 / 节假日粘贴面板等都用 input）
  var t = e.target
  var tag = (t && t.tagName) ? String(t.tagName).toLowerCase() : ''
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || (t && t.isContentEditable)) return
  e.preventDefault()
  e.stopPropagation()
  setHidden(!state.hidden)
}

function localPoint(e) {
  var r = container.getBoundingClientRect()
  return { x: e.clientX - r.left, y: e.clientY - r.top, rect: r }
}

function onPointerMove(e) {
  if (destroyed || !container || state.hidden) return
  if (dragging) return       // 拖动角色时不切换穿透
  if (heldBowl) return       // 拖着盆时同理
  var p = localPoint(e)
  var inside = p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H
  var opaque = inside && hitTest(p.x, p.y)
  container.style.pointerEvents = opaque ? 'auto' : 'none'
  notePatPointer(e)
}

// ============================================================================
// 摸头手势（petpet）
// ============================================================================
function patOnHer(e) {
  if (!container || state.hidden) return false
  if (typeof e.clientX !== 'number' || typeof e.clientY !== 'number') return false
  var p = localPoint(e)
  if (p.x < 0 || p.y < 0 || p.x > W || p.y > H) return false
  return hitTest(p.x, p.y)
}

function startPat() {
  patActive = true
  patT = 0
  patAccum = 0
  patMoveMs = 0
  patIdleMs = 0
  patHeartT = 0
  patWaitingPotOff = false
  spawnHearts()
  wake()
}

function stopPat() {
  patActive = false
  patT = 0
  patAccum = 0
  patMoveMs = 0
  patIdleMs = 0
  patWaitingPotOff = false
}

// 指针移动采样：只在「她身上 + 没有按键」时累计划动距离。
// 拖动 / 拿盆 / 右键菜单 / 吸附飞行期间都不算，并且会被短暂封锁。
function notePatPointer(e) {
  if (!state.fxPat || patBlocked || dragging || heldBowl || state.hidden || menuOpen()) {
    patPointerOn = false
    patAccum = 0
    patMoveMs = 0
    patSeen = false
    patMoved = false
    return
  }
  var on = (e.buttons === 0) && patOnHer(e)
  patPointerOn = on
  if (!on) {
    patAccum = 0
    patMoveMs = 0
    patSeen = false
    patMoved = false
    if (patActive || patWaitingPotOff) wake()
    return
  }
  if (patSeen) {
    var dx = e.clientX - patLastX
    var dy = e.clientY - patLastY
    var d = Math.sqrt(dx * dx + dy * dy)
    // 单帧跳半屏是指针跳跃（远程桌面 / 瞬移），不算划动
    if (d > 0 && d <= PAT_MOVE_MAX_STEP) {
      patAccum = Math.min(PAT_MOVE_MIN_PX * 4, patAccum + d)
      patMoved = true
    }
  }
  patSeen = true
  patLastX = e.clientX
  patLastY = e.clientY
  if (patActive) patIdleMs = 0
  // 摸头状态机跑在 rAF 的 tick 里；指针移动本身不会启动帧循环，
  // 不唤醒的话「划满 500ms」永远没有机会被计数。
  wake()
}

function updatePat(dt) {
  if (patBlocked) {
    patBlockMs -= dt * 1000
    if (patBlockMs <= 0) { patBlocked = false; patBlockMs = 0 }
  }
  if (!state.fxPat) {
    if (patActive) stopPat()
    return
  }
  var moving = patPointerOn && patMoved
  patMoved = false

  // 铁锅还在头上：先把它敲掉，等它淡出再开始摸（上游同样的顺序）
  if (patWaitingPotOff) {
    if (!patPointerOn) { patWaitingPotOff = false; return }
    if (exprPotOnHead) return
    startPat()
    return
  }

  if (patActive) {
    patT += dt * 1000
    patHeartT -= dt
    if (patHeartT <= 0) { patHeartT = 0.75; spawnHearts() }
    if (!patPointerOn) {
      patIdleMs += dt * 1000
      if (patIdleMs >= PAT_END_DELAY_MS) stopPat()
      return
    }
    if (moving) {
      patIdleMs = 0
    } else {
      patIdleMs += dt * 1000
      patAccum = Math.max(0, patAccum - PAT_MOVE_DECAY * dt * 1000)
      if (patIdleMs >= PAT_END_DELAY_MS) stopPat()
    }
    return
  }

  if (moving) {
    if (patAccum >= PAT_MOVE_MIN_PX) patMoveMs += dt * 1000
  } else {
    patAccum = Math.max(0, patAccum - PAT_MOVE_DECAY * dt * 1000)
    if (patAccum < PAT_MOVE_MIN_PX) patMoveMs = 0
  }
  if (patAccum >= PAT_MOVE_MIN_PX && patMoveMs >= PAT_START_DELAY_MS) {
    if (exprPotOnHead) {
      patWaitingPotOff = true
      knockPotOff()
      patMoveMs = 0
      patAccum = 0
      return
    }
    startPat()
  }
}

function patFrameIndex() {
  return Math.floor((patT % (PAT_FRAME_MS * PAT_FILES.length)) / PAT_FRAME_MS) % PAT_FILES.length
}

// 手部素材是「从左边伸进来的一只手」，掌心按上游的 palm 比例落在她头顶。
// 画在**全屏覆盖层**上（视口坐标），所以手不会被挂件画布裁掉。
function drawPatHand(c) {
  if (!patActive || !patReady) return
  var idx = patFrameIndex()
  var img = patImages[idx]
  if (!img || !img.width) return
  var k = side / 454
  var dw = img.width * k
  var dh = img.height * k
  var palmFx = PAT_PALM_X[idx] + PAT_PALM_BIAS_X
  var palmFy = PAT_PALM_Y[idx] + PAT_PALM_BIAS_Y
  var hp = headPoint()
  // 手是「从左下方伸进来」的一只胳膊，掌心在图像的 palmFx 处。
  // 站在右边时整个场景镜像：手心要落在镜像后的头顶上，图像也要翻。
  // 做法与上游一致 —— 先把**未镜像**的盒子算出来，再整体反射，
  // 而不是「用镜像后的头当锚点、再把图像原地翻」：后者掌心会偏 (1-2·palmFx)·dw。
  var bx = (typeof state.x === 'number') ? state.x : ANCHOR_MARGIN
  var localHx = hp.x - bx
  var handXLocal
  if (isMirrored()) {
    var hand0 = (W - localHx) - palmFx * dw      // 未镜像时的盒子左边
    handXLocal = W - (hand0 + dw)                // 关于画布中线反射
  } else {
    handXLocal = localHx - palmFx * dw
  }
  var handX = bx + handXLocal
  // 掌心直接落在**当前头顶锚点**上。之前用固定 crownY 算，没有加立绘在画布里的
  // 垂直偏移，所以手会飘在头顶上方一大截（用户截图反馈）。
  var handY = hp.y - palmFy * dh
  c.save()
  if (isMirrored()) {
    // 镜像整只手，让它从她所在的那一侧伸进来（位置与图像一起翻）
    c.translate(Math.round(handX + dw / 2), 0)
    c.scale(-1, 1)
    c.translate(-Math.round(handX + dw / 2), 0)
  }
  c.globalAlpha = 0.98
  c.drawImage(img, handX, handY, dw, dh)
  c.restore()
}

function menuOpen() {
  return !!(menuEl && menuEl.root && menuEl.root.style.display === 'block')
}
var menuPos = { x: 0, y: 0 }
function isInMenu(target) {
  try { return !!(menuEl && menuEl.root && target && menuEl.root.contains(target)) } catch (err) { return false }
}

// ============================================================================
// 拖盆（上游：左键按住盆拖动，拖到角色身上喂 / 拖到头顶扣上；也可甩出去）
// 盆画在 pointer-events:none 的覆盖层上，所以命中判定得在这里自己按视口坐标做。
// ============================================================================
function nowMs() {
  return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now()
}
function bowlAt(x, y) {
  // 从后往前找：后画的在上层
  for (var i = bowls.length - 1; i >= 0; i--) {
    var b = bowls[i]
    if (b.fed) continue
    // 扣在头上的铁盆**不参与拖动** —— 它就压在她头顶，否则会抢走「双击头部」
    // 的判定（真 bug：锅扣上后点她的头只会把锅又拖起来，敲不掉）。
    if (b.onHead) continue
    var dx = x - b.x, dy = y - b.y
    var rr = b.r * 1.15                  // 比视觉半径放宽一点，好点中
    if (dx * dx + dy * dy <= rr * rr) return b
  }
  return null
}

function onBowlDragMove(e) {
  if (!heldBowl) return
  // 采样光标轨迹算「甩出速度」。上游同样这么做 —— 手拿着盆时 VX/VY 是停留的，
  // 不从轨迹采样的话，接近率读数会一直停在停下前的那个值（上游踩过这个坑）。
  var t = nowMs()
  var dt = (t - lastPtrT) / 1000
  if (dt > 0.001 && dt < 0.2) {
    throwVX = (e.clientX - lastPtrX) / dt
    throwVY = (e.clientY - lastPtrY) / dt
  }
  lastPtrX = e.clientX; lastPtrY = e.clientY; lastPtrT = t
  // 只更新目标点：米饭盆的位置与形变由 updateBowls 的 stepDragBowl 处理，
  // 铁锅则每帧直接对齐目标（扣头需要精确落点）。
  heldBowl.targetX = e.clientX - heldBowl.grabX
  heldBowl.targetY = e.clientY - heldBowl.grabY
  e.preventDefault()
}

function onBowlDragEnd(e) {
  window.removeEventListener('pointermove', onBowlDragMove, true)
  window.removeEventListener('pointerup', onBowlDragEnd, true)
  var b = heldBowl
  heldBowl = null
  if (!b) return
  b.dragging = false
  // 位置已经在目标上（跟手）；形变会自己衰减，不再强行吸附。
  // 甩出的速度仍然取光标轨迹采样，扔铁盆 / 甩米饭盆都靠它。
  b.vx = throwVX * 0.35
  b.vy = throwVY * 0.35
  b.bounces = 0
  b.restT = 0
  wake()
}

// ============================================================================

function onPointerDown(e) {
  if (destroyed || !container) return
  // 点在菜单上：**完全放行** —— 既不关菜单，也不触发拖动。
  // 曾经的写法是 `if (menuEl.sub) hideMenu()`：pointerdown 先于 click，菜单在
  // mousedown→mouseup 之间被 display:none 掉，元素不再渲染 ⇒ click 永远不派发，
  // 于是所有**子菜单项**（切换角色 / 尺寸 / 刷新间隔 / 演示连续扣费）全部点不动。
  if (isInMenu(e.target)) return
  // 隐藏状态下没有桌宠可点，但**恢复菜单**要能靠点空白处关掉
  if (state.hidden) {
    if (menuOpen()) hideMenu()
    return
  }

  // 任何按键都说明玩家在「操作」她，不是「抚摸」她：立刻停手并短暂封锁，
  // 避免手部动画跟着拖拽 / 菜单点击一起抖动。
  if (patActive) stopPat()
  patBlocked = true
  patBlockMs = PAT_SETTLE_MS
  patPointerOn = false
  patAccum = 0
  patMoveMs = 0
  wake()

  // 米饭盆与铁锅**活动在整个窗口里**，所以必须在「是否落在挂件盒子里」之前判定，
  // 而且用的是**视口坐标**（e.clientX/Y），不是画布局部坐标。
  // 命中时吞掉事件：同一击不该再落到下面的 DSH 界面上。
  if (e.button !== 2 && !e.ctrlKey) {
    // ① 点在盆上 → 按住拖动（拖到她身上就喂；铁盆拖到头顶就扣上；也可甩出去）
    var hitBowl = bowlAt(e.clientX, e.clientY)
    if (hitBowl) {
      e.preventDefault(); e.stopPropagation()
      heldBowl = hitBowl
      hitBowl.dragging = true
      hitBowl.homing = false   // 玩家一旦拿起锅，就不再自动追着头走（可以随手丢掉）
      hitBowl.autoEmpty = false // 被拿起来过的锅，之后掉到头上可以正常扣上
      hitBowl.locked = false
      hitBowl.lockT = 0
      hitBowl.sucking = false
      hitBowl.restT = 0
      hitBowl.grabX = e.clientX - hitBowl.x
      hitBowl.grabY = e.clientY - hitBowl.y
      // 拖动目标点先对齐当前位置，避免刚拿起就被弹簧拽一下
      hitBowl.targetX = hitBowl.x
      hitBowl.targetY = hitBowl.y
      hitBowl.prevTargetX = hitBowl.targetX
      hitBowl.prevTargetY = hitBowl.targetY
      hitBowl.targetVx = 0
      hitBowl.targetVy = 0
      hitBowl.deform = 0
      hitBowl.deformV = 0
      hitBowl.shear = 0
      hitBowl.shearV = 0
      hitBowl.vx = 0
      hitBowl.vy = 0
      throwVX = 0; throwVY = 0
      lastPtrX = e.clientX; lastPtrY = e.clientY; lastPtrT = nowMs()
      window.addEventListener('pointermove', onBowlDragMove, true)
      window.addEventListener('pointerup', onBowlDragEnd, true)
      wake()
      return
    }
    // ② 双击她的头 → 把铁盆敲掉（上游是**双击**，不是单击）。
    //    第一次点只记时间、照常走下面的拖动逻辑 —— 否则就没法抓着头拖她了。
    var ib = ironBowl()
    if (ib && ib.onHead) {
      var hp = headPoint()
      if (Math.abs(e.clientX - hp.x) <= spriteRect.w * 0.35 &&
          e.clientY >= hp.y - spriteRect.h * 0.15 &&
          e.clientY <= hp.y + spriteRect.h * 0.35) {
        var t = nowMs()
        if (t - lastHeadClick < 420) {
          lastHeadClick = 0
          e.preventDefault(); e.stopPropagation()
          knockPotOff()
          return
        }
        lastHeadClick = t
      }
    }
  }

  if (menuOpen()) hideMenu()
  var p = localPoint(e)
  var inside = p.x >= 0 && p.y >= 0 && p.x <= W && p.y <= H
  if (!inside) return

  if (e.button === 2 || e.ctrlKey) return // 右键交给 contextmenu

  if (!hitTest(p.x, p.y)) return

  // 原版：拖动要超过 2pt 才真的动，避免一次点击把摆好的位置蹭歪
  dragging = {
    startX: e.clientX, startY: e.clientY,
    origX: state.x, origY: state.y,
    moved: false,
    onTablet: pointInTablet(p.x, p.y),
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
  // 越过中线立刻镜像（立绘 + 平板几何）；位置变化本身靠 CSS，只有换边需要重绘。
  if (syncSideToPosition()) draw()
}

function onDragEnd() {
  window.removeEventListener('pointermove', onDragMove, true)
  window.removeEventListener('pointerup', onDragEnd, true)
  var moved = dragging && dragging.moved
  var wasTablet = dragging && dragging.onTablet
  dragging = null
  patBlocked = true
  patBlockMs = PAT_SETTLE_MS
  wake()
  if (!moved && wasTablet) {
    // 单击平板（没有拖动）→ 金额区在「余额」与「梁文峰 / 梁文谷 + 剩余时长」之间切换
    toggleTariff()
    return
  }
  if (moved) {
    // 松手时她在屏幕哪一半，就吸附回哪一侧的下角（与上游一致）。
    syncSideToPosition()
    if (state.snapOnRelease) snapToCorner()
    else { saveState(); wake() }
  }
}

function onContextMenu(e) {
  if (destroyed || !container) return
  // 【隐藏后的自救路径】桌宠已经 display:none，像素命中无从谈起，所以必须在
  // 「命中角色」之前处理。原来的写法是 `if (... || state.hidden) return` —— 直接返回，
  // 而「显示桌宠」只存在于桌宠自己的菜单里 ⇒ 隐藏 = 不可逆（真 bug，只能改 localStorage）。
  if (state.hidden) {
    if (isInMenu(e.target)) { e.preventDefault(); return }
    e.preventDefault()
    menuPos.x = e.clientX
    menuPos.y = e.clientY
    showMenu(e.clientX, e.clientY, recoverMenu)
    return
  }
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

// ============================================================================
// 通用输入弹层（自定义尺寸 / 自定义音量共用）
// ============================================================================
var promptOverlay = null

function closePrompt() {
  var o = promptOverlay
  if (!o) return
  promptOverlay = null
  try { document.removeEventListener('keydown', o.onKey, true) } catch (err) {}
  try { if (o.root.parentNode) o.root.parentNode.removeChild(o.root) } catch (err) {}
}

function showPrompt(opt) {
  closePrompt()
  var root = document.createElement('div')
  root.id = 'dshpet-prompt'
  var box = document.createElement('div')
  box.className = 'dshpet-lic-box'
  var head = document.createElement('div')
  head.className = 'dshpet-lic-title'
  head.textContent = String(opt.title || '')
  var lab = document.createElement('div')
  lab.className = 'dshpet-prompt-label'
  lab.textContent = String(opt.label || '')
  var wrap = document.createElement('div')
  wrap.className = 'dshpet-prompt-row'
  var inp = document.createElement('input')
  inp.type = 'text'
  inp.className = 'dshpet-prompt-inp'
  inp.value = (opt.value === undefined || opt.value === null) ? '' : String(opt.value)
  wrap.appendChild(inp)
  if (opt.suffix) {
    var suf = document.createElement('span')
    suf.className = 'dshpet-prompt-suf'
    suf.textContent = String(opt.suffix)
    wrap.appendChild(suf)
  }
  var msg = document.createElement('div')
  msg.className = 'dshpet-hol-msg'
  var actions = document.createElement('div')
  actions.className = 'dshpet-hol-row dshpet-hol-actions'
  var okBtn = document.createElement('button')
  okBtn.type = 'button'
  okBtn.className = 'dshpet-hol-btn dshpet-hol-primary'
  okBtn.textContent = '确定'
  var cancel = document.createElement('button')
  cancel.type = 'button'
  cancel.className = 'dshpet-hol-btn'
  cancel.textContent = '取消'
  actions.appendChild(okBtn)
  actions.appendChild(cancel)
  box.appendChild(head)
  box.appendChild(lab)
  box.appendChild(wrap)
  box.appendChild(msg)
  box.appendChild(actions)
  root.appendChild(box)
  ;(document.body || document.documentElement).appendChild(root)
  var o = { root: root }
  promptOverlay = o

  function submit() {
    // onOk 返回 true 才关闭；返回 false 表示校验没过，弹层留着让用户改
    var keep = opt.onOk ? opt.onOk(String(inp.value).trim(), msg) : true
    if (keep !== false) closePrompt()
  }
  okBtn.addEventListener('click', submit)
  inp.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') { ev.preventDefault(); submit() }
  })
  cancel.addEventListener('click', function () { closePrompt() })
  root.addEventListener('pointerdown', function (ev) { if (ev.target === root) closePrompt() })
  o.onKey = function (ev) { if (ev.key === 'Escape') closePrompt() }
  document.addEventListener('keydown', o.onKey, true)
  try { inp.focus() } catch (err) {}
  try { inp.select() } catch (err) {}
}

// ============================================================================
// 轻量提示条（音效上传 / 试听的反馈）
// ============================================================================
var toastEl = null, toastTimer = 0
function showToast(text, ok) {
  try {
    if (!toastEl) {
      toastEl = document.createElement('div')
      toastEl.id = 'dshpet-toast'
      ;(document.body || document.documentElement).appendChild(toastEl)
    }
    toastEl.className = ok ? 'is-ok' : 'is-err'
    toastEl.textContent = String(text || '')
    toastEl.style.display = 'block'
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(function () {
      if (toastEl) toastEl.style.display = 'none'
    }, 2600)
  } catch (err) {}
}

// ============================================================================
// 显示设置（尺寸 / 外观 / 声音）
// ============================================================================
function setSizeIndex(i) {
  if (!(i >= 0 && i < SIZE_PRESETS.length)) return
  state.sizeIndex = i
  state.sizePx = 0            // 选预设就清掉自定义值
  saveState(); layout(); place(); draw()
}

function askSize() {
  showPrompt({
    title: '自定义尺寸',
    label: '高度（像素）—— 可用范围 120 ~ 1200；宽度按 1.5 倍自动计算。',
    value: state.sizePx > 0 ? state.sizePx : SIZE_PRESETS[state.sizeIndex],
    suffix: 'px',
    onOk: function (v, msg) {
      var n = parseInt(v, 10)
      if (!isFinite(n) || String(n) !== v) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '请输入整数像素值'
        return false
      }
      if (n < 120 || n > 1200) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '超出范围：' + n + ' px（应在 120 ~ 1200 之间）'
        return false
      }
      state.sizePx = n
      saveState(); layout(); place(); draw()
      return true
    },
  })
}

function setTheme(t) {
  state.theme = (t === 'dark') ? 'dark' : 'light'
  saveState()
  // 菜单每次打开都会重建，所以下一次右键就是新配色，不需要额外重绘
}

function setSoundOn(on) {
  state.soundOn = !!on
  if (!state.soundOn) stopAllCues()
  // 打开声音时若音量还是 0，恢复到一个能听见的默认值，否则「开启」等于没开
  if (state.soundOn && !(state.volume > 0)) {
    state.volume = 80
    for (var i = 0; i < CUE_IDS.length; i++) {
      if (!(cueVolume(CUE_IDS[i]) > 0)) state.cueVolume[CUE_IDS[i]] = 80
    }
  }
  saveState()
  if (state.soundOn) playCue('turn')
}

// 声音菜单第一层的模式开关：分音效调节 / 只用全部音量（两种视图互斥）
function setSoundPerCue(on) {
  state.soundPerCue = !!on
  saveState()
}

function askVolume() {
  showPrompt({
    title: '全部音效音量',
    label: '把所有音效统一设为这个音量（0 ~ 100）。勾选「分音效调节音量」后还可以逐个调整。',
    value: state.volume,
    suffix: '%',
    onOk: function (v, msg) {
      if (!/^\d+$/.test(v)) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '请输入 0 ~ 100 的整数'
        return false
      }
      var n = parseInt(v, 10)
      if (n < 0 || n > 100) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '超出范围：' + n + '（应在 0 ~ 100 之间）'
        return false
      }
      setVolume(n)
      return true
    },
  })
}

// —— 扣费步长：每扣多少钱提示一次 ——
function setStep(yuan) {
  state.stepYuan = clampStep(yuan)
  saveState()
  // 改小步长时，已经积压的差额会在后续节拍里按新步长继续提示；
  // 改大步长也不会丢掉余额，剩下的差额会作为最后一步补上。
  wake()
}

function askStep() {
  showPrompt({
    title: '自定义扣费步长',
    label: '每扣多少钱提示一次。范围 0.01 ~ 100 元（默认 0.01），最小单位 0.01 元。',
    value: stepLabel(),
    suffix: '元',
    onOk: function (v, msg) {
      var n = Number(String(v).replace(/，/g, '.').replace(/,/g, '.'))
      if (!isFinite(n)) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '请输入一个数字，例如 0.01 或 0.5'
        return false
      }
      var cents = Math.round(n * 100)
      if (cents < 1) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '太小了：最小 0.01 元'
        return false
      }
      if (cents > 10000) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '太大了：最大 100 元'
        return false
      }
      if (Math.abs(cents / 100 - n) > 1e-9) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '最小单位是 0.01 元（最多两位小数）'
        return false
      }
      setStep(cents / 100)
      return true
    },
  })
}

// —— 平板峰谷视图显示时长 ——
function tariffSecondsLabel(s) {
  var n = Math.round(Number(s) * 10) / 10
  return (isFinite(n) ? n : DEFAULT_TARIFF_SECONDS) + ' 秒'
}

function setTariffSeconds(sec) {
  state.tariffSeconds = clampTariffSeconds(sec)
  saveState()
  // 正显示着就按新时长续上，改完立刻能看出来
  if (tariffT > 0) tariffT = state.tariffSeconds
  wake()
  draw()
}

function askTariffSeconds() {
  showPrompt({
    title: '平板峰谷显示时长',
    label: '单击平板后，峰谷视图显示多久？（' + TARIFF_SECONDS_MIN + ' ~ ' + TARIFF_SECONDS_MAX + ' 秒，默认 ' +
      DEFAULT_TARIFF_SECONDS + ' 秒；保留一位小数）',
    value: state.tariffSeconds,
    suffix: '秒',
    onOk: function (v, msg) {
      var n = Number(String(v).replace(/，/g, '.').replace(/,/g, '.'))
      if (!isFinite(n)) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '请输入一个数字，例如 2.5 或 5'
        return false
      }
      if (n < TARIFF_SECONDS_MIN || n > TARIFF_SECONDS_MAX) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '超出范围：' + n + ' 秒（应在 ' + TARIFF_SECONDS_MIN + ' ~ ' + TARIFF_SECONDS_MAX + ' 之间）'
        return false
      }
      if (Math.abs(Math.round(n * 10) / 10 - n) > 1e-9) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '最多一位小数（例如 2.5 秒）'
        return false
      }
      setTariffSeconds(n)
      return true
    },
  })
}

// —— 拖盆流体形变强度 ——
function fluidIntensityLabel(v) {
  var n = Math.round(Number(v) * 10) / 10
  if (!isFinite(n)) n = DEFAULT_FLUID_INTENSITY
  if (n <= 0) return '关闭'
  return n + '×'
}

function setFluidIntensity(v) {
  state.fluidIntensity = clampFluidIntensity(v)
  saveState()
  // 下一帧就按新强度算；正在拖着盆时能立刻看到
  wake()
}

function askFluidIntensity() {
  showPrompt({
    title: '拖盆流体形变强度',
    label: '0 ~ ' + FLUID_INTENSITY_MAX + ' 倍，0 = 关闭；默认 ' + DEFAULT_FLUID_INTENSITY + '×（强）。保留一位小数。',
    value: state.fluidIntensity,
    suffix: '×',
    onOk: function (v, msg) {
      var n = Number(String(v).replace(/，/g, '.').replace(/,/g, '.'))
      if (!isFinite(n)) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '请输入一个数字，例如 1.6 或 2'
        return false
      }
      if (n < 0 || n > FLUID_INTENSITY_MAX) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '超出范围：' + n + '×（应在 0 ~ ' + FLUID_INTENSITY_MAX + ' 之间）'
        return false
      }
      if (Math.abs(Math.round(n * 10) / 10 - n) > 1e-9) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '最多一位小数（例如 1.6×）'
        return false
      }
      setFluidIntensity(n)
      return true
    },
  })
}

function setFx(which, on) {
  if (which === 'bowl') state.fxBowlDrop = !!on
  else if (which === 'pat') state.fxPat = !!on
  else if (which === 'hurt') state.fxHurt = !!on
  saveState()
  if (!state.fxPat && patActive) stopPat()
  if (!state.fxPat) {
    patPointerOn = false
    patMoved = false
    patSeen = false
  }
  wake()
}

// —— 演示次数 / 测试充值金额 ——
function askDemoCount() {
  showPrompt({
    title: '自定义演示次数',
    label: '连续扣费演示要播放几次？每次扣「一个步长」（当前 ' + stepLabel() + ' 元）。',
    value: 10,
    suffix: '次',
    onOk: function (v, msg) {
      if (!/^\d+$/.test(v)) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '请输入 1 ~ ' + MAX_DEMO_STEPS + ' 的整数'
        return false
      }
      var n = parseInt(v, 10)
      if (n < 1 || n > MAX_DEMO_STEPS) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '超出范围：' + n + '（应在 1 ~ ' + MAX_DEMO_STEPS + ' 之间）'
        return false
      }
      playDemo(n)
      return true
    },
  })
}

// 掉 N 盆饭：测试用，不真的加钱，只生成 N 个米饭盆。
// 三个预设分别掉 1 / 3 / 10 盆；关掉「充值后掉落米饭盆」时只演示光环与飘字。
function testTopUpBowls(count) {
  var n = Math.max(1, Math.min(50, Math.floor(Number(count)) || 1))
  if (!state.fxBowlDrop) {
    appendLabel('+' + n + ' 盆', C_TOPUP)
    topupTime = TOPUP_DURATION
    wake()
    return
  }
  for (var i = 0; i < n; i++) spawnRice(0)
  wake()
}

function testTopUp(yuan) {
  var amount = Number(yuan)
  if (!isFinite(amount) || amount <= 0) return
  if (state.fxBowlDrop) spawnRice(amount)
  else {
    // 掉盆关掉时，测试充值只演示绿色光环与飘字（不会真的加钱，也不改显示余额）
    appendLabel('+' + moneyString(toUnits(amount)), C_TOPUP)
    topupTime = TOPUP_DURATION
    wake()
  }
}

function askTopUp() {
  showPrompt({
    title: '自定义测试充值金额',
    label: '模拟充值多少元？只掉一盆米饭，不会真的加钱。',
    value: 3,
    suffix: '元',
    onOk: function (v, msg) {
      var n = Number(String(v).replace(/，/g, '.').replace(/,/g, '.'))
      if (!isFinite(n) || n <= 0) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '请输入一个大于 0 的金额'
        return false
      }
      if (n > 100000) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '太大了（上限 100000 元）'
        return false
      }
      testTopUp(n)
      return true
    },
  })
}

function showMenu(cx, cy, sub) {
  var root = menuEl.root
  root.innerHTML = ''
  // 菜单配色跟随「外观」里的设置（浅色 / 深色），只是菜单换色，角色本身不受影响
  root.className = state.theme === 'dark' ? 'is-dark' : ''
  var items = (typeof sub === 'function' ? sub() : sub) || mainMenu()
  for (var i = 0; i < items.length; i++) {
    ;(function (it) {
      // 分隔线
      if (it.sep) {
        var hr = document.createElement('div')
        hr.className = 'dshpet-msep'
        root.appendChild(hr)
        return
      }
      // 分组标题（不可点）
      if (it.header) {
        var hd = document.createElement('div')
        hd.className = 'dshpet-mhead'
        hd.textContent = it.label
        root.appendChild(hd)
        return
      }
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
          run: function () { state.character = c.id; saveState(); refreshAssets(); loadExpressionArt() },
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
        var name = s.builtin ? 'DSH 账户余额' : s.name
        return { label: mark + kind + best + name, run: function () { setSource(s.id) } }
      }).concat([{ label: '返回', sub: mainMenu }])
    } },
    { label: (ledgerCache && ledgerCache.enabled ? '✓ ' : '　') + '累计计费', run: function () {
      var on = !!(ledgerCache && ledgerCache.enabled)
      postLedger(on ? 'disable' : 'enable')
    } },
    { label: '结束计费并结算' +
        (ledgerCache && ledgerCache.total ? '（¥' + moneyString(toUnits(ledgerCache.total)) + '）' : ''),
      disabled: !(ledgerCache && ledgerCache.turns > 0),
      run: function () {
        postLedger('settle').then(function (p) {
          if (p && p.ok) showSettlement(p)
        })
      } },
    { label: (holidayStatus && holidayStatus.level !== 'ok' ? '⚠ ' : '') + '节假日清单…',
      run: function () { showHolidayPanel() } },
    { label: '扣费步长（每 ' + stepLabel() + ' 元提示一次）▸', sub: function () {
      var rows = STEP_PRESETS.map(function (v) {
        var units = toUnits(v)
        return {
          label: (stepUnits() === units ? '✓ ' : '　') + '¥' + moneyString(units) +
            (v === 0.01 ? '（1 分）' : ''),
          run: function () { setStep(v) },
        }
      })
      rows.push({ sep: true })
      rows.push({ label: '自定义步长…', run: function () { askStep() } })
      rows.push({ label: '返回', sub: mainMenu })
      return rows
    } },
    { label: '平板峰谷时长（' + tariffSecondsLabel(state.tariffSeconds) + '）▸', sub: function () {
      var rows = TARIFF_SECONDS_PRESETS.map(function (v) {
        return {
          label: (Math.abs(state.tariffSeconds - v) < 1e-9 ? '✓ ' : '　') + tariffSecondsLabel(v),
          run: function () { setTariffSeconds(v) },
        }
      })
      rows.push({ sep: true })
      rows.push({ label: '自定义时长…', run: function () { askTariffSeconds() } })
      rows.push({ label: '返回', sub: mainMenu })
      return rows
    } },
    { label: '尺寸 ▸', sub: function () {
      // 命名与「带 px 标注」沿用上游；本插件多一档小号，所以是四档
      return SIZE_PRESETS.map(function (px, i) {
        return {
          label: (state.sizePx <= 0 && i === state.sizeIndex ? '✓ ' : '　') + SIZE_NAMES[i] +
            '（' + px + ' px ≈ ' + pxToCm(px) + ' cm）',
          run: function () { setSizeIndex(i) },
        }
      }).concat([
        { sep: true },
        { label: '自定义尺寸…', run: function () { askSize() } },
        { label: '返回', sub: mainMenu },
      ])
    } },
    { label: '外观 ▸', sub: function () {
      return [
        { label: (state.theme !== 'dark' ? '✓ ' : '　') + '浅色', run: function () { setTheme('light') } },
        { label: (state.theme === 'dark' ? '✓ ' : '　') + '深色（DSH 风格）', run: function () { setTheme('dark') } },
        { label: '返回', sub: mainMenu },
      ]
    } },
    { label: '拖盆流体效果（' + fluidIntensityLabel(state.fluidIntensity) + '）▸', sub: function () {
      var rows = FLUID_INTENSITY_PRESETS.map(function (p) {
        return {
          label: (Math.abs(state.fluidIntensity - p.v) < 1e-9 ? '✓ ' : '　') + p.label,
          run: function () { setFluidIntensity(p.v) },
        }
      })
      rows.push({ sep: true })
      rows.push({ label: '0 = 关闭；数值越大，拖动时晃得越明显', disabled: true })
      rows.push({ label: '自定义强度…', run: function () { askFluidIntensity() } })
      rows.push({ label: '返回', sub: mainMenu })
      return rows
    } },
    { label: '功能选择 ▸', sub: function () {
      return [
        { label: (state.fxBowlDrop ? '✓ ' : '　') + '充值后掉落米饭盆，手动拖取',
          run: function () { setFx('bowl', !state.fxBowlDrop) } },
        { label: (state.fxPat ? '✓ ' : '　') + '鼠标抚摸会开心',
          run: function () { setFx('pat', !state.fxPat) } },
        { label: (state.fxHurt ? '✓ ' : '　') + '扣费时播放音效与动画',
          run: function () { setFx('hurt', !state.fxHurt) } },
        { sep: true },
        { label: '关掉后对应的事情不再发生，演示也一视同仁', disabled: true },
        { label: '返回', sub: mainMenu },
      ]
    } },
    { label: '声音 ▸', sub: soundMenu },
    { label: '松手吸附 ▸', sub: function () {
      function row(label, on, corner, off) {
        return {
          label: (on ? '✓ ' : '　') + label,
          run: function () {
            state.snapOnRelease = !off
            if (corner) state.snapCorner = corner
            saveState()
            if (corner) snapToCorner()
          },
        }
      }
      return [
        row('吸附到左下角', state.snapOnRelease && state.snapCorner === 'left', 'left', false),
        row('吸附到右下角', state.snapOnRelease && state.snapCorner === 'right', 'right', false),
        row('关闭（松手停在原地）', !state.snapOnRelease, null, true),
        { sep: true },
        { label: '吸附回' + cornerName(), run: function () { snapToCorner() } },
        { label: '返回', sub: mainMenu },
      ]
    } },
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
    { label: '立即刷新余额', run: function () { pollOnce(false, true) } },
    { label: '网络自检…', run: function () { showSelfCheck() } },
    { label: '测试一次扣费（-' + stepLabel() + '）', run: function () { playDemo(1) } },
    { label: '测试充值 ▸', sub: function () {
      var tail = state.fxBowlDrop ? '' : '（仅演示，不掉盆）'
      return [
        { label: '掉 1 盆饭' + tail, run: function () { testTopUpBowls(1) } },
        { label: '掉 3 盆饭' + tail, run: function () { testTopUpBowls(3) } },
        { label: '掉 10 盆饭' + tail, run: function () { testTopUpBowls(10) } },
        { sep: true },
        { label: '自定义金额…（掉 1 盆）', run: function () { askTopUp() } },
        { label: '返回', sub: mainMenu },
      ]
    } },
    { label: (radarOn ? '✓ ' : '　') + '打开火控雷达', run: function () { radarOn = !radarOn; wake() } },
    { label: '演示连续扣费 ▸', sub: function () {
      return [1, 5, 10, 20, 50, 100].map(function (n) {
        return {
          label: '扣 ' + n + ' 次（-' + moneyString(stepUnits() * n) + '）',
          run: function () { playDemo(n) },
        }
      }).concat([
        { sep: true },
        { label: '自定义次数…', run: function () { askDemoCount() } },
        { label: '返回', sub: mainMenu },
      ])
    } },
    { label: '吸附回' + cornerName(), run: function () { snapToCorner() } },
    // 隐藏前就把恢复方式写在菜单上 —— 否则用户点完「隐藏桌宠」才知道自己进了死胡同
    { label: state.hidden ? '显示桌宠' : '隐藏桌宠　（Ctrl+Shift+H 可恢复）', run: function () { setHidden(!state.hidden) } },
    { label: '关于…', run: function () { showAbout() } },
  ]
  return items
}

// 声音菜单：先选「是否分音效调节音量」。
//   是 → 6 个音效各自的「音量 / 自定义音频」；
//   否 → 只显示「全部音效音量」，但**自定义音频栏仍然显示**（需求：不勾选也要能换音频），
//        只是其中不再出现逐个音效的音量档位。
function soundMenu() {
  var off = !state.soundOn
  var per = !!state.soundPerCue
  var items = [
    { label: (state.soundOn ? '✓ ' : '　') + '开启音效', run: function () { setSoundOn(!state.soundOn) } },
    { label: (per ? '✓ ' : '　') + '分音效调节音量', run: function () { setSoundPerCue(!state.soundPerCue) } },
    { sep: true },
  ]
  if (off) items.push({ label: '音效已关闭，先勾选「开启音效」才能调整下面的选项', disabled: true })
  if (per) {
    items.push({ label: '单独音效（音量 / 自定义）', header: true })
    for (var i = 0; i < CUE_IDS.length; i++) {
      ;(function (id) {
        var custom = state.cueCustom[id]
        items.push({
          label: CUE_LABELS[id] + '（' + cueVolume(id) + ' %' + (custom ? ' · 自定义' : '') + '）▸',
          disabled: off,
          sub: function () { return cueMenu(id) },
        })
      })(CUE_IDS[i])
    }
  } else {
    items.push({ label: '全部音效音量', header: true })
    VOLUME_STEPS.forEach(function (v) {
      items.push({
        label: (allCuesAt(v) ? '✓ ' : '　') + (v === 0 ? '0%（静音）' : v + ' %'),
        disabled: off,
        run: function () { setVolume(v) },
      })
    })
    items.push({ label: '自定义音量…', disabled: off, run: function () { askVolume() } })
    // 自定义音频栏：与音量模式无关，始终显示；进去后只有试听 / 上传 / 恢复出厂。
    items.push({ sep: true })
    items.push({ label: '单独音效（自定义音频）', header: true })
    for (var j = 0; j < CUE_IDS.length; j++) {
      ;(function (id) {
        var custom = state.cueCustom[id]
        items.push({
          label: CUE_LABELS[id] + '（' + (custom ? '自定义' : '出厂') + '）▸',
          disabled: off,
          sub: function () { return cueMenu(id) },
        })
      })(CUE_IDS[j])
    }
  }
  items.push({ label: '返回', sub: mainMenu })
  return items
}

function cueMenu(id) {
  var off = !state.soundOn
  var custom = state.cueCustom[id]
  // 全局音量模式下来到这里：只保留自定义音频，不再显示逐个音效的音量档位。
  var audioOnly = !state.soundPerCue
  var items = []
  if (audioOnly) {
    items.push({ label: '「' + CUE_LABELS[id] + '」自定义音频', header: true })
  } else {
    items.push({ label: '「' + CUE_LABELS[id] + '」音量', header: true })
    VOLUME_STEPS.forEach(function (v) {
      items.push({
        label: (cueVolume(id) === v ? '✓ ' : '　') + (v === 0 ? '0%（静音）' : v + ' %'),
        disabled: off,
        run: function () { setCueVolume(id, v) },
      })
    })
    items.push({ label: '自定义音量…', disabled: off, run: function () { askCueVolume(id) } })
    items.push({ sep: true })
  }
  items.push({ label: '试听（音量 ' + cueVolume(id) + ' %）', disabled: off, run: function () { previewCue(id) } })
  items.push({ label: '上传自定义音效…（可截取片段）', disabled: off, run: function () { pickCustomCue(id) } })
  items.push({
    label: custom ? '当前：' + custom.name : '当前：出厂音效',
    disabled: true,
  })
  items.push({
    label: '恢复出厂音效',
    disabled: off || !custom,
    run: function () { restoreFactoryCue(id) },
  })
  items.push({ label: '返回', sub: soundMenu })
  return items
}

function askCueVolume(id) {
  showPrompt({
    title: CUE_LABELS[id] + '音量',
    label: '只调整这一个音效（0 ~ 100）。0% 等于关掉它，不影响其它音效。',
    value: cueVolume(id),
    suffix: '%',
    onOk: function (v, msg) {
      if (!/^\d+$/.test(v)) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '请输入 0 ~ 100 的整数'
        return false
      }
      var n = parseInt(v, 10)
      if (n < 0 || n > 100) {
        msg.className = 'dshpet-hol-msg is-err'
        msg.textContent = '超出范围：' + n + '（应在 0 ~ 100 之间）'
        return false
      }
      setCueVolume(id, n)
      return true
    },
  })
}

// 「隐藏」之后的恢复菜单。
//
// 为什么需要它：桌宠一旦 display:none，它自己的右键菜单就再也没有机会被打开 ——
// 而「显示桌宠」原来**只**存在于那个菜单里，于是隐藏成了不可逆的单程票。
// 所以隐藏之后改由「页面任意位置右键」唤出这个最小菜单。
function recoverMenu() {
  return [
    { label: '👁 显示桌宠', run: function () { setHidden(false) } },
    { label: '（Ctrl+Shift+H 也能切换）', disabled: true },
    { label: '关于…', run: function () { showAbout() } },
  ]
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
// 从 '/dsh-pet/license.txt?f=xxx.txt' 里取出文件名 —— 许可证入口的单一数据源
function licenseFileFrom(url) {
  var m = /[?&]f=([^&]+)/.exec(String(url || ''))
  if (!m) return ''
  try { return decodeURIComponent(m[1]) } catch (err) { return m[1] }
}

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
  title.textContent = '关于 ' + (info.name || 'DSH Balance Pet Enhanced')
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

  kv('名称', info.name || 'DSH Balance Pet Enhanced')
  kv('版本', info.version || '—')
  kv('构建时间', info.buildTime ? fmtTime(Date.parse(info.buildTime)) : '—')
  // 包名 = dsh plugin add 时用的名字（与上面的产品名是两件事）
  if (info.pkgName) kv('包名', info.pkgName)
  // 本分支的仓库地址（可点）
  if (info.repo && info.repo.url) kv(info.repo.label || 'GitHub', [aboutLink(info.repo.url)])

  var au = info.author || {}
  kv(au.role || '作者', [au.name || '—', '　', au.url ? aboutLink(au.url) : ''])
  // 许可证原文随包分发，这里给的是**可点开直接阅读**的入口（应用内显示，不依赖浏览器）
  if (info.selfLicense) kv('许可', [(info.selfLicense.label || 'MIT') + '　', licenseAnchor('LICENSE.txt', 'MIT 许可证原文')])
  if (info.notices) kv('第三方声明', [licenseAnchor('THIRD-PARTY-NOTICES.txt', '第三方来源与许可')])

  var refs = info.references || []
  if (refs.length) {
    var sep = document.createElement('div')
    sep.className = 'dshpet-about-sep'
    // 标题由宿主下发 —— 里面写明了本插件基于哪个版本改写
    sep.textContent = info.refsTitle || '参考的开源项目'
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
      // 许可证：有原文链接就链过去（可点开阅读），没有就如实写出状态。
      // 文件名**从 ref.licenseUrl / provenanceUrl 里解析** —— 曾经这里把
      // 'whale-LICENSE.txt' 写死了，于是每一条参考项目点开都是 whale 的许可证
      //（加了 VK-1 的 MIT 之后才暴露出来）。
      var licFile = licenseFileFrom(ref.licenseUrl)
      if (licFile) {
        var lic = document.createElement('div')
        lic.className = 'dshpet-about-reflink'
        var lab = document.createElement('span')
        lab.textContent = (ref.license ? ref.license + ' 许可证原文：' : '许可证：')
        lic.appendChild(lab)
        lic.appendChild(licenseAnchor(licFile, '点此阅读'))
        var provFile = licenseFileFrom(ref.provenanceUrl)
        if (provFile) {
          var lab2 = document.createElement('span')
          lab2.textContent = '　素材来源说明：'
          lic.appendChild(lab2)
          lic.appendChild(licenseAnchor(provFile, '点此阅读'))
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

function playSoundFile(which) { playCue(which) }

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
  var units = toUnits(t.amount)
  if (!isFinite(units) || units <= 0) return // 消耗为 0 的回合不提示也不记账
  var sym = currencySymbol(String(t.currency || 'CNY').toUpperCase())
  showTurnBubble('喜报', '您本次消耗了 ' + sym + moneyString(units))
  celebrateTime = CELEBRATE_DURATION // 红闪庆祝（复用原版的 source-atop 红叠加）
  wake()
  playCue('turn')
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
  // 正文往下挪一点；高度同步减掉，底部仍与黄区对齐
  var drop = h * CERT_BODY_DROP
  o.body.style.left = bx + 'px'
  o.body.style.top = (by + drop) + 'px'
  o.body.style.width = bw + 'px'
  o.body.style.height = (bh - drop) + 'px'
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
    bodyEl.appendChild(certRow(models[i].name, '¥' + moneyString(toUnits(models[i].amount))))
  }
  var tot = certRow('合计', '¥' + moneyString(toUnits(p.total)))
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
    // 米饭盆的全屏覆盖层：铺满窗口、完全不吃事件，z-index 在挂件之上、菜单之下
    '#dshpet-rice{position:fixed;left:0;top:0;width:100%;height:100%;pointer-events:none;' +
      'z-index:9999;-webkit-user-drag:none}' +
    '#dshpet-menu{position:fixed;display:none;min-width:184px;box-sizing:border-box;' +
      'background:var(--m-bg);border:1px solid var(--m-border);border-radius:10px;padding:5px;' +
      'z-index:10001;box-shadow:0 6px 18px rgba(0,0,0,.18);font-size:12.5px;color:var(--m-ink);' +
      // 浅色（默认）：取自上游 PetColors 的 light 一套
      '--m-bg:rgba(248,249,250,.97);--m-ink:#0f1115;--m-head:#81858c;--m-hover:#e9ecf2;' +
      '--m-border:rgba(32,49,112,.30);--m-sep:#ebeef2;--m-accent:#4176e6;color-scheme:light}' +
    // 深色：DSH 界面风（上游 PetColors 的 dark 一套）
    '#dshpet-menu.is-dark{--m-bg:rgba(44,44,46,.97);--m-ink:#f9fafb;--m-head:#adb2b8;' +
      '--m-hover:#3a3d42;--m-border:#42444a;--m-sep:#36373a;--m-accent:#7aaaff;color-scheme:dark;' +
      'box-shadow:0 6px 18px rgba(0,0,0,.5)}' +
    '.dshpet-mi{padding:6px 10px;border-radius:6px;cursor:pointer;white-space:nowrap}' +
    '.dshpet-mi:hover{background:var(--m-hover)}' +
    '.dshpet-msep{height:1px;background:var(--m-sep);margin:4px 8px}' +
    '.dshpet-mhead{padding:5px 10px 2px;color:var(--m-head);font-size:11px;cursor:default;white-space:nowrap}' +
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
    '.dshpet-cert-body{position:absolute;overflow:hidden;color:#000;font-weight:900;' +
      'font-family:system-ui,"Segoe UI",sans-serif;line-height:1.3}' +
    // 首行缩进两格（中文排版习惯）；标题就是正文第一行
    '.dshpet-cert-title{font-weight:900;white-space:normal;line-height:1.28;margin-bottom:.45em;' +
      'text-indent:2em}' +
    '.dshpet-cert-row{display:flex;justify-content:space-between;gap:1.4em;font-weight:800;line-height:1.42}' +
    '.dshpet-cert-total{display:flex;justify-content:space-between;gap:1.4em;font-weight:900;' +
      'border-top:2px solid rgba(0,0,0,.6);margin-top:.3em;padding-top:.3em}' +
    '.dshpet-cert-sign{position:absolute;text-align:right;color:#000;font-weight:800;' +
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
    '.dshpet-about-k{flex:0 0 96px;color:#6b7ba8;font-weight:600}' +
    '.dshpet-about-v{flex:1;word-break:break-all;font-weight:600}' +
    '.dshpet-about-link{color:#1d4ed8;text-decoration:none;font-weight:600}' +
    '.dshpet-about-link:hover{text-decoration:underline}' +
    '.dshpet-about-sep{margin-top:12px;padding-top:10px;border-top:1px solid rgba(32,49,112,.18);' +
      'font-weight:800;color:#203170}' +
    '.dshpet-about-refname{margin-top:8px;font-weight:700}' +
    '.dshpet-about-reflink{margin-top:2px;word-break:break-all}' +
    '.dshpet-about-refnote{margin-top:2px;color:#6b7ba8;line-height:1.5}' +
    '.dshpet-about-actions{display:flex;justify-content:flex-end;margin-top:14px}' +
    // 通用输入弹层（自定义尺寸 / 音量）
    '#dshpet-prompt{position:fixed;inset:0;z-index:31500;background:rgba(0,0,0,.6);display:flex;' +
      'align-items:center;justify-content:center}' +
    '.dshpet-prompt-label{margin:2px 0 10px;color:#6b7ba8;line-height:1.5}' +
    '.dshpet-prompt-row{display:flex;align-items:center;gap:8px;margin-bottom:8px}' +
    '.dshpet-prompt-inp{flex:1;min-width:0;box-sizing:border-box;padding:7px 10px;border-radius:7px;' +
      'border:1px solid rgba(32,49,112,.28);background:#fff;color:#203170;font-size:13px;' +
      'font-family:ui-monospace,Consolas,monospace}' +
    '.dshpet-prompt-inp:focus{outline:none;border-color:#4176e6;box-shadow:0 0 0 2px rgba(65,118,230,.18)}' +
    '.dshpet-prompt-suf{color:#6b7ba8;font-weight:700}' +
    // 音频片段截取
    '#dshpet-trim{position:fixed;inset:0;z-index:31600;background:rgba(0,0,0,.62);display:flex;' +
      'align-items:center;justify-content:center}' +
    '.dshpet-trim-box{width:min(620px,94vw);box-sizing:border-box;background:#fff;color:#203170;' +
      'border-radius:12px;padding:16px 18px;box-shadow:0 14px 50px rgba(0,0,0,.5);color-scheme:light;' +
      'font-family:system-ui,"Segoe UI",sans-serif;font-size:13px}' +
    '.dshpet-trim-title{font-size:15px;font-weight:800;margin-bottom:4px}' +
    '.dshpet-trim-sub{color:#6b7ba8;line-height:1.5;margin-bottom:10px;word-break:break-all}' +
    '.dshpet-trim-audio{width:100%;margin:2px 0 12px}' +
    '.dshpet-trim-row{display:flex;align-items:center;gap:10px;margin-bottom:10px}' +
    '.dshpet-trim-label{flex:0 0 38px;color:#6b7ba8;font-weight:700}' +
    '.dshpet-trim-range{flex:1;min-width:0;accent-color:#4176e6}' +
    '.dshpet-trim-time{flex:0 0 66px;text-align:right;font-family:ui-monospace,Consolas,monospace;' +
      'font-size:12px;color:#203170}' +
    '.dshpet-trim-msg{min-height:18px;font-size:12px;margin-bottom:6px;color:#6b7ba8}' +
    '.dshpet-trim-msg.is-ok{color:#15803d}.dshpet-trim-msg.is-err{color:#b91c1c}' +
    '.dshpet-trim-actions{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}' +
    // 轻量提示条（音效上传反馈）
    '#dshpet-toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);z-index:32000;' +
      'display:none;max-width:min(560px,90vw);box-sizing:border-box;padding:9px 14px;border-radius:9px;' +
      'background:rgba(24,32,52,.94);color:#fff;font-size:12.5px;line-height:1.45;' +
      'font-family:system-ui,"Segoe UI",sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.35);' +
      'white-space:pre-wrap;word-break:break-word}' +
    '#dshpet-toast.is-err{background:rgba(150,30,40,.95)}' +
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

  // 米饭盆玩法的全屏覆盖层。盆要能落在**整个窗口底部的任意位置**，所以不能画在
  // 挂件那块小画布里。pointer-events:none —— 它绝不吃 DSH 界面的任何事件，
  // 命中判定由 document 上的 pointerdown 自己做（见 onPointerDown）。
  riceEl = document.createElement('canvas')
  riceEl.id = 'dshpet-rice'
  ;(document.body || document.documentElement).appendChild(riceEl)
  riceCtx = riceEl.getContext('2d')

  ctx = canvas.getContext('2d')
  layout()
  place()
}

function setHidden(h) {
  var wasHidden = state.hidden
  state.hidden = !!h
  saveState()
  if (state.hidden) {
    stopPat()
    patPointerOn = false
    patSeen = false
  }
  if (container) container.style.display = state.hidden ? 'none' : 'block'
  if (menuEl.root) menuEl.root.style.display = 'none'
  // 恢复显示时要把位置与画面重新拾起来：隐藏期间帧循环可能已经停了，
  // 只把 display 设回 block 会留下一个空白盒子（旧实现就有这个隐患）。
  if (wasHidden && !state.hidden && container) {
    place()
    draw()
    wake()
  }
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
  })).then(function () {
    // 掩码刚建好，顺便量出头顶锚点（铁锅扣头用）
    computeHeadAnchor()
    draw()
  })
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
      // 立绘 / 表情 / 充值玩法的素材一起加载
      return Promise.all([refreshAssets(), loadExpressionArt(), loadTopupArt(), loadPatArt(), loadCustomClips()])
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
