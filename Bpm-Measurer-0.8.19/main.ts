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
// 忽略 GPU 黑名单（避免 Intel 老驱动被 Chromium 禁硬件加速 → 软件渲染卡顿）
app.commandLine.appendSwitch('ignore-gpu-blocklist');
// 优先使用独立显卡（Optimus 笔记本上尽量选 NVIDIA）
app.commandLine.appendSwitch('prefer-integrated-gpu', 'false');
// 2D canvas 硬件加速：频谱/波形是「整幅重绘 + 大块 putImageData」型负载。
if (process.env.BPM_CANVAS_GPU === '1') {
  app.commandLine.appendSwitch('enable-accelerated-2d-canvas');
}

// 本机性能档案（低配自适应）
function detectPerfProfile() {
  let totalKB = 0;
  let freeKB = 0;
  try {
    // getSystemMemoryInfo 是 Electron 主进程专属 API（单位 KB）
    const info = (process as any).getSystemMemoryInfo();
    totalKB = info?.total ?? 0;
    freeKB = info?.free ?? 0;
  } catch {
    /* 取不到就按常规机器处理（不降级） */
  }
  const totalGB = totalKB / 1048576;
  const freeGB = freeKB / 1048576;
  // ≤8.5GB 总量（即物理 8GB）或可用不足 1.2GB → 判定为内存吃紧
  const lowEnd = totalKB > 0 && (totalGB <= 8.5 || freeGB < 1.2);
  return { totalGB, freeGB, lowEnd };
}

const PERF_PROFILE = detectPerfProfile();

if (PERF_PROFILE.lowEnd) {
  // 1) 别让 Chromium 因为窗口被遮挡就把渲染降频/暂停（本软件常和 osu! 等窗口叠着用）
  app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
  // 2) 窗口失焦时不降后台渲染优先级（边看谱边切窗口时不至于一回来就卡一下）
  app.commandLine.appendSwitch('disable-renderer-backgrounding');
  console.log(
    `[perf] 低配模式：总内存 ${PERF_PROFILE.totalGB.toFixed(1)}GB / 可用 ${PERF_PROFILE.freeGB.toFixed(2)}GB`
  );
}

let mainWindow: BrowserWindow | null = null;

// 解析启动参数：`--open-audio=<路径>`，或把音频 / .osu / .osz / 谱面文件夹直接拖到 exe 图标上
const OPEN_EXT_RE = /\.(wav|mp3|flac|aac|ogg|wma|osu|osz)$/i;
function getAutoOpenPath(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  for (const raw of args) {
    const val = raw.startsWith('--open-audio=') ? raw.slice('--open-audio='.length) : raw;
    if (!val || val.startsWith('-')) continue;
    try {
      if (!fs.existsSync(val)) continue;
      if (fs.statSync(val).isDirectory() || OPEN_EXT_RE.test(val)) return path.resolve(val);
    } catch { /* 路径异常就当没有 */ }
  }
  return null;
}

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      nodeIntegration: false,
      contextIsolation: true,
      // 窗口被遮挡/最小化时不节流渲染循环：本软件播放时要靠 rAF 推播放头，
      // 一旦被降频，切回来会出现播放头"跳一格"的错觉。
      backgroundThrottling: false
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

  // 启动参数里带了音频路径（--open-audio=<path> 或直接把文件拖到 exe 上）→ 页面就绪后自动载入
  const autoOpenPath = getAutoOpenPath();
  if (autoOpenPath) {
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow?.webContents.send('auto-open-audio', autoOpenPath);
    });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
};

// 渲染进程启动时同步取一次性能档案（一次同步 IPC，开销可忽略）
ipcMain.on('get-perf-profile', (event) => {
  event.returnValue = PERF_PROFILE;
});

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

// 谱面导入通道：.osz（zip 谱面包）/ .osu / 谱面文件夹

interface ZipEntry { name: string; method: number; compSize: number; size: number; localOffset: number }

/** 读 ZIP 中央目录（从尾部 EOCD 反查，注释区最长 65535 字节） */
function readZipEntries(buf: Buffer): ZipEntry[] {
  const minPos = Math.max(0, buf.length - 0x10000 - 22);
  let eocd = -1;
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 解出单个 ZIP 条目 */
function readZipEntry(buf: Buffer, e: ZipEntry): Buffer | null {
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + e.compSize);
  if (e.method === 0) return Buffer.from(raw);
  if (e.method === 8) { try { return zlib.inflateRawSync(raw); } catch { return null; } }
  return null;
}

