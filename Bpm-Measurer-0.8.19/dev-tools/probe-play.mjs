// 播放期间 rAF 帧间隔统计（含自动翻页瞬间的长帧），用于确认「自动跟随」没有引入掉帧
// 用法：node dev-tools/probe-play.mjs [seconds]
const PORT = 9222;
const SEC = Number(process.argv[2] || 18);

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

// 确保在播放
const playing = await ev(`!!document.querySelector('.lucide-pause')`);
if (!playing) {
  await ev(`document.querySelector('button .lucide-play')?.closest('button')?.click()`);
  await new Promise(r => setTimeout(r, 300));
}

const res = await ev(`(async () => {
  const el = [...document.querySelectorAll('div')].find(d => d.style && d.style.willChange === 'transform' && d.style.zIndex === '5');
  const frames = [];
  const t0 = performance.now();
  let last = t0;
  let lastX = null;
  await new Promise(resolve => {
    const tick = () => {
      const now = performance.now();
      const m = /translate3d\\((-?[\\d.]+)px/.exec(el.style.transform || '');
      const x = m ? +m[1] : null;
      frames.push({ dt: now - last, x, jump: lastX !== null && x !== null && x - lastX < -200 });
      last = now; lastX = x;
      if (now - t0 < ${SEC * 1000}) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  const dts = frames.slice(1).map(f => f.dt).sort((a, b) => a - b);
  const q = p => dts[Math.min(dts.length - 1, Math.floor(dts.length * p))];
  const jumpFrames = frames.filter(f => f.jump).map(f => +f.dt.toFixed(1));
  return {
    frames: frames.length,
    fps: +(1000 / (dts.reduce((a, b) => a + b, 0) / dts.length)).toFixed(1),
    p50: +q(0.5).toFixed(1), p90: +q(0.9).toFixed(1), p99: +q(0.99).toFixed(1),
    max: +dts[dts.length - 1].toFixed(1),
    slow20: dts.filter(d => d > 20).length,
    slow50: dts.filter(d => d > 50).length,
    jumpCount: jumpFrames.length,
    jumpFrameDt: jumpFrames,
  };
})()`);
console.log(JSON.stringify(res, null, 2));
ws.close();
