# BPM 测速助手 · 使用说明（README）

> Vibe-Coding项目
> 面向**使用者**。想改代码请看文末「从源码构建」。
> 版本：**主程序 v0.8.17** / 内置侧栏 **v0.8.17**（两侧版本号各自独立）

---

## 致谢与许可

> **本项目是衍生作品**，并非从零原创。原始作者与上游作者的**版权与许可一律保留**。

本项目源自 **@CMYC_4237** 的开源项目；**@iExploder** 将其打包成 Electron 版并构建了 release；
本仓库在二者之上继续开发与扩展。

| 层 | 项目 · 作者 | 链接 | 许可 |
|---|---|---|---|
| ① 原项目 | **Bpm-Measurer** · CMYC4237（B 站 **@CMYC_4237**） | https://github.com/CMYC4237/Bpm-Measurer | Apache-2.0 |
| ① 讲解视频 | **BV1n9XPB7Eyb** | https://www.bilibili.com/video/BV1n9XPB7Eyb | — |
| ② Electron 打包版 | **Bpm-Measurer-Util** · **iExploder** | https://github.com/iExploder/Bpm-Measurer-Util | Apache-2.0 |
| ③ 本仓库 | **music-game-bpm-measurer** · kkkhover | https://github.com/kkkhover/music-game-bpm-measurer | Apache-2.0 |

- **许可：Apache License 2.0**（继承上游，**不是 MIT**）。许可全文见 [`LICENSE`](LICENSE)；
  三代来源与版权声明见 [`NOTICE`](NOTICE)。
- 上游原项目的自述：*"这是一个 BPM 测量器，用于手工精确测量歌曲的 BPM，来用于你的音乐游戏关卡中。可以测量存在变速的歌曲。"*
- 本仓库在两位上游作者工作之上新增的部分：osu! 制谱侧栏（`osu-maphelper_v*/`）、9 语言界面、
  频谱/声谱与内存优化、多游戏 timing 导出等。
