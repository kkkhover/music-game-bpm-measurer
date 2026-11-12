#!/usr/bin/env node
/**
 * 外部谱面链路回归验收（不需要 Electron / 浏览器）。
 *
 *   node scripts/verify-beatmap.cjs <file.osu|file.osz|目录> [...]
 *   npm run verify:beatmap -- "D:/GAME/osu!/Exports/Camellia - WHAT THE CAT!.osz"
 *
 * 检查：4K/7K 键数识别、[TimingPoints] 全量保真、卡片往返一致、
 *       连续编辑幂等（绿线不叠加）、改单条 SV 只改一行、SV 时间轴单调可逆。
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const ROOT = path.join(__dirname, '..');
// 直接用本地 TypeScript 转译 .ts（只做类型擦除），避免为测试单独产出构建文件
require.extensions['.ts'] = (mod, filename) => {
  const src = fs.readFileSync(filename, 'utf8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
  }).outputText;
  mod._compile(out, filename);
};

// main.ts / skinFiles.ts 用 ESM 风格的 './xxx.js' 后缀，测试环境里源码是 .ts：
// 给 Node 的模块解析加一层回退，找不到 .js 时改找同目录的 .ts。
const Module = require('module');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, isMain, options) {
  if (parent && request.startsWith('.') && request.endsWith('.js')) {
    const abs = path.resolve(path.dirname(parent.filename), request);
    const asTs = abs.replace(/\.js$/, '.ts');
    if (!fs.existsSync(abs) && fs.existsSync(asTs)) return asTs;
  }
  return origResolve.call(this, request, parent, isMain, options);
};

const B = require(path.join(ROOT, 'utils/osuBeatmap.ts'));
const P = require(path.join(ROOT, 'utils/osuPatch.ts'));
const S = require(path.join(ROOT, 'utils/svTimeline.ts'));
const E = require(path.join(ROOT, 'utils/osuExport.ts'));
const V = require(path.join(ROOT, 'utils/noteViewport.ts'));
const SK = require(path.join(ROOT, 'utils/osuSkin.ts'));
const O = require(path.join(ROOT, 'utils/osuScroll.ts'));
const SF = require(path.join(ROOT, 'src/skinFiles.ts'));
const { readZip } = require(path.join(ROOT, 'src/zipReader.ts'));

let failures = 0;
let skipped = 0;
const ok = (cond, msg) => { console.log((cond ? '  PASS ' : '  FAIL ') + msg); if (!cond) failures++; };
const skip = (msg) => { console.log('  SKIP ' + msg); skipped++; };
const MODE_NAME = { 0: 'osu!standard', 1: 'osu!taiko', 2: 'osu!catch', 3: 'osu!mania' };

function collect(input) {
  const out = [];
  const st = fs.statSync(input);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(input)) {
      if (/\.(osu|osz)$/i.test(n)) out.push(...collect(path.join(input, n)));
    }
    return out;
  }
  if (/\.osz$/i.test(input)) {
    for (const e of readZip(fs.readFileSync(input))) {
      if (/\.osu$/i.test(e.name)) out.push({ name: `${path.basename(input)} :: ${e.name}`, text: e.data.toString('utf8') });
    }
  } else if (/\.osu$/i.test(input)) {
    out.push({ name: path.basename(input), text: fs.readFileSync(input, 'utf8') });
  }
  return out;
}

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.log('用法: node scripts/verify-beatmap.cjs <file.osu|file.osz|目录> [...]');
  process.exit(2);
}
const files = inputs.flatMap(collect);
if (!files.length) { console.error('没有找到 .osu 谱面'); process.exit(2); }

for (const f of files) {
  console.log('\n=== ' + f.name + ' ===');
  const doc = B.parseOsuDocument(f.text, f.name, f.name);
  ok(!!doc, '解析 [TimingPoints] 成功');
  if (!doc) { failures++; continue; }
  const { points } = B.docToPoints(doc);
  // 本工具只处理 mania 谱面；扫目录时遇到其他模式（Exports 里常混有 standard 谱）
  // 记为 SKIP 跳过，而不是算作失败，避免无关谱面把 mania 回归结果淹没。
  if (doc.mode !== 3) {
    skip(`非 mania 谱面（Mode=${doc.mode} → ${MODE_NAME[doc.mode] || 'unknown'}），跳过`);
    continue;
  }
  ok(true, `Mode=${doc.mode} (osu!mania)`);
  ok(doc.keyCount >= 1 && doc.keyCount <= 18, `键数 ${doc.keyCount}K`);
  ok(doc.notes.count > 0, `[HitObjects] ${doc.notes.count} 个音符（TypedArray ${Math.round(doc.notes.count * 18 / 1024)}KB）`);
  ok(doc.timing.length > 0, `[TimingPoints] ${doc.timing.length} 行 → ${points.length} 张卡片`);
  ok(points.every(p => typeof p.timeSec === 'number' && p.svRate > 0), '卡片都有绝对时间与有效 SV');

  const patched = P.patchOsuDocument(doc, points);
  ok(P.verifyTimingOnlyChange(doc.text, patched), '段外字节完全一致（安全闸）');
  const d2 = B.parseOsuDocument(patched, '', f.name);
  ok(d2 && d2.timing.length === doc.timing.length, `重建行数 ${d2?.timing.length} == 原 ${doc.timing.length}`);
  ok(d2 && d2.notes.count === doc.notes.count && d2.keyCount === doc.keyCount, '音符数与键数不变');
  if (d2) {
    // 逐值保真：时间、红线 BPM、绿线 SV、采样/音量字段都不能被重建改写
    const val = l => l.uninherited ? 60000 / l.beatLength : -100 / l.beatLength;
    const same = doc.timing.every((l, i) => {
      const r = d2.timing[i];
      return r && Math.abs(l.timeMs - r.timeMs) < 1 && Math.abs(val(l) - val(r)) < 0.002
        && l.sampleSet === r.sampleSet && l.sampleIndex === r.sampleIndex && l.volume === r.volume
        && l.effects === r.effects && l.kiai === r.kiai && l.meter === r.meter;
    });
    ok(same, 'timing 逐条保真（时间 / BPM / SV / 采样 / 音量 / Kiai / 拍号）');
  }

  let idem = true, cur = points;
  for (let i = 0; i < 12; i++) {
    if (P.patchOsuDocument(doc, cur) !== patched) { idem = false; break; }
    cur = B.docToPoints(B.parseOsuDocument(patched, '', f.name)).points;
  }
  ok(idem, '连续重建 12 次幂等（绿线不叠加）');

  const gi = points.findIndex(p => p.lineType === 'green' || p.lineType === 'both');
  if (gi >= 0) {
    const edited = points.map((p, i) => i === gi ? { ...p, svRate: 3.5 } : p);
    const after = P.patchOsuDocument(doc, edited);
    const lines = s => s.split(/\r+\n|\n/).filter(l => /^\s*-?[\d.]+,/.test(l));
    const a = lines(patched), b = lines(after);
    ok(a.length === b.length && a.filter((l, i) => l !== b[i]).length === 1, '改一条 SV 只影响 1 行');
    ok(P.verifyTimingOnlyChange(doc.text, after), '改 SV 后仍通过安全校验');
    const tl = S.buildSvTimeline(edited, doc.durationMs);
    let mono = true;
    for (let ms = 0; ms < Math.min(doc.durationMs, 60000); ms += 500) {
      if (tl.posAt(ms + 500) <= tl.posAt(ms)) { mono = false; break; }
    }
    ok(mono, 'SV 积分 pos(t) 严格单调');
    ok(Math.abs(tl.timeAtPos(tl.posAt(12345)) - 12345) < 1, 'pos/t 反解可逆');
  }

  const both = P.emitTimingLines([{ tMs: 1000, point: { id: 'x', beatIndex: 0, bpm: 200, svRate: 1, lineType: 'both' } }]);
  ok(both.length === 2 && both[1].split(',')[1] === '-100.000000000000', '默认「红+绿」且 SV=1');
  ok(E.generateOsuTimingPoints(1, [{ beatIndex: 0, bpm: 180, svRate: 1, lineType: 'both' }], 180).includes('-100'),
     '旧 txt 导出链路仍可用');

  // ★ 高流速 LN 回归：找出最长的一条 LN，在它持续时间的中点检查仍然可见
  let bi = -1, best = 0;
  for (let i = 0; i < doc.notes.count; i++) {
    const hold = doc.notes.endMs[i] - doc.notes.timeMs[i];
    if (hold > best) { best = hold; bi = i; }
  }
  ok(Number.isFinite(doc.notes.maxHoldMs) && doc.notes.maxHoldMs >= best - 1,
     `最长 LN 回看上界 ${(doc.notes.maxHoldMs / 1000).toFixed(1)}s`);
  if (bi >= 0 && best > 1000) {
    const mid = doc.notes.timeMs[bi] + best / 2;
    const tl0 = S.buildSvTimeline(points, doc.durationMs);
    const tMax0 = Math.min(tl0.timeAtPos(tl0.posAt(mid) + 500 / 260), doc.durationMs);
    ok(V.visibleNoteIndices(doc.notes, mid - 400, tMax0).includes(bi),
       `真实谱面：${(best / 1000).toFixed(1)}s 长条在中点仍可见（高流速不提前消失）`);
  }
}

// ===== 合成场景：高 SV × 高 ScrollSpeed 的 LN 裁剪、皮肤 ini、三色线 =====
console.log('\n=== 高流速 LN / 皮肤方案 / 线型配色 ===');
const synth = {
  count: 5,
  timeMs: Float64Array.from([0, 1000, 2000, 9500, 11000]),
  endMs: Float64Array.from([0, 9000, 2000, 9500, 11000]), // 1 号是 8 秒长条
  column: Uint8Array.from([0, 1, 2, 3, 0]),
  isLn: Uint8Array.from([0, 1, 0, 0, 0]),
  maxHoldMs: 8000,
};
const highSv = S.buildSvTimeline([{ id: 'a', beatIndex: 0, bpm: 180, timeSec: 0, svRate: 6.3, lineType: 'both' }], 12000);
const nowMs = 3000, tMin = nowMs - 400, pps = 260 * 3; // SV 6.3 × ScrollSpeed 3
const tMax = Math.min(highSv.timeAtPos(highSv.posAt(nowMs) + (500 / pps) * 1.05), nowMs + 20000, 12000);
ok(V.visibleNoteIndices(synth, tMin, tMax).includes(1), 'SV=6.3 / SS=3：起点已出视口的 8 秒长条仍可见');
ok(B.firstNoteAtOrAfter(synth, tMin) > 1, '复现旧 bug：只按 tMin 二分必然漏掉该长条');
ok(!V.visibleNoteIndices(synth, 9200, 9300).includes(1), '长条尾巴也过去后不再绘制');
// 连续播放 75 帧：高流速下长条必须始终在可见集合里（旧逻辑约 3 帧后就把它丢掉）
let frames = 0, kept = 0, oldKept = 0;
for (let now = 1200; now <= 8600; now += 100) {
  const hi = Math.min(highSv.timeAtPos(highSv.posAt(now) + (500 / pps) * 1.05), now + 20000, 12000);
  if (V.visibleNoteIndices(synth, now - 400, hi, 1500).includes(1)) kept++;
  if (B.firstNoteAtOrAfter(synth, now - 400) <= 1) oldKept++;
  frames++;
}
ok(kept === frames, `高流速连续 ${frames} 帧长条始终可见（旧逻辑只有 ${oldKept} 帧）`);
ok(oldKept < frames / 4, '旧逻辑确实会提前丢失长条（对照组）');
const r1 = V.noteRect(700, 100, 500);
ok(r1 && r1.top === 100 && r1.bottom === 500 && r1.height === 400, 'LN 头在屏幕下方时裁剪到 [0,h] 仍画到判定线');
ok(V.noteRect(-30, -120, 500) === null, '整条在屏幕上方 → 不画');
ok(V.noteRect(600, 590, 500) === null, '整条在屏幕下方 → 不画');
const many = {
  count: 2000,
  timeMs: Float64Array.from({ length: 2000 }, (_, i) => i * 2),
  endMs: Float64Array.from({ length: 2000 }, (_, i) => i * 2),
  column: new Uint8Array(2000), isLn: new Uint8Array(2000), maxHoldMs: 4000,
};
const visMany = V.visibleNoteIndices(many, 1000, 1200, 50);
ok(visMany.length === 50 && visMany[0] === 500, '回看时跳过的已过去音符不占用绘制配额');

const iniText = [
  '[General]', 'Name: My Skin', '[Mania]', 'Keys: 4',
  'ColumnWidth: 40,40,40,40', 'Colour1: 255,0,0', 'NoteImage0: myfolder/noteA.png',
  'JudgementLine: 1', 'NoteBodyStyle: 1',
  '[Mania]', 'Keys: 7', 'ColumnWidth: 30,30,30,30,30,30,30',
].join('\n');
const parsed = SK.parseSkinIni(iniText);
ok(parsed.mania.length === 2 && parsed.mania[0].keys === 4 && parsed.mania[1].keys === 7,
   'skin.ini 多个 [Mania] 段按 Keys 分组');
const style = { name: 'test', images: new Map(), general: parsed.general, colours: parsed.colours, mania: parsed.mania, imageCount: 0 };
const r4 = SK.skinForKeys(style, 4), r7 = SK.skinForKeys(style, 7);
ok(r4.columnWidth.every(v => v === 40) && r7.columnWidth.every(v => v === 30), '按谱面键数取对应列宽（x480 单位）');
ok(r4.laneColors[0] === '#ff0000' && r4.noteStems[0] === 'myfolder/notea', '列色 / ini 指定素材路径解析');
ok(r4.noteBodyStyle === 1 && r4.judgeLine === true, 'LN 样式与判定线开关解析');
const lay = SK.laneLayout(7, 320, 500, r7);
ok(lay.x.length === 7 && lay.total > 0 && lay.total <= 320, '7K x480 列布局能收进竖屏小窗');
ok(SK.lineColor('green') === '#3cc83c' && SK.lineColor('red') === '#ef4444' && SK.lineColor('both') === '#f59e0b',
   '频谱三色线：绿 / 红 / 橙');

// ===== osu!mania 真实流速模型（BPM 不参与下落，SV 与 SS 直接相乘）=====
console.log('\n=== osu! 流速模型 / 皮肤素材通道 ===');
ok(Math.abs(O.OSU_SCROLL_MS - 13720) < 1e-9, 'osu! 常量：480 单位 / SS=1 → 13720ms');
ok(Math.abs(O.osuPxPerSec(1, 20) - 480 * 20 * 1000 / 13720) < 1e-6, '落速 = 480×SS×1000/13720 px/s');
ok(Math.abs(O.osuVisibleMs(20, 1) - 686) < 1, 'SS=20 SV=1 → 可视 686ms');
ok(Math.abs(O.osuVisibleMs(20, 2) - 343) < 1, 'SV 翻倍 → 可视时间减半');
ok(Math.abs(O.osuVisibleMs(20, 1, 240) - 343) < 1, 'HitPosition=240 → 可视时间按 /480 缩放');
// osu!mania 的真实模型：谱面内 BPM 变化**一定**改变流速（官方论坛 posts/6564040、posts/7246487），
// 作者靠绿线 SV=原BPM/新BPM 补偿。所以 v=(bpm/基准)×sv 才是默认，纯 SV 只是可选项。
const bpmPts = [
  { timeSec: 0, bpm: 120, svRate: 1, lineType: 'both' },
  { timeSec: 10, bpm: 240, svRate: 1, lineType: 'both' },
  { timeSec: 20, bpm: 240, svRate: 2, lineType: 'green' },
];
const linked = S.buildSvTimeline(bpmPts, 30000);                       // 默认 = BPM×SV
const svOnly = S.buildSvTimeline(bpmPts, 30000, { bpmScale: false });  // 只看 SV
ok(Math.abs(linked.baseBpm - 120) < 1e-6, '基准 BPM 取主导红线 BPM（120）');
ok(Math.abs(linked.stateAt(15000).speed - 2) < 1e-6, 'BPM 翻倍（未补偿）→ 流速翻倍，与 osu! 一致');
ok(Math.abs(linked.stateAt(25000).speed - 4) < 1e-6, 'BPM×2 且 SV×2 → 流速 ×4');
ok(Math.abs(svOnly.stateAt(15000).speed - 1) < 1e-6, '关掉 BPM 联动后只看 SV：段速仍为 1');
ok(Math.abs(svOnly.stateAt(25000).speed - 2) < 1e-6, '关掉 BPM 联动后 SV=2 才使流速翻倍');
// 橙线（红线 + 同刻绿线补偿）：bpm×sv = 基准 BPM ⇒ 流速恒为 100%
const comp = S.buildSvTimeline([
  { timeSec: 0, bpm: 150, svRate: 1, lineType: 'both' },
  { timeSec: 10, bpm: 250, svRate: 0.6, lineType: 'both' },
  { timeSec: 20, bpm: 300, svRate: 0.5, lineType: 'both' },
  { timeSec: 30, bpm: 440, svRate: 0.34, lineType: 'both' },
], 40000);
const compSpeed = [11000, 21000, 31000].map(t => comp.stateAt(t).speed);
ok(compSpeed.every(s => Math.abs(s - 1) < 0.01),
   `橙线补偿：250×0.6 / 300×0.5 / 440×0.34 流速恒为 100%（实测 ${compSpeed.map(s => (s * 100).toFixed(1) + '%').join(' / ')}，440 那条因 0.34 取整为 99.7%）`);
let rev = true;
for (let t = 0; t <= 30000; t += 250) if (Math.abs(linked.timeAtPos(linked.posAt(t)) - t) > 0.01) { rev = false; break; }
ok(rev, 'pos(t) / timeAtPos 仍严格可逆');
ok(linked.posAt(30000) > svOnly.posAt(30000) * 0.5, '两种模型积分位置有区分度');

// ===== skin.ini 路径型字段 + LN 三段 + x480 布局 =====
ok(SF.toStem('Orbs\\izquierda@2x.PNG') === 'orbs/izquierda', 'toStem 归一化：反斜杠 / @2x / 扩展名 / 大小写');
const stems = SF.stemsFromIni([
  '[Mania]', 'Keys: 4', 'ColumnWidth: 40,40,40,40', 'Colour1: 0,0,0,150',
  'NoteImage0: Orbs\\izquierda', 'NoteImage0L: Orbs\\noteL', 'NoteImage0T: Orbs\\noteT',
  'KeyImage0: Orbs\\key', 'StageLeft: mania-stage-left', 'LightingN: none', 'HitPosition: 454',
].join('\n'));
ok(stems.has('orbs/izquierda') && stems.has('orbs/notel') && stems.has('orbs/notet')
   && stems.has('orbs/key') && stems.has('mania-stage-left'), 'skin.ini 引用的自定义路径全部被收集');
ok(!stems.has('0,0,0,150') && !stems.has('454') && !stems.has('none'), '颜色 / 数值 / none 不会被误判为素材路径');
const fullIni = [
  '[Mania]', 'Keys: 4', 'ColumnStart: 296', 'HitPosition: 454',
  'ColumnWidth: 73,73,73,73', 'ColumnSpacing: 0,0,0,0', 'JudgementLine: 0',
  'KeysUnderNotes: 1', 'UpsideDown: 0', 'NoteBodyStyle: 2',
  'ColourHold: 255,128,0', 'WidthForNoteHeightScale: 60',
  'NoteImage0: Orbs\\izquierda', 'NoteImage0H: Orbs\\izquierda',
  'NoteImage0L: Orbs\\noteL', 'NoteImage0T: Orbs\\noteT',
  'KeyImage0: Orbs\\key', 'KeyImage0D: Orbs\\keyD',
  'StageHint: mania-stage-hint', 'LightingN: lightingN',
].join('\n');
const fp = SK.parseSkinIni(fullIni);
const fs2 = { name: 'real', images: new Map(), byBase: new Map(), general: fp.general, colours: fp.colours, mania: fp.mania, imageCount: 0 };
const fr = SK.skinForKeys(fs2, 4);
ok(fr.noteStems[0] === 'orbs/izquierda' && fr.lnBodyStems[0] === 'orbs/notel'
   && fr.lnTailStems[0] === 'orbs/notet' && fr.headStems[0] === 'orbs/izquierda',
   'LN 三段 H/L/T 与自定义音符路径解析');
ok(fr.keyStems[0] === 'orbs/key' && fr.keyDownStems[0] === 'orbs/keyd', '接收器 KeyImage / KeyImageD 解析');
ok(fr.columnStart === 296 && fr.hitPosition === 454 && fr.judgeLine === false
   && fr.noteBodyStyle === 2 && fr.widthForNoteHeightScale === 60,
   'ColumnStart / HitPosition / JudgementLine / NoteBodyStyle / 参考宽度');
ok(fr.colourHold === '#ff8000' && fr.stageHint === 'mania-stage-hint' && fr.lightingN === 'lightingn',
   'ColourHold / StageHint / LightingN');
const fl = SK.laneLayout(4, 320, 500, fr);
ok(fl.x[0] >= 0 && fl.x[3] + fl.width[3] <= 320.5 && fl.unit > 0.5 && fl.judgeY > 300
   && Math.abs(fl.judgeY - (fl.offsetY + fr.hitPosition * fl.unit)) < 1e-6,
   'x480 布局：舞台居中、判定线由 HitPosition 锚定');

// ===== 固定比例游玩区（窗口放大缩小不改变显示区域形状）=====
const viewRatio = l => (l.viewRight - l.viewLeft) / (l.viewBottom - l.viewTop);
const a1 = SK.laneLayout(4, 320, 500, fr);
const a2 = SK.laneLayout(4, 900, 300, fr);
const a3 = SK.laneLayout(4, 240, 900, fr);
ok(Math.abs(viewRatio(a1) - viewRatio(a2)) < 1e-9 && Math.abs(viewRatio(a1) - viewRatio(a3)) < 1e-9
   && Math.abs(viewRatio(a1) - a1.viewW / a1.viewH) < 1e-9,
   '窗口宽高比任意变化，游玩区宽高比恒定（letterbox）');
const stageRel = l => (l.x[0] - l.viewLeft) / (l.viewRight - l.viewLeft);
ok(Math.abs(stageRel(a1) - stageRel(a2)) < 1e-9 && Math.abs(stageRel(a1) - stageRel(a3)) < 1e-9,
   '缩放时舞台在游玩区内的相对位置不变');
ok(a1.viewLeft >= -0.001 && a1.viewRight <= 320.001 && a2.viewTop >= -0.001 && a2.viewBottom <= 300.001,
   '游玩区始终完整落在画布内（多余部分是信箱区）');

// ===== 接收器 / 判定区域 =====
const rq = SK.receptorRect(a1, 0, 100, 284);
// 高度 = 图片高 × 0.625（x768→x480），宽 = 列宽，底边贴游玩区下沿。
// fengpengGG 的 drawKeys() 就是 ent.h * scale / 1.6；按宽高比算会偏大 14%，圆环变竖椭圆。
const expectH = 284 * 0.625 * a1.unit;
ok(Math.abs(rq.y + rq.h - a1.viewBottom) < 1e-9 && Math.abs(rq.h - expectH) < 1e-9,
   `接收器：底边贴游玩区下沿、高 = 图片高 × 0.625（100×284 → ${(expectH / rq.w).toFixed(2)} 倍列宽）`);
ok(rq.h / rq.w < 2.84, '接收器不再是按宽高比放大的竖长椭圆（188/100=2.84 已被 0.625 修正）');
ok(rq.y > a1.viewTop && rq.x >= a1.viewLeft - 0.001 && rq.x + rq.w <= a1.viewRight + 0.001,
   '接收器完整落在游玩区内，不会被窗口下沿切掉');
ok(rq.y < a1.judgeY && rq.y + rq.h > a1.judgeY,
   '判定线穿过接收器（HitPosition=454 时圆环正好压在线上）');
ok(Math.abs((a1.judgeY - a1.viewTop) - fr.hitPosition * a1.unit) < 1e-9,
   '判定线高度 = HitPosition × unit（从游玩区顶部算起）');
// 真实 key.png 的可见圆环在图片 y145~247；按 0.625 换算后环底应压在判定线上
{
  const ringBottomInImg = 247, imgH = 284;
  const ringBottomY = a1.viewBottom - (imgH - ringBottomInImg) * 0.625 * a1.unit;
  ok(Math.abs(ringBottomY - a1.judgeY) < 12,
     `真实皮肤圆环底边 ≈ 判定线（相差 ${Math.abs(ringBottomY - a1.judgeY).toFixed(1)}px < 12px）`);
}
// 动画帧 -0 与 basename 回退
const fakeImg = { img: {}, is2x: false, w: 10, h: 10 };
const fs3 = {
  ...fs2,
  images: new Map([['mania-note1l-0', fakeImg], ['sub/custom', fakeImg]]),
  byBase: new Map([['mania-note1l-0', fakeImg], ['custom', fakeImg], ['mania-note1l', fakeImg]]),
};
ok(SK.findSkinImage(fs3, 'mania-note1L') === fakeImg, '官方 -0 动画帧默认取第一帧');
ok(SK.findSkinImage(fs3, 'custom') === fakeImg, 'ini 写文件名、素材在子目录时按 basename 回退');
ok(SK.findSkinImageAny(fs3, ['missing', 'sub/custom']) === fakeImg, '多候选 stem 逐级回退');
// 同一段内重复字段取第一个值（与 OsuSkinMaker / osu! 官方一致）
const dup = SK.parseSkinIni('[Mania]\nKeys: 4\nHitPosition: 400\nHitPosition: 460\n');
ok(SK.skinForKeys({ ...fs2, mania: dup.mania }, 4).hitPosition === 400, '同字段重复取首值');

// ===== 真实皮肤（仅当本机存在这些路径时执行，保证脚本可移植）=====
const realSongs = 'D:/GAME/osu!/Songs';
if (fs.existsSync(realSongs)) {
  const t0 = Date.now();
  const payload = SF.buildSkinPayload(realSongs);
  const ms = Date.now() - t0;
  ok(!payload.error && payload.count > 0 && payload.count <= 120,
     `歌曲库自动定位内嵌皮肤（${payload.count} 张素材，${ms}ms）`);
  const names = Object.keys(payload.images || {});
  ok(['izquierda', 'notel', 'notet', 'key'].every(n => names.some(k => k.includes('orbs/' + n))),
     '真实皮肤：Orbs 自定义音符 / LN / 接收器素材全部读到');
  ok(ms < 2000, `大目录导入不卡顿（${ms}ms < 2s）`);
}
const realOsk = 'D:/GAME/osu!/Exports/zhitu.osk';
if (fs.existsSync(realOsk)) {
  const z = SF.buildSkinPayload(realOsk);
  ok(!z.error && z.count > 0, `.osk 皮肤包导入（${z.count} 张素材）`);
}
// 「扩展名是 .png、内容其实是 TIFF」的超长面身：必须被解成 PNG 并只留顶部行
const tiffSkin = 'D:/GAME/osu!/Skins/隠(なばり) 杏珠(あんじゅ)';
if (fs.existsSync(path.join(tiffSkin, 'mania/holdbody.png'))) {
  const t0 = Date.now();
  const p = SF.buildSkinPayload(tiffSkin);
  const ms = Date.now() - t0;
  const bodyKey = Object.keys(p.images || {}).find(k => k.endsWith('mania/holdbody.png'));
  ok(!!bodyKey, 'TIFF 伪装的 .png 面身没有被体积上限挡掉');
  ok(!!bodyKey && p.images[bodyKey].startsWith('data:image/png;base64,'),
     'TIFF 面身已转成浏览器能解的 PNG dataURL');
  const meta = bodyKey && p.imageMeta && p.imageMeta[bodyKey];
  ok(!!meta && meta.h === 40000 && meta.rows === 4096,
     `面身保留「原图高 ${meta && meta.h} / 实际 ${meta && meta.rows} 行」语义`);
  ok(!!bodyKey && p.images[bodyKey].length < 400 * 1024,
     `面身 PNG 体积已压到 ${bodyKey ? Math.round(p.images[bodyKey].length / 1024) : 0}KB`);
  ok(ms < 3000, `含 22MB TIFF 的皮肤导入不卡顿（${ms}ms）`);
}
const noIni = SF.locateSkinRoot(path.join(ROOT, 'scripts'));
ok(!!noIni.error, '非皮肤目录返回明确错误，不会递归读无关图片');

// ===== 自动游玩按键状态：没有音符时必须松开 =====
// 对应 bug：旧实现把「已越过判定线且还在可见列表里的音符」都标记成按下，而可见列表按
// 最长 LN 回看，于是空段里按键/灯光一直亮着（用户："没有 note 的时候也有按下特效"）。
console.log('\n=== 自动游玩按键状态（没有音符就松开）===');
const AP = require(path.join(ROOT, 'utils/autoPlay.ts'));
const apState = { flash: new Float32Array(0), pressed: new Uint8Array(0), held: new Uint8Array(0) };
/** 查某一时刻每列的按下状态（可见列表用真实回看区间算，和预览里一致） */
function pressAt(notes, keys, t) {
  // tMin 用预览里的真实取值（nowMs - 400），不是「回看最长 LN」——
  // 回看是 fillVisibleNoteIndices 内部自己按 maxHoldMs 再往前找的。
  const vis = V.visibleNoteIndices(notes, t - 400, t + 1000, 1500);
  AP.fillAutoPlayState(notes, vis, vis.length, t, keys, apState);
  return { pressed: Array.from(apState.pressed), held: Array.from(apState.held), flash: Array.from(apState.flash) };
}
const taps = {
  count: 2,
  timeMs: Float64Array.from([1000, 5000]),
  endMs: Float64Array.from([1000, 5000]),
  column: Uint8Array.from([0, 1]),
  isLn: Uint8Array.from([0, 0]),
  maxHoldMs: 0,
};
ok(pressAt(taps, 4, 900).pressed.every(v => v === 0), '音符到来前 100ms 不按下');
ok(pressAt(taps, 4, 960).pressed[0] === 1, '命中前 40ms 已按下（提前量 55ms）');
ok(pressAt(taps, 4, 1040).pressed[0] === 1, '命中后 40ms 仍按住');
ok(pressAt(taps, 4, 1060).pressed[0] === 0, '普通音符命中 45ms 后松开（点按，不是按住不放）');
ok(pressAt(taps, 4, 3000).pressed.every(v => v === 0), '空段（1~5s 之间没有音符）所有列都是抬起态');
ok(pressAt(taps, 4, 1060).flash[0] > 0, '命中光在松开后仍保留（供 LightingN 淡出）');
const lns = {
  count: 1,
  timeMs: Float64Array.from([1000]),
  endMs: Float64Array.from([4000]),
  column: Uint8Array.from([2]),
  isLn: Uint8Array.from([1]),
  maxHoldMs: 3000,
};
ok(pressAt(lns, 4, 2500).pressed[2] === 1 && pressAt(lns, 4, 2500).held[2] === 1, '长条按住期间 pressed + held');
ok(pressAt(lns, 4, 4200).pressed[2] === 0, '长条尾巴过了就松开');
ok(pressAt(lns, 4, 900).held[2] === 0, '长条还没到判定线时不标 held');

