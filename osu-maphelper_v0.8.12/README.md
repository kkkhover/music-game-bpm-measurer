# osu! 制谱侧栏（osu-maphelper）

贴在 **osu!stable 制谱器**旁边的独立侧栏模块（v0.8.5 多窗口版）：

- **主窗口 + 功能区块独立窗口** —— 主窗口精简（状态 + 播放位置 + 入口按钮），
  **频谱声谱 + 变速段落（合并窗口）**、谱面信息、自动备份、设置、日志各自是**独立小窗口**，可同时摆开
- **每个窗口可置顶** —— 标题栏 📌 按钮切换；位置/尺寸/置顶状态自动记住（config.json 的 `panels`）；
  新窗口会**自动吸附到侧栏侧边**（已按需求去掉"拖动时磁吸对齐"）
- **实时频谱 / 声谱 / 波形** —— 对齐 BPM 测速助手：Chromium 原生 FFT 预计算
  （OfflineAudioContext + AnalyserNode）+ 22 种配色方案（完整色阶/三分频/单色）+
  对比度增强 + 峰值突出；设置窗口可切配色/灵敏度/FFT 精度
- **节拍线延迟跟随 BPM 测速助手（v0.8.5）** —— 侧栏与软件是两个独立程序，这里会**直接读
  软件里校准好的「红线节拍线延迟」**，两边的拍线永远对得上（设置窗口可切回手动）
- **可拖动的时间轴** —— 红线（段起点）/ 蓝线（节拍线）直接在时间轴上拖，交互与 BPM 测速助手一致
- **timing 编辑「导入」** —— 拖动/改 BPM 只改主进程内存（多窗口共享同一份编辑状态），
  点「导入谱面」或 Ctrl+S 才覆盖 `.osu` 的 `[TimingPoints]`，**音符和设计一律不动**
- **定时自动备份** —— 默认 2 分钟一次、保留 60 份、`年-月-日-时-分` 命名，位置可改
- **从 BPM 测速助手打开** —— BPM 测速助手设置面板 →「制谱侧栏」→ 启动；侧栏右上「↩ 返回测速」跳回

---

## 一、关键结论：先说三件事，跟你的预期不一样

在动手前我把 tosu 和 osu-standard-stable 两个源码都读完了，有三点必须先纠正，
否则后面会白做：

### ① tosu **不是**"内存注入"，它是只读的外部内存读取器

| 你的假设 | 实际情况 |
|---|---|
| 注入到 osu! 进程里 | ❌ 不注入。tosu 是独立进程，用 `OpenProcess` + `ReadProcessMemory` 读 |
| 会修改游戏内存 | ❌ 只读。`tsprocess` 的 C++ 层只导出 `readByte/readInt/readFloat/scan...`，**没有任何 write 函数**（已核对 `lib/functions.cc` 的 `init()` 全表） |
| 会写 DLL | ❌ 全项目搜不到 `inject` / `dll` 相关代码 |

这反而是好事：**只读**意味着不会被反作弊盯上，也不会把游戏搞崩。我们自己实现时也坚持只读。

### ② 为什么 tosu 必须扫"活进程内存"——我实测确认了

我把 tosu 的 16 条 AOB 特征码直接对着你这份 `E:\game\osu!\osu!.exe` 磁盘文件扫，
结果 **0 命中**。原因不是签名过期：

```
导入表只有 mscoree.dll，含 BSJB/.NET 元数据 → 这是纯 .NET 程序集
.text 段熵值 5.872 → 正常 IL 代码，没有被加壳
```

`.text` 里是 **IL 中间码**，而 tosu 的特征码（如 `55 8B EC`）是 **x86 原生指令**。
这些原生码只有在 **.NET JIT 运行时把 IL 编译成机器码**之后才会出现在内存里。
所以"扫活进程"不是 tosu 的选择，是唯一可行路径。

### ③ 制谱器的红线 timing **不从内存读**，是从磁盘 `.osu` 文件读

这是最关键的一条。tosu 的实际做法（`packages/tosu/src/states/beatmap.ts` `updateMapMetadata`）：

