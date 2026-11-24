// 把「osu! 制谱侧栏」源码同步成集成副本 maphelper/，随主程序一起打包。
// 用法：node scripts/sync-maphelper.mjs
// 说明：maphelper/ 是生成物，不要在里面改代码；改侧栏源码后再跑一次。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.resolve(__dirname, '..');
const TARGET = path.join(PROJECT, 'maphelper');

// 候选根目录：环境变量优先，然后从主程序目录逐级向上找（覆盖仓库、并排开发、交付包三种布局）
const SEARCH_ROOTS = [];
if (process.env.MAPHELPER_SRC_ROOT) SEARCH_ROOTS.push(process.env.MAPHELPER_SRC_ROOT);
let cursor = PROJECT;
for (let i = 0; i < 6; i++) {
    const parent = path.resolve(cursor, '..');
    if (path.dirname(parent) === parent) break; // 到盘符根就停，不再往上扫
    cursor = parent;
    SEARCH_ROOTS.push(cursor);
}

/** 任何层级都不进集成副本的目录 */
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

/** 在候选根目录里找版本号最高的侧栏源码；找不到 osu-maphelper* 时兼容交付包的「侧栏/」布局 */
function findSource() {
    for (const root of SEARCH_ROOTS) {
        if (!root || !fs.existsSync(root)) continue;
        let entries = [];
        try {
            entries = fs.readdirSync(root);
        } catch {
            continue;
        }
        const versioned = entries.filter((n) => n.startsWith('osu-maphelper')).sort(byVersionDesc);
        const aliases = entries.filter((n) => n === '侧栏' || n === 'sidebar');
        for (const name of [...versioned, ...aliases]) {
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

const src = findSource();

if (!src) {
    if (isOurArtifact(TARGET)) {
        console.log('[同步] 未找到侧栏源码目录，沿用已有的集成副本：', TARGET);
        process.exit(0);
    }
    console.error('[同步] 找不到侧栏源码（需要含 package.json + electron/main.cjs 的 osu-maphelper* 或 侧栏 目录）。');
    console.error('       已查找：');
    for (const r of SEARCH_ROOTS) console.error('         ' + r);
    console.error('       可用环境变量 MAPHELPER_SRC_ROOT 指定它所在的大目录。');
    process.exit(1);
}

// 安全阀：只有确认是上一轮的生成物时才整目录删
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
        if (!rel) return true;
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
            /* 统计用 */
        }
        return true;
    }
});

const ver = JSON.parse(fs.readFileSync(path.join(TARGET, 'package.json'), 'utf8')).version;

// 清掉 config.json 里与本机绑定的字段（osu! 路径、窗口坐标），保留用户偏好
const cfgPath = path.join(TARGET, 'config.json');
if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.osu) {
        cfg.osu.installDir = '';
        cfg.osu.songsDir = '';
    }
    if (cfg.window) {
        cfg.window.x = null;
        cfg.window.y = null;
    }
    cfg.panels = {};
    cfg.backup = { ...cfg.backup, dir: '' };
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
    console.log('[同步] 已清掉 config.json 里与机器绑定的字段');
}

// 抽查关键文件，漏了直接报错（打包缺文件最难查）
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
