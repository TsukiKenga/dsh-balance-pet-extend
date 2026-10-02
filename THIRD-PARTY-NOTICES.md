# 第三方来源与许可（THIRD-PARTY NOTICES）

本插件（`dsh-balance-pet` / 对外名称 `dsh-balance-pet-extend`）的**代码**按 MIT 许可发布，
见 [`LICENSE`](LICENSE)。以下逐项说明另外三类内容的来源与权利状态。

---

## 1. 参考的开源项目

### DeepSeek-Balance-Whale-Widget

- 仓库：<https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget>
- 作者：MeteorNOX
- 许可：**MIT**
- 许可证原文随包分发：[`licenses/DeepSeek-Balance-Whale-Widget-LICENSE.txt`](licenses/DeepSeek-Balance-Whale-Widget-LICENSE.txt)
  （逐字节复制自上游 `LICENSE`，SHA-256 已核对）
- 素材来源说明：[`licenses/DeepSeek-Balance-Whale-Widget-PROVENANCE.md`](licenses/DeepSeek-Balance-Whale-Widget-PROVENANCE.md)
- 本插件的用途：**计价口径**（峰谷时段、周末谷价、法定节假日谷价、自定义单价与汇率折算）
  与**厂商模板**（各家的余额/额度接口地址与字段路径）参考自该项目。

> MIT 要求再分发时保留版权与许可声明，因此上面两个文件**必须随包一起发布**。

### VK-1

- 仓库：<https://github.com/VKmich16/VK-1>
- 作者：VKmich
- 许可：**上游暂未附许可证**

> ⚠️ 这一条在**打包发布前必须留意**。上游项目（VK-1）及其 macOS 移植版
> (`dsh-balance-pet-macos`) 的素材说明里明确写着：
> 「上游原作者说明 UI 图片由其处理；**上游暂未附许可证**。这里保留来源说明，
> **不另行授予上游代码、素材或衍生图片的许可**。」
>
> 也就是说：`assets/sprites/*.png`（四个角色立绘）源自 VK-1，**没有可再分发的许可依据**。
> 本插件按 as-is 随包提供、仅供本地运行；如果你要**公开发布**这个插件，
> 建议先向 VK-1 作者确认授权，或替换成你自己拥有权利的立绘。

---

## 2. 美术素材

| 文件 | 来源 | 权利状态 |
| --- | --- | --- |
| `assets/sprites/fish.png`、`fish-offline.png`、`gpt.png`、`claude.png`、`gemini.png` | VK-1 的 macOS 移植版 `Resources/` 目录 | 见上：上游未附许可 |
| `assets/certificate.png` | 「喜报」庆祝模板底图 | 来源不明，按 as-is 使用；**发布前请自行确认** |

原始的逐文件 SHA-256 记录在 `dsh-balance-pet-macos/Resources/README.md`。

---

## 3. 音频素材

| 文件 | 来源 | 权利状态 |
| --- | --- | --- |
| `assets/hit.mp3` | 原版桌宠音效（Windows 版逐字节复制） | 随上游素材，按 as-is |
| `assets/congrats-turn.mp3` | vjshi 音效库 <https://www.vjshi.com/sound-effects/detail/59738> | **商业素材站**，按该站条款授权给使用者；**不可再分发** |
| `assets/congrats-settle.mp3` | *The Magnificent Seven*（Elmer Bernstein，ID3 标签确认），经 <https://github.com/ShirasawaSama/CefDetector> 取得 | ⚠️ **有版权的电影配乐**；仅供本地私人使用，**绝不可随插件再分发** |

> 打包发布时建议：把 `congrats-settle.mp3`（13.5 MB，版权曲）**排除**出发布包，
> 让使用者自备，或替换成可自由再分发的音效。

---

## 4. 小结：发布前请确认

| 内容 | 能不能随包公开发布 |
| --- | --- |
| `lib/`、`assets/pet.js`、`test/`（本插件代码） | ✅ MIT，可以 |
| whale 的 LICENSE / PROVENANCE 文本 | ✅ MIT，**必须**一起带 |
| `assets/sprites/*.png`（VK-1 立绘） | ⚠️ 上游无许可，先确认或替换 |
| `assets/certificate.png` | ⚠️ 来源不明，先确认或替换 |
| `assets/congrats-turn.mp3`（vjshi） | ⚠️ 商业素材，不可再分发 |
| `assets/congrats-settle.mp3`（电影配乐） | ❌ 不可再分发，建议排除 |