```
内存里读：GameState 状态、playTime（实时播放位置）、
          谱面的「文件夹名 + 文件名」、Songs 目录、音频长度
                ↓
磁盘上读：把 .osu 文件整个读进来，用 osu-parsers 解析出 timingPoints
```

也就是说：**红线 timing 的权威来源是 `.osu` 文件本身**，内存只提供"正在编辑哪张图"和"播到哪了"。

> 这有个直接后果，见下面「五、注意事项」里的**写回冲突**。

### ④ `osu-standard-stable` 不是 osu!stable 源码

你给的 `osu-standard-stable-master.zip` 是 **osu!lazer ruleset 的 JS 移植**（kionell 出品），
用来算 pp / 难度（`StandardDifficultyCalculator`、`Aim/Speed/Flashlight` 技能等）。
它**不含** osu!stable 的编辑器代码——osu!stable 本身是闭源的。

不过它有个很有用的地方：它依赖 `osu-parsers`，而 tosu 正是用
`osu-parsers` 的 `BeatmapDecoder` 读谱面。我们的模块用的是自己的最小解析器
（只动 `[TimingPoints]`，其余逐字节保留），比全量解析更适合"写回"这种场景。

---

## 二、最终架构

```
┌──────────────────┐   只读内存    ┌───────────────┐   本地 HTTP    ┌──────────────────┐
│  osu!.exe        │ ◀─────────── │  tosu.exe     │ ◀──────────── │  本模块          │
│  (制谱器)         │  ReadProcess │  AOB 特征码   │  /json/sc     │  (侧栏窗口)      │
└──────────────────┘   Memory     │  社区在维护   │               │                  │
        ▲                         └───────────────┘               │  ① 实时位置       │
        │                                                         │  ② 红线 timing    │
        │ 只改 [TimingPoints]                                      │  ③ 编辑/写回      │
        │ 原子写 + 写前备份                                         │  ④ 定时备份       │
        │                                                         └──────────────────┘
        └──────────────────── .osu 文件 ◀──────────────────────────────────┘
```

**为什么复用 tosu 而不是自己写特征码扫描**：

| 方案 | 成本 | 风险 |
|---|---|---|
| 自己实现 AOB 扫描 + 维护签名 | 要编译原生 addon（node-gyp/MSVC），每次 osu! 更新都得重新逆向 | 高 |
| **复用 tosu 的 HTTP API**（本方案） | 零逆向，一个本地端口 | 低（tosu 社区在维护签名） |

tosu 的 `/json/sc` 一次就返回我们需要的全部字段：

| 字段 | 含义 |
|---|---|
| `time` | 实时播放位置（秒）—— 制谱器里的音频进度 |
| `rawStatus` | GameState 枚举（`1` = 制谱器编辑中，`4` = 选歌） |
| `mapTimingPoints` | `[{startTime, beatLength}]` —— **红线 timing** |
| `osuFileLocation` | 当前谱面相对路径（`文件夹/xxx.osu`） |
| `totalAudioTime` / `mp3Name` | 音频总长 / 音频文件名 |

---

## 三、文件结构

