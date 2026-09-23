// ============================================================================
// 把「制谱侧栏」(osu-maphelper) 导入本软件 —— 生成集成副本 maphelper/
// ============================================================================
// 背景：
//   侧栏一直是在独立的 osu-maphelper_v<版本> 目录里**单独开发**的。
//   要让它"长在软件身上"，就把它的整棵树复制一份到本项目的 maphelper/，
//   打包时随 package.json 的 files 一起进 <resources>\app\maphelper\，
//   于是软件自带的 exe 加一个 --maphelper 参数就能当侧栏跑（见根目录 boot.cjs）。
//
// 用法：
//   node scripts/sync-maphelper.mjs
//   环境变量 MAPHELPER_SRC_ROOT 可指定侧栏源码所在的大目录。
//
// 注意：
//   maphelper/ 是**生成物**，不要在里面直接改代码 —— 改了下次同步就没了。
//   要改侧栏请改 osu-maphelper_v<版本>/ 里的源码，再跑一次本脚本。
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const TARGET = path.join(PROJECT, 'maphelper');

// 侧栏源码可能所在的大目录（按顺序找，第一个命中为准）
const SEARCH_ROOTS = [
    process.env.MAPHELPER_SRC_ROOT || '',
    path.resolve(PROJECT, '..'),
    path.resolve(PROJECT, '..', '..'),
    'D:\\tmp\\新建文件夹\\bpm app'
].filter(Boolean);

/** 任何层级都不进集成副本的目录（依赖 / 日志 / 用户备份 / 版本控制） */
const SKIP_ANYWHERE = new Set(['node_modules', 'logs', 'backups', '.git']);
/** 只在顶层跳过的目录（测试与截图产物，交付包里用不到） */
const SKIP_TOPDIR = new Set(['tests']);

/** 把名字里的数字抽出来做版本比较 */
const numVer = (s) => (s.match(/\d+/g) || []).map(Number);
/** 版本号降序：v0.8.5 排在 v0.8.4 前面 */
function byVersionDesc(a, b) {
    const va = numVer(a);
    const vb = numVer(b);
    for (let i = 0; i < Math.max(va.length, vb.length); i++) {
        const d = (vb[i] || 0) - (va[i] || 0);
        if (d !== 0) return d;
    }
    return a.localeCompare(b);
}

/** 判断某个目录是不是合格的侧栏源码根 */
function isSidebarDir(dir) {
    return (
        fs.existsSync(path.join(dir, 'package.json')) &&
        fs.existsSync(path.join(dir, 'electron', 'main.cjs'))
    );
}

/** 在候选根目录里找版本号最高的侧栏源码 */
function findSource() {
    for (const root of SEARCH_ROOTS) {
        if (!root || !fs.existsSync(root)) continue;
        let entries = [];
        try {
            entries = fs
                .readdirSync(root)
                .filter((n) => n.startsWith('osu-maphelper'))
                .sort(byVersionDesc);
        } catch {
            continue;
        }
        for (const name of entries) {
            const dir = path.join(root, name);
            if (isSidebarDir(dir)) return dir;
        }
    }
    return '';
}

/** 目标目录是不是"我们自己的生成物"（用于安全地整目录重建） */
function isOurArtifact(dir) {
    const pkg = path.join(dir, 'package.json');
    if (!fs.existsSync(pkg)) return false;
    try {
        return JSON.parse(fs.readFileSync(pkg, 'utf8')).name === 'osu-maphelper';
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// 正文
// ---------------------------------------------------------------------------
const src = findSource();

if (!src) {
    if (isOurArtifact(TARGET)) {
        console.log('[同步] 未找到侧栏源码目录，沿用已有的集成副本：', TARGET);
        process.exit(0);
    }
    console.error('[同步] 找不到侧栏源码（需要含 package.json + electron/main.cjs 的 osu-maphelper* 目录）。');
    console.error('       已查找：');
    for (const r of SEARCH_ROOTS) console.error('         ' + r);
    console.error('       可用环境变量 MAPHELPER_SRC_ROOT 指定它所在的大目录。');
    process.exit(1);
}

// 安全阀：只有在确认是"上一轮的生成物"时才整目录删；否则宁可不删
if (fs.existsSync(TARGET)) {
    if (!isOurArtifact(TARGET)) {
        console.error('[同步] 目标目录已存在且不像本脚本的生成物，为安全起见不覆盖：', TARGET);
        console.error('       请先自行确认/清理该目录，或删除后重跑。');
        process.exit(1);
    }
    fs.rmSync(TARGET, { recursive: true, force: true });
}

let files = 0;
let bytes = 0;
fs.cpSync(src, TARGET, {
    recursive: true,
    force: true,
    filter: (s) => {
        const rel = path.relative(src, s);
        if (!rel) return true; // 根目录本身
        const segs = rel.split(path.sep);
        if (segs.some((x) => SKIP_ANYWHERE.has(x))) return false;
        if (SKIP_TOPDIR.has(segs[0])) return false;
        try {
            const st = fs.statSync(s);
            if (st.isFile()) {
                files++;
                bytes += st.size;
            }
        } catch {
            /* 忽略：filter 只做统计 */
        }
        return true;
    }
});

const ver = JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8')).version;

// ---------------------------------------------------------------------------
// 规范化随包发布的 config.json
//
// 源码目录里的 config.json 是**开发机上跑出来的**，里面带着这台机器才成立的字段：
//   osu.installDir / osu.songsDir  → 别人机器上根本不存在这个路径
//   window.x / window.y / panels.*.x|y → 换台分辨率不同的机器，窗口会摆到屏幕外
// 直接发出去的表现就是"装完打开，窗口不见了 / 找不到 osu!"。
// 所以这里把这些「机器绑定」字段清回默认（自动探测 + 自动摆位），
// 而用户偏好类（配色/音量/FFT/灵敏度/是否跟随软件…）是跨机器通用的，保留。
// ---------------------------------------------------------------------------
const cfgPath = path.join(TARGET, 'config.json');
if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.osu) {
        cfg.osu.installDir = ''; // 留空 = 启动时自动探测
        cfg.osu.songsDir = '';
    }
    if (cfg.window) {
        cfg.window.x = null; // null = 自动贴到 osu! 窗口旁边
        cfg.window.y = null;
    }
    cfg.panels = {}; // 各功能窗口的位置/尺寸一律回到默认
    cfg.backup = { ...cfg.backup, dir: '' }; // 备份目录留空 = 用（打包后的）用户数据区
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log('[同步] 已清掉 config.json 里与机器绑定的字段（osu! 路径 / 窗口坐标）');
}

// 抽查关键文件，漏了就直接报错（打包缺文件最难查）
const must = [
    'package.json',
    'config.json',
    'electron/main.cjs',
    'src/core.mjs',
    'src/router.mjs',
    'src/config.mjs',
    'src/bpmSettings.mjs',
    'renderer/index.html',
    'renderer/viz.html',
    'renderer/style.css'
];
const missing = must.filter((f) => !fs.existsSync(path.join(TARGET, f)));

console.log('[同步] 侧栏源码 →', src);
console.log('[同步] 集成副本 →', TARGET);
console.log(`[同步] 侧栏版本 v${ver}，共 ${files} 个文件 / ${(bytes / 1024).toFixed(0)} KB`);
if (missing.length) {
    console.error('[同步] 缺少关键文件：', missing.join(', '));
    process.exit(1);
}
console.log('[同步] 关键文件齐全，完成。');
