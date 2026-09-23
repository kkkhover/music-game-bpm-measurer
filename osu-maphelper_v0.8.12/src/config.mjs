// ============================================================================
// 配置模块 —— 读写 config.json（首次运行自动生成默认配置）
// 所有可调项都在这里，UI 上改完会立刻落盘，不依赖重启。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 可写数据根目录（config.json 与 backups 的落点）
//
// 默认仍是「侧栏模块目录」—— 独立运行时行为完全不变。
// 但被**打包进 BPM 测速助手**之后，侧栏代码位于安装目录里
// （<安装目录>\resources\app\maphelper\）。若还把配置/备份写在代码旁边，
// 软件一升级或重装就会把备份连同代码目录一起删掉 —— 那是用户攒下来的谱面底稿。
// 所以打包运行时由软件传入环境变量 OSU_MAPHELPER_DATA 指向用户数据区，
// 把「可写数据」与「程序」彻底分开：
//   独立运行 → <侧栏目录>\config.json、<侧栏目录>\backups
//   打包运行 → %APPDATA%\bpm-measurer-util\maphelper\{config.json,backups}
// ---------------------------------------------------------------------------
export const ROOT = process.env.OSU_MAPHELPER_DATA
    ? path.resolve(process.env.OSU_MAPHELPER_DATA)
    : path.resolve(__dirname, '..');
export const CONFIG_PATH = path.join(ROOT, 'config.json');
export const DEFAULT_BACKUP_DIR = path.join(ROOT, 'backups');
export const DEFAULT_EXPORT_DIR = path.join(ROOT, 'exports');

/** 默认配置（含中文说明，写盘后仍可读） */
export const DEFAULT_CONFIG = {
    // ---- tosu 连接（tosu 是只读内存读取器，我们通过它的本地 HTTP API 拿数据）----
    tosu: {
        host: '127.0.0.1',
        port: 24050,
        pollMs: 100, // 主进程轮询 tosu 的间隔（毫秒）
        autoLaunchHint: true
    },

    // ---- osu! 路径（留空 = 自动探测）----
    osu: {
        installDir: '', // 例：E:\game\osu!
        songsDir: '' // 留空 = 读 osu!.cfg 的 BeatmapDirectory（默认 <安装目录>\Songs）
    },

    // ---- 定时备份 ----
    backup: {
        enabled: true,
        intervalMinutes: 2, // 默认 2 分钟一次
        keepCount: 60, // 保留 60 份，超出删最旧
        dir: '', // 留空 = <模块目录>\backups
        onlyWhenChanged: true, // 内容没变就不写新备份（避免刷一堆同样的）
        backupBeforeWrite: true, // 每次写回 .osu 之前强制备份一次（安全网）
        nameFormat: 'YYYY-M-D-H-m' // 年-月-日-时-分
    },

    // ---- timing 导出（编辑后保存到时间戳命名文件，不写回 .osu，用户手动导入）----
    export: {
        dir: '' // 留空 = <模块目录>\exports
    },

    // ---- 主窗口（精简：状态 + 播放位置 + 功能区入口）----
    window: {
        width: 360,
        height: 460,
        x: null, // null = 自动贴到 osu! 窗口右侧
        y: null,
        alwaysOnTop: true,
        opacity: 1 // 窗口透明度（0.4~1.0），设置面板滑条实时调
    },

    // ---- 可视化（频谱 / 声谱 / 时间轴）----
    // ★ 与 BPM 测速助手 utils/settings.ts 的 DEFAULT_SETTINGS 逐项对齐（键名尽量同名）：
    //   侧栏设置面板里改任意一项，渲染色/参数与软件完全一致。
    visual: {
        showWaveform: true, // 显示波形层（内容区上半）
        showSpectrogram: true, // 显示声谱层（内容区下半）
        waveColor: '#a855f7', // 波形颜色（软件默认紫）
        palette: 'spectrum', // 声谱配色方案 id（见 viz.js 的 SCALES/MULTI_COLORS/single）
        custom: ['#ff2222', '#ff2222', '#ff2222'], // palette=custom 时的三段色 [低,中,高]
        peakThreshold: 0.5, // 峰值阈值（0.5~0.98）
        peakColor: '#ffee00', // 峰值颜色
        invert: false, // 频谱垂直倒转
        renderScale: 1, // 渲染分辨率倍率（=1 跟随屏幕缩放，<1 更流畅，>1 更清晰）
        // ★ v0.8.5：节拍线延迟默认「跟随 BPM 测速助手」—— 把软件里校准过的值直接拿来用。
        //   侧栏与软件是两个独立程序（各有各的 userData / 设置存储），
        //   这里通过读软件的 localStorage 实现同步，见 src/bpmSettings.mjs。
        beatLineDelayFollowSoftware: true, // true=用软件里的值（默认，推荐）；false=用下面的手动值
        beatLineDelayMs: 30, // 手动值：仅在「不跟随软件」或读不到软件设置时生效
        fftSize: 1024, // FFT 采样点数（512/1024/2048/4096，越大频率分辨率越高）
        sensitivity: 75, // 显示灵敏度 dB 阈值（60~120，越小越敏感）
        logBase: 50, // 频率轴对数底（1 = 线性；越大低频越展开）
        autoFollow: true, // 自动翻页跟随：播放头到视区 85% 处提前翻到下一段并渲染（频谱窗 ⏭ 按钮）

        // ★ v0.8.7：跟随 osu! 播放时的播放头平滑 + 帧率兜底（见 renderer/viz-panel.js 的 osuSmooth）
        //   背景（实测）：osu! 播放位置要经 tosu(POLL_RATE=150ms) → 主进程(pollMs=100ms) 两跳，
        //   渲染进程拿到的 time 天生 100~150ms 一跳 → 画面每秒只前进 10 次，看着像"锁帧"。
        //   开启平滑后按本地时钟外推，位置在每帧都连续前进。
        osuFollowSmooth: true, // 跟随 osu! 时平滑播放头（关掉 = 回到 v0.8.6 的"一跳一跳"）
        // 外推封顶（ms）：默认 400 —— v0.8.8 起它是"样本断了多久才认定上游停了"的阈值，
        // 实际生效值 = max(本值, 3×实测样本间隔)；实测样本间隔抖动到 212ms，
        // v0.8.7 固定 200ms 会把"只是晚到的正常样本"误判成暂停（先冻一下、样本到了再跳）。
        // 0 = 完全不平滑（纯外推禁用）；400 为上限。
        osuFollowExtrapMs: 400,
        // rAF 停摆（被游戏独占全屏盖住等）时的保底绘制帧率：33=30fps / 60 / 120 / -1=跟随屏幕刷新率
        // ★ 这个值会**直接变成用户看到的帧率**，所以做成可调（"锁 30"就来自这里）
        fallbackFps: 33,
        showFrameStat: false // 标题栏显示帧率诊断（rAF / 实际绘制 / 兜底接管 三个数）
    },

    // ---- 音频（合并窗口标题栏那一排控件）----
    // 本地试听（空格播放/暂停）的音量 / 变速，以及节拍器
    audio: {
        musicVolume: 80, // 音乐音量 0~100
        metroVolume: 60, // 节拍器音量 0~100
        metroOn: false, // 节拍器开关（本地试听时按红线/BPM 打拍）
        rate: 1 // 音乐变速倍率（0.5~2.0，保持音调不变）
    },

    // ---- 面板布局（可拆分可摆放）----
    // 记录每个功能面板在侧栏内的顺序（拖拽重排后写回）。id 与 index.html 的 data-panel 对应
    layout: {
        order: ['live', 'viz', 'map', 'timeline', 'backup', 'settings', 'log'],
        collapsed: []
    },

    // ---- 功能区块独立窗口（多窗口架构）----
    // 每个 panel 可弹出为独立 Electron 子窗口，各自记录位置/尺寸/置顶/透明度
    panels: {
        // panelId -> { x, y, width, height, pinned, opacity }
        // 缺省时用 main.cjs 里 PANELS 的尺寸，位置自动贴到主窗口旁；
        // pinned 缺省 = true（新窗口默认置顶）、opacity 缺省 = 1
    },

    // ---- 本地服务 ----
    server: {
        port: 24100
    }
};