```
osu-maphelper\
├─ src\
│  ├─ config.mjs     配置读写（config.json 首次运行自动生成）
│  ├─ paths.mjs      osu! 安装目录 / Songs / 谱面绝对路径 探测
│  ├─ tosu.mjs       tosu HTTP 客户端（/json/sc，含优雅降级）
│  ├─ osuFile.mjs    .osu 解析 + 保真写回（本模块最核心的部分）
│  ├─ timingEdit.mjs 编辑逻辑（纯函数，可单独测）
│  ├─ backup.mjs     定时备份调度（2 分钟 / 60 份 / 年月日时分）
│  ├─ app.mjs        编排层：把上面几块串成状态机（含音频文件定位）
│  ├─ core.mjs       核心运行时（建 app + 轮询循环，两种模式共用）
│  ├─ router.mjs     路由（与传输方式解耦，HTTP 和 app:// 共用同一套）
│  └─ server.mjs     本地 HTTP 服务（仅网页模式用，127.0.0.1:24100）
├─ electron\main.cjs Electron 主进程（app:// 协议 + 面板窗口管理/置顶/透明度、EncloseWindow 唤醒软件）
├─ renderer\
│  ├─ index.html     侧栏主窗口骨架（状态 + 播放位置 + 功能区块入口）
│  ├─ style.css      深色主题样式（含合并窗口的 ①变速段落卡片 / ②全局 offset 区）
│  ├─ state.js       共用工具（轮询 / post / 配置 / 开面板 / 置顶）
│  ├─ main.js        侧栏主窗口逻辑
│  ├─ viz.html       合并窗口：上=频谱声谱，下=①变速段落卡片 + ②全局 offset / 编号 / 添加
│  ├─ viz.js         频谱/声谱/时间轴四层 canvas + 红线拖动交互（含 LUT 性能优化）
│  ├─ viz-panel.js   合并窗口逻辑（卡片编辑 / 双向联动 / 快捷键 / 撤销重做）
│  ├─ map|backup|settings|log.html + *-panel.js   其余功能区窗口
│  └─ （v0.8.4 起原 timing.html / timing-panel.js 已合并进 viz 窗口，不再存在）
├─ scripts\
│  ├─ launch.mjs     启动器（自动找可用 Electron）
│  └─ sendkey.vbs    辅助（备用）
├─ tests\
│  ├─ selftest.mjs   离线自测（40 项，不依赖 osu! 运行）
│  ├─ ui_contract.mjs 界面契约自测（128 项：id/class/语法/关键结构/合并窗口）
│  ├─ live_check.mjs 实机自检（osu! 运行时跑，逐步打印链路）
│  ├─ proto_probe.cjs Electron 启动参数探针（排障用）
│  └─ fetch_probe.cjs 探针：主进程三种取数方式是否可用（排障用）
├─ 启动侧栏.bat      一键启动侧栏窗口
├─ 仅网页版.bat      只起服务，用浏览器看（不需要 Electron）
└─ config.json       配置（可手改，也可在 UI 改）
```

### 侧栏 vs 网页：为什么是两套传输

`src/core.mjs`（建 app + 轮询）和 `src/router.mjs`（路由）是共用的，差别只在"怎么把界面送到屏幕"：

| 模式 | 传输 | 说明 |
|---|---|---|
| 侧栏（Electron） | `app://renderer/index.html` 自定义协议 | 进程内直接响应，**无端口、无 socket、不过代理** |
| 网页 | `http://127.0.0.1:24100` | 浏览器打开，方便调试 / 不想装 Electron 时用 |

一开始侧栏也走 HTTP，但在本机环境里必然加载失败（见下面排障坑 2），所以改成了 `app://`。

---

## 四、怎么用

### 前置
1. **tosu** 要在跑（`tosu.exe`）——它负责读 osu! 内存
2. **osu!stable** 要开着
3. Node.js ≥ 20

### 启动
双击 **`启动侧栏.bat`**（没有 Electron 时会给出提示；也可以双击 `仅网页版.bat` 用浏览器看，
不需要 Electron）。

侧栏窗口会自动贴在 osu! 窗口右侧、置顶，osu! 移动时跟着走。
手动拖动侧栏后，位置会被记住并停止自动跟随（想恢复跟随：删掉 `config.json` 里的
`window.x` / `window.y` 改成 `null`）。

### 界面
- **顶部**：tosu / osu! 连接状态、当前 GameState
- **实时位置**：大号时间码 + 当前红线 BPM + 进度条
- **频谱声谱 + 变速段落（合并窗口，v0.8.4）**：上半是波形 + 声谱瀑布图；下半左边
  **① 变速段落选项卡**（每段一张卡片：拍索引 / BPM / 起始时间；横向铺开、最底部一条左右滑条、
  向右无限收纳），右边 **② 全局起始偏移 offset + 变速段落编号 + 添加变速段落**；
  标题栏还有一排**音频控件**（见下）
