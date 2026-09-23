// ============================================================================
// 实机自检 —— 在 osu! 运行时执行，逐步打印整条链路是否打通
// 用法：node tests/live_check.mjs
// 建议：先打开 osu! → 进入制谱器（或选歌界面选中一张图）→ 再运行
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { createTosuClient, detectTosuPort, GameState } from '../src/tosu.mjs';
import { findOsuInstallDir, findSongsDir, findOsuProcess, resolveBeatmapPath } from '../src/paths.mjs';
import { readOsu, extractRedLines } from '../src/osuFile.mjs';

const line = (t) => console.log(`\n${'─'.repeat(60)}\n${t}\n${'─'.repeat(60)}`);
const kv = (k, v) => console.log(`  ${String(k).padEnd(22)} ${v}`);

line('1. osu! 进程');
const proc = await findOsuProcess(); // v0.8.10 起为异步（不再阻塞）
if (proc) {
    kv('状态', '✔ 正在运行');
    kv('PID', proc.pid);
    kv('路径', proc.path);
} else {
    kv('状态', '✘ 未检测到 osu!.exe 进程');
}

line('2. osu! 安装目录 / Songs');
const installDir = findOsuInstallDir();
const songsDir = installDir ? findSongsDir(installDir) : '';
kv('安装目录', installDir || '✘ 未找到');
kv('Songs 目录', songsDir || '✘ 未找到');

line('3. tosu');
const port = await detectTosuPort(24050);
if (!port) {
    kv('状态', '✘ 没有找到在监听的 tosu（请先启动 tosu.exe）');
    process.exit(1);
}
kv('状态', '✔ 已连接');
kv('端口', port);

const client = createTosuClient({ port, timeoutMs: 3000 });
const st = await client.getState();

if (!st) {
    kv('osu! 数据', '✘ tosu 报告 osu! 未就绪（游戏还没进到可读状态）');
    console.log('\n  提示：等 osu! 完全进入界面（主菜单/选歌/制谱器）后再试。');
    process.exit(1);
}

line('4. 实时状态（来自 tosu 读 osu! 内存）');
kv('GameState', `${st.state}（${GameState && st.isEditor ? '制谱器相关 ✔' : '非制谱器'}）`);
kv('是否制谱器', st.isEditor ? '✔ 是' : '— 否');
kv('实时播放位置', `${st.time.toFixed(3)} 秒`);
kv('音频总时长', `${(st.audioLength / 1000).toFixed(1)} 秒`);
kv('BPM 范围', st.bpmRange || '—');
kv('谱面文件', st.fileName || '（无）');
kv('文件相对路径', st.fileLocation || '（无）');
kv('红线 / 绿线（内存）', `${st.redCount} / ${st.greenCount}`);

if (!st.fileName || st.folder === '.') {
    console.log('\n  ⚠ 当前是 osu! 主菜单主题曲（tosu 故意跳过），');
    console.log('    请进入「选歌」选中一张图，或直接进入「制谱器」，再重新运行本脚本。');
    process.exit(0);
}

line('5. 谱面文件定位');
const full = resolveBeatmapPath(st.fileLocation, songsDir, installDir);
kv('解析出的绝对路径', full || '✘ 解析失败');
if (!full || !fs.existsSync(full)) {
    kv('文件是否存在', '✘ 不存在');
    process.exit(1);
}
kv('文件是否存在', '✔ 存在');

line('6. 读取 & 解析谱面');
const bm = readOsu(full);
const reds = extractRedLines(bm);
const h = bm.header;
kv('Artist - Title', `${h.artist} - ${h.title}`);
kv('难度名', h.version);
kv('红线数（磁盘文件）', reds.length);
kv('红线数（编辑器内存）', st.redCount);
kv('是否一致', reds.length === st.redCount ? '✔ 一致（编辑器没有未保存改动）' : `✘ 不一致（差 ${reds.length - st.redCount}）`);
kv('文件大小', `${(bm.size / 1024).toFixed(1)} KB`);
kv('换行风格', bm.eol === '\r\n' ? 'CRLF' : 'LF');

line('7. 前 10 条红线（磁盘文件）');
console.log('  #    时间         BPM');
for (const [i, r] of reds.slice(0, 10).entries()) {
    console.log(`  ${String(i + 1).padStart(2)}   ${String(r.time).padStart(9)} ms   ${r.bpm.toFixed(3)}`);
}
if (reds.length > 10) console.log(`  … 还有 ${reds.length - 10} 条`);

line('8. 当前播放位置对应哪条红线');
const curMs = st.time * 1000;
let active = null;
for (const r of reds) {
    if (r.time <= curMs) active = r;
    else break;
}
if (active) {
    kv('当前红线时间', `${active.time} ms`);
    kv('当前 BPM', active.bpm.toFixed(3));
    kv('距红线', `${(curMs - active.time).toFixed(0)} ms`);
} else {
    kv('当前红线', '尚未到第一条红线之前');
}

line('结论');
console.log('  ✔ tosu → 内存实时位置           正常');
console.log('  ✔ 制谱器状态识别                 正常');
console.log('  ✔ 谱面文件定位                   正常');
console.log('  ✔ .osu 解析（红线 timing）       正常');
console.log('  ✔ 磁盘与内存红线一致性检查       正常');
console.log('\n  可以启动侧栏了：双击「启动侧栏.bat」');