/** 音频扩展名（与渲染进程支持的解码格式一致） */
const AUDIO_EXTS = new Set(['.mp3', '.ogg', '.wav', '.m4a', '.flac', '.aac', '.wma']);

/** 从 .osu 文本里取 AudioFilename（相对谱面所在目录） */
function audioFilenameOf(osuText: string): string {
  const m = osuText.match(/^\s*AudioFilename\s*:\s*(.+?)\s*$/im);
  return m ? m[1].trim() : '';
}

/** 目录里找音频（优先 .osu 引用的名字，找不到就取体积最大的音频） */
function pickAudioInDir(dir: string, preferred: string): { path: string; name: string } | null {
  let entries: string[] = [];
  try { entries = fs.readdirSync(dir); } catch { return null; }
  if (preferred) {
    const hit = entries.find((n) => n.toLowerCase() === preferred.toLowerCase());
    if (hit) return { path: path.join(dir, hit), name: hit };
  }
  const cands = entries.filter((n) => AUDIO_EXTS.has(path.extname(n).toLowerCase()));
  if (!cands.length) return null;
  cands.sort((a, b) => {
    try { return fs.statSync(path.join(dir, b)).size - fs.statSync(path.join(dir, a)).size; } catch { return 0; }
  });
  return { path: path.join(dir, cands[0]), name: cands[0] };
}

/** 收集目录里的 .osu（谱面文件夹里一般就在根目录，向下多看两层） */
function collectOsuFiles(dir: string, depth = 0): string[] {
  let out: string[] = [];
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isFile() && /\.osu$/i.test(e.name)) out.push(p);
    else if (e.isDirectory() && depth < 1) out = out.concat(collectOsuFiles(p, depth + 1));
  }
  return out;
}

/** 组装一份「导入结果」：音频路径 + 候选 .osu 列表 */
function buildImportPayload(dir: string, osuPaths: string[], audio?: { path: string; name: string } | null) {
  const osuFiles = osuPaths
    .map((p) => { try { return { name: path.basename(p), path: p, text: fs.readFileSync(p, 'utf8') }; } catch { return null; } })
    .filter(Boolean) as { name: string; path: string; text: string }[];
  if (!osuFiles.length) return { ok: false as const, error: '没有找到 .osu 谱面文件' };
  const audioInfo = audio ?? pickAudioInDir(dir, audioFilenameOf(osuFiles[0].text));
  if (!audioInfo) return { ok: false as const, error: '没有找到谱面对应的音频文件' };
  return {
    ok: true as const,
    dir,
    audioPath: audioInfo.path,
    audioName: audioInfo.name,
    osuFiles,
  };
}

/** 导入按钮的对话框：音频 / .osu / .osz 一起选 */
ipcMain.handle('open-import-file', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: '音频 / 谱面 / 谱面包', extensions: ['mp3', 'ogg', 'wav', 'm4a', 'flac', 'aac', 'wma', 'osu', 'osz'] },
      { name: 'osu! 谱面包 (.osz)', extensions: ['osz'] },
      { name: 'osu! 谱面 (.osu)', extensions: ['osu'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null;
});

/** 选择谱面文件夹（里面放 .osu + 音频） */
ipcMain.handle('open-map-folder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  return !result.canceled && result.filePaths.length > 0 ? result.filePaths[0] : null;
});

/** 读文本文件（.osu / timing txt） */
ipcMain.handle('read-text-file', async (_event, filePath: string) => {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
});

/** 在谱面目录里找某个 AudioFilename（切换难度时用；找不到就返回 null，不动当前音频） */
ipcMain.handle('find-map-audio', async (_event, dir: string, preferred: string) => {
  try {
    if (!dir || !fs.existsSync(dir)) return null;
    const want = String(preferred || '').trim();
    if (!want) return pickAudioInDir(dir, '');
    const exact = path.join(dir, want);
    if (fs.existsSync(exact)) return { path: exact, name: path.basename(exact) };
    // Windows 大小写不敏感兜底（谱面里常写成 Audio.mp3，实际文件是 audio.mp3）
    const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === want.toLowerCase());
    return hit ? { path: path.join(dir, hit), name: hit } : null;
  } catch { return null; }
});

