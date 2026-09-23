import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron';
import path from 'path';
import fs from 'fs';
import zlib from 'zlib'; // 只用来做 Malody 谱面包(.mcz) 里的 deflate 条目
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ===== GPU/渲染优化（笔记本 Intel 核显 / NVIDIA 独显兼容）=====
// 强制 D3D11（Chromium 在混合显卡下默认可能跑核显或软件回退，D3D11 对 NVIDIA/Intel 驱动更稳定）
app.commandLine.appendSwitch('use-angle', 'd3d11');
// 启用 2D canvas 硬件加速（频谱/波形绘制）
app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
// 忽略 GPU 黑名单（避免 Intel 老驱动被 Chromium 禁硬件加速 → 软件渲染卡顿）
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 优先使用独立显卡（Optimus 笔记本上尽量选 NVIDIA）
app.commandLine.appendSwitch('prefer-integrated-gpu', 'false');

let mainWindow: BrowserWindow | null = null;

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true
    },
    backgroundColor: '#0f0f0f',
    show: false,
    icon: path.join(__dirname, 'icon.ico'),
    autoHideMenuBar: true
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.removeMenu();

  mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

ipcMain.handle('open-audio-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Audio Files', extensions: ['wav', 'mp3', 'flac', 'aac', 'ogg', 'wma'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('save-file', async (event, options) => {
  if (!mainWindow) return null;
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: options?.defaultPath || 'untitled.txt',
    filters: options?.filters || [{ name: 'Text Files', extensions: ['txt'] }]
  });

  if (result.canceled) {
    return null;
  }

  // 若调用方提供了 content，则直接写入文件
  if (options && typeof options.content === 'string') {
    try {
      fs.writeFileSync(result.filePath, options.content, 'utf-8');
    } catch (err) {
      console.error('写入文件失败:', err);
      return null;
    }
  }

  return result.filePath;
});

// 读取音频文件内容（返回 Uint8Array）
ipcMain.handle('read-audio-file', async (_event, filePath: string) => {
  try {
    const data = fs.readFileSync(filePath);
    return new Uint8Array(data);
  } catch (err) {
    console.error('读取文件失败:', err);
    return null;
  }
});

// ============================================================================
// Malody 谱面包（.mcz）打包 —— 极简 ZIP 写入器
// ============================================================================
// 为什么需要它（v0.8.12 修「Malody 里音乐只有几秒钟」）：
//   .mc 里指定音频靠的是「文件名」，Malody 只会去**谱面文件夹里**找同名文件。
//   我们的导出原样带上"你在本软件里导入的那个音频文件名"（往往是 osu! 谱面里的
//   audio.mp3），而目标 Malody 谱面文件夹里的音频叫别的名字 → 找不到 → Malody 退回
//   一个约 1 秒的占位音源 → 编辑器里"音乐时长只有几秒钟"。
//   （Malody 日志特征：[Audio] Forced reset ... raw audio time: 1002.667 —— 卡在约 1 秒）
//   所以这里直接把音频**打进包里**，包里的音频名与 .mc 里写的一致，问题从根上消失。
//
// 为什么手写而不是引第三方库：只需要"把几个文件塞进一个 zip"，而 Node 自带的
//   zlib.deflateRawSync 输出的正是 ZIP 的 deflate 流，拼上头即可。
//   结构对齐真实 .mcz（Malody 官方谱面包）：DEFLATE + 文件名 UTF-8。

/** CRC32 查表（ZIP 每个条目头里都要带） */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** ZIP 头里用的是 DOS 时间（1980 起算） */
function dosDateTime(d = new Date()): { time: number; date: number } {
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() / 2) & 0x1f);
  const date = (((d.getFullYear() - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time, date };
}

/** 把若干文件打成 zip（DEFLATE，文件名 UTF-8），返回完整字节 */
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  const { time, date } = dosDateTime();
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8');
    const comp = zlib.deflateRawSync(e.data, { level: 6 });
    const crc = crc32(e.data);

    // 本地文件头（30 字节固定部分 + 文件名）
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); // version needed
    lh.writeUInt16LE(0x0800, 6); // 通用标志：文件名为 UTF-8
    lh.writeUInt16LE(8, 8); // 压缩方法：deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(e.data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28); // 扩展区长度
    local.push(lh, nameBuf, comp);

    // 中央目录项（46 字节固定部分 + 文件名）
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); // version made by
    cd.writeUInt16LE(20, 6); // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(comp.length, 20);
    cd.writeUInt32LE(e.data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42); // 本地头偏移
    central.push(cd, nameBuf);

    offset += 30 + nameBuf.length + comp.length;
  }

  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, cdBuf, eocd]);
}