- 侧栏的 osu! 实时数据来自 **[tosu](https://github.com/tosuapp/tosu)**（第三方，非本软件组件）。
- Malody → osu! 的谱面转换参考 **[Jakads/malody2osu](https://github.com/Jakads/malody2osu)**。
- 随包使用的第三方库各自遵循其许可证，详见 `依赖库与原理.md`。

---

## 0. 关于这个仓库

**本仓库包含源码 + `LICENSE` + 这份 README + `依赖库与原理.md`**。
下面这些请到 **[Releases](https://github.com/kkkhover/music-game-bpm-measurer/releases)** 下载：

- 🡒 **安装包** `BPM 测速助手 Setup 0.8.17.exe`（免安装版请下载后解压）
- 🡒 **更新日志.md**（历代版本的问题 / 修复 / 新增）

**仓库目录结构**

```
Bpm-Measurer-Util-release-v0.1.0/
└─ Bpm-Measurer-Util-release-v0.1.0/     主程序源码（Electron + React + TypeScript）
osu-maphelper_v0.8.17/                    osu! 制谱侧栏源码（零第三方运行时依赖）
音游Timing转换脚本/                        各音游 timing 格式互转的 Python 脚本
依赖库与原理.md                            依赖清单（含许可证）+ 实现原理
```

> ⚠️ 本文第 2 节与第 8 节的路径是按**交付压缩包**的目录结构写的
> （那里分 `软件\` 和 `源码\{主程序,侧栏}\` 两层）；本仓库里**没有**这两层。

---

## 1. 这是什么

一个帮你在**音乐游戏里做出准确 timing** 的桌面工具。核心用途：

1. 导入一首歌 → 看**波形 + 声谱**，听、对着节拍线找 BPM 变化点；
2. 一段一段地记录「BPM + 起始时间 + 拍号」（软件里叫**变速段落**，也就是谱面里的**红线**）；
3. 一键导出成各游戏/制谱器能直接用的 timing 文件。

它由两部分组成，**打包在同一个 exe 里**：

| 部分 | 作用 |
|---|---|
| **主程序**（BPM 测速助手） | 导入音频、测速、编排变速段落、导出 timing |
| **制谱侧栏**（osu-maphelper） | 做 osu! 谱面时贴在编辑器旁边：实时频谱/声谱、可拖的红线时间轴、跟随 osu! 播放位置、定时备份 |

侧栏**不需要单独安装**：主程序里点「制谱侧栏」就能拉起。

---

## 2. 本交付包里有什么

```
bpm app v0.8.17\
├─ README.md                ← 本文件（使用说明）
├─ 更新日志.md               ← 历代版本的问题 / 修复 / 新增
├─ 依赖库与原理.md            ← 用了哪些库、关键功能的实现原理
│
├─ 软件\
│   ├─ BPM 测速助手 Setup 0.8.17.exe   ← 安装包（可选安装目录、建快捷方式）
│   └─ win-unpacked\                   ← 免安装版：整个文件夹拷走，双击 "BPM 测速助手.exe"
│
└─ 源码\
    ├─ 主程序\                ← Electron + React + TypeScript 源码（**不含 node_modules**，见第 8 节）
    └─ 侧栏\                  ← 侧栏单独源码（零第三方运行时依赖，无需安装依赖）
```

> 两台机器之间传发：**不确定对方环境就用 `win-unpacked`**（解压即用、不写注册表）；
> 想要开始菜单/桌面图标就用安装包。

---

## 3. 运行环境

- Windows 10 / 11（64 位）
- 免安装版**不需要**装 Node.js、不需要联网
- 侧栏要实时跟随 osu!，需要本机跑着 **[tosu](https://github.com/tosuapp/tosu)**（见第 5 节）

---

## 4. 主程序怎么用

### 4.1 界面构成

| 区域 | 说明 |
|---|---|
| 顶部工具条 | 「导入音频」、「制谱侧栏」、音量、**变速播放**（听慢速不改音高）、设置、帮助、当前播放时间、导出 |
| 主可视区 | 上方**波形**、下方**声谱**；叠着竖线：**红线**（BPM 变化点）、**绿线**（变速/节拍）、**拍线** |
| 底部播放条 | 播放/暂停、当前 BPM、缩放（像素/秒） |
| 右侧「配置面板」 | 全局起始偏移 **OFFSET**、导出按钮、**变速段落列表**（索引号 / BPM / 起始时间） |

### 4.2 标准流程

1. **导入音频**（顶部按钮，或 `Ctrl+O`）——支持的音频由 Chromium 解码器决定，`.mp3 / .ogg / .wav / .m4a / .flac` 都行。
2. **对齐 OFFSET**：在「全局起始偏移」里填/微调这首歌的第一拍时间（秒）。右侧的「起始时间」会跟着整体平移。
3. **逐段编排**：
   - 在右侧「变速段落」里添加/编辑每一项（**BPM**、**拍号/索引号 BEAT**、**起始时间**）；
   - 左边时间轴上可以直接**拖动红线**改位置；波形/声谱用来判断"这一拍到底在哪"；
   - 变速播放（把速度降到 35% 左右）能明显提高找拍的准确度。
4. **核对**：底部显示**播放头所在段落**的 BPM；节拍线与实际鼓点对齐即说明该段正确。
5. **导出**（见 4.3）。

### 4.3 导出

点顶部「导出 JSON 配置」旁的下拉箭头，得到两类出口：

**A. 通用**
| 项 | 产物 | 用途 |
|---|---|---|
| 导出 JSON 配置 | `.json` | 本软件自己的工程配置（可再导入回来） |
| 导出 osu! TimingPoints | `.txt` | `[TimingPoints]` 段（红线 + 绿线），复制进 `.osu` |

**B. 其他音游**
| 项 | 产物 | 用途 |
|---|---|---|
| **Malody 谱面包（含音频）** | `.mcz` | **直接拖进 Malody 即可导入**（含音频，最省事） |
| Arcaea 自制谱 | `.txt` | `.aff` 的 Timing 段 |
| Phigros 自制谱 | `.txt` | `BPMList` |
| ADOFAI（冰与火之舞） | `.txt` | `SetSpeed` actions |
| vivid/stasis | `.txt` | `vschart.json` 的 timingPoints |

> **关于 Malody**：v0.8.15 起只保留「**谱面包**」这一条出口。
> 原因是 `.mc` 里只写音频的**文件名**，Malody 只在**该谱面文件夹里**找同名音频；
> 名字对不上它会静默退回约 1 秒的占位音源 —— 表现就是"**编辑器里音乐只有几秒钟**"。
> 谱面包把音频一起打包（包内音频名与 `.mc` 里的 `sound` 必然一致），从根上避免这个问题。
> 用法：导出后把 `.mcz` **直接拖进 Malody 窗口**即可。

### 4.4 快捷键（主程序）

| 按键 | 作用 |
|---|---|
| `Ctrl+O` | 导入音频 |
| `Ctrl+S` | 导出 JSON 配置 |
| `Ctrl+Z` | 撤销 |
| `Ctrl+Y` / `Ctrl+Shift+Z` | 重做 |
| `空格` | 播放 / 暂停 |
| `←` / `→` | 前后移动（按住 `Shift` 每次 ±5 秒） |
| `Alt+←` / `Alt+→` | 切到**上一段 / 下一段**（播放头移到段起点并居中，到头即停） |
| `+` / `-` | 时间轴放大 / 缩小 |
| `滚轮` | 横向滚动（按住 `Shift` 竖向） |
| `Shift+滚轮` | **粗调**频谱 px/s（每格 ×1.1），以光标位置为锚点 |
| `Alt+滚轮` | **精细**调频谱 px/s（每格 ±3%），用来在"看清某一拍"和"看全整段"之间微调 |
| `Delete` | 删除选中的红线 |

### 4.5 设置项（顶部齿轮）

- **主题配色**：预设主题、自定义颜色、强调色、背景/面板底色、波形色、频谱配色、峰值色
- **频谱**：FFT 精度（512 ~ 8192）、灵敏度、调色板（含自定义三段色）、对数频率刻度、反相、峰值阈值与颜色
- **节拍线延迟**：让节拍线与实际声音对齐（可设为「跟随软件」，直接采用测速助手里校准好的值）
- **拍号（meter）**（v0.8.17）：每个变速段落可设置「每小节几拍」（4 = 4/4、3 = 3/4），决定小节线与节拍器重音分组
- **渲染倍率**：画面清晰度 / 显存的取舍（调低可显著省内存）
- **节拍器音色**：电子 / 打击 / 柔和（可预览）
- **语言**：中文 / English / 日本語 / 한국어 等
- **重置**：恢复默认设置

---

## 5. 制谱侧栏怎么用

### 5.1 前置：跑起 tosu

侧栏**自己不读 osu! 内存**，而是向本机的 **tosu** 要数据：

```
GET http://127.0.0.1:24050/json/sc
```

所以使用前请先启动 tosu（默认端口 `24050`），并确认 osu! 正在运行、tosu 界面能看到当前谱面。
**tosu 没开 → 侧栏会一直显示"无音频/无数据"，这是正常的。**

### 5.2 打开方式

主程序里点「**制谱侧栏**」。它其实是同一个 exe 用 `--maphelper` 参数启动的第二个进程，
两者互不干扰。

### 5.3 面板

| 面板 | 内容 |
|---|---|
| **频谱（viz）** | 实时频谱 + 声谱 + 波形；时间轴上可**拖红线**；显示 osu! 播放位置（平滑跟随） |
| **map** | 当前谱面信息 |
| **backup** | 定时备份（把谱面文件夹里的 `.osu` 定期复制一份） |
| **settings** | 侧栏自己的设置（配色、缩放、轮询、面板位置…） |
| **log** | 运行日志 |

### 5.4 导出 timing（侧栏）

侧栏改完红线后，用 **`POST /api/timing/export`** 导出：

- 产物落在**数据根目录**下的 `exports\<谱面标识>-<年-月-日-时-分-秒>.osu`；
- **不会写回原谱面文件**（安全，不会污染你的谱面）；
- 导出采用 **merge 模式**：红线整体替换 + **每条红线后跟一条绿线**，绿线倍速 = **基准 BPM ÷ 当前 BPM**，
  这样 BPM 变化时下落流速保持恒定；
- 添加红线时，新红线严格落在「上一条红线的**下一拍**」。

### 5.5 快捷键（侧栏）

| 按键 | 作用 |
|---|---|
| `Ctrl+Z` / `Ctrl+Shift+Z` · `Ctrl+Y` | 撤销 / 重做 |
| `空格` | 播放 / 暂停预览 |
| `←` / `→` | 前后移动（按住 `Shift` 每次 ±5 秒） |
| `+` / `-` | 缩放 |
| `Ctrl+O` | 重新载入音频 |
| `Ctrl+S` | 导出 timing |
| `Delete` | 删除选中的红线 |
| `Alt+←` / `Alt+→` | 上一个 / 下一个面板 |

### 5.6 侧栏的语言（v0.8.17）

侧栏的 **settings** 面板底部有「**语言 / Language**」：

- 默认**跟随软件** —— 直接采用你在 BPM 测速助手里选的语言（中 / 英 / 日 / 韩 / 法 / 德 / 西 / 俄 / 葡）；
- 取消勾选后可**单独为侧栏**指定语言；
- 在测速助手里刚改完语言，点一下旁边的「**⟳ 重新读取**」立即生效（不点的话下一轮轮询也会跟上）。

侧栏与主程序是两个独立进程、各有各的配置目录，所以语言是靠主进程去读测速助手的设置来同步的。

---

## 6. 数据文件放在哪

| 内容 | 位置 |
|---|---|
| 主程序设置 | `%APPDATA%\bpm-measurer-util\` |
| 侧栏配置 + 定时备份 | `%APPDATA%\bpm-measurer-util\maphelper\` |
| 侧栏导出的 timing | 侧栏数据根 `exports\` 目录（可在侧栏设置里改） |

> 放在 `%APPDATA%` 而不是安装目录，是为了**升级/重装不会把你的备份删掉**。

---

## 7. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| **界面样式全丢**（排版垮掉、颜色没了） | v0.8.11 已修（Tailwind 改成本地随包发布）。若用的是旧版，请更新 |
| **Malody 里音乐只有几秒钟** | 导出的 `.mc` 与谱面文件夹里的音频**不同名**。v0.8.15 起请用「**Malody 谱面包**」导出 |
| **切谱面时内存涨到几个 G / 卡顿** | v0.8.14 已修（频谱预计算串行化）。建议更新到这个版本 |
| 侧栏一直"无音频 / 无数据" | tosu 没启动、或 osu! 没在跑、或端口被改过 |
| 侧栏切进游戏全屏后掉帧 | v0.8.6 起已有**反降频**措施（禁系统遮挡检测/唤醒节流 + 优先 + 渲染心跳） |
| 跟随 osu! 播放头一顿一顿 | v0.8.7 起已改为**本地外推平滑**（真因是 tosu 数据 100~150ms 一跳，不是帧率） |
| 内存占用偏高 | 频谱面板本身是"整曲 × 缩放 × 渲染倍率"的画布，**固定占几百 MB 属正常**；想降：调低**渲染倍率**、把 `fftSize` 调到 512、调大侧栏轮询间隔 |
| 侧栏内存随时间一直涨 | 那是 **tosu 自身**的已知泄漏（约 2.5~3 GB/小时），与切谱面无关；本软件未做规避 |
| 导出的 timing 文件带注释导致游戏读不了 | JSON 类导出从来不带注释头；若你自己编辑过，注意别加 `//` |
| 旧 Malody 谱面打不开 | 旧格式（`beat` 全是 `[n,0,1]` 整数）仍可正常导入，向后兼容 |

---

## 8. 从源码构建

> ### ★ 拿到这份源码的人先看这里
>
> **这份源码不带 `node_modules`**（第三方依赖目录，单独就有 800 多 MB，
> 其中大部分是 Electron 预编译运行时和**只有打包才用得到、还分平台**的工具链）。
> 依赖清单在 `package.json` + `package-lock.json` 里，装回来是**版本可精确复现**的：
>
> ```bash
> cd 源码/主程序
> npm ci                     # 严格按 package-lock.json 安装（想宽松些用 npm install）
> ```
>
> **前提条件**
>
> | 项 | 要求 |
> |---|---|
> | 操作系统 | Windows 10/11 64 位（依赖里含 Windows 版原生二进制；mac/Linux 也能装，但要重新装依赖） |
> | Node.js | **≥ 20**（`electron` 34 与 `vite` 6 的要求） |
> | 网络 | 首次安装需要能访问 npm 源 |
>
> **国内网络注意**（`electron` 装包和打包时都要从境外下载大文件，容易失败，建议先设镜像）：
>
> ```bash
> # 包源
> npm config set registry https://registry.npmmirror.com
> # electron 预编译运行时（约 270MB）
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> # electron-builder 首次打包要下载 winCodeSign / nsis 资源
> set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```
>
> **★ 必须改一处配置**：`package.json` 里
> `build.directories.output` 是**写死的绝对路径**（指向原作者机器上的目录）。
> 换机器/换人之前请把它改成你自己的输出目录，否则打包会写到你没有的盘或直接报错。
>
> 侧栏源码**零第三方依赖**，不需要 `npm install`，直接 `node scripts/launch.mjs` 即可跑。

### 8.1 主程序

```bash
cd 源码/主程序
npm ci                            # 先装依赖（本包不含 node_modules，见上方「先看这里」）
npm run build                     # tsc(electron) + tsc(preload) + vite build
npm run sync:maphelper            # 把 侧栏源码 同步成 maphelper/（生成物，勿手改）
npx electron-builder --win        # 打包；输出目录见 package.json 的 build.directories.output
```

一行等价写法：`npm run electron:build`（= 同步侧栏 + 构建 + 打包）。

开发时：`npm run electron:dev`。

**注意**：`build.directories.output` 是**写死的绝对路径**，换机器/换版本要手工改，
否则会跟已占用的旧 exe 冲突（`Access is denied`）。

### 8.2 侧栏

侧栏是**普通 Node + 浏览器 API**，没有打包步骤：

```bash
cd 源码/侧栏
node scripts/launch.mjs            # 启动（开发）
node scripts/launch.mjs --screenshot
node tests/selftest.mjs            # 自测
node tests/ui_contract.mjs         # UI 契约测试
```

侧栏有独立的版本目录（`osu-maphelper_v<版本>`）。**主程序打包时会自动挑版本号最高的那个**，
所以侧栏改完后要重新 `sync:maphelper` 再打包。

### 8.3 源码树怎么读

```
主程序\
├─ boot.cjs              ★ 双模式入口：默认主程序，带 --maphelper 走侧栏
├─ main.ts                Electron 主进程（窗口、IPC、文件、mcz 打包）
├─ preload.cts            contextBridge 桥接（编译成 preload.cjs）
├─ App.tsx                主界面（导入/播放/红线编辑/导出）
├─ components/            Visualizer（波形+声谱）、SettingsModal、OverviewBar…
├─ utils/                 音频、timing、导出、i18n、设置、频谱预计算
├─ public/tailwind-play.js 本地 Tailwind（离线可用的关键）
├─ maphelper/             ← 同步生成的侧栏副本（勿手改）
└─ dist/ dist-electron/   构建产物

侧栏\
├─ electron/main.cjs      主进程（多窗口、app:// 协议、窗口 API 拦截）
├─ src/                   业务逻辑（core / router / config / bpmSettings…）
├─ renderer/              界面（viz.js 频谱引擎、viz-panel.js 面板、各面板）
├─ scripts/sync-maphelper 的源目录就是它
└─ tests/                 自测与 UI 契约测试
```

---

## 9. 相关文档

| 文件 | 内容 |
|---|---|
| `LICENSE` | Apache License 2.0 全文 |
| `NOTICE` | **来源与版权声明**（三代作者 · 第三方组件） |
| `更新日志.md` | 历代版本**提出的问题 / 修复 / 新增**（含总表） |
| `依赖库与原理.md` | 依赖库清单（含许可证）+ 关键功能实现原理 |
| `源码/主程序/README.md` | 主程序源码侧说明（构建、打包、双模式入口细节） |
| `源码/侧栏/README.md` | 侧栏源码侧说明 |