// 真实谱面：找最大空隙（前后都没有音符），中间时刻必须全列抬起
let maxGap = 0, gapMid = 0;
for (const f of files) {
  const doc = B.parseOsuDocument(f.text, f.name, f.name);
  if (!doc || doc.mode !== 3 || doc.notes.count < 2) continue;
  const n = doc.notes;
  let bestGap = 0, bestMid = 0;
  for (let i = 0; i + 1 < n.count; i++) {
    const g = n.timeMs[i + 1] - Math.max(n.endMs[i], n.timeMs[i]);
    if (g > bestGap) { bestGap = g; bestMid = (Math.max(n.endMs[i], n.timeMs[i]) + n.timeMs[i + 1]) / 2; }
  }
  if (bestGap > maxGap) { maxGap = bestGap; gapMid = bestMid; }
  if (bestGap >= 1500) {
    const p = pressAt(n, doc.keyCount, bestMid);
    ok(p.pressed.every(v => v === 0),
       `${f.name}: 最长空隙 ${(bestGap / 1000).toFixed(2)}s 的中点（${(bestMid / 1000).toFixed(1)}s）全列抬起`);
  }
  // 结尾：最后一个音符过去 2 秒后不许还有按下的列
  const pEnd = pressAt(n, doc.keyCount, n.endMs[n.count - 1] + 2000);
  ok(pEnd.pressed.every(v => v === 0), `${f.name}: 谱面结束后所有列都松开`);
}
if (maxGap >= 1500) console.log(`  (采样到的最大空隙 ${(maxGap / 1000).toFixed(2)}s @ ${(gapMid / 1000).toFixed(1)}s)`);

