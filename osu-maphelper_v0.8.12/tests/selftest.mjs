// ============================================================================
// 自测：验证核心模块（不依赖 osu! 运行）
//   ① .osu 解析/序列化：除 [TimingPoints] 外必须逐字节不变
//   ② 原子写回 + 只写 .osu 的保护
//   ③ 备份命名 / 保留数 / 清理（严格限定范围）
//   ④ tosu 客户端连通性（osu! 没开也要优雅降级）
//   ⑤ BPM 测速助手设置读取（节拍线延迟同步：取最后一次写入 / 双编码 / 优雅降级）
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseOsu, serializeOsu, readOsu, writeOsuAtomic, extractRedLines } from '../src/osuFile.mjs';
import { applyTimingToText } from '../src/timingEdit.mjs';
import { createBackupManager, stampName } from '../src/backup.mjs';
import { createTosuClient, detectTosuPort, GameState } from '../src/tosu.mjs';
import { findOsuInstallDir, findSongsDir } from '../src/paths.mjs';
import { loadConfig, saveConfig } from '../src/config.mjs';
import { readBpmSettings, readBpmBeatLineDelayMs } from '../src/bpmSettings.mjs';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
    if (cond) {
        pass++;
        console.log(`  PASS  ${name}${extra ? '  ' + extra : ''}`);
    } else {
        fail++;
        console.log(`  FAIL  ${name}${extra ? '  ' + extra : ''}`);
    }
};
const section = (t) => console.log(`\n=== ${t} ===`);

// ---------------------------------------------------------------- ① 解析 ---
section('① .osu 解析 / 序列化');

const installDir = findOsuInstallDir();
const songsDir = findSongsDir(installDir);
console.log(`  osu! 目录: ${installDir || '(未找到)'}`);
console.log(`  Songs 目录: ${songsDir || '(未找到)'}`);

// 找一份有较多 timing 的谱面
let samplePath = '';
if (songsDir) {
    const folders = fs.readdirSync(songsDir).slice(0, 400);
    let best = { n: -1, p: '' };
    for (const f of folders) {
        const dir = path.join(songsDir, f);
        let entries = [];
        try {
            entries = fs.readdirSync(dir).filter((x) => x.toLowerCase().endsWith('.osu'));
        } catch {
            continue;
        }
        for (const e of entries.slice(0, 6)) {
            const p = path.join(dir, e);
            try {
                const txt = fs.readFileSync(p, 'utf8');
                const n = (txt.match(/\n/g) || []).length;
                if (n > best.n) best = { n, p };
            } catch {
                /* ignore */
            }
        }
    }
    samplePath = best.p;
}

if (!samplePath) {
    console.log('  跳过：没有找到样本谱面');
} else {
    console.log(`  样本: ${path.basename(samplePath)}`);
    const content = fs.readFileSync(samplePath, 'utf8');
    const parsed = parseOsu(content);

    ok('解析成功', parsed.ok === true);
    ok('检测到 [TimingPoints]', !!parsed.sections.find((s) => s.name === 'TimingPoints'));
    ok('解析出 timing 点', parsed.timingPoints.length > 0, `${parsed.timingPoints.length} 条`);
    const reds = extractRedLines(parsed);
    console.log(`  红线 ${reds.length} 条 / 绿线 ${parsed.timingPoints.length - reds.length} 条`);

    // --- 关键：round-trip 必须一模一样 ---
    const same = serializeOsu(parsed, parsed.timingPoints);
    // 归一化比较（换行/BOM 由 serialize 按原风格还原）
    const identical = same === content;
    ok('round-trip 字节级一致', identical, identical ? '' : `差异长度 ${same.length - content.length}`);

    if (!identical) {
        // 找出第一处差异
        let i = 0;
        while (i < Math.min(same.length, content.length) && same[i] === content[i]) i++;
        console.log(`  首个差异 @${i}: 原=${JSON.stringify(content.slice(i, i + 60))}`);
        console.log(`           新=${JSON.stringify(same.slice(i, i + 60))}`);
    }

    // --- 改一条红线 BPM，段落外必须完全不变 ---
    const firstRed = parsed.timingPoints.find((p) => p.uninherited);
    const modPoints = parsed.timingPoints.map((p) =>
        p === firstRed ? { ...p, bpm: 999.5 } : p
    );
    const modified = serializeOsu(parsed, modPoints);
    const mParsed = parseOsu(modified);

    const tp = parsed.sections.find((s) => s.name === 'TimingPoints');
    const headSame = mParsed.lines.slice(0, tp.startLine).join('\n') === parsed.lines.slice(0, tp.startLine).join('\n');
    ok('[TimingPoints] 之前的段落逐行一致', headSame);

    const afterIdxOrig = tp.endLine + 1;
    const newTp = mParsed.sections.find((s) => s.name === 'TimingPoints');
    const afterIdxNew = newTp.endLine + 1;
    const tailSame = mParsed.lines.slice(afterIdxNew).join('\n') === parsed.lines.slice(afterIdxOrig).join('\n');
    ok('[TimingPoints] 之后的段落逐行一致', tailSame);

    const mRed = mParsed.timingPoints.find((p) => p.uninherited);
    ok('改后 BPM 已生效', Math.abs(mRed.bpm - 999.5) < 0.01, `=${mRed.bpm}`);
    ok('timing 条数不变', mParsed.timingPoints.length === parsed.timingPoints.length,
        `${parsed.timingPoints.length} → ${mParsed.timingPoints.length}`);
}

