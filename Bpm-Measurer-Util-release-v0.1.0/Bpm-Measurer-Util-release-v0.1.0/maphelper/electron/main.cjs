// ============================================================================
// Electron 主进程（CommonJS 入口）
//
// 为什么用 .cjs 而不是 .mjs：
//   Electron 34 内置 Node 20，用 ESM(.mjs) 作主进程入口时会挂在
//   "cjsPreparseModuleExports / Cannot read properties of undefined (reading 'exports')"。
//   CJS 入口稳定；内部需要用到我们自己的 ESM 模块时，用动态 import() 即可。
//
// 为什么界面走 app:// 而不是 http://127.0.0.1：
//   实测本机（装了系统代理）里 Chromium 加载 http://127.0.0.1:24100/ 会直接
//   ERR_FAILED (-2)，重试、--no-proxy-server 都不管用，界面一片空白。
//   app:// 是进程内自定义协议：没有端口、没有 socket、不过代理，稳。
//   （网页模式仍然保留 HTTP，用"仅网页版"启动脚本跑。）
// ============================================================================
const { app, BrowserWindow, screen, protocol, powerSaveBlocker, shell } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync, execFile } = require('node:child_process');

// ---------------------------------------------------------------------------
// 【EPIPE 防护】必须放在最前面 —— 任何 console.log 之前。
//
// 症状：弹窗 "A JavaScript error occurred in the main process: EPIPE: broken
//       pipe, write"，栈指向某一行 console.log，点确定后整个侧栏退出。
// 真相：侧栏常由启动器/脚本层层 spawn（stdio 继承），主进程的 stdout 是一条
//       管道。当管道读端（终端/父进程）先关闭，再写日志就会 EPIPE。
//       对 pipe 类型的 process.stdout，Node 会把写失败以 'error' 事件发出；
//       【没有人监听时才升级为未捕获异常】（Node 官方文档明确行为）。
// 修法：给 stdout/stderr 挂上 'error' 监听 —— EPIPE（管道断了）静默忽略，
//       其余错误原样重抛，不吞真 bug。这样终端/父进程无论何时关闭，
//       侧栏都只丢日志、不崩窗口。
// ---------------------------------------------------------------------------
for (const stream of [process.stdout, process.stderr]) {
    if (stream && typeof stream.on === 'function') {
        stream.on('error', (e) => {
            if (e && e.code === 'EPIPE') return; // 管道读端没了：只丢日志，照常运行
            throw e;                              // 其他错误照旧抛出
        });
    }
}

// ---------------------------------------------------------------------------
// 【必须放在 app.ready 之前】把 app:// 注册成"标准 + 安全"协议。
//   standard   → 让 URL 能正确解析出 host/path，相对路径 fetch('xxx') 才会对
//   secure     → 页面被视为安全上下文（可用 clipboard 等 API）
//   supportFetchAPI → 页面里可以用 fetch()
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
    {
        scheme: 'app',
        privileges: {
            standard: true,
            secure: true,
            supportFetchAPI: true,
            stream: true
        }
    }
]);

const APP_ORIGIN = 'app://renderer';
const INDEX_URL = `${APP_ORIGIN}/index.html`;

let win = null; // 主窗口
let coreHandle = null;
let followTimer = null;
let lastAutoPlace = 0; // 上次"自动摆位"时间戳，用来区分用户拖动
let mods = null; // { startCore, createRouter, loadConfig, saveConfig }

const SCREENSHOT_MODE = process.argv.includes('--screenshot');

// ============================================================================
// 功能区块（panel）→ 独立子窗口定义
// 每个 panel 加载 renderer/<panel>.html，独立窗口，可置顶、可自由摆放。
// ★ v0.8.4：原「红线 timing」窗口已**合并进 viz 窗口**（上半频谱声谱 / 下半变速段落），
//   这里不再有 timing 这个 panel。
// ============================================================================
const PANELS = {
    viz: { html: 'viz.html', title: '频谱声谱 + 变速段落', width: 980, height: 560, minWidth: 640, minHeight: 380 },
    map: { html: 'map.html', title: '谱面信息', width: 380, height: 300, minWidth: 280, minHeight: 200 },
    backup: { html: 'backup.html', title: '自动备份', width: 420, height: 360, minWidth: 320, minHeight: 240 },
    settings: { html: 'settings.html', title: '设置', width: 440, height: 560, minWidth: 340, minHeight: 300 },
    log: { html: 'log.html', title: '日志', width: 420, height: 360, minWidth: 300, minHeight: 200 }
};
const panelWindows = new Map(); // panelId -> BrowserWindow

// 新建 panel 窗口默认置顶（用户要求"生成新窗口默认置顶"）。
// 用户手动关掉置顶后会被记进 config.panels[id].pinned，之后按记录走。
const DEFAULT_PINNED = true;

// ---------------------------------------------------------------------------
// 【必须】关掉 Chromium 沙箱（--no-sandbox）。
//
// 症状：窗口能创建，但页面永远 ERR_FAILED (-2)，界面一片空白。
// 真相：不是加载的问题 —— 是 Chromium 的渲染/GPU 子进程被系统直接杀掉
//       （render-process-gone: {"reason":"killed","exitCode":1}），
//       子进程一死，这次导航就报 ERR_FAILED。
//       在一些受限环境（企业策略 / 安全软件 / 沙箱内运行）里必然发生，
//       在普通桌面环境里不会，所以这个开关两头都安全。
//
// 安全性：本侧栏只加载项目自带的本地页面，且 contextIsolation:true、
//         nodeIntegration:false，不加载任何远程内容，关沙箱风险可忽略。
//         确实需要保留沙箱的话，设环境变量 OSU_MAPHELPER_SANDBOX=1 即可。
if (process.env.OSU_MAPHELPER_SANDBOX !== '1') {
    app.commandLine.appendSwitch('no-sandbox');
}