- **当前谱面**：曲名难度、红线/绿线数、**一致性**（磁盘文件红线数 vs 编辑器内存红线数）
- **自动备份**：下次备份倒计时、已存份数、占用空间、间隔/保留数可改
- **设置**：各窗口透明度滑条（40%~100%，实时生效）+ 频谱/声谱参数（配色 / FFT / 灵敏度 /
  对数刻度 / 峰值 / 倒转 / 渲染倍率 / **节拍线延迟跟随软件**）
- **日志**：每次备份/导入都记一笔

### 合并窗口（频谱声谱 + 变速段落）的联动

| 操作 | 效果 |
|---|---|
| 频谱里点/拖一条**红线**（任意高度） | 选中它，① 的卡片列表自动滚到对应段落并高亮，② 的编号同步变 |
| 频谱里**双击**一条**红线**（任意高度） | 选中它 **+ 视图滚动到它居中**（不改播放位置） |
| 点一张**卡片** | 频谱里高亮那条红线 |
| **双击卡片** | 频谱滚动到该红线**居中**（不改播放位置，对齐软件） |
| 播放中（没有手动选中时） | ① 自动跟着播放头所在段落滚动 |
| 卡片里改 **起始时间** | 直接写这条红线的绝对时间戳；**起点锚点**那张 = 改全局 offset |
| 卡片里改 **BPM** | 只改这条红线下方蓝线（节拍线）的间距，不决定下一条红线位置 |
| 卡片里改 **拍索引** | 按**上一段**的 BPM 把这条红线推到对应那一拍（越不过下一段） |
| ② 全局起始偏移（offset） | 改第一条红线的时间 → **整体平移**所有变速段落 |
| ② ◀ ▶ / 卡片双击 | 上/下一个变速段落（也可 `Alt+←` / `Alt+→`） |
| ② ＋ 添加变速段落 | 在播放头位置新增一条红线（继承所在段 BPM）；双击时间轴空白处同效 |
| 滚轮停在 ① 的卡片区 | 横向浏览卡片（等效于拖最底部那条滑条） |
| 标题栏音频控件 | 时间显示 / 音乐音量 / 节拍器音量 / 节拍器开关 / 音乐变速，见下 |

### 时间轴（频谱/声谱区）交互
| 操作 | 效果 |
|---|---|
| 滚轮 | 缩放时间轴（以鼠标位置为锚点） |
| 按住波形/声谱左右拖 | 平移时间轴 |
| 单击波形/声谱区里的**红线** | 选中它 → ① 卡片滚到位（红线纵贯上下，哪个高度都能点中） |
| **双击波形/声谱区里的红线** | 选中 + 视图滚动到它居中 |
| 拖**红线**（底部三角或竖线） | 改这条红线的**时间戳**（只改内存，不写文件） |
| 拖第一条红线的三角 | 整体平移全部红线（= 改全局 Offset） |
| 拖**蓝线** | 改该段 **BPM**（按拍数×60/时间差实时换算） |
| 双击**底部时间轴区**空白处 | 在该时间点新增一条红线（继承所在段 BPM） |
| 播放时 | 视图自动跟随播放头；暂停时可以随便平移看别处 |

### 标题栏音频控件（黄圈那一排）

| 控件 | 说明 |
|---|---|
| `0:31.500` 时间显示 | 本地试听中 = 试听时间；否则 = osu! 制谱器时间 |
| `♪` 音乐音量 | 本地试听（空格播放/暂停）的音量，0~100 |
| `♩` 节拍器音量 | 节拍器单独的音量，0~100 |
| `♩ 节拍器` 开关 | 本地试听时按红线/BPM 打拍，重拍（每小节第一拍、段落起点）用高音 |
| `⏩ 1.50×` 音乐变速 | 0.5× ~ 2.0×，**保持音调不变**（`playbackRate` + `preservesPitch`） |

音频参数（音量 / 开关 / 倍率）都存在 `config.json` 的 `audio` 段，重启后保持。