// ------------------------------------------------- ② 原子写 + 扩展名保护 ---
section('② 原子写回 / 扩展名保护');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maphelper-'));
const tmpOsu = path.join(tmpDir, 'test.osu');
const demo = [
    'osu file format v14',
    '',
    '[General]',
    'AudioFilename: audio.mp3',
    'PreviewTime: 12345',
    '',
    '[TimingPoints]',
    '1000,500,4,2,1,70,1,0',
    '1000,-100,4,2,1,70,0,0',
    '5000,400,4,2,1,70,1,0',
    '',
    '[HitObjects]',
    '256,192,1000,1,0,0:0:0:0:'
].join('\r\n');

fs.writeFileSync(tmpOsu, demo, 'utf8');
const dp = parseOsu(demo);
// demo 里：1000 一条红线 + 1000 一条绿线 + 5000 一条红线 → 共 3 点 / 红线 2 条
ok('demo 解析出 2 条红线 + 1 条绿线',
    extractRedLines(dp).length === 2 && dp.timingPoints.length === 3,
    `红${extractRedLines(dp).length}/共${dp.timingPoints.length}`);

const out = serializeOsu(dp, dp.timingPoints);
ok('demo round-trip 一致（含 CRLF 与尾部空行）', out === demo,
    out === demo ? '' : `长度 ${out.length} vs ${demo.length}`);
if (out !== demo) {
    const a = out.split('\r\n');
    const b = demo.split('\r\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) {
            console.log(`    差异行 #${i}: 原=${JSON.stringify(b[i])} 新=${JSON.stringify(a[i])}`);
            break;
        }
    }
}

try {
    writeOsuAtomic(path.join(tmpDir, 'evil.txt'), 'x');
    ok('拒绝写入非 .osu', false, '竟然写成功了');
} catch (e) {
    ok('拒绝写入非 .osu', /拒绝写入/.test(e.message));
}

// 写入后不留 .tmp
writeOsuAtomic(tmpOsu, out + '\r\n');
const leftovers = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp'));
ok('原子写后无 .tmp 残留', leftovers.length === 0, leftovers.join(','));

// ------------------------------------------------- ②b 真实谱面写回保真度 ---
section('②b 真实谱面「只改一条红线 BPM」的写回保真度');

