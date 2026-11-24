// ============================================================================
// v0.8.17 拍号（meter）功能验证 —— 纯函数层（不起应用）
//   ① generateOsuTimingPoints 把 meter 写进 [TimingPoints] 第 3 字段
//   ② 默认 meter=4（向后兼容，不传 meter 时仍是 4）
//   ③ parseOsu 从谱面读回 meter
//   ④ recalculateTiming 透传 meter
// ============================================================================
import { generateOsuTimingPoints } from '../utils/osuExport.ts';
import { parseTimingFile } from '../utils/timingParser.ts';
import { recalculateTiming } from '../utils/timingUtils.ts';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}${e ? '   ' + e : ''}`); } else { fail++; console.log(`  FAIL  ${n}${e ? '   ' + e : ''}`); } };

// ---- ① meter 写入第 3 字段 ----
console.log('\n=== ① 导出 osu：meter 写第 3 字段 ===');
const points = [
    { beatIndex: 0, bpm: 120, meter: 4, timeSec: 0.0 },
    { beatIndex: 4, bpm: 150, meter: 3, timeSec: 2.0 },
    { beatIndex: 8, bpm: 90, meter: 6, timeSec: 4.0 },
];
const out = generateOsuTimingPoints(0.0, points, 120);
const lines = out.split('\n').filter(l => !l.startsWith('[') && l.trim());
console.log(out);
console.log('---');

// 每段两条（红线 + 绿线）
ok('输出 6 行（3 段 × 红线+绿线）', lines.length === 6, `实际 ${lines.length}`);

// 第 1 段红线 meter=4，绿线 meter=4
ok('红线① meter=4（第3字段）', lines[0].split(',')[2] === '4', lines[0]);
ok('绿线① meter=4', lines[1].split(',')[2] === '4', lines[1]);
// 第 2 段 meter=3
ok('红线② meter=3', lines[2].split(',')[2] === '3', lines[2]);
ok('绿线② meter=3', lines[3].split(',')[2] === '3', lines[3]);
// 第 3 段 meter=6
ok('红线③ meter=6', lines[4].split(',')[2] === '6', lines[4]);
ok('绿线③ meter=6', lines[5].split(',')[2] === '6', lines[5]);

// ---- ② 默认 meter=4（不传 meter）----
console.log('\n=== ② 默认 meter=4（向后兼容）===');
const out2 = generateOsuTimingPoints(0.0, [{ beatIndex: 0, bpm: 100 }], 100);
const l2 = out2.split('\n').filter(l => !l.startsWith('[') && l.trim());
ok('不传 meter 时红线第3字段=4', l2[0].split(',')[2] === '4', l2[0]);

// ---- ③ parseOsu 读回 meter ----
console.log('\n=== ③ 从 .osu 谱面读回 meter ===');
const osuText = `[TimingPoints]
0,500,4,1,0,72,1,0
0,-100,4,1,0,72,0,0
2000,400,3,1,0,72,1,0
2000,-133.33,3,1,0,72,0,0
`;
const parsed = parseTimingFile(osuText, 'test.osu');
ok('解析成功', !!parsed && parsed.points.length >= 1, parsed ? `${parsed.points.length} 点` : 'null');
ok('红线① meter=4', parsed.points[0].meter === 4, `meter=${parsed.points[0].meter}`);
ok('红线② meter=3', parsed.points[1].meter === 3, `meter=${parsed.points[1].meter}`);

// ---- ④ recalculateTiming 透传 meter ----
console.log('\n=== ④ recalculateTiming 透传 meter ===');
const rp = [
    { id: 'a', beatIndex: 0, bpm: 120, meter: 4 },
    { id: 'b', beatIndex: 4, bpm: 150, meter: 3, timeSec: 2.0 },
];
const recalc = recalculateTiming(0.1, rp);
ok('起点锚点 meter=4', recalc[0].meter === 4, `meter=${recalc[0].meter}`);
ok('第二段 meter=3', recalc[1].meter === 3, `meter=${recalc[1].meter}`);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
