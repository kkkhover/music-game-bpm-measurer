// ============================================================================
// BPM 测速助手 设置读取器 —— 让侧栏的「节拍线延迟」跟软件保持同一个值
//
// 【为什么需要这个模块】
//   BPM 测速助手 与 制谱侧栏 是两个完全独立的 Electron 程序：不同的进程、
//   不同的 userData 目录、不同的设置存储位置。
//     · 软件：设置存在自己的 localStorage（Chromium 的 LevelDB）
//     · 侧栏：设置存在本目录的 config.json
//   两边默认值虽然都写着 30ms，但用户在软件里一旦校准过（例如调到 -25ms），
//   侧栏并不知道 —— 结果就是侧栏频谱上的拍线和软件里的对不上，看着像"延迟没同步"。
//
// 【做法】
//   侧栏直接去读软件 userData 下的 LevelDB 文件，把设置 JSON 抠出来：
//     %APPDATA%\<appName>\Local Storage\leveldb\*.log / *.ldb
//
//   · Chromium 把 localStorage 的值按「Latin-1（值前缀 0x01）或 UTF-16LE（0x00）」
//     落盘。设置 JSON 全是 ASCII 字符（颜色是 #rrggbb、其余是数字/英文键名），
//     因此落在 Latin-1 分支 —— 直接按字节 indexOf 就能命中，无需解 LevelDB 格式。
//   · .log 是预写日志（WAL）、只追加、**不压缩** → 最新一次保存一定在里面；
//     同一文件里**最后一次**出现的才是当前值（LevelDB 追加写，旧值留在前面）。
//   · .ldb 是压缩过的 SSTable（snappy），可能读不出来。这只影响「很久没改过、
//     且已被 compact 掉」的极端情况；此时本模块返回 null，调用方退回侧栏自己的值，
//     不会让侧栏崩掉或显示乱值。
//
// 【注意】纯只读：只 fs.readFileSync，绝不写软件的任何文件。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** 软件 localStorage 里的设置键（对齐软件 utils/settings.ts 的 STORAGE_KEY） */
const SETTINGS_KEY = 'bpm-measurer-settings';

/**
 * userData 目录候选名。
 * Electron 的 app.getPath('userData') = %APPDATA%\<package.json 的 name>，
 * 打包后若 build.productName 生效也可能用中文名，故多列几个候选。
 */
const APP_DIR_NAMES = ['bpm-measurer-util', 'BPM 测速助手', 'BPM测速助手'];

/** 缓存 TTL：snapshot() 每 pollMs(100ms) 调一次，没必要每次都读盘 */
const CACHE_TTL_MS = 1000;
let _cache = { at: 0, sig: '', dir: null, value: null };

/** 定位软件的 userData 目录；找不到返回 null */
export function bpmUserDataDir() {
    // 显式用环境变量指定时**以它为准**（即便不存在也不回退）——
    // 便于指向非默认安装位置，也让测试能隔离出「找不到目录」的分支。
    const envDir = process.env.BPM_USER_DATA;
    if (envDir && envDir.trim()) {
        const dir = envDir.trim();
        return fs.existsSync(path.join(dir, 'Local Storage', 'leveldb')) ? dir : null;
    }

    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    for (const name of APP_DIR_NAMES) {
        const dir = path.join(appdata, name);
        if (fs.existsSync(path.join(dir, 'Local Storage', 'leveldb'))) return dir;
    }
    return null;
}

/** 软件的 localStorage LevelDB 目录；找不到返回 null */
export function bpmLeveldbDir() {
    const u = bpmUserDataDir();
    return u ? path.join(u, 'Local Storage', 'leveldb') : null;
}

/**
 * 以 idx 为锚点（必须落在某个对象内部），向左右扩展出完整的 {...} 文本。
 * 手写括号配平而不是正则 —— 正则在嵌套 / 字符串里的花括号上不可靠。
 */
