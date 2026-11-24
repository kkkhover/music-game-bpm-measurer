// 抓「自动翻页」期间的 trace，输出最耗时的 slice 序列（定位 130ms 长帧来源）
// 用法：node dev-tools/trace-jump.mjs [seconds]
const SEC = Number(process.argv[2] || 9);
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map(); const chunks = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); }
  else if (m.method === 'Tracing.dataCollected') chunks.push(...m.params.value);
  else if (m.method === 'Tracing.tracingComplete') pend.get('done')?.(1);
};
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const done = new Promise(res => pend.set('done', res));
const ev = async (expression) => (await cmd('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;

await cmd('Page.bringToFront');
// 确保在播放
if (!(await ev(`!!document.querySelector('.lucide-pause')`))) {
  await ev(`document.querySelector('button .lucide-play')?.closest('button')?.click()`);
  await new Promise(r => setTimeout(r, 500));
}

await cmd('Tracing.start', {
  traceConfig: {
    includedCategories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'toplevel', 'gpu', 'skia', 'cc', 'viz', 'benchmark'],
    excludedCategories: ['*'],
    transferMode: 'ReportEvents',
  },
});
await new Promise(r => setTimeout(r, SEC * 1000));
await cmd('Tracing.end');
await Promise.race([done, new Promise(r => setTimeout(r, 15000))]);

// 打印耗时 > 20ms 的 slice，按时间排序
const slices = chunks.filter(e => e.ph === 'X' && e.dur > 20000).sort((a, b) => a.ts - b.ts);
const t0 = slices.length ? slices[0].ts : 0;
console.log('切片数:', slices.length);
for (const e of slices.slice(0, 60)) {
  console.log(`${((e.ts - t0) / 1000).toFixed(1).padStart(9)}ms +${(e.dur / 1000).toFixed(1).padStart(7)}ms  ${e.name}${e.args?.data?.functionName ? ' · ' + e.args.data.functionName : ''}`);
}

// 找出最长的那个 FunctionCall，打印窗口内的所有事件（含短事件），看它内部到底在干什么
const big = chunks.filter(e => e.ph === 'X' && e.dur > 100000 && e.name === 'FunctionCall').sort((a, b) => b.dur - a.dur)[0];
if (big) {
  console.log('\n==== 最长 FunctionCall 窗口内事件 ====');
  const win = chunks.filter(e => e.ph === 'X' && e.ts >= big.ts && e.ts <= big.ts + big.dur && e.dur >= 100)
    .sort((a, b) => a.ts - b.ts || b.dur - a.dur);
  for (const e of win.slice(0, 80)) {
    console.log(`+${((e.ts - big.ts) / 1000).toFixed(1).padStart(7)}ms  ${(e.dur / 1000).toFixed(2).padStart(7)}ms  ${e.name}${e.args?.data?.functionName ? ' · ' + e.args.data.functionName : ''}`);
  }
}
ws.close();