// ★ v0.8.15：此处原有「只导出 Malody 谱面文件（.mc，不含音频）」的整条通道
// （扫目标文件夹音频、询问是否改名、以及对应的 IPC 处理器）。该导出选项已按需求删除 ——
// 现在 Malody 只有「谱面包(.mcz，含音频)」一条出口，音频跟着一起打包，
// 不存在"音频名与谱面文件夹里对不上"的可能，故整块移除。
// 注：注释里刻意不再写出被删符号的名字，免得产物 dist-electron/main.js 里还搜得到。


/**
 * 导出「Malody 完整谱面包」(.mcz)：把 .mc 与音频一起打包。
 * 包内结构对齐真实 .mcz（文件平铺在根目录）：
 *   <曲名>.mc  +  <音频原名>
 * 拖进 Malody 即可导入；音频名与 .mc 里 sound 字段完全一致，不会再出现"音乐只有几秒"。
 */
ipcMain.handle('save-malody-package', async (_event, opts) => {
  if (!mainWindow) return { ok: false, error: '窗口不可用' };
  const packName = String(opts?.packName || 'malody-timing').replace(/[\\/:*?"<>|]/g, '_');
  const audioPath = String(opts?.audioPath || '');
  const audioName = String(opts?.audioName || '').replace(/[\\/]/g, '');
  const mcContent = String(opts?.mcContent ?? '');
  if (!mcContent) return { ok: false, error: '没有可导出的 timing 内容' };
  if (!audioPath || !fs.existsSync(audioPath)) {
    return { ok: false, error: '原音频文件不在了（请重新导入音频）' };
  }
  if (!audioName) return { ok: false, error: '音频文件名为空' };

  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `${packName}.mcz`,
    filters: [{ name: 'Malody Chart Package', extensions: ['mcz'] }]
  });
  if (result.canceled || !result.filePath) return { ok: false, canceled: true };

  try {
    const audio = fs.readFileSync(audioPath);
    const zip = buildZip([
      { name: `${packName}.mc`, data: Buffer.from(mcContent, 'utf8') },
      { name: audioName, data: audio }
    ]);
    fs.writeFileSync(result.filePath, zip);
    return { ok: true, path: result.filePath, size: zip.length, audioName };
  } catch (err) {
    console.error('打包 .mcz 失败:', err);
    return { ok: false, error: String(err) };
  }
});

// ===== 制谱侧栏（osu-maphelper）启动入口 =====
// 从设置面板点「制谱侧栏」→ 拉起独立的 Electron 侧栏（主窗口 + 各功能区块独立窗口）。
// 两个程序完全独立进程，互不干扰；已开着就不再重复启动。
//
// 取侧栏代码有两条路，优先走 ①：
//   ① 【打包进软件的内置侧栏】v0.8.5 起：侧栏整棵树随包进了
//      <安装目录>\resources\app\maphelper\（见 scripts/sync-maphelper.mjs）。
//      直接拿**本软件自己的 exe** 加 --maphelper 参数启动即可 ——
//      Electron 打包后入口固定是 resources/app，同一个入口按参数分流
//      （带 --maphelper 走内置侧栏，不带就是本软件，见项目根 boot.cjs）。
//      好处：交付包只有一个 exe，目标机器上既不需要 node，也不用另放侧栏文件夹。
//   ② 【兜底】按版本号扫兄弟目录里的 osu-maphelper*，在 Node 模式下跑它的
//      scripts/launch.mjs。开发环境走这条，改侧栏源码能立刻生效，不必重新同步。
import { spawn } from 'child_process';

let mapHelperProc: ReturnType<typeof spawn> | null = null;

/** 内置侧栏目录（打包后 = <安装目录>\resources\app\maphelper；开发时 = <项目根>\maphelper） */
const BUNDLED_MAPHELPER_DIR = path.join(__dirname, '..', 'maphelper');

