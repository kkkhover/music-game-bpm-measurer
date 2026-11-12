<div align="center">

# 🎵 BPM 测速助手

**music-game-bpm-measurer**

帮你在音乐游戏里做出准确 timing 的桌面工具：导入一首歌，看波形 + 声谱，一段段记录「BPM + 起始时间」，一键导出成各音游 / 制谱器能直接用的 timing 文件。支持存在变速的歌曲。

主程序 **v0.9.0** · 内置制谱侧栏 **v0.8.17**（两者打包在同一个 exe 里）

</div>

---

> ### 🤖 Vibecoding 提示
> 本项目的大部分代码由 **AI 辅助编写**（Vibe Coding），人工负责需求设计、代码审核与功能验证。
> 使用与二次开发前请知悉：AI 生成的内容可能存在疏漏或未覆盖的边界情况；衍生来源与第三方组件的版权声明已在下方「[许可与来源](#许可与来源)」完整保留，请勿用于任何违规用途。

---

## 目录

- [简介](#简介)
- [安装与运行](#安装与运行)
- [主程序怎么用](#主程序怎么用)
- [制谱侧栏（osu-maphelper）](#制谱侧栏osu-maphelper)
- [外部谱面 · 红绿线 · 实时变速预览](#外部谱面--红绿线--实时变速预览)
- [从源码构建](#从源码构建)
- [环境依赖](#环境依赖)
- [许可与来源](#许可与来源)
- [相关文档](#相关文档)

---

## 简介

BPM 测速助手是一款面向音游制谱者的桌面工具，核心流程：

1. **导入音频**，通过波形 + 声谱定位节拍；
2. **逐段编排** BPM、拍号与起始时间，支持变速歌曲；
3. **导出**到 osu!、Malody、Arcaea、Phigros、ADOFAI、vivid-stasis 等格式。

除了主程序，它还内置一个可实时跟随 osu! 的制谱侧栏，以及 v0.9.0 新增的外部谱面「红绿线 / 变速实时预览」能力。

---

## 安装与运行

- 系统：**Windows 10 / 11（64 位）**。安装包与免安装版见 [Releases](https://github.com/kkkhover/music-game-bpm-measurer/releases)。
- 免安装版**解压即用**，不需要 Node.js、不需要联网。
- 侧栏要实时跟随 osu!，需本机运行 [tosu](https://github.com/tosuapp/tosu)（默认端口 `24050`）。

---

## 主程序怎么用

1. **导入音频**（`Ctrl+O`）——支持 `.mp3 / .ogg / .wav / .m4a / .flac`。
2. **对齐 OFFSET**：设置第一拍的时间（秒）。
3. **逐段编排**：添加 / 编辑「变速段落」（BPM、拍号、起始时间），时间轴上可直接拖动红线。
   变速播放可降到 0.25x~2.0x **不变调**，方便听清鼓点。
4. **导出**：JSON 配置、osu! `[TimingPoints]`、Malody 谱面包（含音频）、Arcaea / Phigros / ADOFAI / vivid-stasis 的 timing 文件。

**快捷键**：`空格` 播放暂停 · `Ctrl+Z/Y` 撤销重做 · `←/→` 移动 · `Alt+←/→` 切段 · `+/-` 缩放 · `Delete` 删除选中红线。

---

## 制谱侧栏（osu-maphelper）

贴在 osu! 制谱器旁边的独立侧栏：实时频谱 / 声谱 / 波形、可拖动的红线时间轴、跟随 osu! 播放位置、定时备份。主程序里点「制谱侧栏」即拉起，无需单独安装。

> 侧栏不读 osu! 内存，数据经 tosu 获取；红线以磁盘上的 `.osu` 为权威来源，编辑导出成新文件、不写回原谱面。

---

## 外部谱面 · 红绿线 · 实时变速预览

读取 `.osu/.osz` 的 timing，改红线 BPM / 绿线 SV，钢琴卷帘实时预览变速效果并写回磁盘谱面：

- 点「导入谱面」选 `.osu/.osz`；`[TimingPoints]` 每一行变成一张卡片，红线 / 绿线分开可改。
- 点「谱面预览」打开竖屏小窗；改 BPM / SV 下一帧即生效，60ms 防抖后原子写回。
- 支持导入自己的 osu! 皮肤、一键录制 720p60 MP4（含音乐）、导出当前画面 / 整曲长图。
- 只读写磁盘上的外部文件，不连游戏进程、不读内存。

---

## 从源码构建

```bash
cd 主程序目录
npm ci                 # 严格按 package-lock 安装
npm run electron:build # 同步侧栏 + 编译 + 打包（NSIS 安装包 / 免安装目录）
```

- 打包输出目录在 `package.json` 的 `build.directories.output`，换机器前请改成你自己的路径。
- 国内网络建议先设 npm / electron 镜像（见 `依赖库与原理.md`）。

---

## 环境依赖

**运行时**（直接使用 Releases 产物）：无需任何额外前置，Windows 下解压即用。

**从源码构建**仅需：

| 依赖 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 20 | 提供 `npm` / `tsc` / `vite` / `electron-builder` 运行环境 |
| npm（随 Node） | — | `npm ci` 会按 `package-lock.json` 精确安装全部项目依赖 |

- 侧栏源码**零第三方运行时依赖**，只用 Node 内置模块 + 浏览器原生 API。
- 无需额外安装系统级前置库（如 ffmpeg、Python、VC++ 运行库等）；electron-builder 会在 `npm ci` 时自动拉取所需的打包二进制。
- 详细依赖清单与许可证见 [`依赖库与原理.md`](依赖库与原理.md)。

---

## 许可与来源

本项目是**衍生作品**，三代来源均以 **Apache License 2.0** 发布，版权与许可一律保留。许可全文见 [`LICENSE`](LICENSE)。

| 项目 | 作者 | 链接 |
|---|---|---|
| Bpm-Measurer（原始项目） | CMYC4237（B 站 @CMYC_4237） | https://github.com/CMYC4237/Bpm-Measurer |
| Bpm-Measurer-Util（Electron 打包版） | iExploder | https://github.com/iExploder/Bpm-Measurer-Util |
| music-game-bpm-measurer（本仓库） | kkkhover | https://github.com/kkkhover/music-game-bpm-measurer |

**本仓库新增内容**（同样以 Apache License 2.0 提供）：

- osu! 制谱侧栏（`osu-maphelper_v*/`，零第三方运行时依赖）
- 9 语言界面（中 / 英 / 日 / 韩 / 法 / 德 / 西 / 俄 / 葡）
- 频谱 / 声谱与内存优化、多游戏 timing 导出等

### 第三方组件

| 组件 | 许可证 |
|---|---|
| Electron、React、Vite、electron-builder 等 | MIT |
| lucide-react | ISC |
| TypeScript | Apache-2.0 |
| soundtouchjs（变速不变调） | LGPL-2.1（以依赖形式引用、未修改源码） |

> 以上第三方组件的许可与本产品自身的许可相互独立，各自按其条款执行。

### 其他致谢

- [tosu](https://github.com/tosuapp/tosu)：侧栏的 osu! 实时数据来源。
- [Jakads/malody2osu](https://github.com/Jakads/malody2osu)：Malody → osu! 转换参考。

### 谱面预览的版式参考

本软件的「谱面预览」在**视觉规范与版式**上参考了
[fengpengGG/om_Beatmap_Preview_Generator](https://github.com/fengpengGG/om_Beatmap_Preview_Generator)：
暗色配色、窄条钢琴卷帘、按小节分段自动换行的长图布局、红线 BPM 标注、长条（LN）画法与图例、mania 列映射。

**皮肤渲染方案**参考了 [fengpengGG/OsuSkinMaker_New](https://github.com/fengpengGG/OsuSkinMaker_New) 的
`skin.ini [Mania]` 多段匹配、素材读取优先级、x480 坐标系、图层顺序与长条画法（头 + 身体 + 可选尾帽）。

> ⚠️ **重要**：上述两个参考项目仓库根目录**均无 LICENSE 文件**（按著作权法默认「保留所有权利」）。
> 因此本软件**没有复制、内嵌或改编**其 Python / Rust / JavaScript 源码，也未打包其运行时依赖
> （Python、Pillow、moviepy、ffmpeg、Tauri、WebView2 等）。预览渲染器是本仓库独立编写的
> TypeScript + Canvas 2D 实现，此处仅借用配色 / 版式 / 公式作为设计参考并致谢。
> 如需使用原项目的代码或生成 MP4 视频，请直接访问原仓库并向原作者取得授权。
> 皮肤素材完全由用户自行导入，本软件只读、不写回皮肤目录。

---

## 相关文档

| 文件 | 内容 |
|---|---|
| `LICENSE` | Apache License 2.0 全文 |
| `依赖库与原理.md` | 依赖库清单（含许可证）+ 关键功能实现原理 |
| `更新日志.md` | 历代版本问题 / 修复 / 新增（随 Releases 发布，不入仓库） |
| `音游Timing转换脚本/README.md` | 各音游 timing 转换脚本用法 |
| `osu-maphelper_v*/README.md` | 制谱侧栏说明 |

> 来源与版权声明的完整细节（三代作者、谱面预览参考、皮肤方案参考的逐条说明）原载于 `NOTICE`，
> 现已合并到本文档的「许可与来源」一节，不再单独维护 `NOTICE` 文件。
