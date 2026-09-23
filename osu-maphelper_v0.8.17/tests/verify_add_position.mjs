// v0.8.17 两个 bug 的验证：
//   bug 2：planAddRedLine 应该总是加在"最后一条红线的下一拍"，不管 anchorMs 在哪
import { planAddRedLine } from '../src/timingEdit.mjs';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log(`  PASS  ${n}${e ? '   ' + e : ''}`); } else { fail++; console.log(`  FAIL  ${n}${e ? '   ' + e : ''}`); } };

console.log('=== bug 2：添加红线总是落在最后一条红线的下一拍 ===');

// 三条红线：0ms@120bpm, 2000ms@150bpm, 4000ms@90bpm
const reds = [
    { time: 0, bpm: 120, meter: 4 },
    { time: 2000, bpm: 150, meter: 3 },
    { time: 4000, bpm: 90, meter: 6 }
];

// anchorMs = 3000（在 2000 和 4000 中间）—— 旧实现会加在 2000 的下一拍（2000+400=2400）
const plan = planAddRedLine(reds, 3000);
// 最后一条是 4000ms@90bpm，一拍 = 60000/90 = 666.67ms，下一拍 = 4000 + 667 = 4667
const expected = Math.round(4000 + 60000 / 90);
console.log(`  anchorMs=3000 时，新红线 time=${plan.time}（期望 ${expected}）`);
ok('播放头在中间时，红线加在最后一条的下一拍', plan.time === expected, `${plan.time} vs ${expected}`);
ok('继承最后一条的 BPM（90）', plan.bpm === 90, `bpm=${plan.bpm}`);
ok('继承最后一条的拍号（6）', plan.meter === 6, `meter=${plan.meter}`);

// anchorMs = 0（播放头在最开始）—— 也应该加在最后一条下一拍
const plan2 = planAddRedLine(reds, 0);
ok('播放头在开头时，红线仍加在最后一条的下一拍', plan2.time === expected, `${plan2.time} vs ${expected}`);

// 空列表 → 用 anchorMs 作为首条时间
const plan3 = planAddRedLine([], 5000);
ok('空列表时用 anchorMs 作为首条时间', plan3.time === 5000, `time=${plan3.time}`);
ok('空列表默认 meter=4、bpm=120', plan3.meter === 4 && plan3.bpm === 120);

console.log(`\n${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