// 【性能】关掉 2D canvas 的 GPU 加速（对齐 BPM 测速助手《性能诊断报告》的 P0-1）。
// 频谱/声谱走的是 putImageData 逐像素写入：开了加速反而要把整块像素数据
// 从 CPU 内存上传到显存，在混合显卡笔记本上「上传→光栅化→显示」的往返比
// 直接 CPU 写内存更慢。关掉后 putImageData 走 CPU 光栅化，拖频谱帧率明显回升。
//
// ⚠ 这是一把双刃剑：走 CPU 光栅化意味着**一旦 CPU 被别的程序（如全屏游戏）抢走，
//   频谱就会跟着卡**。默认保持关闭（多数机器上更快）；
//   若你的机器上"切进游戏后反而更卡"（或 CPU 较弱），设环境变量
//   OSU_MAPHELPER_CANVAS_GPU=1 换回硬件加速 2D canvas 再试。
if (process.env.OSU_MAPHELPER_CANVAS_GPU !== '1') {
    app.commandLine.appendSwitch('disable-accelerated-2d-canvas');
}

// 【性能·必开】禁止 Chromium 在"窗口不在前台 / 被遮挡"时锁帧。
// 侧栏的播放头与自动翻页靠 requestAnimationFrame 驱动，状态轮询靠 setInterval；
// 默认情况下 Chromium 会把后台窗口的 rAF 压到 1fps、定时器压到 1s，
// 表现就是"点了 osu! 制谱器的播放，侧栏频谱却卡住不跟随、播放头不动"。
// 三个开关 + webPreferences.backgroundThrottling:false 一起才彻底关得掉：
//   · disable-background-timer-throttling      → setInterval/setTimeout 不降频
//   · disable-renderer-backgrounding           → 渲染进程不被整体降级
//   · disable-backgrounding-occluded-windows   → 被别的窗口完全盖住时也不降低优先级
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

// 【性能·必开】上面三个开关还不够 —— Windows 上有两套"页面被判隐藏 → 降频"
// 的机制，必须用 disable-features 单独关掉，否则会出现：
//   ★ 挂着侧栏 → 切进 osu! 全屏编辑谱面 → 频谱预览卡顿 / 低帧率（本问题）。
//
//   · CalculateNativeWinOcclusion
//       Windows 原生遮挡检测：窗口被别的窗口**完全盖住**时（全屏游戏），
//       系统会把窗口报告为不可见 → 页面立刻变 hidden → requestAnimationFrame
//       不是降频而是**直接停摆**（播放头定住、自动翻页失效、声谱不再流动）。
//       关掉后即便被全屏盖住，页面依然保持 visible，rAF 照常跑。
//   · IntensiveWakeUpThrottling
//       Chrome 88+ 的"隐藏页面定时器强化节流"：页面 hidden 且静置一段时间后，
//       setInterval 被压到**每 1 分钟才醒一次**（100ms 的状态轮询直接停摆）。
//       这就是为什么必须连它一起关 —— 只关前者的话，一旦页面隐藏仍会被它掐死。
app.commandLine.appendSwitch('disable-features',
    'CalculateNativeWinOcclusion,IntensiveWakeUpThrottling');

// ---------------------------------------------------------------------------
// 【性能】把侧栏自己的进程优先级提到"高于正常"（ABOVE_NORMAL_PRIORITY_CLASS）。
//
// 为什么需要：osu! 全屏运行时是**前台窗口**，Windows 与 DWM 会把 CPU/GPU 调度
// 大幅倾斜给它；侧栏的渲染进程默认只有 Normal 优先级，抢不到时间片，
// 表现就是"切进游戏画面编辑谱面后，频谱预览卡顿、帧率掉下来"。
// 提到 AboveNormal 后能跟游戏"平起平坐地抢时间片"——
// 刻意**不用** HIGH、更不用 REALTIME：那会反过来饿死游戏和系统，得不偿失。
//
// 安全边界：以**本进程 PID 为根**做进程树广度优先，只提升侧栏自己
//（主进程 + 它的 renderer / GPU / utility 子进程）。
// 软件主进程是侧栏的**父进程**，不在树里，所以绝不会被误提；osu! 更完全无关。
// 想关掉：设环境变量 OSU_MAPHELPER_NO_PRIORITY_BOOST=1。
// ---------------------------------------------------------------------------
function boostProcessPriority() {
    if (process.platform !== 'win32') return;
    if (process.env.OSU_MAPHELPER_NO_PRIORITY_BOOST === '1') return;
    const script = `
$root = [int]$env:MH_ROOT_PID
$procs = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId)
$want = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$want.Add($root)
for ($i = 0; $i -lt 6; $i++) {
  $added = 0
  foreach ($p in $procs) {
    if ($want.Contains([int]$p.ParentProcessId) -and -not $want.Contains([int]$p.ProcessId)) {
      [void]$want.Add([int]$p.ProcessId); $added++
    }
  }
  if ($added -eq 0) { break }
}
$n = 0
foreach ($one in @($want)) {
  try {
    $pr = Get-Process -Id $one -ErrorAction Stop
    if ($pr.PriorityClass -ne 'AboveNormal') { $pr.PriorityClass = 'AboveNormal'; $n++ }
  } catch { }
}
Write-Output $n`;
    // 异步跑 PowerShell 提升优先级（v0.8.10：不再用 execFileSync——它会在启动期
    // 把主进程卡住 2~5 秒，页面加载和状态轮询全部排队，就是"刚打开卡顿"的元凶之一）
    const run = () => {
        execFile(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            {
                encoding: 'utf8',
                timeout: 12000,
                windowsHide: true,
                stdio: ['ignore', 'pipe', 'ignore'],
                env: Object.assign({}, process.env, { MH_ROOT_PID: String(process.pid) })
            },
            (err, out) => {
                if (err) {
                    console.log('[osu-maphelper] 进程优先级提升失败（忽略，不影响功能）:', err.message);
                    return;
                }
                console.log('[osu-maphelper] 进程优先级 → AboveNormal：', String(out).trim(), '个进程');
            }
        );
    };
    // 子进程（renderer / GPU）是陆续创建的，错峰补两次即可全部覆盖
    setTimeout(run, 1200);
    setTimeout(run, 5000);
}

