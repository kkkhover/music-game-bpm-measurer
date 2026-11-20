<div align="center">

# 🎵 BPM 测速助手

**给音乐游戏做准确 timing 的桌面工具**

导入一首歌 → 波形 + 声谱找拍 → 一段段记录「BPM + 起始时间」→ 一键导出成 osu! / Malody / Arcaea / Phigros / ADOFAI / vivid-stasis 能直接用的 timing 文件

**稳定版 `v0.8.18`** ｜ Windows 10 / 11 64 位 ｜ 离线可用 ｜ 无需 Node.js

[**⬇ 下载稳定版**](https://github.com/kkkhover/music-game-bpm-measurer/releases/download/v0.8.18/BPM.Setup.0.8.18.exe) ·
[安装与上手](#安装与上手) ·
[功能](#能做什么) ·
[制谱侧栏](#osu-制谱侧栏osu-maphelper) ·
[常见问题](#常见问题) ·
[从源码构建](#从源码构建) ·
[许可与来源](#许可与来源)

</div>

---

## ⚠️ 先看版本：稳定版 0.8.18 / 预览版 0.9.0

| | 版本 | 定位 | 建议 |
|---|---|---|---|
| ✅ | **`v0.8.18`** | **稳定版（本页介绍的就是它）** | **所有人下载这个**。测速 + 制谱侧栏功能完整，并做完了一轮性能修复 |
| 🧪 | `v0.9.0` | **预览版（Pre-release）** | 只在你想试「谱面预览 / 红绿线 SV / 录视频」时下载，**可能不稳定、接口随时会改** |

- 两个版本都在 [**Releases**](https://github.com/kkkhover/music-game-bpm-measurer/releases) 里，预览版带 `Pre-release` 标记。
- 预览版逐条说明见 [v0.9.0 Release Notes](https://github.com/kkkhover/music-game-bpm-measurer/releases/tag/v0.9.0)。
- **仓库默认分支 `main` 就是 v0.8.18 稳定版源码**；0.9.x 预览代码放在 [`dev-0.9x`](https://github.com/kkkhover/music-game-bpm-measurer/tree/dev-0.9x) 分支和 [tag `v0.9.0`](https://github.com/kkkhover/music-game-bpm-measurer/tree/v0.9.0) 里。

> 🤖 **Vibecoding 项目**：代码大部分由 AI 辅助编写，人工负责需求、审核与验证。
> 使用与二次开发前请知悉：AI 生成的内容可能有疏漏或未覆盖的边界情况；
> 三代上游来源与第三方版权声明已在「[许可与来源](#许可与来源)」完整保留。

---

## 安装与上手

**下载**：Releases → `BPM.Setup.0.8.18.exe`（约 84 MB）→ 双击安装。免安装也简单：安装完成后把程序目录整个拷走即可。

**首次使用五步**：

1. **导入音频**（`Ctrl+O`）：`.mp3 / .ogg / .wav / .m4a / .flac`。
2. **对齐 OFFSET**：右侧「全局起始偏移」填第一拍的时间（秒），所有段的起始时间会跟着整体平移。
3. **分段**：右侧「变速段落」逐条加 BPM + 起始时间；左侧时间轴上可以直接拖红线改位置。
   遇到听不清的鼓点，把**变速播放**降到 35% 左右（不变调），拍点会清楚很多。
4. **核对**：底部显示播放头所在段的 BPM，节拍线与鼓点对齐就说明这段对了。
5. **导出**：顶部「导出」下拉，按目标游戏选格式（见下表）。

> 一首歌里有变速（BPM 变化）也照这个流程走：在变化处再加一段即可，不需要先切成多个文件。

---

## 能做什么

| 能力 | 说明 |
|---|---|
| **波形 + 声谱 + 频谱** | 三条对齐的时间轴视图，配合节拍线判断拍点位置；声谱用来抓鼓点/贝斯的起音 |
| **变速不变调播放** | `0.25x ~ 2.0x` 可调，慢放听细节、音高不变（soundtouchjs） |
| **变速段落（红线）编排** | BPM、拍号（`meter`）、起始时间逐段可编辑；时间轴上可拖动；撤销/重做、缩放、切段 |
| **拍号 / 小节线** | 每段单独设「每小节几拍」，小节线与节拍器重音按拍号分组 |
| **节拍器** | 电子 / 打击 / 柔和三种音色，可设延迟与软件里校准好的拍线对齐 |
| **多游戏导出** | osu!、Malody、Arcaea、Phigros、ADOFAI、vivid-stasis，以及本软件的 JSON 工程 |
| **9 语言界面** | 中文 / English / 日本語 / 한국어 / Français / Deutsch / Español / Русский / Português |
| **osu! 制谱侧栏** | 同一个 exe 内置，贴在 osu! 编辑器旁边用（下面单独讲） |

### v0.8.18 这一版改了什么

- **拖动时间轴不再卡成幻灯片**：总览条拆成「静态波形层 + 动态高亮层」并按列聚合，
  拖动从 **1–2 fps → 110–120 fps**（GPU 光栅化 5961 ms → 12.7 ms）。
- **导入 timing 后也能正常播放**：播放头改成独立合成层、覆盖层参数全等短路、段落卡片 `React.memo`，
  播放 **19.7 fps → 55~61 fps**（120 Hz 前台 115 fps），p99 18.2 ms，零帧超过 20 ms。
- **长曲翻页不再一顿**：频谱兜底路径的 `log10` 改位模式查表，翻页长帧 **126–155 ms → 59–67 ms**。
- **播放中点一下就停在那**：点击频谱/白条直接定位并保持（修掉旧版「点了之后 UI 冻死」）。
- **播放头自动跟随**：白条滑出视口自动跳到下一屏（瞬跳、无动画）；手动滚动会临时关闭。
- 导入音频只需点一次；缩放倍率（`px/s`）支持键盘直接输入数值。

---

## 导出格式

| 出口 | 产物 | 用途 |
|---|---|---|
| JSON 配置 | `.json` | 本软件工程文件，可再导入回来继续改 |
| osu! TimingPoints | `.txt` | `[TimingPoints]` 段（红线 + 绿线），粘进 `.osu` |
| **Malody 谱面包** | `.mcz` | **直接拖进 Malody 即可导入**（音频一起打包，最省事） |
| Arcaea | `.txt` | `.aff` 的 Timing 段 |
| Phigros | `.txt` | `BPMList` |
| ADOFAI（冰与火之舞） | `.txt` | `SetSpeed` actions |
| vivid/stasis | `.txt` | `vschart.json` 的 `timingPoints` |

> **关于 Malody**：`.mc` 里只写音频**文件名**，Malody 只在该谱面文件夹里找同名音频，名字对不上就静默退回
> 约 1 秒的占位音源（表现就是「编辑器里音乐只有几秒钟」）。所以从 v0.8.15 起只保留**谱面包**这一条出口，
> 音频和 `.mc` 一起打包，从根上避免这个问题。

---

## 快捷键

| 按键 | 作用 |
|---|---|
| `Ctrl+O` / `Ctrl+S` | 导入音频 / 导出 JSON 配置 |
| `Ctrl+Z` / `Ctrl+Y`（或 `Ctrl+Shift+Z`） | 撤销 / 重做 |
| `空格` | 播放 / 暂停 |
| `←` / `→` | 前后移动（按住 `Shift` 每次 ±5 秒） |
| `Alt+←` / `Alt+→` | 上一段 / 下一段（移到段起点并居中） |
| `+` / `-` | 时间轴放大 / 缩小 |
| `Shift+滚轮` / `Alt+滚轮` | 粗调 / 精细调频谱缩放（`px/s`） |
| `Delete` | 删除选中的红线 |

---

## osu! 制谱侧栏（osu-maphelper）

贴在 **osu!stable 制谱器**旁边的独立侧栏，和主程序打包在同一个 exe 里：主程序点「**制谱侧栏**」就拉起，
不需要单独安装（本质是同一 exe 带 `--maphelper` 参数启动的第二个进程，互不干扰）。

- **实时频谱 / 声谱 / 波形**，22 种配色，FFT 精度可调，带峰值突出。
- **可拖红线的时间轴**，交互与主程序一致；新增红线严格落在上一条红线的**下一拍**。
- **跟随 osu! 播放位置**（本地外推平滑，消除 tosu 数据 100~150 ms 一跳的顿挫）。
- **定时自动备份**：默认 2 分钟一次、保留 60 份。
- **反降频**：切进游戏全屏也不会掉帧。
- **拍号可读可改**（v0.8.17），上限 7；节拍线延迟可「跟随软件」直接采用主程序校准值。

**前置**：侧栏**不读 osu! 内存**，数据来自本机的 [tosu](https://github.com/tosuapp/tosu)：
`http://127.0.0.1:24050/json/sc`。tosu 没启动就会一直显示「无音频 / 无数据」，这是正常的。

**安全边界**：红线以磁盘上的 `.osu` 为权威来源，拖动/改 BPM 只改内存，导出时写成**新文件**
（`exports\<谱面标识>-<时间>.osu`），**不写回原谱面**，音符和设计一律不动。

---

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 安装时提示「未知发布者」 | 安装包没有代码签名，点「更多信息 → 仍要运行」即可 |
| **Malody 里音乐只有几秒钟** | 用了旧的 `.mc` 出口。请用「Malody 谱面包（`.mcz`）」 |
| 侧栏一直「无音频 / 无数据」 | tosu 没启动、osu! 没在跑，或端口不是 `24050` |
| 内存占用偏高（几百 MB） | 正常：频谱画布大小 = 整曲 × 缩放 × 渲染倍率。想降就调低**渲染倍率**、把 `fftSize` 调到 512 |
| 侧栏内存随时间一直涨 | 是 **tosu 自身**的已知泄漏（约 2.5~3 GB/小时），与本软件无关 |
| 切谱面时卡顿 / 内存暴涨 | v0.8.14 起已修（频谱预计算串行化），请更新到 0.8.18 |
| 导出的 timing 游戏读不了 | JSON 类导出本身不带注释；若手工编辑过，注意别加 `//` |
| 拖动/缩放很卡 | 请确认用的是 **v0.8.18**（v0.8.17 及更早版本拖动只有 1~2 fps） |

**数据存放**（放 `%APPDATA%` 而不是安装目录，升级/重装不会丢备份）：

| 内容 | 位置 |
|---|---|
| 主程序设置 | `%APPDATA%\bpm-measurer-util\` |
| 侧栏配置 + 定时备份 | `%APPDATA%\bpm-measurer-util\maphelper\` |
| 侧栏导出的 timing | 侧栏数据根目录下的 `exports\`（可在侧栏设置里改） |

---

## 从源码构建

```bash
cd Bpm-Measurer-Util-release-v0.1.0/Bpm-Measurer-Util-release-v0.1.0
npm ci                  # 严格按 package-lock 安装
npm run electron:build  # 同步侧栏 + 编译 + 打包（NSIS 安装包 / 免安装目录）
```

- 只依赖 **Node.js ≥ 20**；不需要 ffmpeg、Python、VC++ 运行库等系统级前置。
- 打包输出目录在 `package.json` 的 `build.directories.output`，换机器前改成自己的路径。
- 侧栏源码（`osu-maphelper_v0.8.17/`）**零第三方运行时依赖**，只用 Node 内置模块 + 浏览器原生 API。
- 国内网络建议先设 npm / electron 镜像（见 [`依赖库与原理.md`](依赖库与原理.md)）。

**仓库结构**

```
Bpm-Measurer-Util-release-v0.1.0/Bpm-Measurer-Util-release-v0.1.0/   主程序源码（Electron + React + TypeScript）
osu-maphelper_v0.8.17/                                               osu! 制谱侧栏源码
音游Timing转换脚本/                                                   各音游 timing 互转的脚本
依赖库与原理.md                                                       依赖清单（含许可证）+ 实现原理
```

---

## 许可与来源

本项目是**衍生作品**，三代来源均以 **Apache License 2.0** 发布，版权与许可一律保留。
许可全文见 [`LICENSE`](LICENSE)，逐条版权声明见 [`NOTICE`](NOTICE)。

| 项目 | 作者 | 链接 |
|---|---|---|
| Bpm-Measurer（原始项目） | CMYC4237（B 站 @CMYC_4237） | https://github.com/CMYC4237/Bpm-Measurer |
| Bpm-Measurer-Util（Electron 打包版） | iExploder | https://github.com/iExploder/Bpm-Measurer-Util |
| music-game-bpm-measurer（本仓库） | kkkhover | https://github.com/kkkhover/music-game-bpm-measurer |

原项目说明：*「这是一个 BPM 测量器，用于手工精确测量歌曲的 BPM，来用于你的音乐游戏关卡中。可以测量存在变速的歌曲。」*
原项目讲解视频：[BV1n9XPB7Eyb](https://www.bilibili.com/video/BV1n9XPB7Eyb)。

**本仓库新增内容**（同样 Apache-2.0）：osu! 制谱侧栏、9 语言界面、频谱/声谱与内存优化、
多游戏 timing 导出、性能重构（0.8.18）。

### 第三方组件

| 组件 | 许可证 |
|---|---|
| Electron、React、Vite、electron-builder 等 | MIT |
| lucide-react | ISC |
| TypeScript | Apache-2.0 |
| soundtouchjs（变速不变调） | LGPL-2.1（依赖形式引用，未改源码） |

> 第三方组件许可与本产品许可相互独立，各自按其条款执行。完整清单见 [`依赖库与原理.md`](依赖库与原理.md)。

### 其他致谢

- [tosu](https://github.com/tosuapp/tosu)：侧栏的 osu! 实时数据来源（第三方，非本软件组件）。
- [Jakads/malody2osu](https://github.com/Jakads/malody2osu)：Malody → osu! 转换参考。

### 预览版（0.9.x）的版式参考

**仅 0.9.0 及以后的预览版涉及**，0.8.18 不含相关代码：谱面预览的视觉规范参考
[fengpengGG/om_Beatmap_Preview_Generator](https://github.com/fengpengGG/om_Beatmap_Preview_Generator)，
皮肤渲染方案参考 [fengpengGG/OsuSkinMaker_New](https://github.com/fengpengGG/OsuSkinMaker_New)
（`skin.ini [Mania]` 多段匹配、@2x 优先级、x480 坐标系、图层顺序）。

> ⚠️ 这两个参考项目仓库根目录**均无 LICENSE**（默认保留所有权利）。因此本软件**没有复制、内嵌或改编**其
> Python / Rust / JavaScript 源码，也未打包其运行时依赖（Python、Pillow、moviepy、ffmpeg、Tauri 等）；
> 预览渲染器是本仓库独立编写的 TypeScript + Canvas 2D 实现，此处仅借用配色 / 版式 / 公式并致谢。
> 皮肤素材完全由用户自行导入，本软件只读、不写回皮肤目录。

---

## 相关文档

| 文件 | 内容 |
|---|---|
| [`LICENSE`](LICENSE) | Apache License 2.0 全文 |
| [`NOTICE`](NOTICE) | 三代上游版权声明与许可条款（不可移除） |
| [`依赖库与原理.md`](依赖库与原理.md) | 依赖库清单（含许可证）+ 关键功能实现原理 |
| [`osu-maphelper_v0.8.17/README.md`](osu-maphelper_v0.8.17/README.md) | 制谱侧栏设计与实现细节 |
| [`音游Timing转换脚本/README.md`](音游Timing转换脚本/README.md) | 各音游 timing 转换脚本用法 |
| [Releases](https://github.com/kkkhover/music-game-bpm-measurer/releases) | 安装包与历代更新日志（`更新日志.md` 随 Release 发布，不入仓库） |