// ===== 预览显示时钟：暂停必须立刻静止、播放不许倒退 =====
// 对应 bug：暂停后显示时钟还在按学到的速率外推 150ms 才吸附 → 画面"停不下来"再猛回跳，
// 用户看到的就是「暂停时小窗预览抽搐」。
console.log('\n=== 预览显示时钟（暂停静止 / 播放不倒退）===');
const PC = require(path.join(ROOT, 'utils/previewClock.ts'));
const q11 = (sec) => Math.floor(sec / 0.011) * 0.011; // 模拟 AudioContext 的 11ms 量化台阶

// 120fps：每帧 8.33ms，播放头按 11ms 台阶往前走 1 秒
const clk = PC.newClock();
let wallMs = 1000;
let prevT = -1;
let monotonic = true;
let maxLagMs = 0;
let lastRaw = 0;
for (let i = 0; i < 120; i++) {
  wallMs += 8.3333;
  lastRaw = q11((wallMs - 1000) / 1000);
  const t = PC.stepClock(clk, lastRaw, wallMs);
  if (t < prevT - 1e-9) monotonic = false;
  maxLagMs = Math.max(maxLagMs, Math.abs(t - lastRaw) * 1000);
  prevT = t;
}
ok(monotonic, '播放中显示时间单调不减（不会回跳）');
ok(maxLagMs < 40, `播放中与真实播放头的最大偏差 ${maxLagMs.toFixed(1)}ms（< 40ms）`);

