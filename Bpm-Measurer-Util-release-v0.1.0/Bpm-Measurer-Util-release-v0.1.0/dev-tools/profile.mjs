// 抓一次缩放过程中的 CPU profile，按自身耗时聚合热点函数
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); } };
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await cmd('Profiler.enable');
await cmd('Profiler.setSamplingInterval', { interval: 200 });
await cmd('Profiler.start');
await cmd('Runtime.evaluate', { expression: `(() => { for(let i=0;i<3;i++) setTimeout(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'+',bubbles:true})), i*400); })()` });
await new Promise(r => setTimeout(r, 6000));
const { profile } = await cmd('Profiler.stop');

// 聚合 self time
const byId = new Map(profile.nodes.map(n => [n.id, n]));
const self = new Map();
const total = profile.samples.length;
const deltas = profile.timeDeltas;
for (let i = 0; i < profile.samples.length; i++) {
  const n = byId.get(profile.samples[i]);
  if (!n) continue;
  const key = `${n.callFrame.functionName || '(anon)'} @${(n.callFrame.url || '').split('/').pop()}:${n.callFrame.lineNumber}`;
  self.set(key, (self.get(key) || 0) + (deltas[i] || 0));
}
const arr = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18);
const sum = [...self.values()].reduce((a, b) => a + b, 0);
console.log('总采样时长: ' + (sum / 1000).toFixed(0) + 'ms, 样本数 ' + total);
for (const [k, v] of arr) console.log((v / 1000).toFixed(1).padStart(8) + 'ms  ' + (v / sum * 100).toFixed(1).padStart(5) + '%  ' + k);
ws.close();
