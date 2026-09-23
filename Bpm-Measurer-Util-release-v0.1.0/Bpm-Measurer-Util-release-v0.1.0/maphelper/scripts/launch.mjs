// ============================================================================
// 启动器 —— 找 Electron、必要时建"复用联接"，然后拉起侧栏
//
// 背景：Electron 主进程里 `require('electron')` 需要该包能被 Node 解析到。
//       本项目不重复下载 200MB+ 的 Electron，而是：
//         ① 先在项目内找 node_modules/electron
//         ② 找不到就去邻近项目找现成的
//         ③ 找到后在本项目建一个**目录联接(junction)** 指过去 —— 零拷贝、免管理员权限
//
// 用法：
//   node scripts/launch.mjs                 → 起侧栏窗口
//   node scripts/launch.mjs --screenshot    → 只渲染一次并存图（自测用）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SCREENSHOT = process.argv.includes('--screenshot');

/** 从一个 node_modules 目录里找 electron 包目录（返回包目录本身，不是 exe） */
function electronPkgIn(nodeModulesDir) {
    const pkgDir = path.join(nodeModulesDir, 'electron');
    if (!fs.existsSync(path.join(pkgDir, 'package.json'))) return '';
    return pkgDir;
}

/** 从 electron 包目录里解出真正的可执行文件路径 */
function exeFromPkgDir(pkgDir) {
    const pathTxt = path.join(pkgDir, 'path.txt');
    if (fs.existsSync(pathTxt)) {
        const exe = path.join(pkgDir, 'dist', fs.readFileSync(pathTxt, 'utf8').trim());
        if (fs.existsSync(exe)) return exe;
    }
    for (const n of ['electron.exe', 'electron']) {
        const p = path.join(pkgDir, 'dist', n);
        if (fs.existsSync(p)) return p;
    }
    return '';
}

/** 在邻近项目里递归找现成的 electron 包（有界深度） */
function findNeighborElectronPkg() {
    const roots = [path.resolve(ROOT, '..'), path.resolve(ROOT, '..', '..')];
    const seen = new Set();
    const walk = (dir, depth) => {
        if (depth > 4 || seen.has(dir)) return '';
        seen.add(dir);

        const hit = electronPkgIn(path.join(dir, 'node_modules'));
        if (hit) return hit;

        let entries = [];
        try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
        } catch {
            return '';
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const found = walk(path.join(dir, e.name), depth + 1);
            if (found) return found;
        }
        return '';
    };
    for (const r of roots) {
        if (!fs.existsSync(r)) continue;
        const found = walk(r, 0);
        if (found) return found;
    }
    return '';
}

console.log('');

// ---- 1. 定位 electron ----
let exe = '';

if (process.env.ELECTRON_PATH && fs.existsSync(process.env.ELECTRON_PATH)) {
    exe = process.env.ELECTRON_PATH;
    console.log('[启动器] 使用 ELECTRON_PATH:', exe);
} else {
    const localPkg = electronPkgIn(path.join(ROOT, 'node_modules'));
    if (localPkg) {
        exe = exeFromPkgDir(localPkg);
        console.log('[启动器] 使用项目内 Electron:', exe);
    }
}

if (!exe || !fs.existsSync(exe)) {
    const pkgDir = findNeighborElectronPkg();
    if (pkgDir) {
        exe = exeFromPkgDir(pkgDir);
        console.log('[启动器] 复用邻近项目的 Electron:', pkgDir);
    }
}

if (!exe || !fs.existsSync(exe)) {
    console.log('  没找到可用的 Electron。三种办法：');
    console.log('');
    console.log('  【A】只跑网页版（不需要 Electron，立刻可用）');
    console.log('       双击 "仅网页版.bat"，然后用浏览器打开 http://127.0.0.1:24100');
    console.log('');
    console.log('  【B】本项目装一个 Electron：');
    console.log(`       cd /d "${ROOT}"`);
    console.log('       npm install electron --no-save');
    console.log('');
    console.log('  【C】指定已有的 Electron 可执行文件：');
    console.log('       set ELECTRON_PATH=D:\\path\\to\\electron.exe');
    console.log('       node scripts\\launch.mjs');
    console.log('');
    process.exit(1);
}

// ---- 2. 清理会破坏 Electron 的环境变量 ----
// 【重要】ELECTRON_RUN_AS_NODE=1 会让 Electron 以"纯 Node 模式"启动：
//   没有 app / BrowserWindow，require('electron') 直接报 Cannot find module。
//   本机会话环境里恰好有这个变量，必须先摘掉。
const childEnv = { ...process.env };
delete childEnv.ELECTRON_RUN_AS_NODE;

// ---- 3. 拉起 ----
const args = ['.'];
if (SCREENSHOT) args.push('--screenshot');

console.log('[启动器] 启动:', exe, args.join(' '));

// ---- 4. 日志落文件，不走继承管道 ----
// 【为什么不用 stdio:'inherit'】继承意味着 Electron 的 stdout 直通本启动器的
//   管道；而本启动器自己又被别的终端/任务系统包着。任何一环先关闭管道读端，
//   Electron 里再写日志就是 EPIPE，直接把主进程弹窗崩掉（实际发生过）。
// 解法：stdout/stderr 重定向到项目内日志文件（每次启动截断），与父进程管道
//   彻底解耦 —— 终端怎么关都不影响侧栏。排查问题直接看这个文件。
const logDir = path.join(ROOT, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, 'electron.log');
// 【关键】spawn 的 stdio 只接受真实文件描述符（fd 数字），不接受未打开的
//   WriteStream（fd 还是 null 时会抛 ERR_INVALID_ARG_VALUE）。先用 openSync
//   拿到真实 fd，再把 fd 传给 spawn，子进程写日志才真正落到这个文件。
const logFd = fs.openSync(logPath, 'w'); // 'w' 每次启动新日志

console.log('[启动器] 日志文件:', logPath);
console.log('');

const child = spawn(exe, args, {
    cwd: ROOT,
    stdio: ['ignore', logFd, logFd],
    windowsHide: false,
    env: childEnv
});
child.on('exit', (code) => {
    try { fs.closeSync(logFd); } catch { /* 已关/无效则忽略 */ }
    process.exit(code ?? 0);
});
// 启动器自己也不得因管道问题崩溃（同样挂一层 EPIPE 防护）
for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') {
        stream.on('error', (e) => { if (e && e.code === 'EPIPE') return; throw e; });
    }
}