// 暂停：播放头冻结在 lastRaw，继续喂 30 帧（250ms）
let travel = 0;
let lockedAt = -1;
let lastT = prevT;
for (let i = 0; i < 30; i++) {
  wallMs += 8.3333;
  const t = PC.stepClock(clk, lastRaw, wallMs);
  travel += Math.abs(t - lastT);
  lastT = t;
  if (lockedAt < 0 && Math.abs(t - lastRaw) < 1e-9) lockedAt = i;
}
ok(lockedAt >= 0 && lockedAt <= 3, `暂停后第 ${lockedAt + 1} 帧就锁死（旧实现要等 ~18 帧 / 150ms）`);
ok(travel < 0.05, `暂停后总共只挪了 ${(travel * 1000).toFixed(1)}ms 就完全静止（旧实现 ~90ms 回跳）`);
ok(Math.abs(lastT - lastRaw) < 1e-9, '暂停稳定后显示时间 === 真实播放头（画面零重绘）');
// 静止后继续喂帧，返回值必须一模一样（否则渲染循环会一帧帧重画 → 抽搐）
let stillSame = true;
const frozen = lastT;
for (let i = 0; i < 10; i++) {
  wallMs += 8.3333;
  if (PC.stepClock(clk, lastRaw, wallMs) !== frozen) stillSame = false;
}
ok(stillSame, '暂停期间每帧返回同一个值（timeMoved=false → 不重绘）');

