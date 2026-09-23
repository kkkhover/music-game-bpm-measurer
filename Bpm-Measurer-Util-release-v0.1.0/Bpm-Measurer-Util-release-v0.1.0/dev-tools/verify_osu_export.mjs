// 自测脚本：验证 utils/osuExport.ts 与 generate_timing.py 输出一致
// 运行：node --experimental-strip-types verify_osu_export.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { generateOsuTimingPoints } from './utils/osuExport.ts';

// 读取与 generate_timing.py 相同的输入数据
const data = JSON.parse(readFileSync('D:/tmp/timing apolo.json', 'utf-8'));
const offsetSec = data.offset;           // 0.475
const points = data.points;              // [{beatIndex, bpm}, ...]
const baseBpm = 182.0;

const content = generateOsuTimingPoints(offsetSec, points, baseBpm);
writeFileSync('D:/tmp/TimingPoints_node.txt', content, 'utf-8');

const pythonOut = readFileSync('D:/tmp/TimingPoints.txt', 'utf-8');
// Windows 下 Python 文本模式会把 \n 写成 \r\n，这里统一按行拆分并去掉行尾 \r
const pythonLines = pythonOut.split(/\r?\n/).map(l => l.replace(/\r$/, ''));
const nodeLines = content.split('\n');

console.log(`Python 行数: ${pythonLines.length}, Node 行数: ${nodeLines.length}`);
console.log(`Node 输出前缀: ${nodeLines.slice(0, 3).join(' | ')}`);
console.log(`Node 输出后缀: ${nodeLines.slice(-3).join(' | ')}`);

if (pythonLines.length !== nodeLines.length) {
  console.error('❌ 行数不一致！');
  process.exit(1);
}

let diffCount = 0;
for (let i = 0; i < pythonLines.length; i++) {
  if (pythonLines[i] !== nodeLines[i]) {
    diffCount++;
    if (diffCount <= 10) {
      console.log(`第 ${i + 1} 行不同:`);
      console.log(`  Python: ${pythonLines[i]}`);
      console.log(`  Node  : ${nodeLines[i]}`);
    }
  }
}

if (diffCount === 0) {
  console.log('✅ 输出完全一致：utils/osuExport.ts 与 generate_timing.py 结果完全相同！');
} else {
  console.error(`❌ 共 ${diffCount} 行不同！`);
  process.exit(1);
}
