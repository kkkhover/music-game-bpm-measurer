# BPM 测速助手 - Electron

使用 Electron 封装的 BPM 测速助手 GUI 应用程序。

- 原项目：[CMYC4237/Bpm-Measurer](https://github.com/CMYC4237/Bpm-Measurer)
- Electron 打包版：[iExploder/Bpm-Measurer-Util](https://github.com/iExploder/Bpm-Measurer-Util)
- 本仓库：在上一版之上继续开发

三代均为 Apache License 2.0。许可全文见仓库根目录 `LICENSE`，版权声明见 `NOTICE`。

## 构建

需要 Node.js 20 及以上。

```bash
npm ci
npm run electron:build   # 同步侧栏 → 编译 → 打包
npm run electron:dev     # 开发模式
npm run sync:maphelper   # 仅同步侧栏
```

产物输出到 `package.json` 的 `build.directories.output`。

## 目录

```
boot.cjs                双模式入口（默认主程序，--maphelper 启动侧栏）
main.ts                 主进程
preload.cts             预加载脚本
App.tsx                 界面主组件
maphelper/              制谱侧栏（sync-maphelper.mjs 生成，勿手改）
scripts/                构建与同步脚本
dist-electron/          编译后的主进程与预加载
dist/                   前端产物
```

`asar` 保持 `false`，侧栏需按普通文件路径读取自己的资源。
