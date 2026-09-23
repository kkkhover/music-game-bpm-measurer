// ============================================================================
// 路径探测模块 —— 找到 osu! 安装目录 / Songs 目录 / 当前谱面的绝对路径
// 探测顺序（先可靠、后兜底）：
//   ① 配置文件里手填的 installDir
//   ② 环境变量 OSU_INSTALL_DIR
//   ③ 正在运行的 osu!.exe 进程路径（最准）
//   ④ 注册表卸载项 InstallLocation
//   ⑤ 常见盘符浅层扫描（结果写回配置，下次直接用）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { loadConfig, saveConfig } from './config.mjs';

/** 静默执行命令，失败返回 '' */
function tryExec(file, args, timeout = 6000) {
    try {
        return execFileSync(file, args, {
            encoding: 'utf8',
            timeout,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'ignore']
        }).trim();
    } catch {
        return '';
    }
}

/** ①~③ 从运行中的 osu! 进程拿安装目录 */
function fromRunningProcess() {
    const ps = 'powershell';
    const cmd = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$p = Get-Process -Name 'osu!' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Path; if ($p) { $p }"
    ];
    const out = tryExec(ps, cmd);
    if (out && /\.exe$/i.test(out)) return path.dirname(out);
    return '';
}

/** ④ 注册表卸载项 */
function fromRegistry() {
    const keys = [
        'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\osu!',
        'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\osu!',
        'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\osu!'
    ];
    for (const k of keys) {
        const out = tryExec('reg', ['query', k, '/v', 'InstallLocation']);
        const m = out.match(/InstallLocation\s+REG_\w+\s+(.+)/);
        if (m && m[1]) {
            const dir = m[1].trim();
            if (dir && fs.existsSync(path.join(dir, 'osu!.exe'))) return dir;
        }
    }
    return '';
}

/** ⑤ 浅层扫描常见位置 */
function fromScan() {
    const roots = [];
    for (const drive of ['C', 'D', 'E', 'F', 'G']) {
        roots.push(`${drive}:\\`);
        roots.push(`${drive}:\\game`);
        roots.push(`${drive}:\\games`);
        roots.push(`${drive}:\\Program Files`);
        roots.push(`${drive}:\\Program Files (x86)`);
        roots.push(`${drive}:\\Users\\Public`);
    }
    for (const r of roots) {
        if (!fs.existsSync(r)) continue;
        // 直接命中 <root>\osu!
        const direct = path.join(r, 'osu!');
        if (fs.existsSync(path.join(direct, 'osu!.exe'))) return direct;
        // 扫一层子目录里的 osu!
        let entries = [];
        try {
            entries = fs.readdirSync(r, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (!e.isDirectory()) continue;
            const sub = path.join(r, e.name);
            if (fs.existsSync(path.join(sub, 'osu!.exe'))) return sub;
            const sub2 = path.join(sub, 'osu!');
            if (fs.existsSync(path.join(sub2, 'osu!.exe'))) return sub2;
        }
    }
    return '';
}

/** 找 osu! 安装目录（带配置缓存） */
export function findOsuInstallDir({ refresh = false } = {}) {
    const cfg = loadConfig();

    if (!refresh && cfg.osu.installDir && fs.existsSync(path.join(cfg.osu.installDir, 'osu!.exe'))) {
        return cfg.osu.installDir;
    }

    const candidates = [
        process.env.OSU_INSTALL_DIR || '',
        fromRunningProcess(),
        fromRegistry(),
        fromScan()
    ];

    for (const c of candidates) {
        if (c && fs.existsSync(path.join(c, 'osu!.exe'))) {
            saveConfig({ osu: { installDir: c } }); // 记住，下次秒开
            return c;
        }
    }
    return '';
}

/**
 * 找 Songs 目录。
 * osu!stable 把 BeatmapDirectory 写在 osu!.cfg 里（默认 'Songs'），可能是相对或绝对路径。
 */
export function findSongsDir(installDir) {
    const cfg = loadConfig();
    if (cfg.osu.songsDir && fs.existsSync(cfg.osu.songsDir)) return cfg.osu.songsDir;
    if (!installDir) return '';

    let beatmapDir = 'Songs';
    try {
        // osu!.cfg 是纯文本；用户配置文件形如 osu!.27771.cfg
        const files = fs.readdirSync(installDir).filter((f) => /^osu!\..*\.cfg$/i.test(f) || f === 'osu!.cfg');
        for (const f of files) {
            const txt = fs.readFileSync(path.join(installDir, f), 'utf8');
            const m = txt.match(/BeatmapDirectory\s*=\s*(.+)/);
            if (m && m[1].trim()) {
                beatmapDir = m[1].trim();
                break;
            }
        }
    } catch {
        /* 用默认值 */
    }

    const resolved = path.isAbsolute(beatmapDir) ? beatmapDir : path.join(installDir, beatmapDir);
    if (fs.existsSync(resolved)) {
        saveConfig({ osu: { songsDir: resolved } });
        return resolved;
    }
    return '';
}

/** 静默异步执行命令，失败返回 ''（不阻塞主进程事件循环） */
function tryExecAsync(file, args, timeout = 6000) {
    return new Promise((resolve) => {
        try {
            execFile(
                file,
                args,
                { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] },
                (err, stdout) => resolve(err || !stdout ? '' : String(stdout).trim())
            );
        } catch {
            resolve('');
        }
    });
}

/**
 * osu! 是否在运行（含 pid）—— **异步版**。
 * ★ v0.8.10 性能：原来用 execFileSync 同步跑 PowerShell（1~3 秒），
 *   probeEnv 每 5 秒一次，每次都把主进程整个卡住 → 侧栏"未响应/卡顿"。
 *   改 execFile 异步后探测在后台进行，主进程照常响应所有请求。
 */
export async function findOsuProcess() {
    const ps = 'powershell';
    const cmd = [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-Process -Name 'osu!' -ErrorAction SilentlyContinue | Select-Object -First 1 Id,Path | ForEach-Object { \"$($_.Id)|$($_.Path)\" }"
    ];
    const out = await tryExecAsync(ps, cmd);
    if (!out || !out.includes('|')) return null;
    const [pid, exe] = out.split('|');
    const n = parseInt(pid, 10);
    if (!Number.isFinite(n)) return null;
    return { pid: n, path: exe || '' };
}

/**
 * 把 tosu 给的 osuFileLocation（形如 "1234567 Artist - Title/xxx.osu"）拼成绝对路径。
 * 兼容：① 相对 Songs 的相对路径 ② 已经是绝对路径
 */
export function resolveBeatmapPath(osuFileLocation, songsDir, installDir) {
    if (!osuFileLocation) return '';

    const normalized = osuFileLocation.replace(/[\\/]+/g, path.sep);

    if (path.isAbsolute(normalized)) {
        return fs.existsSync(normalized) ? normalized : '';
    }

    const bases = [];
    if (songsDir) bases.push(songsDir);
    if (installDir) bases.push(path.join(installDir, 'Songs'));

    for (const base of bases) {
        const full = path.join(base, normalized);
        if (fs.existsSync(full)) return full;
    }
    // 找不到也返回第一个候选，方便报错时显示
    return bases.length ? path.join(bases[0], normalized) : '';
}