/** 读单个 .osu：返回文本 + 它所在目录的音频 */
ipcMain.handle('read-osu-file', async (_event, filePath: string) => {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    const payload = buildImportPayload(path.dirname(filePath), [filePath], null);
    if (!payload.ok) return payload;
    return { ...payload, text, sourceName: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/** 解 .osz：全部 .osu 解到临时目录（保留谱面名），音频取 AudioFilename 指向的那个 */
ipcMain.handle('read-map-package', async (_event, filePath: string) => {
  try {
    const buf = fs.readFileSync(filePath);
    const entries = readZipEntries(buf);
    const osuEntries = entries.filter((e) => /\.osu$/i.test(e.name));
    if (!osuEntries.length) return { ok: false, error: '压缩包里没有 .osu 谱面文件' };

    const base = path.basename(filePath, path.extname(filePath)).replace(/[\\/:*?"<>|]/g, '_');
    const dir = path.join(app.getPath('temp'), 'bpm-measurer-osz', `${base}-${buf.length}`);
    fs.mkdirSync(dir, { recursive: true });

    const osuFiles: { name: string; path: string; text: string }[] = [];
    for (const e of osuEntries) {
      const data = readZipEntry(buf, e);
      if (!data) continue;
      const name = path.basename(e.name);
      const out = path.join(dir, name);
      fs.writeFileSync(out, data);
      osuFiles.push({ name, path: out, text: data.toString('utf8') });
    }
    if (!osuFiles.length) return { ok: false, error: '谱面包里的 .osu 解压失败' };

    // 音频：按第一条 .osu 的 AudioFilename 精确取；找不到就取最大的音频条目
    const want = audioFilenameOf(osuFiles[0].text).toLowerCase();
    const audioEntries = entries.filter((e) => AUDIO_EXTS.has(path.extname(e.name).toLowerCase()));
    let picked = want ? audioEntries.find((e) => path.basename(e.name).toLowerCase() === want) : undefined;
    if (!picked) picked = audioEntries.sort((a, b) => b.size - a.size)[0];
    if (!picked) return { ok: false, error: '谱面包里没有音频文件' };
    const audioData = readZipEntry(buf, picked);
    if (!audioData) return { ok: false, error: '谱面包里的音频解压失败' };
    const audioName = path.basename(picked.name);
    const audioPath = path.join(dir, audioName);
    fs.writeFileSync(audioPath, audioData);

    // 其它难度可能引用别的音频（如 1.1x/1.2x 各有自己的 mp3）→ 一并解到同一目录，切换难度时直接读
    const wanted = new Set(osuFiles.map((f) => audioFilenameOf(f.text).toLowerCase()).filter(Boolean));
    for (const e of audioEntries) {
      const name = path.basename(e.name);
      if (!wanted.has(name.toLowerCase())) continue;
      const out = path.join(dir, name);
      if (fs.existsSync(out)) continue;
      const data = readZipEntry(buf, e);
      if (data) fs.writeFileSync(out, data);
    }

    return { ok: true, dir, audioPath, audioName, osuFiles, sourceName: path.basename(filePath) };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

/** 扫谱面文件夹：里面所有 .osu 都作为候选，音频按第一条 .osu 的 AudioFilename 找 */
ipcMain.handle('scan-map-folder', async (_event, dir: string) => {
  try {
    const osuPaths = collectOsuFiles(dir);
    if (!osuPaths.length) return { ok: false, error: '这个文件夹里没有 .osu 谱面（请选 osu! Songs 下的单曲文件夹）' };
    const payload = buildImportPayload(dir, osuPaths, null);
    return payload.ok ? { ...payload, sourceName: path.basename(dir) } : payload;
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// Malody 谱面包（.mcz）打包 —— 极简 ZIP 写入器

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

    // 启动参数
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
  // 用本软件自己的 Electron 内核以 Node 模式跑 launch.mjs
  // 打包成 exe 后机器上可能没有 node 命令，用 execPath 则开发/打包两种环境都有现成运行时。
  try {
    mapHelperProc = spawn(process.execPath, ['scripts/launch.mjs'], {
      cwd: projectDir,
      stdio: 'ignore',
      // 必须 windowsHide，不能同时开 detached
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
