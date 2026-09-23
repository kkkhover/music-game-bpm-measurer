# BPM 测速助手 - Electron

这是一个使用 Electron 封装的 BPM 测速助手 GUI 应用程序。

原项目由 [CMYC4237](https://github.com/CMYC4237) 开发。

本项目为原项目的Electron打包，打包环境由Qwen3 Coder Next构建。

## 功能特性

- 音频波形和频谱可视化
- 动态 BPM 测量和调整
- 节拍器功能
- 拖拽时间轴缩放和滚动
- JSON 配置导入/导出

## 制谱侧栏（已打包进本软件）

本软件自带 **osu! 制谱侧栏**（osu-maphelper）。点设置面板里的「制谱侧栏」就能拉起，
**不需要另外准备侧栏文件夹，目标机器也不需要装 Node.js**。

实现方式（一句话）：Electron 打包后入口被写死成 `resources/app`，
所以侧栏不是"再起一个 Electron"，而是**同一个 exe 按参数分流**：

```
BPM 测速助手.exe              → 主程序（dist-electron/main.js）
BPM 测速助手.exe --maphelper  → 内置侧栏（maphelper/electron/main.cjs）
```

- 分流入口：[`boot.cjs`](boot.cjs)（`package.json` 的 `main` 指向它）
- 侧栏代码：`maphelper/` —— 由 [`scripts/sync-maphelper.mjs`](scripts/sync-maphelper.mjs)
  从 `osu-maphelper_v<版本>` 同步生成，**是生成物，不要直接改**；
  要改侧栏请改源码目录再重新同步。
- 侧栏的可写数据（配置 + 定时备份）落在
  `%APPDATA%\bpm-measurer-util\maphelper\`，**不在安装目录里** ——
  这样软件升级/重装不会把备份一并删掉。

```bash
# 同步侧栏源码 → maphelper/，再构建 + 打包（推荐，两步合一）
npm run electron:build

# 只同步侧栏（改完侧栏源码想单独刷新时）
npm run sync:maphelper
```

## 开发环境设置

### 前置要求

- Node.js 20 或更高版本
- npm 或 yarn 包管理器

### 安装依赖

```bash
npm install
```

### 运行开发服务器

```bash
npm run electron:dev
```

这将启动 Vite 开发服务器和 Electron 应用。

### 构建应用程序

```bash
npm run electron:build
```

构建后的**安装程序**与**免安装版**会输出到 `package.json` 里
`build.directories.output` 指定的目录（当前是 `…/BPM测速助手_v0.8.5`）。

## GitHub Actions 自动构建

项目配置了 GitHub Actions 来自动构建和发布应用程序。

### 工作流

- 当推送到 `main` 或 `master` 分支时，会触发构建
- 当创建标签（如 `v1.0.0`）时，会创建发布版本
- 支持 Windows, macOS 和 Linux 平台

### 构建产物

- Windows: NSIS 安装程序 (.exe)
- macOS: DMG 安装包 (.dmg)
- Linux: AppImage (.AppImage)

## 打包说明

### Windows

需要安装 Windows SDK 来签名应用程序。

### macOS

需要配置代码签名证书。

### Linux

需要安装 AppImage 相关依赖。

## 文件结构

```
boot.cjs                 # ★ 双模式入口：默认走主程序，带 --maphelper 走内置侧栏
main.ts                  # 主进程源码（含「制谱侧栏」启动逻辑）
maphelper/               # ★ 打包进来的制谱侧栏（同步脚本生成，勿手改）
├── electron/main.cjs      #     侧栏主进程（自建核心 + app:// 协议 + 多窗口）
├── src/                   #     侧栏业务逻辑（bpmSettings.mjs 负责读本软件的设置）
└── renderer/              #     侧栏界面
scripts/
└── sync-maphelper.mjs   # ★ 把外部 osu-maphelper_v<版本> 同步成 maphelper/

dist-electron/
├── main.js          # 编译后的 Electron 主进程
└── preload.cjs      # Electron 预加载脚本

dist/
├── index.html
└── assets/index-MMMMMMMM.js / index-NNNNNNNN.css
```

## 配置文件

### package.json

```json
{
  "main": "boot.cjs",
  "build": {
    "appId": "com.bpmmeasurer.util",
    "productName": "BPM 测速助手",
    "asar": false,
    "directories": {
      "output": "D:/tmp/新建文件夹/bpm app/BPM测速助手_v0.8.5"
    },
    "files": [
      "dist/**/*",
      "dist-electron/**/*",
      "boot.cjs",
      "maphelper/**/*",
      "package.json"
    ]
  }
}
```

> `asar` 保持 `false`：侧栏要按普通文件路径读取自己的 `renderer/`、`src/`，
> 打进 asar 后自定义协议取文件会麻烦很多；且关掉 asar 便于用户排查。

## 原项目说明

> 这是一个BPM测量器，用于手工精确测量歌曲的BPM，来用于你的音乐游戏关卡中。可以测量存在变速的歌曲。
> 该程序完全由gemini ai制作。

> 运行

> 运行前请先安装Node.js

> 1. 安装依赖:
>    在文件夹内打开cmd执行`npm install`
> 2. 运行:`npm run dev`
> 3. 在浏览器访问`localhost:3000`

## 许可证

MIT