/**
 * 侧栏的可写数据目录。
 *
 * 【为什么必须搬出安装目录】侧栏的配置与定时备份默认写在"自己代码旁边"；
 * 打包后那就是安装目录（resources\app\maphelper），软件一升级/重装就会
 * 把用户攒下来的谱面备份连同代码目录一起删掉。所以这里显式把它指到
 * 用户数据区（%APPDATA%\bpm-measurer-util\maphelper\），做到程序与数据分离。
 * 侧栏侧对应的是 src/config.mjs 里的 OSU_MAPHELPER_DATA 环境变量。
 */
function mapHelperDataDir(): string {
  try {
    return path.join(app.getPath('userData'), 'maphelper');
  } catch {
    // 极端情况下 getPath 不可用，退回安装目录内（至少能跑）
    return path.join(BUNDLED_MAPHELPER_DIR, 'data');
  }
}

/** 需求 6：侧栏起来后自动把软件界面收起来（避免挡住 osu!）。 */
function minimizeAfterLaunch() {
  // 用 minimize 而不是 hide：隐藏的窗口在 .NET 里 MainWindowHandle 会变 0，
  // 侧栏「返回软件」就找不到它了；最小化窗口仍然可被找到并 SW_RESTORE 还原。
  setTimeout(() => {
    try {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
    } catch {
      /* 忽略 */
    }
  }, 900);
}

/**
 * 用「内置侧栏」启动（正常路径）。内置侧栏不存在时返回 null，交给兜底路径。
 */
function launchBundledMapHelper(): { pid?: number; dir: string; log: string } | null {
  const entry = path.join(BUNDLED_MAPHELPER_DIR, 'electron', 'main.cjs');
  if (!fs.existsSync(entry)) return null;
  try {
    const dataDir = mapHelperDataDir();
    const logDir = path.join(dataDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, 'maphelper.log');
    // 打包后是 windowsHide 启动、没有控制台，日志落文件是唯一的排查入口
    const logFd = fs.openSync(logPath, 'w');

    // 参数：
    //   · 打包后入口已被 Electron 写死为 resources/app，多传路径没有意义；
    //     只有开发态的 electron.exe 需要显式给一个 app 目录，否则报
    //     "Unable to find Electron app"（找不到 app 路径）。
    //   · --user-data-dir：给侧栏进程一个**独立**的 Chromium 配置目录。
    //     侧栏和软件是同一个 exe，默认会共用 %APPDATA%\bpm-measurer-util，
    //     两个进程抢同一份 Chromium 缓存 → 日志刷 "Unable to move the cache:
    //     拒绝访问 (0x5)"（缓存锁竞争）。隔开之后互不干扰，软件自己的设置
    //     也不会被侧栏进程的窗口状态污染。（侧栏读软件设置是直接读文件的，
    //     见 maphelper/src/bpmSettings.mjs，不依赖 Chromium 的 userData。）
    const commonArgs = ['--maphelper', `--user-data-dir=${path.join(dataDir, 'chromium')}`];
    const args = app.isPackaged ? commonArgs : [path.join(__dirname, '..'), ...commonArgs];

    // 【关键】必须摘掉 ELECTRON_RUN_AS_NODE —— 这次要以"正常 Electron"跑（要建窗口）；
    //   父进程环境里可能带着它（外层启动器遗留），带着就变成纯 Node，窗口一个都出不来。
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (k === 'ELECTRON_RUN_AS_NODE') continue;
      if (v !== undefined) env[k] = v;
    }
    env.OSU_MAPHELPER_DATA = dataDir; // 告诉侧栏"可写数据放这儿"

    mapHelperProc = spawn(process.execPath, args, {
      cwd: BUNDLED_MAPHELPER_DIR,
      stdio: ['ignore', logFd, logFd],
      // 【必须 false】这次是"正常模式"起 GUI 程序：windowsHide 会在 STARTUPINFO 里
      //   带上 wShowWindow=SW_HIDE，Windows 会把该进程的**首个顶层窗口直接隐藏** ——
      //   表现为侧栏进程活着、日志也正常，但窗口一个都看不见（hwnd 恒为 0）。
      //   上一行注释里的"黑框"问题只在以 ELECTRON_RUN_AS_NODE 跑（控制台子系统）时才有，
      //   GUI 模式的 Electron 根本不带控制台，所以这里不需要 windowsHide。
      windowsHide: false,
      env
    });
    mapHelperProc.unref(); // 侧栏独立于本软件运行（本软件退出不影响侧栏）
    mapHelperProc.on('exit', () => {
      try {
        fs.closeSync(logFd);
      } catch {
        /* 已关闭则忽略 */
      }
    });
    mapHelperProc.on('error', (e) => {
      console.error('启动内置侧栏失败:', e);
      mapHelperProc = null;
    });
    return { pid: mapHelperProc.pid, dir: BUNDLED_MAPHELPER_DIR, log: logPath };
  } catch (err) {
    console.error('启动内置侧栏异常:', err);
    mapHelperProc = null;
    return null;
  }
}