// ---------------------------------------------------------------------------
// 【性能】阻止 Windows 把侧栏当成"空闲应用"降频 / 挂起。
// 侧栏是常驻仪表盘，挂着不操作是常态；系统节能策略会把非前台应用冻结渲染，
// prevent-app-suspension 让 Electron 明确告诉系统"我在运行，别冻我"。
// （用 prevent-app-suspension 而不是 prevent-display-sleep：只防挂起，不阻止息屏。）
// ---------------------------------------------------------------------------
let keepAliveId = -1;
function keepAlive() {
    try {
        if (keepAliveId >= 0 && powerSaveBlocker.isStarted(keepAliveId)) return;
        keepAliveId = powerSaveBlocker.start('prevent-app-suspension');
        console.log('[osu-maphelper] powerSaveBlocker(prevent-app-suspension) started =',
            powerSaveBlocker.isStarted(keepAliveId), '/ id =', keepAliveId);
    } catch (e) {
        console.log('[osu-maphelper] powerSaveBlocker 启动失败（忽略）:', e.message);
    }
}

// 截图模式（无人值守）下没有可用的 GPU，关掉硬件加速防止启动期卡住。
// 正常运行时保留硬件加速（侧栏要流畅滚动）。
if (SCREENSHOT_MODE) {
    app.disableHardwareAcceleration();
    app.commandLine.appendSwitch('disable-gpu');
}

/**
 * 读 osu! 主窗口矩形（Win32 GetWindowRect），拿不到返回 null。
 * ★ v0.8.10 性能：改异步（execFile）——默认配置下 autoPlace 每 2 秒跟随一次
 *   osu! 摆位，原来 execFileSync 同步跑 PowerShell（1~3 秒）会把主进程整个
 *   卡住，页面加载/状态轮询全部排队，就是"刚打开侧栏未响应、卡顿"的主因。
 */