// 恢复播放：从冻结位置继续，不许倒退
let resumeMonotonic = true;
let t2 = frozen;
for (let i = 0; i < 60; i++) {
  wallMs += 8.3333;
  const r = q11((wallMs - 1000) / 1000);
  const t = PC.stepClock(clk, r, wallMs);
  if (t < t2 - 1e-9) resumeMonotonic = false;
  t2 = t;
}
ok(resumeMonotonic, '暂停后恢复播放不倒退');

// 主窗口明确告知 playing=false：零外推，第一帧就精确对齐
const clk2 = PC.newClock();
let wall2 = 1000;
let raw2 = 0;
for (let i = 0; i < 60; i++) {
  wall2 += 8.3333;
  raw2 = q11((wall2 - 1000) / 1000);
  PC.stepClock(clk2, raw2, wall2, true);
}
const frozen2 = raw2;
const firstPaused = PC.stepClock(clk2, frozen2, (wall2 += 8.3333), false);
let zeroDrift = true;
for (let i = 0; i < 20; i++) {
  wall2 += 8.3333;
  if (PC.stepClock(clk2, frozen2, wall2, false) !== frozen2) zeroDrift = false;
}
ok(firstPaused === frozen2, '显式暂停：第一帧就对齐真实播放头（不靠猜，0ms 外推）');
ok(zeroDrift, '显式暂停：之后每帧恒等，画面彻底静止');
// 恢复播放后不许倒退
let okResume2 = true;
let t3 = frozen2;
for (let i = 0; i < 60; i++) {
  wall2 += 8.3333;
  const r = q11((wall2 - 1000) / 1000);
  const t = PC.stepClock(clk2, r, wall2, true);
  if (t < t3 - 1e-9) okResume2 = false;
  t3 = t;
}
ok(okResume2, '显式暂停 → 恢复播放不倒退');