ipcMain.handle('launch-maphelper', async () => {
  // 已在运行就不重复启动
  if (mapHelperProc && mapHelperProc.exitCode === null) {
    return { ok: true, alreadyRunning: true };
  }

  // ---------------- ① 打包进软件的内置侧栏（v0.8.5 起，正常走这条） ----------------
  const bundled = launchBundledMapHelper();
  if (bundled) {
    minimizeAfterLaunch();
    return { ok: true, pid: bundled.pid, dir: bundled.dir, bundled: true, log: bundled.log };
  }

  // ---------------- ② 兜底：扫描外部的 osu-maphelper* 项目目录（开发环境用） ----------------
  // 定位 osu-maphelper 项目：
  //   ① 先在固定目录里按名字扫（osu-maphelper_v0.8.3 / _v0.8.1 / 无版本号）——
  //      用目录扫描而不是写死路径，以后换版本号目录不用改代码；
  //   ② 再试相对本程序的位置（开发环境 __dirname 在 dist-electron 里）。
  const searchRoots = [
    'D:\\tmp\\新建文件夹\\bpm app',
    path.join(__dirname, '..')
  ];
  /** 版本号目录降序比较：v0.8.3 要排在 v0.8.1 前面 */
  const byVersionDesc = (a: string, b: string) => {
    const num = (s: string) => (s.match(/\d+/g) || []).map((n) => Number(n));
    const va = num(a);
    const vb = num(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
      const d = (vb[i] || 0) - (va[i] || 0);
      if (d !== 0) return d;
    }
    return a.localeCompare(b);
  };
  const found: string[] = [];
  for (const root of searchRoots) {
    if (!fs.existsSync(root)) continue;
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(root).filter((n) => n.startsWith('osu-maphelper')).sort(byVersionDesc);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = path.join(root, name);
      if (fs.existsSync(path.join(dir, 'scripts', 'launch.mjs'))) found.push(dir);
    }
  }
  const projectDir = found[0];
  if (!projectDir) {
    return { ok: false, error: '未找到 osu-maphelper 项目（scripts/launch.mjs）' };
  }
  // 用本软件自己的 Electron 内核（process.execPath）以 Node 模式去跑 launch.mjs：
  // 打包成 exe 后机器上可能没有 node 命令，用 execPath 则开发/打包两种环境都有现成运行时。
  try {
    mapHelperProc = spawn(process.execPath, ['scripts/launch.mjs'], {
      cwd: projectDir,
      stdio: 'ignore',
      // 【关键】windowsHide 必须为 true，而且**不能同时开 detached**：
      //   以 ELECTRON_RUN_AS_NODE 运行时 execPath 变成了「控制台子系统」程序，
      //   会弹出一个 cmd 黑框（用户看到的"指令窗口"）。
      //   Windows 上 windowsHide 对应 CREATE_NO_WINDOW，而该标志在同时指定
      //   DETACHED_PROCESS 时会被系统忽略 —— 之前正是 detached:true 让黑框一直挂着。
      //   去掉 detached 后 CREATE_NO_WINDOW 生效，全程无窗口；Node 的子进程本来
      //   就不会随父进程退出而被杀，所以侧栏照样独立存活。
      windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } // 让 Electron 以纯 Node 模式执行 .mjs
    });
    mapHelperProc.unref(); // 侧栏独立于本软件运行（本软件退出不影响侧栏）
    mapHelperProc.on('error', (e) => {
      console.error('启动侧栏失败:', e);
      mapHelperProc = null;
    });
    // 需求 6：侧栏起来后自动把软件界面收起来（避免挡住 osu!）
    minimizeAfterLaunch();
    return { ok: true, pid: mapHelperProc.pid, dir: projectDir };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