function getOsuWindowRectAsync() {
    return new Promise((resolve) => {
        const script = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class OsuWin {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
}
"@
$p = Get-Process -Name 'osu!' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($p) {
  $r = New-Object OsuWin+RECT
  if ([OsuWin]::GetWindowRect($p.MainWindowHandle, [ref]$r)) {
    if ($r.Right -gt $r.Left) { Write-Output "$($r.Left),$($r.Top),$($r.Right),$($r.Bottom)" }
  }
}`;
        try {
            execFile(
                'powershell',
                ['-NoProfile', '-NonInteractive', '-Command', script],
                { encoding: 'utf8', timeout: 8000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
                (err, stdout) => {
                    if (err || !stdout) return resolve(null);
                    const out = String(stdout).trim();
                    if (!out) return resolve(null);
                    const [l, t, r, b] = out.split(',').map(Number);
                    if (![l, t, r, b].every(Number.isFinite) || r <= l) return resolve(null);
                    resolve({ left: l, top: t, right: r, bottom: b, width: r - l, height: b - t });
                }
            );
        } catch {
            resolve(null);
        }
    });
}

/** 计算侧栏应该放哪（异步：内部要等 osu! 窗口矩形的 PowerShell 探测结果） */
async function computeBounds() {
    const cfg = mods.loadConfig();
    const w = cfg.window.width || 400;
    const h = cfg.window.height || 940;

    if (cfg.window.x !== null && cfg.window.y !== null) {
        const savedRect = { x: cfg.window.x, y: cfg.window.y, width: w, height: h };
        // 老坐标可能来自另一台显示器 / 另一个分辨率：已经基本不在屏幕里就作废。
        // 阈值放到 10% 这么松，是为了不打扰"故意把侧栏拖到屏幕边上"的正常用法。
        if (visibleRatio(savedRect) >= 0.1) return savedRect;
        console.log(
            `[osu-maphelper] 侧栏保存的位置已跑出屏幕（x=${cfg.window.x}, y=${cfg.window.y}），重新自动摆位`
        );
        mods.saveConfig({ window: { x: null, y: null } });
    }

    const osuRect = await getOsuWindowRectAsync();
    const display = osuRect
        ? screen.getDisplayMatching({
              x: osuRect.left,
              y: osuRect.top,
              width: osuRect.width,
              height: osuRect.height
          })
        : screen.getPrimaryDisplay();
    const wa = display.workArea;

    let x;
    let y;
    if (osuRect) {
        x = osuRect.right + 4;
        y = osuRect.top;
    } else {
        x = wa.x + wa.width - w - 8;
        y = wa.y + 8;
    }

    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - w));
    const maxH = wa.y + wa.height - y;
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: w,
        height: Math.round(Math.max(320, Math.min(h, maxH)))
    };
}

/**
 * 加载本地页面，带重试。
 * app:// 是进程内协议，正常一次就成；留重试是为了防协议注册/窗口就绪的时序竞争。
 */
async function loadWithRetry(bw, url, attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
        try {
            await bw.loadURL(url);
            return true;
        } catch (e) {
            console.log(`[osu-maphelper] 第 ${i} 次加载失败: ${e.message}`);
            if (i < attempts) await new Promise((r) => setTimeout(r, 800));
        }
    }
    console.log(`[osu-maphelper] 页面加载失败：${url}`);
    return false;
}

/** 自动跟随摆位（异步 + in-flight 守卫：上一轮 PowerShell 没回来就不叠加新一轮） */
let placing = false;
async function autoPlace() {
    if (!win || win.isDestroyed()) return;
    const cfg = mods.loadConfig();
    if (cfg.window.x !== null && cfg.window.y !== null) return;
    if (placing) return;
    placing = true;
    try {
        const b = await computeBounds();
        if (!win || win.isDestroyed()) return;
        const cur = win.getBounds();
        if (Math.abs(cur.x - b.x) > 2 || Math.abs(cur.y - b.y) > 2 || Math.abs(cur.height - b.height) > 4) {
            lastAutoPlace = Date.now();
            win.setBounds(b);
        }
    } finally {
        placing = false;
    }
}

/**
 * 同步窗口透明度（设置面板改了 config 后，这里每 500ms 拉一次并应用）。
 * 主窗口读 config.window.opacity；每个 panel 窗口读 config.panels[id].opacity
 * —— 各自独立，一个窗口调暗不影响别的。
 */
function syncOpacity() {
    const cfg = mods.loadConfig();

    if (win && !win.isDestroyed()) {
        const target = cfg.window.opacity !== undefined ? cfg.window.opacity : 1;
        const cur = win.getOpacity ? win.getOpacity() : 1;
        if (Math.abs(cur - target) > 0.005) win.setOpacity(clampOpacity(target));
    }

    for (const [panelId, pw] of panelWindows) {
        if (!pw || pw.isDestroyed()) continue;
        const st = (cfg.panels && cfg.panels[panelId]) || {};
        const target = st.opacity !== undefined ? st.opacity : 1;
        const cur = pw.getOpacity ? pw.getOpacity() : 1;
        if (Math.abs(cur - target) > 0.005) pw.setOpacity(clampOpacity(target));
    }
}

/** 透明度下限 0.2：再低就完全看不见窗口了（拖都拖不回来） */
function clampOpacity(v) {
    return Math.max(0.2, Math.min(1, Number(v) || 1));
}

// ============================================================================
// 功能区块独立窗口管理
// ============================================================================

/** 读 panel 窗口的持久化位置/尺寸/置顶 */
function panelState(panelId) {
    const cfg = mods.loadConfig();
    return (cfg.panels && cfg.panels[panelId]) || null;
}

/** 保存 panel 窗口状态 */
function savePanelState(panelId, patch) {
    const cfg = mods.loadConfig();
    const cur = (cfg.panels && cfg.panels[panelId]) || {};
    const next = { ...cur, ...patch };
    const panels = { ...(cfg.panels || {}) };
    panels[panelId] = next;
    mods.saveConfig({ panels });
}

// ---------------------------------------------------------------------------
// 【窗口生成位置】panel 子窗口一律"贴着侧栏侧边"生成（只在**首次生成**时算一次）。
//
// 老逻辑的坑：x = 侧栏.x + 侧栏宽 + 8。
//   侧栏默认摆位就是贴 osu! 窗口 / 屏幕右侧边缘的，此时 x 已经越过屏幕右边界，
//   于是 panel "生成位置错误"：要么整块跑到屏幕外看不见，要么被系统丢到奇怪的位置。
//   而 y 又只是加了个 40，跟侧栏顶边不对齐，看着也不像"贴上去"。
//
// 现在的规则（越靠前的优先级越高）：
//   1. 右侧放得下就贴右侧；右侧放不下就贴左侧（绝对不往屏幕外生）
//   2. 纵向与侧栏顶边对齐（视觉上是"贴上去"的）
//   3. 位置被已经打开的 panel 占了 → 顺着这一侧往下排；一列排满再往外开一列
//   4. 两侧都塞不下（侧栏几乎占满屏幕宽）→ 夹回工作区内，不留半截在屏幕外
//
// ★ "吸附功能"（拖拽磁吸对齐 + 🔗 一键吸附回位）已按需求删除：
//   生成之后窗口就是自由的，随便拖，不会再被自动拉回去。
// ---------------------------------------------------------------------------
const DOCK_GAP = 0; // 与侧栏之间的间隙（0 = 严丝合缝，真正的"吸附"）
const DOCK_MIN_W = 240; // panel 窗口的可用最小宽
const DOCK_MIN_H = 160; // panel 窗口的可用最小高

/** 两个矩形是否相交 */
function rectsOverlap(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** 矩形在屏幕工作区内的可见面积占比（0~1，取所有显示器里最好的那个） */
function visibleRatio(rect) {
    const area = Math.max(1, rect.width * rect.height);
    let best = 0;
    for (const d of screen.getAllDisplays()) {
        const wa = d.workArea;
        const w = Math.min(rect.x + rect.width, wa.x + wa.width) - Math.max(rect.x, wa.x);
        const h = Math.min(rect.y + rect.height, wa.y + wa.height) - Math.max(rect.y, wa.y);
        if (w > 0 && h > 0) best = Math.max(best, (w * h) / area);
    }
    return best;
}

/** 把矩形夹进工作区（尺寸放不下时才收缩） */
function clampToWorkArea(x, y, w, h, wa) {
    const cw = Math.max(DOCK_MIN_W, Math.min(w, wa.width));
    const ch = Math.max(DOCK_MIN_H, Math.min(h, wa.height));
    return {
        x: Math.round(Math.max(wa.x, Math.min(x, wa.x + wa.width - cw))),
        y: Math.round(Math.max(wa.y, Math.min(y, wa.y + wa.height - ch))),
        width: Math.round(cw),
        height: Math.round(ch)
    };
}

/** 计算"贴着侧栏侧边"的生成位置 */
function snapBesideMain(def) {
    const main = win && !win.isDestroyed() ? win.getBounds() : { x: 0, y: 0, width: 360, height: 460 };
    const wa = screen.getDisplayMatching(main).workArea;

    const w = Math.max(DOCK_MIN_W, Math.min(def.width, wa.width));
    const h = Math.max(DOCK_MIN_H, Math.min(def.height, wa.height));

    // 右侧优先（与"osu! 在左、侧栏在右"的常规摆位一致）；右侧塞不下再考虑左侧
    const roomRight = wa.x + wa.width - (main.x + main.width) - DOCK_GAP;
    const roomLeft = main.x - wa.x - DOCK_GAP;
    const side = roomRight >= w ? 1 : roomLeft >= w ? -1 : 0;

    // 已打开的 panel 窗口算障碍物，避免新窗口直接压在旧窗口上
    const obstacles = [];
    for (const pw of panelWindows.values()) {
        if (pw && !pw.isDestroyed()) obstacles.push(pw.getBounds());
    }

    // 侧栏顶边对齐（side=0 时先按右侧算，最后统一夹回工作区）
    let x = side === -1 ? main.x - w - DOCK_GAP : main.x + main.width + DOCK_GAP;
    let y = Math.max(wa.y, Math.min(main.y, wa.y + wa.height - h));

    for (let col = 0; side !== 0 && col < 6; col++) {
        if (x < wa.x || x + w > wa.x + wa.width) break; // 这一列已经出屏
        let cy = y;
        for (let row = 0; row < 10; row++) {
            const hit = obstacles.find((o) => rectsOverlap({ x, y: cy, width: w, height: h }, o));
            if (!hit) return { x: Math.round(x), y: Math.round(cy), width: Math.round(w), height: Math.round(h) };
            cy = hit.y + hit.height + DOCK_GAP;
            if (cy + h > wa.y + wa.height) break; // 这一列排到底了 → 换下一列
        }
        x += side * (w + DOCK_GAP);
        y = wa.y;
    }

    // 兜底：两侧都没空间（侧栏几乎占满屏幕宽）→ 夹回工作区内
    return clampToWorkArea(x, y, w, h, wa);
}

/**
 * 计算新 panel 窗口的初始位置。
 * 优先复用"用户自己摆过的位置"，但那个位置必须还确实看得见；
 * 否则（没摆过 / 换分辨率 / 换显示器后老坐标飘到屏幕外）一律重新吸附到侧栏侧边。
 */
function panelInitialBounds(panelId) {
    const def = PANELS[panelId];

    const saved = panelState(panelId);
    if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
        const rect = {
            x: saved.x,
            y: saved.y,
            width: saved.width || def.width,
            height: saved.height || def.height
        };
        // 可见面积不足 60% 就认为这条记录已失效（比如分辨率变小、拔了副屏）
        if (visibleRatio(rect) >= 0.6) return rect;
        console.log(
            `[osu-maphelper] panel ${panelId} 保存的位置已不可见（x=${saved.x}, y=${saved.y}），改为吸附到侧栏侧边`
        );
    }

    return snapBesideMain(def);
}

/** 打开（或聚焦）一个 panel 独立窗口 */
function openPanelWindow(panelId) {
    const def = PANELS[panelId];
    if (!def) return { ok: false, error: '未知 panel: ' + panelId };

    const existing = panelWindows.get(panelId);
    if (existing && !existing.isDestroyed()) {
        existing.show();
        existing.focus();
        return { ok: true, focused: true };
    }

    const b = panelInitialBounds(panelId);
    const state = panelState(panelId);
    // 新窗口默认置顶；用户关掉过就按记录来
    const pinned = !state || state.pinned === undefined ? DEFAULT_PINNED : !!state.pinned;

    const pw = new BrowserWindow({
        ...b,
        minWidth: def.minWidth,
        minHeight: def.minHeight,
        backgroundColor: '#12131a',
        title: def.title,
        autoHideMenuBar: true,
        alwaysOnTop: pinned,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });
    if (pinned) pw.setAlwaysOnTop(true, 'screen-saver');
    // 每个 panel 窗口独立的透明度（config.panels[id].opacity）
    const opacity = state && state.opacity !== undefined ? state.opacity : 1;
    if (opacity < 1 && pw.setOpacity) pw.setOpacity(clampOpacity(opacity));
    panelWindows.set(panelId, pw);

    const url = `${APP_ORIGIN}/${def.html}`;
    loadWithRetry(pw, url);

    // 注意：创建窗口时设置 bounds 会触发 moved/resized。
    // 如果照单全收就会把"自动摆好的坐标"记成"用户摆的位置"，下次打开就不再跟随侧栏了。
    // 所以刚开窗的 800ms 内不下笔（用户手速再快也不会在这之前拖窗口）。
    let acceptState = false;
    setTimeout(() => {
        acceptState = true;
    }, 800);

    // 拖动结束保存位置/尺寸
    pw.on('moved', () => {
        if (!acceptState || !pw || pw.isDestroyed()) return;
        const [x, y] = pw.getPosition();
        savePanelState(panelId, { x, y });
    });
    pw.on('resized', () => {
        if (!acceptState || !pw || pw.isDestroyed()) return;
        const [w, h] = pw.getSize();
        savePanelState(panelId, { width: w, height: h });
    });
    pw.on('closed', () => {
        panelWindows.delete(panelId);
    });

    return { ok: true, focused: false };
}

/** 列出所有窗口的位置/尺寸/置顶状态 + 各显示器工作区（排查"窗口生成位置不对"） */
function listWindows() {
    const windows = [];
    const push = (id, bw, label) => {
        if (!bw || bw.isDestroyed()) return;
        const b = bw.getBounds();
        windows.push({
            id,
            label,
            x: b.x,
            y: b.y,
            width: b.width,
            height: b.height,
            right: b.x + b.width,
            bottom: b.y + b.height,
            pinned: bw.isAlwaysOnTop(),
            visible: bw.isVisible(),
            visibleRatio: Number(visibleRatio(b).toFixed(3))
        });
    };
    push('sidebar', win, '主窗口（侧栏）');
    for (const [panelId, pw] of panelWindows) {
        push(panelId, pw, PANELS[panelId] ? PANELS[panelId].title : panelId);
    }
    return {
        ok: true,
        windows,
        displays: screen.getAllDisplays().map((d) => ({
            id: d.id,
            bounds: d.bounds,
            workArea: d.workArea,
            scaleFactor: d.scaleFactor
        }))
    };
}

/** 切换 panel 窗口置顶 */
function togglePanelPin(panelId) {
    const pw = panelWindows.get(panelId);
    if (!pw || pw.isDestroyed()) return { ok: false, error: '窗口未打开' };
    const nowPinned = pw.isAlwaysOnTop();
    pw.setAlwaysOnTop(!nowPinned, 'screen-saver');
    savePanelState(panelId, { pinned: !nowPinned });
    return { ok: true, pinned: !nowPinned };
}

/**
 * 读某个 panel 窗口的置顶状态（给标题栏 📌 按钮回显高亮用）。
 * 窗口没开时返回记录里的值，避免按钮状态闪烁。
 */
function panelPinState(panelId) {
    const pw = panelWindows.get(panelId);
    if (pw && !pw.isDestroyed()) return { ok: true, pinned: pw.isAlwaysOnTop(), open: true };
    const st = panelState(panelId);
    const pinned = !st || st.pinned === undefined ? DEFAULT_PINNED : !!st.pinned;
    return { ok: true, pinned, open: false };
}

/**
 * 打开一个文件夹（用系统资源管理器）。
 * type: 'export' = timing 导出的保存文件夹；'backup' = 定时备份文件夹。
 * 目录不存在则先创建（空目录也能打开，方便用户定位）。
 */
function openFolder(type) {
    let dir;
    try {
        dir = type === 'backup' ? mods.getBackupDir() : mods.getExportDir();
        fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
        return { ok: false, error: e.message };
    }
    // shell.openPath 返回 Promise<string>（空串 = 成功）；不等它，失败只记日志
    shell.openPath(dir).then((err) => {
        if (err) console.log('[osu-maphelper] 打开文件夹失败:', dir, err);
    });
    return { ok: true, dir };
}

/** 处理窗口管理请求（主进程专属，router 拿不到 BrowserWindow） */
function handleWindowApi(pathname, body) {
    const json = (obj, status = 200) => ({ status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, body: JSON.stringify(obj) });

    if (pathname === '/api/window/open' && (body || {}).panel) {
        return json(openPanelWindow(body.panel));
    }
    // 打开保存文件夹 / 备份文件夹（需求：快捷按钮）
    if (pathname === '/api/window/open-folder') {
        return json(openFolder((body || {}).type));
    }
    if (pathname === '/api/window/pin' && (body || {}).panel) {
        return json(togglePanelPin(body.panel));
    }
    // 读置顶状态（标题栏 📌 按钮高亮回显）
    if (pathname === '/api/window/pin-state' && (body || {}).panel) {
        return json(panelPinState(body.panel));
    }
    // 列出所有窗口的位置/尺寸 + 各显示器工作区（排查"窗口生成位置不对"用）
    if (pathname === '/api/window/list') {
        return json(listWindows());
    }
    // 返回 BPM 测速助手（需求 6）：把软件窗口恢复并拉到前台，随后**关闭侧栏**。
    if (pathname === '/api/window/focus-bpm') {
        const r = focusBpmWindow();
        // 先把响应发回去，再关闭（否则渲染进程收不到返回）
        setTimeout(() => closeSidebar(), 250);
        return json({ ...r, closing: true });
    }
    return null; // 不是窗口 API
}

/** 关闭整个侧栏（所有 panel 窗口 + 主窗口 → window-all-closed 里退出） */
function closeSidebar() {
    try {
        for (const [, pw] of panelWindows) {
            if (pw && !pw.isDestroyed()) pw.destroy();
        }
        panelWindows.clear();
    } catch { /* 忽略 */ }
    try {
        if (win && !win.isDestroyed()) win.destroy();
    } catch { /* 忽略 */ }
    app.quit();
}

/**
 * 聚焦/恢复 BPM 测速助手的窗口（需求 6：侧栏点「返回软件」要能回到软件）。
 *
 * ★ 不能再用 `Get-Process ... MainWindowHandle`：.NET 的 MainWindowHandle 只在
 *   窗口**可见**时才非零，而软件启动侧栏后会把自己**最小化**起来 —— 那时按
 *   MainWindowHandle 找必然返回 0，用户就再也回不去了（踩过这个思路）。
 *   改为 EnumWindows 枚举**所有顶层窗口**（含隐藏/最小化），按标题匹配后唤醒。
 *
 * ★ 只取"第一个标题命中的窗口"是不够的（踩过）：同名窗口可能有好几个 ——
 *   Electron 会额外创建一个**标题相同但完全隐藏**的辅助窗口，而 EnumWindows 按
 *   Z 序枚举，排在前面的未必是我们想唤醒的那个。对隐藏窗口做 ShowWindow 等于白做，
 *   现象就是"返回按钮点了没反应/软件没出来"。
 *   所以这里**收齐所有命中的窗口**，优先挑 `IsWindowVisible = true` 的
 *   （最小化窗口的 IsWindowVisible 仍为 true、IsIconic 为 true；
 *     而隐藏辅助窗口 IsWindowVisible = false），一个都没有才退回隐藏窗口。
 *
 * ★ 唤醒顺序与返回值：先 SW_RESTORE(9) 再 SW_SHOW(5) + BringWindowToTop +
 *   SetForegroundWindow。返回里带上"还原前/还原后是否仍是最小化（IsIconic）"，
 *   这样前端和排障都能直接看到到底有没有救回来，不用靠肉眼猜。
 */
function focusBpmWindow() {
    const script = `
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class WinFocus2 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
  public static IntPtr FoundVisible = IntPtr.Zero;
  public static IntPtr FoundAny = IntPtr.Zero;
  public static string Log = "";
  public static string[] Want;
  public static bool Cb(IntPtr h, IntPtr l) {
    int len = GetWindowTextLength(h);
    if (len <= 0) return true;
    var sb = new StringBuilder(len + 1);
    GetWindowText(h, sb, sb.Capacity);
    string t = sb.ToString();
    bool match = false;
    foreach (string w in Want) { if (t.IndexOf(w, StringComparison.OrdinalIgnoreCase) >= 0) { match = true; break; } }
    if (!match) return true;
    bool vis = IsWindowVisible(h);
    bool ico = IsIconic(h);
    Log += h.ToInt64() + "!vis=" + vis + "!ico=" + ico + ";";
    if (FoundAny == IntPtr.Zero) FoundAny = h;
    if (vis && FoundVisible == IntPtr.Zero) FoundVisible = h;
    return true;   // 收齐全部命中项，不提前中断
  }
}
"@
[WinFocus2]::Want = @('BPM 测速助手','BPM测速助手','BPM Measurer','Bpm-Measurer')
[WinFocus2]::EnumWindows([WinFocus2+EnumProc]{ param($h,$l) [WinFocus2]::Cb($h,$l) }, [IntPtr]::Zero) | Out-Null
$t = [WinFocus2]::FoundVisible
if ($t -eq [IntPtr]::Zero) { $t = [WinFocus2]::FoundAny }
if ($t -ne [IntPtr]::Zero) {
  $before = [WinFocus2]::IsIconic($t)
  [WinFocus2]::ShowWindow($t, 9) | Out-Null   # SW_RESTORE 先还原（对最小化窗口必须先做这步）
  [WinFocus2]::ShowWindow($t, 5) | Out-Null   # SW_SHOW 再显形（对 hide() 过的情况）
  [WinFocus2]::BringWindowToTop($t) | Out-Null
  [WinFocus2]::SetForegroundWindow($t) | Out-Null
  $after = [WinFocus2]::IsIconic($t)
  Write-Output ("ok hwnd=" + $t.ToInt64() + " iconicBefore=" + $before + " iconicAfter=" + $after + " visible=" + [WinFocus2]::IsWindowVisible($t) + " candidates=[" + [WinFocus2]::Log + "]")
} else {
  Write-Output "not-found"
}`;
    try {
        const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
            encoding: 'utf8',
            timeout: 6000,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
        const m = out.match(/^ok hwnd=(-?\d+) iconicBefore=(\w+) iconicAfter=(\w+) visible=(\w+)/);
        if (!m) return { ok: false, detail: out || 'no-output' };
        return {
            ok: true,
            hwnd: Number(m[1]),
            // 还原是否真的成功：还原后不再是最小化即算成功
            restored: m[3].toLowerCase() === 'false',
            iconicBefore: m[2].toLowerCase() === 'true',
            visible: m[4].toLowerCase() === 'true',
            detail: out
        };
    } catch {
        return { ok: false };
    }
}

/**
 * 【核心】注册 app:// 协议处理器。
 * 页面里 fetch('app://renderer/api/state') 或相对路径 fetch('/api/state')
 * 都会被路由到 src/router.mjs —— 与网页模式共用同一套逻辑。
 */
function registerAppProtocol(handle) {
    protocol.handle('app', async (request) => {
        let pathname = '/';
        try {
            pathname = new URL(request.url).pathname || '/';
        } catch {
            /* 保持默认 */
        }

        try {
            let body = null;
            if (request.method === 'POST' || request.method === 'PUT') {
                try {
                    const raw = await request.text();
                    body = raw ? JSON.parse(raw) : {};
                } catch {
                    body = {};
                }
            }

            // 窗口管理请求由主进程直接处理（router 拿不到 BrowserWindow）
            const winApi = handleWindowApi(pathname, body);
            if (winApi) return new Response(String(winApi.body), { status: winApi.status, headers: winApi.headers });

            const out = await handle(request.method, pathname, body);
            // 注意：前端每 100ms 轮询一次 /api/state，绝不能无脑打日志，否则刷屏。
            if (!pathname.startsWith('/api/state')) {
                console.log(`[protocol] ${request.method} ${request.url} → ${out.status}`);
            }
            // Response 的 body 只接受 string / Uint8Array / ReadableStream。
            // Node 的 Buffer 虽然是 Uint8Array 子类，但转成标准 Uint8Array 更保险。
            const payload = Buffer.isBuffer(out.body)
                ? new Uint8Array(out.body)
                : String(out.body);
            return new Response(payload, { status: out.status, headers: out.headers });
        } catch (e) {
            console.error(`[protocol] 处理失败 ${request.url}:`, e && e.stack ? e.stack : e);
            return new Response('protocol error: ' + (e && e.message), {
                status: 500,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
        }
    });
    console.log('[osu-maphelper] app:// 协议已注册，isProtocolHandled =', protocol.isProtocolHandled ? protocol.isProtocolHandled('app') : 'n/a');
}

async function createWindow() {
    const cfg = mods.loadConfig();
    const b = await computeBounds();

    win = new BrowserWindow({
        ...b,
        minWidth: 320,
        minHeight: 360,
        backgroundColor: '#12131a',
        title: 'osu! 制谱侧栏',
        autoHideMenuBar: true,
        alwaysOnTop: !!cfg.window.alwaysOnTop,
        webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    });

    if (cfg.window.alwaysOnTop) win.setAlwaysOnTop(true, 'screen-saver');
    // 透明度也走 clampOpacity：防止手改 config 成 0.05 后主窗口几乎不可见、抓都抓不回来
    if (cfg.window.opacity && cfg.window.opacity < 1) win.setOpacity(clampOpacity(cfg.window.opacity));

    await loadWithRetry(win, INDEX_URL);

    win.on('moved', () => {
        if (!win || win.isDestroyed()) return;
        if (Date.now() - lastAutoPlace < 2500) return;
        const [x, y] = win.getPosition();
        mods.saveConfig({ window: { x, y } });
    });

    win.on('closed', () => {
        win = null;
        // 主窗口关闭 → 关闭所有 panel 独立窗口
        for (const [id, pw] of panelWindows) {
            if (pw && !pw.isDestroyed()) pw.destroy();
        }
        panelWindows.clear();
    });

    followTimer = setInterval(autoPlace, 2000);
    // 透明度独立于摆位：500ms 一次，滑条改动能及时反映到窗口
    setInterval(syncOpacity, 500);
}

app.whenReady().then(async () => {
    console.log('[osu-maphelper] Electron', process.versions.electron, '/ Node', process.versions.node,
        '/ protocol.handle =', typeof protocol.handle);
    // 反节流 / 反降频：阻止系统把侧栏当空闲应用挂起 + 提升自身进程优先级，
    // 保证"挂着小窗切进 osu! 全屏"时频谱预览不掉帧（详见两个函数上方注释）。
    keepAlive();
    boostProcessPriority();
    // 动态加载我们自己的 ESM 模块（CJS → ESM 的唯一可靠方式）
    const coreMod = await import('../src/core.mjs');
    const routerMod = await import('../src/router.mjs');
    const configMod = await import('../src/config.mjs');
    mods = { startCore: coreMod.startCore, createRouter: routerMod.createRouter, ...configMod };

    // 核心运行时（tosu 轮询 + 谱面读写 + 备份调度）
    coreHandle = await mods.startCore();
    registerAppProtocol(mods.createRouter(coreHandle.app));

    // ---- 截图模式（自测用）：主窗口 + 每个 panel 各渲染一次，存 PNG + 文本后退出 ----
    if (SCREENSHOT_MODE) {
        const outDir = path.join(__dirname, '..', 'tests', 'shots');
        fs.mkdirSync(outDir, { recursive: true });

        const logs = [];
        const makeShotWindow = (w, h) => {
            const bw = new BrowserWindow({
                width: w,
                height: h,
                show: false,
                backgroundColor: '#12131a',
                webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
            });
            bw.webContents.on('console-message', (_e, level, message, line, src) => {
                logs.push(`[console:${level}] ${message} (${src}:${line})`);
            });
            bw.webContents.on('did-fail-load', (_e, code, desc, url) => {
                logs.push(`[did-fail-load] ${code} ${desc} ${url}`);
            });
            bw.webContents.on('render-process-gone', (_e, details) => {
                logs.push(`[render-process-gone] ${JSON.stringify(details)}`);
            });
            return bw;
        };

        /** 渲染一个页面并存图 */
        const shootPage = async (url, pngName, w, h, waitMs) => {
            const bw = makeShotWindow(w, h);
            const okLoad = await loadWithRetry(bw, url);
            if (!okLoad) return false;
            await new Promise((r) => setTimeout(r, waitMs));
            const img = await bw.webContents.capturePage();
            fs.writeFileSync(path.join(outDir, pngName), img.toPNG());
            console.log(`[screenshot] ${pngName}:`, fs.statSync(path.join(outDir, pngName)).size, 'bytes');
            const text = await bw.webContents.executeJavaScript('document.body.innerText');
            fs.writeFileSync(path.join(outDir, pngName.replace('.png', '.txt')), text, 'utf8');
            bw.destroy();
            return true;
        };

        // 主窗口
        await shootPage(INDEX_URL, 'ui.png', 400, 500, 3500);
        // 各 panel 窗口（viz 多等一会等音频解码 + 声谱渲染）
        for (const [panelId, def] of Object.entries(PANELS)) {
            const waitMs = panelId === 'viz' ? 6500 : 2500;
            await shootPage(`${APP_ORIGIN}/${def.html}`, `panel-${panelId}.png`, def.width, def.height + 60, waitMs);
            await new Promise((r) => setTimeout(r, 600)); // 窗口间间隔，防 GPU 进程连续重建时被杀
        }

        fs.writeFileSync(path.join(outDir, 'ui.txt'), logs.join('\n'), 'utf8');
        if (logs.length) console.log('[screenshot] renderer logs:\n' + logs.join('\n'));

        coreHandle.close();
        app.quit();
        return;
    }

    await createWindow();
    console.log(`[osu-maphelper] 侧栏已就绪（${INDEX_URL}）`);
});

app.on('window-all-closed', () => {
    // 截图模式：窗口都是临时创建销毁的，全部销毁是正常流程，退出时机由截图分支自己控制
    if (SCREENSHOT_MODE) return;
    // 多窗口模式：只有当主窗口也关闭时才真正退出（panel 窗口单独关闭不影响）
    if (followTimer) clearInterval(followTimer);
    if (coreHandle) coreHandle.close();
    app.quit();
});