// ===== 导出文件名：Windows 非法字符不能进「另存为」 =====
// 对应 bug：标题里的 `:`（A.O.E:area_of_effect）让系统对话框当场报「文件名无效」，
// PNG 长图 / 画面、MP4、WebM 全都导不出来。
console.log('\n=== 导出文件名清洗（Windows 非法字符）===');
const EN = require(path.join(ROOT, 'utils/exportName.ts'));
const ILLEGAL = /[<>:"/\\|?*\u0000-\u001f]/;
ok(!ILLEGAL.test(EN.safeFileName('preview-A.O.E:area_of_effect-full.png')),
  '标题里的冒号被替换：preview-A.O.E:area_of_effect-full.png → ' +
  EN.safeFileName('preview-A.O.E:area_of_effect-full.png'));
ok(EN.safeFileName('preview-A.O.E:area_of_effect-full.png') === 'preview-A.O.E_area_of_effect-full.png',
  '冒号换成下划线、其余字符与扩展名保持不变');
ok(EN.safeFileName('a?b*c"d<e>f|g.mp4') === 'a_b_c_d_e_f_g.mp4', '? * " < > | 全部替换');
ok(EN.safeFileName('C:\\out\\preview-x:y.mp4') === 'C:\\out\\preview-x_y.mp4', '目录部分原样保留，只清洗文件名');
ok(EN.safeFileName('tail.') === 'tail', '结尾的点去掉（Windows 不允许）');
ok(EN.safeFileName('   ') === 'preview', '全空白时回退 preview，绝不返回空文件名');
const longName = 'x'.repeat(300) + '.mp4';
const ln = EN.safeFileName(longName);
ok(ln.length <= 150 && ln.endsWith('.mp4'), `超长标题截断到 ${ln.length} 字符并保住扩展名`);

// 真实样本：所有谱面标题生成的文件名都必须干净
let dirtyNames = 0;
for (const f of files) {
  const doc = B.parseOsuDocument(f.text, f.name, f.name);
  if (!doc) continue;
  for (const ext of ['png', 'mp4', 'webm']) {
    const n = EN.safeFileName(`preview-${doc.title || 'beatmap'}-full.${ext}`);
    if (ILLEGAL.test(n) || /[\s.]$/.test(n)) dirtyNames++;
  }
}
ok(dirtyNames === 0, `样本里 ${files.length} 张谱面的导出名全部合法（0 个非法）`);


const summary = `${files.length - skipped} 张 mania 谱面` + (skipped ? ` / ${skipped} 张非 mania 已跳过` : '');
console.log('\n==== ' + (failures === 0 ? `ALL PASSED (${summary})` : `${failures} FAILURES (${summary})`) + ' ====');
process.exit(failures ? 1 : 0);