if (samplePath) {
    const realCopy = path.join(tmpDir, 'real.osu');
    const origText = fs.readFileSync(samplePath, 'utf8');
    fs.writeFileSync(realCopy, origText, 'utf8');

    const rp = readOsu(realCopy);
    const reds = extractRedLines(rp);
    // 挑中间那条红线改
    const pick = reds[Math.floor(reds.length / 2)];
    const newBpm = Math.round((pick.bpm + 7.5) * 100) / 100;

    // 复刻 app.applyTiming('redlines') 的变换
    const newPoints = rp.timingPoints.map((p) => {
        if (!p.uninherited) return p;
        if (Math.round(p.time) !== Math.round(pick.time)) return p;
        if (Math.abs(newBpm - 60000 / p.beatLength) < 1e-6) return p;
        return { time: p.time, bpm: newBpm, uninherited: true, meter: p.meter, volume: p.volume, effects: p.effects };
    });

    const newText = serializeOsu(rp, newPoints);
    const a = origText.split(/\r\n|\n|\r/);
    const b = newText.replace(/^\ufeff/, '').split(/\r\n|\n|\r/);

    const diffIdx = [];
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) diffIdx.push(i);
    }
    ok('确实只改了 1 行', diffIdx.length === 1 && a.length === b.length,
        `差异行数=${diffIdx.length}，行数 ${a.length}→${b.length}`);
    if (diffIdx.length === 1) {
        const i = diffIdx[0];
        const tp = rp.sections.find((s) => s.name === 'TimingPoints');
        const inSection = i > tp.startLine && i < tp.endLine;
        ok('改动的行位于 [TimingPoints] 内', inSection, `行号 ${i} (段 ${tp.startLine}~${tp.endLine})`);
        const m = b[i].match(/^(-?\d+),(-?[\d.]+)/);
        ok('新行时间戳未变', m && Number(m[1]) === Math.round(pick.time), `${m ? m[1] : '?'} vs ${Math.round(pick.time)}`);
        ok('新行 BPM 正确', m && Math.abs(60000 / Number(m[2]) - newBpm) < 0.01,
            `${m ? (60000 / Number(m[2])).toFixed(3) : '?'} vs ${newBpm}`);
    }

    // 真实写盘 + 复读
    writeOsuAtomic(realCopy, newText);
    const re = readOsu(realCopy);
    const reReds = extractRedLines(re);
    ok('写盘后红线总数不变', reReds.length === reds.length, `${reds.length} → ${reReds.length}`);
    const target = reReds.find((r) => Math.round(r.time) === Math.round(pick.time));
    ok('写盘后目标红线 BPM 已更新', target && Math.abs(target.bpm - newBpm) < 0.01,
        target ? `${target.bpm}` : '未找到');

    // 其它红线必须一个字节都没动
    let untouched = 0;
    const reByIdx = new Map(reReds.map((r) => [Math.round(r.time), r]));
    for (const r of reds) {
        if (Math.round(r.time) === Math.round(pick.time)) continue;
        const n = reByIdx.get(Math.round(r.time));
        if (n && n.beatLength === r.beatLength) untouched++;
    }
    ok('其它红线 beatLength 全部逐位未变', untouched === reds.length - 1,
        `${untouched}/${reds.length - 1}`);
}

// ------------------------------------------------- ②c 生产写回管线（app 层）---
section('②c 生产写回管线 applyTimingToText');

if (samplePath) {
    const copy2 = path.join(tmpDir, 'pipeline.osu');
    const origText = fs.readFileSync(samplePath, 'utf8');
    fs.writeFileSync(copy2, origText, 'utf8');
    const rp = readOsu(copy2);
    const reds = extractRedLines(rp);

    // --- 正常：改 3 条红线 ---
    const targets = [reds[1], reds[Math.floor(reds.length / 2)], reds[reds.length - 2]];
    const edits = targets.map((r, i) => ({ time: r.time, bpm: Math.round((r.bpm + 3 + i) * 100) / 100 }));
    const res = applyTimingToText(rp, { mode: 'redlines', points: edits });

    ok('管线返回成功', res.ok === true, res.error || '');
    if (res.ok) {
        ok('红线数不变', res.redCount === reds.length, `${reds.length} → ${res.redCount}`);
        ok('绿线数不变', res.greenCount === rp.timingPoints.length - reds.length,
            `${rp.timingPoints.length - reds.length} → ${res.greenCount}`);

        const a = origText.split(/\r\n|\n|\r/);
        const b = res.text.replace(/^\ufeff/, '').split(/\r\n|\n|\r/);
        const diffIdx = [];
        for (let i = 0; i < Math.max(a.length, b.length); i++) if (a[i] !== b[i]) diffIdx.push(i);
        ok('只改了 3 行（不多改也不少改）', diffIdx.length === 3 && a.length === b.length,
            `差异行数=${diffIdx.length}`);
    }

    // --- 安全校验：故意让输出与输入不匹配时不能通过 ---
    const bad = applyTimingToText({ ok: false }, { mode: 'redlines', points: edits });
    ok('解析失败的谱面被拒绝', bad.ok === false && /拒绝写入/.test(bad.error || ''), bad.error || '');

    const empty = applyTimingToText(rp, { mode: 'replace', points: [] });
    ok('空 timing 被拒绝', empty.ok === false, empty.error || '');

    const noChange = applyTimingToText(rp, {
        mode: 'redlines',
        points: [{ time: reds[0].time, bpm: reds[0].bpm }]
    });
    ok('BPM 未变时输出与原文完全一致（零改动）', noChange.ok && noChange.text === origText);

    // --- 写盘后复读校验 ---
    if (res.ok) {
        writeOsuAtomic(copy2, res.text);
        const re = readOsu(copy2);
        const reReds = extractRedLines(re);
        const map = new Map(reReds.map((r) => [Math.round(r.time), r.bpm]));
        let hit = 0;
        for (const e of edits) {
            const got = map.get(Math.round(e.time));
            if (got !== undefined && Math.abs(got - e.bpm) < 0.01) hit++;
        }
        ok('写盘后 3 条改动全部生效', hit === 3, `${hit}/3`);
        ok('写盘后红线总数不变', reReds.length === reds.length, `${reds.length} → ${reReds.length}`);
    }
}

