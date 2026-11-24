<div align="center">

# 🎵 BPM 测速助手 · 0.8.19

**给音乐游戏做准确 timing 的桌面工具**

导入一首歌或一张谱面 → 波形 + 声谱 + 频谱找拍 → 一段段记录「BPM + 起始时间」→
导出 osu! / Malody / Arcaea / Phigros / ADOFAI / vivid-stasis 能直接用的 timing 文件

Windows 10 / 11 64 位 ｜ 离线可用 ｜ 无需 Node.js

</div>

---

## 下载

[**⬇ BPM.Setup.0.8.19.exe**](https://github.com/kkkhover/music-game-bpm-measurer/releases/download/v0.8.19/BPM.Setup.0.8.19.exe)（约 81 MB，Windows 64 位）

所有版本见 [Releases](https://github.com/kkkhover/music-game-bpm-measurer/releases)。
0.9.x 预览版的说明见 [README-0.9.x.md](README-0.9.x.md)。

---

## 目录

1. [来源与许可](#1-来源与许可)
2. [安装与上手](#2-安装与上手)
3. [软件功能](#3-软件功能)
4. [常见问题](#4-常见问题)
5. [从源码构建](#5-从源码构建)
6. [osu! 制谱侧栏](#6-osu-制谱侧栏osu-maphelper)

---

## 1 来源与许可

本项目是衍生作品，三代来源均以 **Apache License 2.0** 发布，版权与许可全部保留。
许可全文见 [`LICENSE`](LICENSE)，逐条声明见 [`NOTICE`](NOTICE)。

| 项目 | 作者 | 链接 |
|---|---|---|
| Bpm-Measurer（原始项目） | CMYC4237（B 站 @CMYC_4237） | https://github.com/CMYC4237/Bpm-Measurer |
| Bpm-Measurer-Util（Electron 打包版） | iExploder | https://github.com/iExploder/Bpm-Measurer-Util |
| music-game-bpm-measurer（本仓库） | kkkhover | https://github.com/kkkhover/music-game-bpm-measurer |

原项目说明：「这是一个 BPM 测量器，用于手工精确测量歌曲的 BPM，来用于你的音乐游戏关卡中。可以测量存在变速的歌曲。」
原项目讲解视频：[BV1n9XPB7Eyb](https://www.bilibili.com/video/BV1n9XPB7Eyb)。

本仓库新增内容（同样 Apache-2.0）：osu! 制谱侧栏、9 语言界面、频谱 / 声谱渲染与内存优化、
多游戏 timing 导出、谱面与 `.osz` 导入。

**第三方组件**

| 组件 | 许可证 |
|---|---|
| Electron、React、Vite、electron-builder | MIT |
| lucide-react | ISC |
| TypeScript | Apache-2.0 |

完整依赖清单见 [`依赖库与原理.md`](依赖库与原理.md)。

**致谢**：[tosu](https://github.com/tosuapp/tosu)（侧栏的 osu! 实时数据来源，第三方，非本软件组件）、
[Jakads/malody2osu](https://github.com/Jakads/malody2osu)（Malody → osu! 转换参考）。

> 本项目大部分代码由 AI 辅助编写，人工负责需求、审核与验证。使用与二次开发前请知悉此点。

---

## 2 安装与上手

**安装**：下载 `BPM.Setup.0.8.19.exe` → 双击运行。安装包未做代码签名，Windows 提示「未知发布者」时选「更多信息 → 仍要运行」。
装完把程序目录整个拷走即为免安装版。

**五步上手**

1. **导入**（`Ctrl+O`）：可直接选音频（`.mp3 / .ogg / .wav / .m4a / .flac`）、`.osz` 谱面包或 `.osu` 文件；
   也可以点导入按钮右侧的箭头选「导入谱面文件夹」。导入谱面时，其中的 timing 会一并读入。
2. **对齐 OFFSET**：随机选一个已有铺面导入，按自己的习惯调整右侧「全局起始偏移」（第一拍的时间，秒），
   所有段的起始时间会跟着整体平移。
3. **分段**：右侧「变速段落」逐条加 BPM + 起始时间；时间轴上可以直接拖红线改位置。
   听不清鼓点时把**变速播放**降到 35% 左右，拍点会清楚很多。
4. **核对**：底部显示播放头所在段的 BPM 与当前流速，节拍线与鼓点对齐就说明这段对了。
5. **导出**：右侧「导出 osu! timing」或「复制 timing」拿到纯 `[TimingPoints]` 文本，
   粘进谱面替换后，**进游戏实际核对一次初始延迟**，再按结果微调 OFFSET 重新导出。

> 一首歌里有变速也走同一流程：在变化处再加一段即可，不需要先切成多个文件。

---

## 3 软件功能

| 能力 | 说明 |
|---|---|
| **波形 + 声谱 + 频谱** | 三条对齐的时间轴视图；声谱用来抓鼓点 / 贝斯的起音，节拍线用来确认拍点 |
| **变速播放** | `0.25x – 2.0x`，慢放听细节 |
| **变速段落（红线）编排** | BPM、拍号、起始时间逐段可编辑，时间轴上可拖动；撤销 / 重做、缩放、切段 |
| **拍号 / 小节线** | 每段单独设置每小节几拍，节拍器重音按拍号分组 |
| **节拍器** | 电子 / 打击 / 柔和三种音色，可设延迟，与校准好的拍线对齐 |
| **谱面导入** | `.osz`、`.osu`、谱面文件夹；一张包里有多个 `.osu` 时在「谱面难度」抽屉里切换，各难度引用的音频会一起换 |
| **多游戏导出** | osu! timingpoints、Malody 谱面包（`.mcz`）、Arcaea、Phigros、ADOFAI、vivid/stasis |
| **快速取用 timing** | 「复制 timing」直接进剪贴板；「导入 timing 文件」把已有 `[TimingPoints]` 读回来继续改 |
| **9 语言界面** | 中文 / English / 日本語 / 한국어 / Français / Deutsch / Español / Русский / Português |
| **osu! 制谱侧栏** | 同一 exe 内置，贴在 osu! 编辑器旁边用（见[第 6 节](#6-osu-制谱侧栏osu-maphelper)） |

**导出格式**

| 出口 | 产物 | 用途 |
|---|---|---|
| osu! timingpoints | 纯文本（剪贴板 / `.txt`） | `[TimingPoints]` 段正文，可整段覆盖谱面同名段落 |
| Malody 谱面包 | `.mcz` | 直接拖进 Malody 导入，音频一起打包 |
| Arcaea | `.txt` | `.aff` 的 Timing 段 |
| Phigros | `.txt` | `BPMList` |
| ADOFAI（冰与火之舞） | `.txt` | `SetSpeed` actions |
| vivid/stasis | `.txt` | `vschart.json` 的 `timingPoints` |

**快捷键**

| 按键 | 作用 |
|---|---|
| `Ctrl+O` / `Ctrl+S` | 导入 / 导出 osu! timing |
| `Ctrl+Z` / `Ctrl+Y`（或 `Ctrl+Shift+Z`） | 撤销 / 重做 |
| `空格` | 播放 / 暂停 |
| `←` / `→` | 前后移动（按住 `Shift` 每次 ±5 秒） |
| `Alt+←` / `Alt+→` | 上一段 / 下一段 |
| `+` / `-` | 时间轴放大 / 缩小 |
| `Delete` | 删除选中的红线 |

**鼠标 / 触控板**

| 操作 | 作用 |
|---|---|
| 滚轮 / `Shift+滚轮` / `Alt+滚轮` | 横向滚动 / 粗调 / 精细调节频谱缩放 |
| 触控板双指张开 / 捏合 | 放大 / 缩小显示范围；两指左右滑动仍为横向滚动 |
| 双击频谱节拍线 | 吸附到该拍位置；空白处双击不跳转 |
| 双击变速段落卡片 | 播放头、时间码、频谱一起跳到该段起点 |
| 左下角时间码 | 点击输入秒数后回车跳转 |

---

## 4 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 安装时提示「未知发布者」 | 安装包无代码签名，点「更多信息 → 仍要运行」 |
| **Malody 里音乐只有几秒钟** | 用了旧的 `.mc` 出口，请用「Malody 谱面包（`.mcz`）」 |
| 导入 `.osz` 后没有音频 | 包内音频文件名与 `AudioFilename` 不一致，可先把包解压再选文件夹导入 |
| 导出的 timing 游戏里对不上 | 先确认 OFFSET；导出后进游戏核对初始延迟再微调 |
| 声谱峰值与节拍线对不齐 | 频谱与波形**永远按音乐真实时间渲染**（FFT 列按窗心对齐，不再整体晚一个 hop）。剩下的偏差大多是谱面自身的：鼓点从起振到最亮约 4~9ms，红线标的是起振不是峰值。要让红线压最亮处，用「红线延迟」调（正=红线右移） |
| 节拍器比播放头压线更早 / 更晚响 | 设备输出延迟由 `getOutputTimestamp()` 实测自动补偿（多口径交叉校验，防过时读数），设置里能看到「实测输出延迟 xx ms」。若你的设备上报不准（蓝牙耳机、虚拟声卡），用「同步微调」一次校准：**更早响就加大，更晚响就减小**。它只改「画面 ↔ 声音」，红线与频谱的相对位置不受影响 |
| 制谱侧栏一直「无音频 / 无数据」 | tosu 没启动、osu! 没运行，或端口不是 `24050` |
| 内存占用偏高（几百 MB） | 正常：频谱画布大小 = 整曲 × 缩放 × 渲染倍率。调低渲染倍率、把 `fftSize` 设为 512 可降 |
| 侧栏内存随时间持续上涨 | 是 tosu 自身的已知泄漏（约 2.5–3 GB/小时），与本软件无关 |
| 拖动 / 缩放很卡 | 确认版本为 0.8.18 及以上 |

**数据存放**（放在 `%APPDATA%`，升级 / 重装不会丢）

| 内容 | 位置 |
|---|---|
| 主程序设置 | `%APPDATA%\bpm-measurer-util\` |
| 侧栏配置 + 定时备份 | `%APPDATA%\bpm-measurer-util\maphelper\` |
| 侧栏导出的 timing | 侧栏数据根目录下的 `exports\`（可在侧栏设置里改） |

---

## 5 从源码构建

```bash
cd Bpm-Measurer-0.8.19
npm ci                  # 严格按 package-lock 安装
npm run electron:build  # 同步侧栏 + 编译 + 打包（NSIS 安装包 / 免安装目录）
```

- 只依赖 **Node.js ≥ 20**，不需要 ffmpeg、Python、VC++ 运行库等系统级前置。
- 打包输出目录在 `package.json` 的 `build.directories.output`，换机器前改成自己的路径。
- 国内网络建议先设置 npm / electron 镜像，见 [`依赖库与原理.md`](依赖库与原理.md)。

**仓库结构**

```
Bpm-Measurer-0.8.19/    主程序源码（Electron + React + TypeScript）
osu-maphelper_v0.8.17/  osu! 制谱侧栏源码
音游Timing转换脚本/      各音游 timing 互转脚本
依赖库与原理.md          依赖清单（含许可证）与实现原理
```

---

## 6 osu! 制谱侧栏（osu-maphelper）

贴在 **osu!stable 制谱器**旁边的独立侧栏，与主程序打包在同一个 exe 里：主程序点「制谱侧栏」即可拉起，
不需要单独安装（同一 exe 带 `--maphelper` 参数启动的第二个进程，互不干扰）。

- **实时频谱 / 声谱 / 波形**，22 种配色，FFT 精度可调，带峰值突出。
- **可拖红线的时间轴**，交互与主程序一致；新增红线严格落在上一条红线的下一拍。
- **跟随 osu! 播放位置**（本地外推平滑，消除 tosu 数据 100–150 ms 一跳的顿挫）。
- **定时自动备份**：默认 2 分钟一次、保留 60 份。
- **反降频**：切进游戏全屏也不掉帧。
- **拍号可读可改**，上限 7。

**前置**：侧栏不读 osu! 内存，数据来自本机的 [tosu](https://github.com/tosuapp/tosu)：
`http://127.0.0.1:24050/json/sc`。tosu 未启动时会一直显示「无音频 / 无数据」。

**安全边界**：红线以磁盘上的 `.osu` 为权威来源，拖动 / 改 BPM 只改内存，导出时写成新文件
（`exports\<谱面标识>-<时间>.osu`），不写回原谱面，音符与设计一律不动。