> **节拍器只在"本地试听"时响**：侧栏没法控制 osu! 的播放，也就没法跟 osu! 的音频对齐，
> 所以节拍器只服务于自己放的那份音频（空格开始）。

### 节拍线延迟跟随 BPM 测速助手（v0.8.5）

「节拍线延迟」是做音频/画面延迟补偿用的：放一段参考音频，把红蓝拍线调到**跟听到的节拍对齐**
的那一刻。这个值应当**和 BPM 测速助手里校准的完全一致**，否则侧栏里的拍线就是歪的。

麻烦在于两边是**两个独立程序**、各有各的设置存储（软件存自己的 localStorage，侧栏存
`config.json`）。默认值虽然都写着 30ms，但只要你在软件里调过，侧栏并不会跟着变。

**做法**：侧栏默认**直接去读软件设置**（`%APPDATA%\bpm-measurer-util\Local Storage\leveldb`
里的 `bpm-measurer-settings`），把 `beatLineDelayMs` 拿来用。

| 设置窗口里的项 | 说明 |
|---|---|
| **跟随软件**（默认 ✅） | 采用软件里校准好的值；此时**延迟滑条是只读的** |
| 延迟滑条 | 仅当**取消勾选「跟随软件」**后可拖，作为侧栏自己的手动值 |
| **⟳ 重新读取** | 让主进程忽略缓存、立刻重读一次软件设置（在软件里刚拖完延迟时点一下） |
| 下方提示行 | 明示当前值的来源：「BPM 测速助手（当前 -17ms）／侧栏手动设置／读不到软件设置」 |

> **只读、不写**：侧栏只读软件的文件，绝不修改它。读不到时（软件从未运行过、或存储已被压缩）
> 会自动退回侧栏自己的手动值，不报错也不留空。

**改完去哪了？** 全部只存在内存里（列表里标黄的行），**不会碰你的 .osu 文件**。
确认没问题后点 **「导入谱面」**（或 `Ctrl+S`）——这时才覆盖 `.osu` 的 `[TimingPoints]` 段落，
音符/故事板/设计等其它内容**逐字节原样保留**（写入前会自动先备份一份）。

### 面板自由摆放
按住任意面板的**标题栏**上下拖，可以重排顺序，松手自动记住（存进 `config.json` 的 `layout.order`）。
配置里存的顺序如果和当前面板对不上（比如升级后新增了面板），会自动忽略旧配置、用默认顺序。

### 改红线 BPM / 时间 / 拍索引（卡片输入框方式）
1. 点一下 ① 区里那张卡片（或直接点频谱里的红线，卡片会自动滚到位）
2. 在卡片里改 **BPM / 起始时间 / 拍索引**，回车或点别处即生效（只改内存）
3. 点 **「⇩ 导入谱面」** 或按 `Ctrl+S` 写回 `.osu`
4. 改错了：`Ctrl+Z` 撤销（连续拖动 400ms 内合并成一步）、`Ctrl+Shift+Z` / `Ctrl+Y` 重做

---

## 五、注意事项（重要，实测踩出来的）

### ⚠ 写回冲突：osu!stable 编辑器保存时会覆盖你的修改

osu!stable 的编辑器把谱面**读进内存**，按 `Ctrl+S` 时是**从内存写回磁盘**。
所以如果侧栏改了文件、而编辑器里还有旧数据，你在编辑器里一保存，侧栏的修改就没了。

**推荐流程：**
1. 先退出制谱器（回到选歌）
2. 用侧栏改 timing 并写回
3. 重新进入制谱器 —— 这时编辑器读到的就是新数据

或者反过来：**只把侧栏当"读 + 备份"用**，编辑交给你自己在制谱器里做。
界面上的「一致性」那一栏就是给你看这个的：显示 `212/212` 说明两边一致；
显示 `210/212` 说明编辑器里还有未保存的改动（或外部改过文件）。