/** 深合并（仅对象；数组/原始值直接覆盖） */
function deepMerge(base, override) {
    const out = Array.isArray(base) ? [...base] : { ...base };
    for (const [k, v] of Object.entries(override || {})) {
        if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) {
            out[k] = deepMerge(base[k], v);
        } else if (v !== undefined) {
            out[k] = v;
        }
    }
    return out;
}

let cache = null;

/** 读取配置（带默认值合并 + 容错） */
export function loadConfig() {
    if (cache) return cache;
    let user = {};
    try {
        if (fs.existsSync(CONFIG_PATH)) {
            user = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        }
    } catch (e) {
        console.warn('[config] 读取失败，使用默认配置：', e.message);
    }
    cache = deepMerge(DEFAULT_CONFIG, user);
    return cache;
}

/** 写回配置（局部更新；传 patch 对象） */
export function saveConfig(patch) {
    const next = deepMerge(loadConfig(), patch || {});
    cache = next;
    // 数据根可能被外置（打包运行时指向 %APPDATA%\...\maphelper），首次写入前先确保目录在
    fs.mkdirSync(ROOT, { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8');
    return next;
}

/** 备份目录（配置为空则用默认） */
export function getBackupDir() {
    const cfg = loadConfig();
    return cfg.backup.dir && cfg.backup.dir.trim() ? cfg.backup.dir.trim() : DEFAULT_BACKUP_DIR;
}

/** timing 导出目录（配置为空则用默认） */
export function getExportDir() {
    const cfg = loadConfig();
    return cfg.export && cfg.export.dir && cfg.export.dir.trim() ? cfg.export.dir.trim() : DEFAULT_EXPORT_DIR;
}
