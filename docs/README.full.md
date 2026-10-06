# DSH Balance Pet Enhanced · DSH 余额桌宠

> 正式名称 **DSH Balance Pet Enhanced**；安装 / 发布的包名是 **`dsh-balance-pet-extend`**（两者不同，别混）。

> 📖 **这是详细版说明。** 只想快速上手的话看 [精简版 README](../README.md)；
> 这里保留全部细节：每一项菜单、表情切换细则、米饭盆与火控雷达的全部规则、计价口径、
> HTTP 接口、与原版的差异、发布打包、素材与许可。

把 macOS 原生桌宠 **DSH大肥鱼桌宠**（[VK-1](https://github.com/VKmich16/VK-1) 的 Mac 分支
[DSH-DaFeiYu-Desktop-Pet](https://github.com/Andromedahk/DSH-DaFeiYu-Desktop-Pet)，
Swift + AppKit）改写成的 **DSH Web 插件**。五个角色，余额显示在角色手持的倾斜平板里，
每扣 ¥0.01 红闪 + 震动 + 音效 + 飘字，充值有绿色光环。

与 `dsh-whale-widget` **互不依赖，可以共存**：鲸鱼挂件固定在右下角，本桌宠默认吸附
**左下角**（与 macOS 原版一致），两者不会互相遮挡。

## 安装

### 方式一：把下面这段直接发给 DSH（最省事）

复制下面整个代码块，粘到 DSH 的对话框里发出去就行：

```
请帮我把 DSH 插件 dsh-balance-pet-extend 装好。按顺序做，每步做完把结果告诉我。

1. 先确定该装到哪个 profile：桌面应用是 desktop，命令行 / web 界面是 web。
   先试 `dsh plugin --profile desktop list`，能正常输出就用 desktop，否则用 web。

2. 执行安装：
   dsh plugin --profile <上一步确定的 profile> add github:TsukiKenga/dsh-balance-pet-extend

3. 装完必须核对两处，缺一不可（少了插件会「装上了但完全不工作」）：
   - node_modules/dsh-balance-pet-extend/ 存在，且里面有 cordis.patch.yml
   - 该 profile 的 package.json 里，dsh.profile.bundles 数组包含 "dsh-balance-pet-extend"
     （dsh plugin add 一般会自动加；如果没加，手动补上这一项）

4. 启动一次，确认启动日志里没有 "failed to import"。
   如果出现这句话，说明 cordis.patch.yml 里的 name 与 package.json 的 name 不一致。

5. 如果 github: 这条路装不上（本机没装 git、或网络不通），改用发布包：
   dsh plugin --profile <profile> add <dsh-balance-pet-extend-<版本号>.tgz 的绝对路径>

6. 最后提醒我：需要重启 DSH 并刷新页面才会生效。

不要改动我的其它配置，也不要动 dsh-whale-widget。
```

装好后重启 DSH + 刷新页面，**左下角**会出现桌宠；右键它就能看到菜单。

> 余额来源只会列出**你已经在 DSH 里配了 API key 的厂商**（没配的直接隐藏）。
> 想确认哪些通、哪些不通：右键 →「网络自检…」。

### 方式二：手动装

从 GitHub 装（推荐，别人也用这个）：

```powershell
dsh plugin --profile <profile> add github:TsukiKenga/dsh-balance-pet-extend
```

本地开发时用 `link:` 装（软链，改完源码**重启即生效**，不用重装）：

```powershell
dsh plugin --profile <profile> add link:<本目录的绝对路径>
```

> ⚠️ `link:` 是软链安装，**装好后不能移动或改名本目录**；移动后要重新 `add` 一次。
> 另外 `cordis.patch.yml` 里的 `name` 必须与 `package.json` 的 `name` 一致 ——
> 不一致的现象是启动日志出现 `failed to import`，而插件完全不工作。

> ⚠️ **不要拿正在用的 `link:` 安装去测试 tarball**：`remove` 掉 `link:` 依赖时，
> pnpm 可能**顺着软链把源目录清空**。要测发布包，请另建一个临时 profile。

## 操作

| 操作 | 效果 |
| --- | --- |
| 左键拖动 | 移动；默认松手吸附左下角，可在菜单里关掉 |
| 右键 | 菜单：切换角色 / 余额来源 / 累计计费 / 结束计费并结算 / 节假日清单… / 尺寸 / **外观** / **声音** / 松手吸附 / 刷新间隔 / 立即刷新 / 网络自检… / 测试扣费 / **测试充值（掉米饭盆）** / **打开火控雷达** / 演示连续扣费 / 吸附 / 隐藏 / 关于… |
| 左键按住米饭盆拖动 | 拖到她身上就投喂（播 feed 音效 + 飘爱心）；甩出去也可以 |
| 左键按住铁锅拖动 | 铁锅也能拖；拖到她头顶就会扣上 |
| 双击她的头 | 头上扣着铁锅时：让它渐隐消失 |
| **Ctrl+Shift+H** | 显示 / 隐藏桌宠（**随时可用**，隐藏之后也能按回来） |
| 透明区域 | 鼠标穿透（按 PNG 逐像素 alpha 判定，阈值 8/255） |

### 「隐藏桌宠」是可逆的

隐藏之后桌宠变成 `display:none`，它**自己的右键菜单再也打不开** —— 所以
「显示桌宠」不能只放在那个菜单里，否则隐藏就是一张单程票（旧版本确实如此，
只能手动改 `localStorage` 才能恢复）。

现在有**两条互相独立的退路**：

| 退路 | 怎么用 |
| --- | --- |
| **热键** | **Ctrl+Shift+H** 随时切换显示 / 隐藏。挂在 `document` 上，且**不看桌宠是否可见** —— 它存在的意义正是桌宠不可见时。在输入框里打字时不会抢键 |
| **恢复菜单** | 隐藏后**右键页面任意位置**，弹出一个只含「👁 显示桌宠」与「关于…」的小菜单；点空白处即可关掉 |

菜单项本身也写明了恢复方式（「隐藏桌宠　（Ctrl+Shift+H 可恢复）」），
不必等踩坑了才知道怎么回来。

## 角色与尺寸

| id | 角色 |
| --- | --- |
| `fish` | 蓝色大肥鱼（未连接时换成"抱盆"图） |
| `gpt` | GPT龙娘 |
| `claude` | 大小姐Claude |
| `gemini` | 北美猫娘Gemini |
| `kimi` | 白月光Kimi |

> 立绘要求：`1536×1024` PNG、背景透明、角色持有平板。加角色只要在
> `lib/index.js` 的 `CHARACTERS` 里加一行（含 `tablet` 三个角点），立绘路由会自动派生。
> **只有大肥鱼有离线立绘**，其余角色断线时保持原样。

尺寸档：110 / **150（默认）** / 210 / 280（角色"身高"，窗口宽 = 身高 × 1.5，高 = 身高 × 1.55）。

## 余额来源（右键可切）

平板里显示的余额可以从**右键菜单 →「余额来源」**切换，选择会被记住。

| 来源 | 取法 |
| --- | --- |
| **DSH 余额（DeepSeek）** | 凭据里有 `DEEPSEEK_API_KEY` → `https://api.deepseek.com/user/balance`；否则走 DSH 账号登录态（`ctx.get('deepseekAccount')` 可选服务，**不写进 inject**，否则老宿主上整个插件不会 apply） |
| **其它厂商** | 见下表，**自动发现**：只要有对应凭据就出现在菜单里，不需要手工注册 |

覆盖 **12 家「用 API key 就能自动查到」的厂商**：

| 类型 | 厂商 | 显示 |
| --- | --- | --- |
| **金额**（6） | DeepSeek、OpenRouter、Kimi/Moonshot（CN）、Kimi/Moonshot（国际）、阶跃星辰 StepFun、Novita | `¥12.34` / `$23.50` |
| **订阅额度**（6） | 智谱 GLM Coding Plan（国内/国际）、Kimi Coding、MiniMax Coding（国内/国际）、OpenCode Go | `剩余 63%` |

- **只列已配凭据的**：宿主按**候选凭据名依次探测**（DSH 官方环境变量名优先，whale 的旧名兜底），
  **没配的直接隐藏**（而不是列一堆点下去只会报「未配置」的条目）。
  > 为什么是一串候选名：DSH 自己的厂商目录用的名字与 whale 不一致
  > （DSH `KIMI_API_KEY` vs whale `KIMI_CODING_KEY`、DSH `ZAI_CODING_CN_API_KEY` vs whale `ZHIPU_API_KEY` …），
  > 只认一个就会把**已经配好的**显示成未配。每个来源认**各自独立**的凭据，避免两家都「声称已配」而其中一家必然 401。
- **额度类语义统一**：各家接口给的百分比含义不同（有的报「已用 %」、有的报「剩余 %」）。
  模板里用 `sem: 'used' | 'remain'` 显式标注，宿主**统一换算成「剩余 %」**再显示 ——
  否则「37%」到底是用掉还是剩下就说不清了。
- 官方**确实没有**「用 API key 查余额」接口的厂商（Claude、Gemini、硅基流动、火山方舟、
  阿里云百炼、腾讯混元等）**不进菜单**，但模板里仍记录着原因（`apiNote`），免得日后重复试错。

### 为什么没有 OpenAI

试过两轮，**结构上不可能**，不是地区问题、也不是「换把 key 就行」。结论记在
`lib/providers.js` 的 `apiNote` 里，免得以后又去试。

第三方工具（如 [CodexBar](https://github.com/steipete/CodexBar/blob/main/docs/openai.md)）用的是一个旧接口：

```
GET https://api.openai.com/v1/dashboard/billing/credit_grants
```

**OpenAI 自己的回复就是答案：**

```
HTTP 403
{"error":"Your request to GET /v1/dashboard/billing/credit_grants must be made with a
          session key (that is, it can only be made from the browser).
          You made it with the following key type: secret."}
```

即：**该接口只接受「浏览器会话 key」**，而 DSH 凭据里存的是 `sk-…` **secret key** —— 永远不可能满足。
所以这不是「重试一下」「开个代理」能解决的。

排查过程（顺带确认了不是地区问题）：

| 步骤 | 结果 |
| --- | --- |
| 直连 `api.openai.com:443` | **不可达**（DNS 解析到异常地址、TCP 超时） |
| 走本地代理 | **可达** |
| 带**假** key | **HTTP 401** `invalid_api_key` ← 能正常给出鉴权错误，说明**落地地区被支持**、不是 geo 拦截 |
| 带**真实** key | **HTTP 403** ← 响应体明确说是 key 类型不对（见上） |

> 换 Admin key 也不行：那是另一套 `/v1/organization/*` 接口，给的是**用量/花费**而不是余额，
> 而且需要组织级 Admin key。

**这次排查顺带改进了一处产品行为**：HTTP 失败时，错误信息里现在会带上**响应体片段**。
之前只显示一个孤零零的 `HTTP 403`，根本看不出原因；带上 body 之后，
「地区不支持 / key 类型不对 / 接口已下线」一眼就能分辨。

### ⚠️ 境外接口需要显式给 Node 配代理

实测发现一个容易踩的坑：**Node 的 `fetch` 不会自动使用 Windows 系统代理**。
本机系统代理是关的（注册表 `ProxyEnable=0`），直连必然超时（10 秒）。

要让 DSH 走代理，必须**显式**给环境变量（Node 24+）：

```powershell
$env:HTTPS_PROXY = "http://127.0.0.1:10808"   # 换成你的代理端口
$env:NODE_USE_ENV_PROXY = "1"                  # 关键：不开这个，fetch 会忽略上面的变量
# 然后再启动 DSH
```

实测对比：不设 → 10.7 秒后 `fetch failed`；设了 → **530ms 拿到 401**。
网络层失败时，插件的错误信息里也会带上这条提示。

`$DSH_HOME/.dshw-api.json` 仍可用来**覆盖**：与 `dsh-whale-widget` 共用同一份文件**约定**
（不是代码依赖）。它还能带进需要 Base URL 的模板（`openai_compat` 中转站、`custom` 自定义 HTTP）——
**任何官方文档没收录但确实有余额接口的厂商，都可以自己写一条 `provider: "custom"` 接进来，不用改插件代码。**

切来源时会**清空动画状态并直接对齐**，不会拿两个不同来源（可能还是不同币种）的数字做差。
平板标题：DeepSeek 显示原版的「DSH 余额」，其它来源显示该来源名；币种符号按 `currency` 走
（CNY→`¥`、USD→`$`，不认识的显示代码本身，**不会给美元硬套 ¥**）。
**额度类来源不参与扣费动画**（没有金额可比），只显示百分比。

默认 30 秒轮询一次（可改 10 / 30 / 60 / 300 秒）；429 遵守 `Retry-After`，否则逐次退避。

## 每轮消耗「喜报」

**每轮对话结束**（且该轮消耗 ≠ 0）时：

- 角色**上方**弹出红色加粗气泡：`喜报` / `您本次消耗了 ¥0.12`
- 角色播放**庆祝红闪**（复用原版 `source-atop` 红叠加曲线，峰值透明度 0.45；
  时长 0.9 秒、震动幅度取扣费的 0.45 倍 —— 庆祝语气，不是挨打）
- 播放 `assets/congrats-turn.mp3`

气泡停留 6 秒后淡出。**子代理回合不计**，消耗为 0 的回合不弹也不记账。

## 累计计费与结算

右键菜单「**累计计费**」：

- 默认**开启**，且**只要没在菜单里关掉，每次启动 DSH 都自动开始计费**
- 累计区间 = 上一次「结束计费」到这一次（起点落盘，跨重启保留）
- 菜单里「结束计费并结算（¥1.50）」实时显示当前累计；无消耗时该行禁用

点它进入**全屏结算页**：以 `assets/certificate.png`（1671×941 的「喜报」模板）为底，
正文打在**中部黄色区域**（实测标定 `x 352–1330, y 205–772`，避开顶部「喜 报」横幅与左右红幕布）：

```
恭喜您在 2026-10-02 09:00 至 2026-10-02 21:30 中共消耗了：
  deepseek-flash                          ¥1.23
  step-3.5-flash                          ¥0.27
  ─────────────────────────────────────────────
  合计                                    ¥1.50
                                    Deepseek Harness
                                        2026-10-02
```

落款贴右下角（**不要求落在黄区内**）。标题过长会自动缩字号以放进黄区宽度。
进入时播放 `assets/congrats-settle.mp3`（**13.5 MB，绝不预加载**，只在结算页真的打开时才拉取）。

**关闭语义**（按需求实现）：

| 操作 | 效果 |
| --- | --- |
| `ESC` 或点右上角 `×` | **立刻关闭** |
| 按其它键 / 点页面上其它地方 | **只取消 15 秒自动关闭**，页面留着 |
| 什么都不做 | **15 秒后自动关闭** |

结算页会**挡住下层 DSH 的点击**（这正是必须有自动关闭与 `ESC` 的原因）。

## 计价口径

按**该轮实际使用的模型**计价（取自 `assistant/message` 的 `message.source.model`），
**与平板当前显示哪个余额来源无关**。口径照搬 `dsh-whale-widget`：

- 时长峰谷：北京时间 `9–12` 与 `14–18` 为峰价，其余为谷价
- 自 2026-08-23 起**周末全天谷价**；自 2026-09-19 起**法定节假日全天谷价**
- 内置价目表：`deepseek-flash`（input 1/2、output 4/8、缓存命中 0.02/0.04 元/百万 token，
  谷/峰）与 `deepseek-v4-pro`（Flash 的 3 倍）
- 自定义单价取 `$DSH_HOME/.dshw-api.json` 里模型的 `price` 字段，按 `matchIds` 最长匹配；
  按美元填写的会按填的汇率折算成元
- `reasoningTokens ⊆ outputTokens`，故不重复计

## 法定节假日清单（可导入，会提示过期）

**先说结论：没有比"维护一张表"更好的办法。** 中国的法定节假日**放假安排**（放哪几天、
哪个周末补班）是国务院每年 11 月前后以通知形式发布的**行政决定**，不是天文可推算量：
清明/端午/中秋的日期可由历法算出，但"实际放哪几天、怎么调休"取决于通知。所以任何正确实现
都必须摄入这份年度通知，差别只在**维护成本**。

因此这里的做法是把维护成本压到最低：

- **数据与代码分离**：清单落在 `$DSH_HOME/.dshpet-holidays.json`，改数据不用改代码、不用重装
- **一键导入**：右键 →「节假日清单…」，可**粘贴**（一行一个 `YYYY-MM-DD`，或 JSON 数组 /
  `{"years":{"2027":[…]}}`）或**从 URL 拉取**（带体积与格式校验）
- **并集语义**：生效集合 = 内置默认 ∪ 导入清单，导入只会**增加**；要撤销点「恢复内置」
- **过期检测**（两档，都会在界面上提示）：
  - `stale` —— 当前年份根本没覆盖 → 该年的节假日会被**按峰价错算**，启动时弹黄字提示
  - `warn` —— 当年已覆盖，但已到 **11 月**而次年还没数据 → 该去导入了

菜单项在清单过期时会带 `⚠`。内置默认是 **2026 年**（与 `dsh-whale-widget` 同源）。

## 子代理判别（已知限制）

需求是「子代理的回合不计」。DSH 没有给出稳定的会话类型契约，所以 `lib/pricing.js` 的
`sessionVerdict()` 把已知可能的标记全兜了一遍（`parentId` / `parentSessionId` / `parent` /
`isSubagent` / `kind` 含 `sub`/`child` 等）。

**实际观察到的 session 字段会暴露在 `/dsh-pet/sessions.json`**（诊断用），
拿真实数据核对后再收紧判定。若某个 DSH 版本上确实没有任何可判别字段，
退路是「只统计当前会话」—— 目前实现尚未走到这一步，请以 `sessions.json` 的实测为准。

## 表情系统（仅大肥鱼）

**只有大肥鱼有表情立绘** —— 上游项目（VK-1 v2）只提供了这一只角色的四张，所以其余三个角色保持
单张立绘不变（不给他们编造表情）。

| 表情 | 立绘 | 触发条件 |
| --- | --- | --- |
| 常态 | `expression_11` 开口笑 | 默认 |
| 紧张 | `expression_22` 闭眼皱眉 | 扣费动画播放中，**结束后再保持 1 秒**（上游 `NervousHoldSec`） |
| 冷淡 | `expression_12` 鼓嘴 | 米饭盆落地后 **10 秒**没被投喂（上游 `BowlWaitSec`） |
| 平静 | `expression_21` 面无表情 | 铁锅扣在头上（**优先级最高**，压过扣费） |

优先级与上游逐条对齐：**铁锅 > 扣费中 > 盆超时 > 常态**。

四个立绘必须**全部加载成功**才启用多表情 —— 上游同样的取舍：半套会在表情与单图之间闪，
比不加还难看。

> **实现提示**：表情立绘是 `1024×1024` 的**正方形**，而角色立绘是 `1536×1024`（1.5:1）。
> 若按 `spriteRect` 硬铺满，正方形会被**横向拉长 1.5 倍**。所以绘制时按原图宽高比
> **等比缩放、以高度对齐**（对 1.5:1 的立绘本身这是恒等变换，不受影响）。

## 米饭盆充值玩法

余额**上涨**时会掉下来一个**米饭盆**，这就是上游 v2 的核心玩法：

- **物理**：重力 2100 px/s²、弹性 0.5、最多弹 3 次、空气阻力 0.30、滑动摩擦 1.40 ——
  参数逐条照抄上游
- **拖动投喂**：左键按住盆，**拖到她身上**才入账（碰到头发 / 头饰也算）→
  播 `feed.mp3` + 飘像素爱心。也可以把盆**甩出去**
- **多盆并存**：一笔充值掉一个盆，场上可以同时有好几个（上游同）；盆彼此有**碰撞体积**，
  落点会错开，不会叠成一堆
- **不接的代价**：盆落地满 10 秒没被领取 → 切到「冷淡」表情，而且**所有盆一起被锁定**
- **自动吸附**：锁定后再过 1 秒，被锁的盆开始加速朝她飞，吸到身上自动走一次完整的投喂。
  加速度 / 速度上限照抄上游（960 / 2400），按尺寸折算
- **铁锅**：米饭盆被投喂后掉一口铁锅。它**也能拖、也能被甩**；
  拖到她头顶（或扔上去）就会扣在她头上 → 切到「平静」表情；
  **双击她的头**让它渐隐消失。铁锅同时只会有一个，也不会被火控雷达锁定

> **锅扣在哪是量出来的，不是写死的。** 它在立绘 alpha 掩码的最上方 10% 里找「头」
> （取那一段不透明像素的水平中心）。起因：换过一版立绘后角色在画布里的位置变了 ——
> 头从水平居中挪到了约 **0.68** 处，写死 0.5 会把锅扣在她左边的头发上（偏约 270px）。
> 拿不到掩码时退回居中的经验值。**以后再换立绘不用改代码。**

> **活动范围 = 整个 DSH 窗口的底部**。盆画在一层**全屏覆盖层**（`#dshpet-rice`）上，
> 用的是视口坐标：**左右墙 = 窗口左右边，地面 = 窗口底边**，落点在整条底边上随机散布。
> 覆盖层是 `pointer-events: none`，绝不吃 DSH 界面的任何事件；命中判定由 `document` 上的
> `pointerdown` 自己做，只在**真的点中盆**时才吞掉这一次点击。

### 火控雷达

盆被**锁定**时（或菜单里手动打开），会显示《战争雷霆》风格的目标名牌 —— 几何逐条照抄上游：

| 元素 | 上游规格 |
| --- | --- |
| 四角方括号 | 边长 `S = 1.33 × 盆的绘制直径`，臂长 `0.30 S`，纯平色 `#00ff08`、**无外发光**（上游专门注释过：设计稿里的 1px 光晕是截图 JPEG 伪影，试过、不对、已移除） |
| 类型 | `白饭`，字高 `0.40 S`，居中在括号上方 |
| 距离 | 单位 **kpx**（千像素），形如 `1.2 kpx` |
| 接近率 | `px/s`，正 = 正在靠近。手拿着盆时取**光标轨迹采样值**，否则读数会冻在停下前的那个数（上游踩过这个坑） |
| 相对高度 | `px`，正 = 盆比她的头高 |
| 方向环 | 圆心在括号下方 `0.70 S`、半径 `0.185 S`；环上一根指针指向盆相对她的**方位** |

名牌只认米饭盆 —— 铁锅永远不会被锁定。

菜单里的「**打开火控雷达**」只是把名牌提前亮出来给你看，**不会**缩短 10 秒倒计时、
也不会启动吸附；自动流程照常走自己的时间。纯属玩梗，默认关闭。

> 上游**刻意不做屏幕边缘避让**（贴边裁掉可以接受，缩小字号反而看不清），这里照做。

## 显示设置

| 菜单 | 内容 |
| --- | --- |
| **尺寸** | 小杯 / 中杯 / 大杯 / 超大杯，标注 `110 px ≈ 2.9 cm`；另有「自定义尺寸…」 |
| **外观** | 浅色 / 深色（DSH 风格）—— 只换菜单配色，角色本身不受影响 |
| **声音** | 开启声音 + 音量档位（0/25/50/75/100 %）+ 自定义音量。**0% 即静音**，开关会跟着走 |

> **关于厘米**：浏览器**拿不到显示器的物理 DPI**，所以这里的 cm 是按 CSS 标称 96 DPI
> 估算的，菜单里一律写成 `≈ N cm`。上游是 WinForms，可以用 `Graphics.DpiY` 拿真实 DPI
> 把像素反算成厘米，并把它作为派生字段（`AskCm()` 其实也是转去问像素）。

## 网络自检

右键 →「**网络自检…**」会把**每个已配凭据的来源真打一遍**，一次列出：通不通、取值、耗时、失败原因，
并附上代理环境变量的状态。菜单里还有「重新检测」。

存在的意义：**Node 的 `fetch` 不会使用 Windows 系统代理**，境外来源在国内会**静默超时**——
与其让用户在来源之间逐个试，不如一次看清。

本机实测（DeepSeek + StepFun）：

```
通过 2 / 2   总耗时 219ms
代理: HTTPS_PROXY=未设  NODE_USE_ENV_PROXY=未开
 ✓ 阶跃星辰 StepFun        ¥14.02  106ms
 ✓ DSH 余额（DeepSeek）    ¥19.10  218ms
```

失败项会直接给出**响应体片段**（例如 `HTTP 403 {"error":"... key type: secret."}`），
一眼就能分辨是「地区不支持」「key 类型不对」还是「接口已下线」。
接口：`GET /dsh-pet/selfcheck.json`。

## 测试

```powershell
node test/smoke.mjs      # 或 npm test
```

`test/smoke.mjs` 在**最小 DOM / Canvas / 虚拟时钟**里真跑 `assets/pet.js`，然后通过右键菜单、
点击与弹层去验证行为 —— 不需要启动 DSH，也不需要浏览器。当前 **50 项**，覆盖：

- 菜单结构、子菜单展开、分隔线与分组标题
- 尺寸档位（杯命名 / px / cm 估算）、自定义尺寸的校验与生效
- 外观切换（`is-dark` 的加与去）
- 声音档位，以及「0% 即静音」时开关是否跟着走
- 表情系统：四张全部加载、扣费切「紧张」、保持 1 秒后回「常态」、
  切到没有立绘的角色时退回单图
- 米饭盆：重力下落、落定停住、**10 秒不接翻脸**、点盆投喂（`feed.mp3`）、
  投喂后掉铁锅 → 「平静」表情
- 火控雷达开关

> 宿主侧（路由、余额来源、许可证白名单、信任栅栏）暂时没有自动化测试，
> 改动后请手动验证：启动 DSH → 右键「网络自检…」确认来源都能取到余额。
> 若改动了包名或目录名，务必核对 **`package.json` 的 `name` 与 `cordis.patch.yml` 的 `name` 一致**
> —— 不一致时插件会静默不加载，只在启动日志留一行 `failed to import`。
> 若用 `link:` 安装，**不要**对该 profile 执行移除操作来测试发布包：pnpm 可能顺着软链清空源目录。

## HTTP 接口

| 路径 | 内容 |
| --- | --- |
| `/dsh-pet/pet.js` | 浏览器半区脚本 |
| `/dsh-pet/manifest.json` | 角色表、平板角点、尺寸档、节假日过期状态 |
| `/dsh-pet/sources.json` | 可用余额来源（自动发现 + 是否已配 key） |
| `/dsh-pet/balance.json?source=<id>` | 指定来源的余额或额度（`?refresh=1` 强制刷新，绕过 25 秒缓存） |
| `/dsh-pet/turn.json` | 最近一轮消耗（`seq` 单调递增，前端据此判断「有新回合」） |
| `/dsh-pet/ledger.json` | 累计账本。`GET` 读；`POST {"action":"settle"\|"enable"\|"disable"}` |
| `/dsh-pet/holidays.json` | 节假日清单。`GET` 读（含过期状态）；`POST {"action":"import"\|"reset", holidays?\|url?}` |
| `/dsh-pet/sessions.json` | 诊断：观察到的会话字段与子代理判定 |
| `/dsh-pet/certificate.png` | 结算页底图 |
| `/dsh-pet/sound/turn.mp3`、`/dsh-pet/sound/settle.mp3` | 回合结束音 / 结算音 |
| `/dsh-pet/sprite/<file>.png` | 角色立绘 |
| `/dsh-pet/expr/expression_<nn>.png` | 表情立绘（白名单四个文件名） |
| `/dsh-pet/rice.png`、`/dsh-pet/iron_bowl.png` | 米饭盆 / 铁锅 |
| `/dsh-pet/sound/feed.mp3` | 投喂音效 |
| `/dsh-pet/license.txt?f=<白名单名>` | 许可证与第三方声明（纯文本） |
| `/dsh-pet/selfcheck.json` | 网络自检：逐个来源真打一遍 |
| `/dsh-pet/hit.mp3` | 扣费音效 |

账本落在 `$DSH_HOME/.dshpet-ledger.json`、节假日清单落在 `$DSH_HOME/.dshpet-holidays.json`
（均跨重启保留）。

## 与原版的差异（有意为之）

- **没有序列帧**：原版每个角色就是一张静态 1536×1024 PNG，所有动画都是过程式的，
  这里用 `<canvas>` 逐帧重绘复刻（原版把震动施加在整个上下文上，精灵和文字一起抖）。
- **不做 macOS 专有部分**：Dock/菜单栏图标、`NSSound`、`NSWindow.ignoresMouseEvents`、
  `~/.dsh/.credentials.yaml` 手工解析（改由 DSH 凭据服务）、`state.json`（改用 localStorage）。
- 平板文字的排版比例、颜色、状态点位置、震动/红闪/飘字/光环的时长与曲线**全部照搬原版常量**。
- 平板仿射用原图左上角为原点、y 向下的推导；已用原版文档记录的右下角
  `(1443,834)`（三角色共用）与 `(1430,836)`（gemini）验证一致。
- **喜报 / 累计计费 / 结算页是新增功能**，macOS 原版没有。
- 结算页正文全部用 `createElement` + `textContent` 构造，不拼 HTML。

## 关于

右键菜单**最底部** →「**关于…**」：

- **名称**：`DSH Balance Pet Enhanced`
- **版本**：取自 `package.json`
- **构建时间**：参与运行的文件里最新的 mtime
  （本插件是 `link:` 安装、源码改动立刻生效，写死的时间会与实际运行的代码对不上，所以用 mtime）
- **包名**：`dsh-balance-pet-extend` —— 安装与发布用的就是这个
- **GitHub**：[github.com/TsukiKenga/dsh-balance-pet-extend](https://github.com/TsukiKenga/dsh-balance-pet-extend)
  （在对话框里是可点的链接）
- **分支维护者**：[TsukiKenga](https://github.com/TsukiKenga)
  （本仓库是上游桌宠的分支延续，所以署名口径是「分支维护者」而非原作者）
- **许可**：`MIT` + [第三方来源与许可](THIRD-PARTY-NOTICES.txt) —— 都是**可直接点开阅读的链接**
- **参考的开源项目**（标题里直接写明本插件基于哪个分支改写；GitHub 地址在对话框里可点）：
  - [VK-1](https://github.com/VKmich16/VK-1)　By VKmich　**MIT**
    —— **最初的原作者**（Windows 版桌宠）。表情系统、米饭盆充值玩法、铁锅扣头与火控雷达
    移植自这一版的「大肥鱼桌宠改」；米饭盆 / 铁锅 / 喂食与打击音效也取自该目录
    （**MIT 许可证原文已随包分发、点开即读**）
  - [DSH-DaFeiYu-Desktop-Pet](https://github.com/Andromedahk/DSH-DaFeiYu-Desktop-Pet)　By Andromedahk
    —— **fork 自 VK-1** 的 Mac 分支（Swift + AppKit），后被上游合并；
    **本插件基于这一版改写**：四个角色、立绘、平板布局、扣费动画与「抱盆」离线态都来自这里
    （许可证：**上游未另行授予许可**，对话框里如实写出）
  - [DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget)　By MeteorNOX　MIT
    —— 计价口径与厂商模板参考，**许可证原文与素材来源说明都随包分发、点开即读**

### 许可证是「把文本链进去」的，不是只写路径

为了以后打包发布，MIT 要求再分发时保留版权与许可声明，所以这些原文**已经放进包里**：

| 文件 | 内容 |
| --- | --- |
| `LICENSE` | 本插件的 MIT 许可（TsukiKenga） |
| `THIRD-PARTY-NOTICES.txt` | 逐项第三方来源与权利状态 |
| `licenses/DeepSeek-Balance-Whale-Widget-LICENSE.txt` | whale 的 MIT 原文（**逐字节复制**，SHA-256 已核对） |
| `licenses/DeepSeek-Balance-Whale-Widget-PROVENANCE.md` | whale 的素材来源说明原样复制（上游文件，未改动） |

宿主通过 `/dsh-pet/license.txt?f=<白名单文件名>` 提供，**白名单 + `path.basename`**，
路径穿越请求返回 404。这四份都写进了 `package.json` 的 `files`，发布时会一起打包。

> **这几份都是纯文本，故意不写 Markdown。** 它们在 DSH 里是以等宽字体在 `<pre>` 中
> 直接显示的，写 Markdown 只会把 `#`、`|`、`**` 原样露出来，反而更难读。
> 唯一例外是 `licenses/…PROVENANCE.md` —— 那是上游的原始文件，逐字节保留、不做改动。

#### 为什么不是 `<a target="_blank">`（曾经点不开的原因）

最初这几个入口是普通外链，结果**点了没反应**。原因是桌面端（Electron）的页面来源是
`dsh-app://app/`，相对路径 `/dsh-pet/license.txt` 会被解析成
`dsh-app://app/dsh-pet/license.txt` —— 壳子不允许打开这种地址，于是「点了什么都不发生」。

改法：**许可证改成应用内阅读** —— 点一下用 `fetch` 取回文本，直接在弹层里用 `<pre>` 显示，
完全不依赖浏览器打开。（`https` 外链不受影响，所以三个 GitHub 链接仍是普通 `<a target="_blank">`。）

> ⚠️ **发布前必读**：`THIRD-PARTY-NOTICES.txt` 里逐项列了能不能随包公开发布。
> 简单说：本插件代码（MIT）✅；VK-1 立绘**上游无许可** ⚠️；
> `congrats-settle.mp3` 是**有版权的电影配乐，不可再分发** ❌（建议打包时排除）。

## 发布 / 打包

本插件就是一个标准 DSH bundle 插件包（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`）。
三种分发方式：

| 方式 | 发布方要做的 | 使用者安装 |
| --- | --- | --- |
| **GitHub**（推荐） | `git init` → push → 打 tag | `dsh plugin --profile <p> add github:TsukiKenga/dsh-balance-pet-extend` |
| npm | `npm publish` | `dsh plugin --profile <p> add dsh-balance-pet-extend` |
| 本地 / 内部分发 | 打个 zip | `dsh plugin --profile <p> add link:<解压目录>` |

`dsh plugin` 就是 `pnpm` 的透传，所以 **pnpm 能装的来源都能装**（npm 包名 / `github:` / `file:` / `link:` / tarball）。

### 改名 / 搬家时必看

三处名字必须一致，否则插件**静默不工作**（只在启动日志留一行 `failed to import`）：

1. `package.json` 的 `name`
2. `cordis.patch.yml` 里 `insert[].name`（**这是要被 import 的模块名**）
3. 两个 profile 的 `dsh.profile.bundles` 数组（用 `dsh plugin add` 会自动维护）

改完记得把 profile 里的旧名 `remove` 掉，并删掉 `node_modules/` 下指向旧路径的**孤儿 junction**——
它会让 DSH 继续尝试加载旧名并报 `failed to import`。

## 素材与许可

### 已获授权（可随包分发）

| 文件 | 来源 | 许可 |
| --- | --- | --- |
| `assets/expr/*.png` | 原图来自 VK-1 v2「大肥鱼桌宠改」的 `sprites/`；现版由维护者重绘为 1536×1024 | MIT（VK-1）/ 维护者自有 |
| `assets/rice.png` · `assets/iron_bowl.png` | VK-1 v2「大肥鱼桌宠改_D-16BVM」根目录，**逐字节复制** | **MIT** —— VK-1 LICENSE 明确把「角色美术」列入覆盖范围 |
| `assets/hit.mp3` · `assets/feed.mp3` | 同上，**逐字节复制** | **MIT** —— VK-1 LICENSE 明确把「音效」列入覆盖范围 |
| `assets/sprites/kimi.png` | 由本仓库维护者提供 | 维护者自有 |

[VK-1](https://github.com/VKmich16/VK-1) 的 MIT 许可证原文已随包分发，见
[`licenses/VK-1-LICENSE.txt`](licenses/VK-1-LICENSE.txt)（© 2026 VKmich16，逐字节复制、SHA-256 已核对）。
MIT 要求再分发时保留版权与许可声明，**这个文件不要删**。

### 需先确认或替换

| 文件 | 说明 |
| --- | --- |
| `assets/sprites/*.png`（5 张角色立绘） | 来自 Mac 分支 [DSH-DaFeiYu-Desktop-Pet](https://github.com/Andromedahk/DSH-DaFeiYu-Desktop-Pet)（fork 自 VK-1）的 `Resources/`，与这一版**逐字节相同**。该分支的 `Resources/README.md` 明确写着「不另行授予上游代码、素材或衍生图片的许可」，而且四张立绘是在 Windows 原图（1024×1024）基础上 **AI 补全**出来的 1536×1024 版本 —— 原文也说明「含轻微生成重绘，不能视作原图逐像素不变的扩边」 |
| `assets/certificate.png` | 「喜报」庆祝模板底图，来源不明 |

> ⚠️ **VK-1 的 MIT 不覆盖 Mac 分支的目录** —— VK-1 的 README 里写明那一支
> 「许可以其独立说明为准」。所以 `rice.png` / `iron_bowl.png` / 音效 / 表情是 MIT，
> 但四张角色立绘不是。**两者不要混为一谈。**

### 不可再分发

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `assets/congrats-turn.mp3` | vjshi 音效库（[detail/59738](https://www.vjshi.com/sound-effects/detail/59738)） | 商业素材站，按其条款授权给使用者，不可再分发 |
| `assets/congrats-settle.mp3` | *The Magnificent Seven*（Elmer Bernstein，ID3 标签确认），经 [CefDetector](https://github.com/ShirasawaSama/CefDetector) 取得 | ⚠ **有版权的电影配乐**，仅供本地私人使用；打包发布时建议排除（13.5 MB） |

> 代码按 MIT；上表「需先确认或替换」与「不可再分发」的素材**不在本插件的 MIT 覆盖范围内**，
> 按 as-is 随插件分发，仅用于本地运行本插件，不授予再许可。
> 逐项登记见 [`THIRD-PARTY-NOTICES.txt`](THIRD-PARTY-NOTICES.txt)。

---

*本项目中的全部代码与文件由Deepseek V4.1 Flash生成，包括这个文件*