function braceObjectAt(text, idx) {
    // ① 向左找最近的、与之配对的 '{'
    let depth = 0;
    let start = -1;
    for (let i = idx; i >= 0; i--) {
        const c = text[i];
        if (c === '}') depth++;
        else if (c === '{') {
            if (depth === 0) { start = i; break; }
            depth--;
        }
    }
    if (start < 0) return null;

    // ② 向右扫到配对的 '}'（跳过字符串字面量里的花括号）
    let d = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === '{') d++;
        else if (c === '}') {
            d--;
            if (d === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

/**
 * 从一段文本里抠出「软件的设置对象」。
 * 同一份文本里可能有历史值（LevelDB 追加写），取**最后一次**命中 = 当前值。
 *
 * ★ v0.8.16：锚点从 `"beatLineDelayMs"` 改为 `SETTINGS_KEY`（= "bpm-measurer-settings"）。
 *   原因：语言同步需要读 `lang` 字段，而老版本用 beatLineDelayMs 当锚 —— 万一将来
 *   该字段改名/被删，整个读取就失效。以 localStorage 的键名作锚更稳、也更语义化。
 *   为兼容"键名与值不在同一段文本里"的极端情况，两个锚点都会扫，任一命中都算。
 */
function extractSettingsObject(text) {
    let best = null;
    // 先试新锚点（settings 键名），再退回旧锚点（beatLineDelayMs），保证双保险
    for (const anchor of [`"${SETTINGS_KEY}"`, '"beatLineDelayMs"']) {
        let from = 0;
        for (;;) {
            const hit = text.indexOf(anchor, from);
            if (hit < 0) break;
            const objText = braceObjectAt(text, hit);
            if (objText) {
                try {
                    const parsed = JSON.parse(objText);
                    // 判定"这是软件设置对象"的依据：至少含一个已知设置字段
                    if (parsed && (typeof parsed.beatLineDelayMs === 'number' || typeof parsed.lang === 'string')) {
                        best = parsed; // 后面的覆盖前面的 = 取最后一次写入
                    }
                } catch { /* 不是完整 JSON（跨块截断），忽略这次命中 */ }
            }
            from = hit + 1;
        }
        if (best) return best; // 新锚点命中就不必再试旧锚点
    }
    return best;
}

/** 读一个 LevelDB 文件，两种编码都试（返回设置对象或 null） */
function readFromBuffer(buf) {
    // ① Latin-1 单字节（设置全是 ASCII → Chromium 走这一支，实测命中）
    const single = extractSettingsObject(buf.toString('latin1'));
    if (single) return single;
    // ② UTF-16LE（值里含非 Latin-1 字符时 Chromium 改用这个编码）
    const wide = extractSettingsObject(buf.toString('utf16le'));
    if (wide) return wide;
    // ③ 前缀字节导致奇数对齐时的补救：跳过 1 字节再按 UTF-16LE 解
    return extractSettingsObject(buf.slice(1).toString('utf16le'));
}

/** 目录指纹（文件名 + 大小 + mtime），内容没变就不重复读盘 */
function dirSignature(dir) {
    try {
        return fs.readdirSync(dir)
            .map((n) => {
                let st = { size: 0, mtimeMs: 0 };
                try { st = fs.statSync(path.join(dir, n)); } catch { /* 忽略单个文件失败 */ }
                return `${n}:${st.size}:${Math.round(st.mtimeMs)}`;
            })
            .sort()
            .join('|');
    } catch {
        return '';
    }
}

/**
 * 读软件设置（带缓存）。
 * @param {boolean} force 忽略缓存强制重读（设置面板点「重新读取」时用）
 * @returns {{ok:boolean, dir:string|null, settings:object|null, error:string|null}}
 */
export function readBpmSettings(force = false) {
    const dir = bpmLeveldbDir();
    if (!dir) {
        return { ok: false, dir: null, settings: null, error: '未找到 BPM 测速助手的设置目录（软件可能从未运行过）' };
    }

    const now = Date.now();
    const sig = dirSignature(dir);
    if (!force && _cache.dir === dir && _cache.sig === sig && now - _cache.at < CACHE_TTL_MS) {
        return { ok: !!_cache.value, dir, settings: _cache.value, error: _cache.value ? null : '未能解析出设置' };
    }

    let names = [];
    try {
        names = fs.readdirSync(dir);
    } catch (e) {
        return { ok: false, dir, settings: null, error: '无法读取目录：' + e.message };
    }

    // 按 mtime 升序：新的排在后面，循环结束时留下的就是最新的值
    const files = names
        .filter((n) => /\.(log|ldb)$/i.test(n))
        .map((n) => {
            let st = { mtimeMs: 0 };
            try { st = fs.statSync(path.join(dir, n)); } catch { /* 忽略 */ }
            return { n, mtimeMs: st.mtimeMs };
        })
        .sort((a, b) => a.mtimeMs - b.mtimeMs);

    let found = null;
    for (const f of files) {
        let buf;
        try { buf = fs.readFileSync(path.join(dir, f.n)); } catch { continue; }
        const s = readFromBuffer(buf);
        if (s) found = s;
    }

    _cache = { at: now, sig, dir, value: found };
    return found
        ? { ok: true, dir, settings: found, error: null }
        : { ok: false, dir, settings: null, error: '未能从 LevelDB 解析出设置（可能已被压缩存储）' };
}

/** 便捷：只要节拍线延迟（毫秒，整数）；读不到返回 null */
export function readBpmBeatLineDelayMs(force = false) {
    const r = readBpmSettings(force);
    if (!r.ok || !r.settings) return null;
    const v = r.settings.beatLineDelayMs;
    return Number.isFinite(v) ? Math.round(v) : null;
}

/** 侧栏 i18n 支持的语言代码（与软件 utils/settings.ts 的 Language 联合类型一致） */
const SUPPORTED_LANGS = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt'];

/**
 * ★ v0.8.16：读软件界面语言（修 Bug 1：多语言没有全软件统一）。
 * 读不到 / 值非法 → 返回 null，调用方回退到侧栏自己的设置，绝不静默用错语言。
 * @returns {string|null}
 */
export function readBpmLang(force = false) {
    const r = readBpmSettings(force);
    if (!r.ok || !r.settings) return null;
    const v = r.settings.lang;
    return typeof v === 'string' && SUPPORTED_LANGS.includes(v) ? v : null;
}

export { SUPPORTED_LANGS };

/** 导出设置键名，便于测试断言与文档引用 */
export { SETTINGS_KEY };