### 备份文件命名与保留
- 命名：`年-月-日-时-分.osu`，例 `2026-9-21-0-35.osu`
- 位置：默认 `backups\<Artist - Title [Version]>\`（按谱面分文件夹），**界面里「备份位置」可直接改**
- 默认每 **2 分钟**一次，保留 **60** 份，超出删最旧的
- **内容没变就不写新备份**（避免刷一堆一模一样的），可在 config 里关掉
- 清理时**只删**备份目录里文件名严格匹配时间戳模式的 `.osu`，其它文件一概不动

### 性能
- 轮询 tosu 每 100ms 一次（本地回环，开销可忽略）
- 读 `.osu` 文件按 `mtime + size` 缓存，最多每秒检查一次
- 首次探测 osu! 安装目录会扫盘（约 1~3 秒），结果会写进 `config.json`，之后秒开

### 反降频（挂着侧栏切进 osu! 全屏编辑谱面时，频谱不掉帧）
侧栏是"摆在 osu! 旁边当仪表盘"用的，最典型的用法就是**挂着它切进游戏全屏编辑谱面**。
但窗口被全屏游戏完全盖住时，系统会做三件事，每一件都足以让频谱卡住：

| 机制 | 症状 | 对策（默认全部开启） |
|---|---|---|
| Windows 原生遮挡检测 | 被盖住即判"不可见" → `requestAnimationFrame` **停摆**（不是降频，是停） | 关掉 `CalculateNativeWinOcclusion` |
| 隐藏页定时器强化节流（Chrome 88+） | 100ms 的状态轮询被压到**每 1 分钟才醒一次** | 关掉 `IntensiveWakeUpThrottling` |
| 系统把非前台应用当"空闲"降频 / 挂起 | 整个渲染被冻结 | `powerSaveBlocker(prevent-app-suspension)` |
| 前台游戏抢占 CPU / GPU 调度 | 侧栏只有 Normal 优先级，抢不到时间片 | 自身进程树提到 **AboveNormal**（只含侧栏自己，不含父进程、更不含 osu!） |

**外加一层运行时兜底**：万一在某些驱动 / 独占全屏下 rAF 仍被掐停，
`viz.js` 会检测"rAF 超过 120ms 没回调"，立刻用 33ms 定时器接管绘制
（定时器受 `disable-background-timer-throttling` 保护，不会跟着被压）；
rAF 恢复后定时器自动退让 —— **两套驱动不会同时绘制，不会白烧一倍 CPU**。

**逃生口**（环境变量，平时不用管）：
- `OSU_MAPHELPER_NO_PRIORITY_BOOST=1` —— 不提升进程优先级
- `OSU_MAPHELPER_CANVAS_GPU=1` —— 换回"硬件加速 2D canvas"（少数机器上反而更快）

---

## 六、自测

### 离线自测（不需要 osu! 运行）
```bash
node tests/selftest.mjs
```
覆盖 47 项，包括：真实谱面（18381 行）**只改 1 条红线 BPM → 差异行数 = 1**、
其余 211 条红线 `beatLength` **逐位未变**、往返字节一致、备份保留/清理边界、
拒绝写入非 `.osu`、原子写无 `.tmp` 残留，以及 **BPM 软件设置读取**（用假 LevelDB 验证
"取最后一次写入"、Latin-1 / UTF-16LE 双编码、目录缺失优雅降级）。

### 界面契约自测（静态检查，秒出）
```bash
node tests/ui_contract.mjs
```
覆盖 **175 项**：每个 panel 页引用的脚本/`id` 是否存在（**这个测试真抓到过一个
"红线计数从不刷新"的 bug**）、用到的 class 是否有样式、各 JS 语法、关键结构是否齐全、
合并窗口（① 卡片 / ② offset / 双向联动）的契约、节拍线延迟跟随软件的实现契约
（读取器只读 / 快照克隆 config / 设置面板开关与只读态），以及反降频的四项对策
（遮挡检测 / 隐藏页节流 / 挂起保护 / 进程优先级）与渲染兜底心跳。

### 界面渲染快照（不需要人看屏幕）
```bash
node scripts/launch.mjs --screenshot
```
无头渲染一次，把界面截图和文本存到 `tests/shots/ui.png` / `ui.txt`，
同时把渲染进程的 console 与 `did-fail-load` / `render-process-gone` 一起写进 `ui.txt`。
排障时先跑这个，比肉眼快得多。

### 实机自检（osu! 运行时）
```bash
node tests/live_check.mjs
```
逐步打印：osu! 进程 → 安装目录/Songs → tosu 连接 → 实时状态 → 谱面定位 →
解析结果 → 磁盘/内存红线数一致性 → 当前播放位置对应哪条红线。

> 在 osu! 主菜单跑会提示"当前是主题曲，请进选歌或制谱器"——这是 tosu 的设计（跳过菜单主题曲）。

---

## 七、配置项（`config.json`）

```jsonc
{
  "tosu":   { "host": "127.0.0.1", "port": 24050, "pollMs": 100 },
  "osu":    { "installDir": "", "songsDir": "" },        // 留空自动探测
  "backup": {
    "enabled": true,
    "intervalMinutes": 2,        // 备份间隔（分钟）
    "keepCount": 60,             // 保留份数
    "dir": "",                   // 留空 = <模块目录>\backups
    "onlyWhenChanged": true,     // 内容没变不写新备份
    "backupBeforeWrite": true,   // 写回前强制备份
    "nameFormat": "YYYY-M-D-H-m"
  },
  "visual": { "palette": "spectrum", "invert": false, "renderScale": 1,
              // v0.8.5：跟随时采用 BPM 测速助手里的值（滑条只读）；关掉才用手动值
              "beatLineDelayFollowSoftware": true, "beatLineDelayMs": 30,
              "fftSize": 1024, "sensitivity": 75, "logBase": 50, "autoFollow": true },
  "audio":  { "musicVolume": 80, "metroVolume": 60, "metroOn": false, "rate": 1 },
  "window": { "width": 400, "height": 940, "x": null, "y": null,
              "alwaysOnTop": true, "opacity": 1 },
  "server": { "port": 24100 }
}
```

---

## 八、已知限制 / 后续可做

- **频谱/声谱读的是磁盘音频文件**（`[General] AudioFilename`），不是 osu! 正在播放的音频流——
  tosu 不提供音频数据，这是原理限制。效果上等同于"跟随播放头的本地播放器"。
- **拖动红线/蓝线只改内存**，点「导入谱面」才写 `.osu`（v0.8 按需求设计）。
  如果你拖完忘了导入就切谱面，改动会丢（有备份兜底，不会损坏文件）。
- **面板"自由摆放"目前是侧栏内上下重排**（拖标题栏换位置、自动记住）。
  "拖出侧栏变成独立窗口"（真·分离）还没做，需要的话后续用 Electron 多窗口实现。
- **窗口输入自动化**被本机安全策略拦（`Add-Type`、`cscript`、`[Diagnostics.Process]::Start` 属受限命令），
  所以"自动切进制谱器"这类操作目前要手动。不影响正常使用。
- 「一致」判断目前只比**红线条数**。更严格的做法是逐条比 `time + beatLength`，
  需要的话可以加。
- 目前只写 `[TimingPoints]`。如果你需要侧栏也改 `[General] PreviewTime` / `[Editor] Bookmarks`，
  架构上已支持（`serializeOsu` 可以扩展到别的段落），说一声就加。
- `electron` 没有装进本项目（200MB+），启动器会去邻近项目复用现成的；
  想独立分发就 `npm install electron --no-save`。
- Electron 主进程入口用 `.cjs` 而不是 `.mjs`——Electron 34 的 ESM 入口有 bug
  （`cjsPreparseModuleExports: Cannot read properties of undefined`），CJS 稳定。

---

## 十、排障：两个已经踩过的坑

### 坑 1：`ELECTRON_RUN_AS_NODE=1` 会让 Electron 完全起不来

现象：启动侧栏立刻报

```
Error: Cannot find module 'electron'
TypeError: Cannot read properties of undefined (reading 'whenReady')
```

原因：环境变量 `ELECTRON_RUN_AS_NODE=1` 会把 Electron 降级成"纯 Node 模式"——
没有 `app`、没有 `BrowserWindow`、内置 `electron` 模块消失。

**`scripts/launch.mjs` 已经在 spawn 子进程时自动摘掉这个变量**，所以正常用不会遇到。
但如果你是手动执行 `electron.exe .`，请先：

```bat
set ELECTRON_RUN_AS_NODE=
```

### 坑 2：Chromium 沙箱子进程被杀 → 界面一片空白（**这是最坑的一个**）

现象：窗口正常创建，标题也对，但页面永远加载不出来，日志是

```
ERR_FAILED (-2) loading 'app://renderer/index.html'
```

**注意这个报错极具误导性**——它看起来像"协议 / 地址 / 代理"的问题，
但真相跟加载完全无关。加日志之后才看到：

```
[render-process-gone] {"reason":"killed","exitCode":1}
[ERROR:gpu_process_host.cc] GPU process exited unexpectedly: exit_code=1
[FATAL:gpu_data_manager_impl_private.cc] GPU process isn't usable. Goodbye.
```

**渲染进程被系统杀掉了**，子进程一死，这次导航就只能报 ERR_FAILED。
在受限环境（企业策略 / 安全软件 / 沙箱里跑）下必然发生，普通桌面环境不会。

**修法：`--no-sandbox`。** `electron/main.cjs` 已内置。
实测对比（`tests/proto_probe.cjs` 一键跑全部组合）：

| 启动参数 | 结果 |
|---|---|
| `--disable-gpu` | ❌ renderer killed |
| 加 `--no-sandbox` | ✅ `loaded=true text="HELLO-OK"` |
| `--use-angle=swiftshader` | ❌ renderer killed |
| `--no-sandbox` + 保留硬件加速 | ✅ 正常，且**不需要关 GPU** |

也就是说：之前的"GPU 崩溃"其实是沙箱问题的**症状**，不是独立故障。
关掉沙箱后硬件加速可以正常工作，所以正常运行时保留硬件加速。

> 安全性：侧栏只加载项目自带的本地页面，`contextIsolation: true` + `nodeIntegration: false`，
> 不加载任何远程内容，关沙箱的风险可忽略。
> 确实想保留沙箱：设环境变量 `OSU_MAPHELPER_SANDBOX=1`。

顺带一提，"改走 `app://` 协议"这个动作本身是**有益但非必需**的——
真正修好问题的是 `--no-sandbox`。`app://` 的价值在于去掉端口和代理变量，
让侧栏更稳；现在两种传输共用 `src/router.mjs` 一套路由，维护成本没有增加。

