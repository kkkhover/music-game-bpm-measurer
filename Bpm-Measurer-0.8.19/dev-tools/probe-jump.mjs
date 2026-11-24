// 定位「翻页瞬间」慢帧来自哪一层 canvas：逐帧统计各 canvas 的 2D 调用总耗时
// 用法：node dev-tools/probe-jump.mjs [seconds]
const PORT = 9222;
const SEC = Number(process.argv[2] || 25);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 1;
const send = (m, p = {}) => new Promise((res, rej) => {
  const my = id++;
  const on = ev => { const d = JSON.parse(ev.data); if (d.id !== my) return; ws.removeEventListener('message', on); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); };
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id: my, method: m, params: p }));
});
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};
await send('Page.enable'); await send('Page.bringToFront'); await send('Runtime.enable');
await new Promise(r => setTimeout(r, 300));

if (!(await ev(`!!document.querySelector('.lucide-pause')`))) {
  await ev(`document.querySelector('button .lucide-play')?.closest('button')?.click()`);
  await new Promise(r => setTimeout(r, 300));
}

// 安装分层探针：每帧记录各 canvas 的绘制总耗时
await ev(`(() => {
  if (window.__layerProbe) window.__layerProbe.restore();
  const proto = CanvasRenderingContext2D.prototype;
  const names = ['clearRect','fillRect','drawImage','putImageData','fill','stroke','createPattern','getImageData'];
  const orig = {};
  const label = (cv) => {
    const all = [...document.querySelectorAll('canvas')];
    const i = all.indexOf(cv);
    return ['wave','spec','overlay','ov-bg','ov-top'][i] || ('c'+i);
  };
  const cur = {};
  let frameStart = performance.now();
  const frames = [];
  const rafHook = () => {
    // 上一帧结束 → 结算
    const total = performance.now() - frameStart;
    if (Object.keys(cur).length) frames.push({ total: +total.toFixed(1), layers: JSON.parse(JSON.stringify(cur)) });
    for (const k in cur) delete cur[k];
    frameStart = performance.now();
    requestAnimationFrame(rafHook);
  };
  for (const nm of names) {
    orig[nm] = proto[nm];
    proto[nm] = function (...a) {
      const t0 = performance.now();
      const r = orig[nm].apply(this, a);
      const dt = performance.now() - t0;
      const k = label(this.canvas);
      const o = cur[k] || (cur[k] = { ms: 0, n: 0 });
      o.ms += dt; o.n++;
      return r;
    };
  }
  requestAnimationFrame(rafHook);
  window.__layerProbe = {
    frames,
    restore() { for (const nm of names) proto[nm] = orig[nm]; },
  };
  return true;
})()`);

await new Promise(r => setTimeout(r, SEC * 1000));

const out = await ev(`(() => {
  const p = window.__layerProbe;
  const frames = p.frames.slice();
  p.restore();
  frames.sort((a,b) => b.total - a.total);
  return frames.slice(0, 8).map(f => ({ total: f.total, layers: Object.fromEntries(Object.entries(f.layers).map(([k,v]) => [k, +v.ms.toFixed(1)])) }));
})()`);
console.log(JSON.stringify(out, null, 2));
ws.close();
