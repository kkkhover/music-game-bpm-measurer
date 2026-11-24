// 抓 trace，把一次缩放期间的耗时按事件类型归类（JS / Paint / Raster / Composite / GPU）
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.onopen = r);
let id = 0; const pend = new Map(); const chunks = [];
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); }
  else if (m.method === 'Tracing.dataCollected') chunks.push(...m.params.value);
  else if (m.method === 'Tracing.tracingComplete') pend.get('done')?.(1);
};
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const done = new Promise(res => pend.set('done', res));

await cmd('Tracing.start', {
  categories: ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'blink.user_timing', 'toplevel', 'gpu'],
  transferMode: 'ReportEvents',
});
await cmd('Runtime.evaluate', {
  expression: `(() => { let i=0; const t=setInterval(()=>{ document.dispatchEvent(new KeyboardEvent('keydown',{key:'+',bubbles:true})); if(++i>=3) clearInterval(t); }, 700); })()`,
});
await new Promise(r => setTimeout(r, 4000));
await cmd('Tracing.end');
await Promise.race([done, new Promise(r => setTimeout(r, 8000))]);

// 聚合：按 name 统计 duration
const agg = new Map();
for (const e of chunks) {
  if (e.ph !== 'X' || !e.dur) continue;
  const k = e.name;
  const cur = agg.get(k) || { n: 0, dur: 0, max: 0 };
  cur.n++; cur.dur += e.dur; cur.max = Math.max(cur.max, e.dur);
  agg.set(k, cur);
}
const arr = [...agg.entries()].sort((a, b) => b[1].dur - a[1].dur).slice(0, 22);
console.log('事件数: ' + chunks.length);
for (const [k, v] of arr) console.log(`${(v.dur / 1000).toFixed(1).padStart(9)}ms  n=${String(v.n).padStart(4)}  max=${(v.max / 1000).toFixed(1).padStart(7)}ms  ${k}`);
ws.close();