---

## 十、排障工具怎么用

遇到"界面打不开"这类问题，按这个顺序跑，别靠猜：

```bash
# 1) 界面能不能渲染？直接出截图 + 渲染进程日志
node scripts/launch.mjs --screenshot
#    看 tests/shots/ui.txt 里的 render-process-gone / did-fail-load

# 2) 是不是启动参数的问题？一键扫全部组合
<electron.exe> tests/proto_probe.cjs plain
<electron.exe> tests/proto_probe.cjs nosandbox
<electron.exe> tests/proto_probe.cjs ns_gpu        # 关沙箱 + 保留硬件加速

# 3) 主进程取数通不通？（native fetch / net.fetch / node http 三条路）
<electron.exe> tests/fetch_probe.cjs
```

第 3 个探针是用来区分"**是代码连不上**"还是"**是数据源没开**"的——
本次就靠它发现：侧栏显示"未连接 tosu"其实是 tosu 进程被回收了，不是代码问题。

---

## 九、许可与致谢

- [tosu](https://github.com/tosuapp/tosu) — GPL-3.0，本模块**以本地 HTTP API 方式使用它**，未复制其代码
- [osu-parsers](https://github.com/kionell/osu-parsers) / [osu-standard-stable](https://github.com/kionell/osu-standard-stable) — MIT，参考了其 `.osu` 段落结构
- 本模块自身只读 osu! 内存（经由 tosu），不注入、不修改游戏进程
