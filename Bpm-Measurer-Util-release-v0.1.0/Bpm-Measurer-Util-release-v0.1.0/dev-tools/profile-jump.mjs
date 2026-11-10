// 采样 CPU 性能剖析翻页那几帧：找出真正的热点函数
// 用法: node dev-tools/profile-jump.mjs [秒数]
const SEC = Number(process.argv[2] || 9);
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); }
};
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;

await cmd('Page.bringToFront');
if (!(await ev(`!!document.querySelector('.lucide-pause')`))) {
  await ev(`document.querySelector('button .lucide-play')?.closest('button')?.click()`);
  await new Promise(r => setTimeout(r, 400));
}
await cmd('Profiler.enable');
await cmd('Profiler.setSamplingInterval', { interval: 200 });
await cmd('Profiler.start');
await new Promise(r => setTimeout(r, SEC * 1000));
const { profile } = await cmd('Profiler.stop');

// 汇总：按 functionName+url 统计 self time
const byId = new Map();
for (const n of profile.nodes) byId.set(n.id, n);
const self = new Map();
const total = profile.samples.length;
for (const s of profile.samples) {
  const n = byId.get(s);
  if (!n) continue;
  const cf = n.callFrame;
  const key = `${cf.functionName || '(anon)'} @ ${(cf.url || '').split('/').pop()}:${cf.lineNumber}`;
  self.set(key, (self.get(key) || 0) + 1);
}
const dur = (profile.endTime - profile.startTime) / 1000; // ms
const rows = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 22);
console.log(`采样时长 ${dur.toFixed(0)}ms，样本数 ${total}`);
for (const [k, v] of rows) {
  const ms = (v / total) * dur;
  console.log(`${ms.toFixed(1).padStart(9)}ms  ${((v / total) * 100).toFixed(1).padStart(5)}%  ${k}`);
}
ws.close();