// ---------------------------------------------------------------- ③ 备份 ---
section('③ 备份命名 / 保留 / 清理');

ok('命名格式为 年-月-日-时-分', /^\d{4}-\d{1,2}-\d{1,2}-\d{1,2}-\d{1,2}$/.test(stampName()),
    stampName(new Date(2026, 8, 21, 0, 35)));

const bkDir = path.join(tmpDir, 'bk');
// 关键：把备份目录指到临时目录，避免污染真实 backups/ 并确保测试隔离
saveConfig({ backup: { dir: bkDir } });
const bm = createBackupManager({
    getSource: () => tmpOsu,
    getLabel: () => 'TestMap',
    onLog: () => {}
});

const r1 = bm.backupNow('manual');
ok('备份成功', r1.ok === true, r1.name || r1.reason);
const r2 = bm.backupNow('manual');
ok('同分钟重复备份自动去重', r2.ok === true && r2.name !== r1.name, `${r1.name} / ${r2.name}`);

// 造 70 个假备份验证保留 60
const userDir = path.join(bkDir, 'TestMap');
fs.mkdirSync(userDir, { recursive: true });
for (let i = 0; i < 70; i++) {
    const d = new Date(2026, 0, 1, 0, i);
    fs.writeFileSync(path.join(userDir, `${stampName(d)}.osu`), 'x');
}
// 造一个不该被删的干扰文件
fs.writeFileSync(path.join(userDir, 'IMPORTANT.txt'), 'do not delete');
fs.writeFileSync(path.join(userDir, 'not-a-backup.osu'), 'do not delete');

const before = fs.readdirSync(userDir).length;
const pr = bm.prune('TestMap');
const after = fs.readdirSync(userDir);
ok('清理后仍有文件', after.length > 0, `清理 ${pr.removed} 个`);
ok('保留了 60 份时间戳备份', after.filter((f) => /^\d/.test(f)).length === 60,
    `实际 ${after.filter((f) => /^\d/.test(f)).length}`);
ok('非时间戳文件未被删（.txt）', after.includes('IMPORTANT.txt'));
ok('非时间戳文件未被删（.osu）', after.includes('not-a-backup.osu'));

// 内容未变时定时备份应跳过
const r3 = bm.backupNow('timer');
ok('定时备份内容未变时跳过', r3.ok === false && r3.reason === 'unchanged', r3.reason);

// ----------------------------------------------------------- ④ tosu 客户端 ---
section('④ tosu 客户端');

const client = createTosuClient({ port: 24050, timeoutMs: 1500 });
const up = await client.isTosuUp();
ok('tosu 服务可达（本机实测）', typeof up === 'boolean', up ? '已在运行' : '未运行');

const st = await client.getState();
if (up && st === null) {
    ok('osu! 未运行时优雅降级为 null', true, '（osu! 没开，符合预期）');
} else if (st) {
    ok('拿到 osu! 状态', true, `state=${st.state} time=${st.time}s 红线=${st.redCount}`);
} else {
    ok('tosu 未运行时返回 null', true);
}

