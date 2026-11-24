<div align="center">

# 🧪 BPM 测速助手 · 0.9.x 预览版

**在 0.8.x 的测速与制谱功能之上，加谱面预览、红绿线 SV 写入与谱面录制**

Windows 10 / 11 64 位 ｜ 离线可用 ｜ 无需 Node.js

</div>

> 这是**预览版**说明。稳定版（测速 + 制谱侧栏）请见 [README.md](README.md)，日常使用建议装 0.8.19。

---

## 下载

[**⬇ BPM.Setup.0.9.0.exe**](https://github.com/kkkhover/music-game-bpm-measurer/releases/download/v0.9.0/BPM.Setup.0.9.0.exe)（约 81 MB）

Releases 里带 `Pre-release` 标记。源码在 [`dev-0.9x`](https://github.com/kkkhover/music-game-bpm-measurer/tree/dev-0.9x) 分支，
标签 [`v0.9.0`](https://github.com/kkkhover/music-game-bpm-measurer/tree/v0.9.0)。

---

## 与 0.8.x 的关系

0.9.x **包含** 0.8.19 的全部功能（导入音频 / `.osz` / 谱面文件夹、变速段落编辑、多游戏 timing 导出、osu! 制谱侧栏），
在此之上新增下列预览能力。这些功能仍在调整，接口与界面随时可能变化。

| 新增 | 说明 |
|---|---|
| **谱面预览** | 竖屏小窗，按 osu!mania 素材渲染下落音符与长条；可拖动、缩放、吸附位置 |
| **皮肤渲染** | 读 `skin.ini` 的 `[Mania]` 段，支持 `NoteImage*`、`KeyImage*`、`Stage*`、`Lighting*` 与动画帧；素材只读不写回 |
| **流速（SV）** | 红 / 绿线三色标注（红 = BPM、绿 = SV、橙 = 同刻两者），按 `BPM / 基准 BPM × SV × SS` 显示流速 |
| **红绿线写入** | 导出时把 SV 改写成绿线 timing，随 `[TimingPoints]` 一起落到谱面 |
| **自动游玩 / 打击特效** | 按命中时间触发键图按下态与列灯，用皮肤自带素材 |
| **谱面录制** | 录制预览窗口为 MP4 / WebM，可选分辨率、帧率、码率，可带音乐与节拍器 |

---

## 已知限制

- 预览是**示意**，不承诺像素级等同游戏内表现；流速按相对倍率换算，不是游戏的 ScrollSpeed 数值。
- 独立预览窗口无音频（音频图在主窗口），录制带声音需在主窗口内录制。
- 谱面预览为新增模块，长时间播放的帧率与内存仍在优化。

---

## 从源码构建

```bash
git checkout dev-0.9x
cd Bpm-Measurer-0.9.0
npm ci
npm run electron:build
```

打包输出目录见 `package.json` 的 `build.directories.output`。只依赖 Node.js ≥ 20。

---

## 许可与第三方参考

许可与三代上游来源同 0.8.x，见 [`LICENSE`](LICENSE)、[`NOTICE`](NOTICE) 与 [README.md 第 1 节](README.md#1-来源与许可)。

预览功能的视觉规范参考 [fengpengGG/om_Beatmap_Preview_Generator](https://github.com/fengpengGG/om_Beatmap_Preview_Generator)，
皮肤渲染方案参考 [fengpengGG/OsuSkinMaker_New](https://github.com/fengpengGG/OsuSkinMaker_New)。
这两个仓库根目录均无 LICENSE（默认保留所有权利），因此本软件**没有复制、内嵌或改编**其 Python / Rust / JavaScript 源码，
也未打包其运行时依赖；预览渲染器是本仓库独立编写的 TypeScript + Canvas 2D 实现，仅借鉴配色、版式与公式。
