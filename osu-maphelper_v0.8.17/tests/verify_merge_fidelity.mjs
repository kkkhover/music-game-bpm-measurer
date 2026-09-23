// ============================================================================
// v0.8.17 merge 导出保真验证 —— 用真实变拍谱面
//   验证：merge 导出后，绿线的 effects(kiai/omit-barline)/sampleSet/volume 保留，
//   meter 正确写进红线和绿线，替换后与原谱面行为一致。
// ============================================================================
import { readOsu } from '../src/osuFile.mjs';
import { applyTimingToText } from '../src/timingEdit.mjs';
import { extractRedLines } from '../src/osuFile.mjs';

const MAP = 'C:/Users/27771/Downloads/2616518 Camellia vs Kaminose Tsukasa - Resonant Musical Automaton of Twin Agates/Camellia vs. Kaminose Tsukasa - Resonant Musical Automaton of Twin Agates (elexire) [Metamorphose].osu';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}${e ? '   ' + e : ''}`); } else { fail++; console.log(`  FAIL  ${n}${e ? '   ' + e : ''}`); } };

const rp = readOsu(MAP);
console.log(`谱面 timing 总点数: ${rp.timingPoints.length}`);

// 原始绿线的 effects 分布
const origGreens = rp.timingPoints.filter(p => !p.uninherited);
const origEffects = new Set(origGreens.map(g => g.effects));
console.log(`原始绿线 effects 值集合: ${[...origEffects].join(',')}（应含 8 = omit-first-barline / 1 = kiai）`);
ok('原谱面含 effects=8 的绿线（omit-first-barline）', origEffects.has(8));

// 原始绿线的 sampleSet / volume
const origSS = new Set(origGreens.map(g => g.sampleSet));
const origVol = new Set(origGreens.map(g => g.volume));
console.log(`原始绿线 sampleSet 集合: ${[...origSS].join(',')}，volume 集合: ${[...origVol].join(',')}`);

// 用所有红线（含 meter）做 merge 导出（模拟"改 BPM 后重新导出"）
const reds = extractRedLines(rp);
const edits = reds.map(r => ({ time: r.time, bpm: r.bpm, meter: r.meter }));
const res = applyTimingToText(rp, { mode: 'merge', points: edits });
ok('merge 导出成功', res.ok === true, res.error || '');

// 用更直接的方式：重新解析导出文本，检查绿线 effects 是否保留
import { parseOsu } from '../src/osuFile.mjs';
if (res.ok) {
    const reparsed = parseOsu(res.text);
    const newGreens = reparsed.timingPoints.filter(p => !p.uninherited);
    const newReds = reparsed.timingPoints.filter(p => p.uninherited);

    // 1. 绿线 effects 保留
    const newEffects = new Set(newGreens.map(g => g.effects));
    ok('导出后绿线 effects 保留（含 8）', newEffects.has(8), `effects 集合=${[...newEffects].join(',')}`);

    // 2. 绿线 sampleSet 保留
    const newSS = new Set(newGreens.map(g => g.sampleSet));
    ok('导出后绿线 sampleSet 保留（含 2）', newSS.has(2), `sampleSet=${[...newSS].join(',')}`);

    // 3. 红线 meter 正确（应含 7、6、4）
    const redMeters = new Set(newReds.map(r => r.meter));
    ok('导出后红线 meter 含 7（7/4 拍）', redMeters.has(7), `meter=${[...redMeters].join(',')}`);
    ok('导出后红线 meter 含 6（6/4 拍）', redMeters.has(6));

    // 4. 红线/绿线数量
    ok('红线数一致', newReds.length === reds.length, `${reds.length} → ${newReds.length}`);
    console.log(`  导出：红线 ${newReds.length} / 绿线 ${newGreens.length} / 总 ${reparsed.timingPoints.length}`);

    // 5. 抽一条 effects=8 的绿线，看它导出后还带不带 8
    const sampleGreen = origGreens.find(g => g.effects === 8);
    if (sampleGreen) {
        const match = newGreens.find(g => Math.round(g.time) === Math.round(sampleGreen.time) && g.effects === 8);
        ok(`原 effects=8 的绿线 @${sampleGreen.time}ms 导出后仍保留 effects=8`, !!match);
    }
}

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