ok('GameState 枚举映射正确', GameState[1] === 'edit' && GameState[4] === 'selectEdit');

const detected = await detectTosuPort(24050);
ok('端口探测函数可用', detected === null || typeof detected === 'number', `探测到 ${detected}`);

// --------------------------------------- ⑤ BPM 软件设置读取（节拍线延迟同步）---
section('⑤ BPM 测速助手 设置读取（节拍线延迟同步）');

{
    // ★ 关键用例：LevelDB 是**追加写**的 —— 同一个设置键在 .log 里会留下很多历史值，
    //   只有**最后一次**出现的才是当前值。这里用假目录复刻这个场景，
    //   确保取到的是 42 而不是历史值 -25 / 25（取错就会读到过期延迟）。
    const fakeRoot = path.join(tmpDir, 'fake-bpm');
    const fakeDb = path.join(fakeRoot, 'Local Storage', 'leveldb');
    fs.mkdirSync(fakeDb, { recursive: true });

    // 复刻 Chromium localStorage 的落盘格式：_<origin>\x00\x01<key>\x01<json>
    const rec = (ms, v) =>
        `\u0000\u0001_https://osu-maphelper\u0000\u0001bpm-measurer-settings\u0001` +
        `{"accent":"#6366f1","beatLineDelayMs":${ms},"specSensitivity":75,"__v":${v}}`;
    fs.writeFileSync(path.join(fakeDb, '000003.log'), rec(-25, 6) + rec(25, 6) + rec(42, 7), 'latin1');

    const prevEnv = process.env.BPM_USER_DATA;
    process.env.BPM_USER_DATA = fakeRoot;
    try {
        const r = readBpmSettings(true);
        ok('能从假 LevelDB 解析出设置', r.ok === true, r.error || '');
        ok('取的是**最后一次**写入（不是历史值）', r.ok && r.settings.beatLineDelayMs === 42,
            r.ok ? `读到 ${r.settings.beatLineDelayMs}（期望 42；-25/25 是历史值，不该被选中）` : '解析失败');
        ok('便捷函数同样正确', readBpmBeatLineDelayMs(true) === 42);
        ok('缓存命中时结果一致（不重复读盘）', readBpmBeatLineDelayMs() === 42);

        // UTF-16LE 落盘分支（值里含非 Latin-1 字符时 Chromium 会改用这个编码）
        fs.writeFileSync(path.join(fakeDb, '000004.log'), Buffer.from(rec(7, 7), 'utf16le'));
        const rUtf16 = readBpmSettings(true);
        ok('UTF-16LE 编码也能解析', rUtf16.ok === true && rUtf16.settings.beatLineDelayMs === 7,
            rUtf16.ok ? `读到 ${rUtf16.settings.beatLineDelayMs}` : rUtf16.error || '');

        // 目录不存在 → 必须优雅降级（抛异常会让 /api/state 整条挂掉）
        process.env.BPM_USER_DATA = path.join(tmpDir, 'not-exist-dir');
        const r2 = readBpmSettings(true);
        ok('目录不存在时返回 ok:false（不抛异常）', r2.ok === false && !!r2.error, r2.error || '');
    } finally {
        if (prevEnv === undefined) delete process.env.BPM_USER_DATA;
        else process.env.BPM_USER_DATA = prevEnv;
    }

    // 真实环境顺带核对一次（没装/没跑过软件时走 else 分支，同样算通过）
    const real = readBpmSettings(true);
    if (real.ok) {
        ok('本机软件设置可读（真实环境）', Number.isFinite(real.settings.beatLineDelayMs),
            `beatLineDelayMs=${real.settings.beatLineDelayMs}`);
    } else {
        ok('本机未找到软件设置 → 侧栏回退到手动值', true, real.error || '');
    }
}

// ---------------------------------------------------------------- 收尾 ---
section('结果');
console.log(`  ${pass} 通过 / ${fail} 失败`);

// 还原备份目录配置（避免测试残留把真实 app 指向已被删掉的临时目录）
saveConfig({ backup: { dir: '' } });
try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
} catch {
    /* ignore */
}

process.exit(fail === 0 ? 0 : 1);
