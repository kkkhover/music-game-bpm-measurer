// ============================================================================
// 双模式入口（Electron 主进程）—— v0.8.5 起
// ============================================================================
// 为什么必须有这个文件？
//   Electron **打包之后，入口是被写死的**：运行时永远加载
//   <安装目录>\resources\app 下 package.json 里 main 指向的那个文件。
//   命令行里再传别的目录也会被忽略（打包后 process.defaultApp === false，
//   Electron 只认 exe 旁边的 resources/app，不认路径参数）。
//
//   于是"让同一个 exe 既能是 BPM 测速助手、又能是制谱侧栏"的唯一可行做法是：
//   **同一个入口文件按启动参数分流**。这就是本文件的全部职责。
//
// 两种模式：
//   · 默认（无参数）  → 加载主程序 dist-electron/main.js
//   · --maphelper     → 加载内置侧栏 maphelper/electron/main.cjs
//
// 为什么一个用动态 import()、一个用 require()：
//   本包 package.json 里是 "type": "module"，所以 .js 一律是 ESM（只能 import）；
//   而侧栏主进程是 .cjs（CommonJS，只能 require）。
//   .cjs 里 import() 与 require() 都能用，正好各取所需。
//   （别把主程序改成 require('./dist-electron/main.js') —— Node 20 默认不支持 require(ESM)。）
// ============================================================================
'use strict';

const path = require('node:path');
const fs = require('node:fs');

/** 是否以「制谱侧栏」模式启动 */
const MAPHELPER_MODE = process.argv.includes('--maphelper');

/** 统一兜底：把错误弹给用户再退出（否则打包后是"双击没反应"，极难排查） */
function fatal(title, detail) {
    console.error(`[boot] ${title}:`, detail);
    const { app, dialog } = require('electron');
    app.whenReady().then(() => {
        dialog.showErrorBox(title, String(detail));
        app.quit();
    });
}

if (MAPHELPER_MODE) {
    // ---------------------------------------------------------------- 侧栏模式
    // 侧栏源码整棵树随 package.json 的 files 一起进了 <resources>\app\maphelper\，
    // 入口就是它原本的 electron/main.cjs —— 自己起本地核心 + 注册 app:// 协议 + 建多窗口，
    // 跟"单独双击侧栏"跑的是完全同一份代码，没有任何裁剪。
    const entry = path.join(__dirname, 'maphelper', 'electron', 'main.cjs');
    if (!fs.existsSync(entry)) {
        fatal('内置侧栏缺失', `未找到侧栏入口：\n${entry}\n\n打包时请确认 package.json 的 files 里包含 "maphelper/**/*"。`);
    } else {
        process.env.OSU_MAPHELPER_BUNDLED = '1'; // 标记"我是在软件里跑的"，供侧栏自报状态用
        require(entry);
    }
} else {
    // -------------------------------------------------------------- 主程序模式
    // 动态 import：主程序会自己 app.whenReady()，这里只要把它跑起来即可。
    import('./dist-electron/main.js').catch((err) => {
        fatal('主程序加载失败', err && err.stack ? err.stack : err);
    });
}
