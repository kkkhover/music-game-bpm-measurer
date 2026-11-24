// 从曲首开始播放并确认跟随：stop → 点总览条左端 seek 0 → 播放 → 观察 x
const PORT = 9222;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 1;
const send = (m, p = {}) => new Promise((res, rej) => {
  const my = id++;
  const on = ev => { const d = JSON.parse(ev.data); if (d.id !== my) return; ws.removeEventListener('message', on); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); };
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id: my, method: m, params: p }));
});
const ev = async e => (await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true })).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
await send('Page.enable'); await send('Page.bringToFront'); await send('Runtime.enable');

// 1) 停止
await ev(`document.querySelector('.lucide-square')?.closest('button')?.click()`);
await sleep(300);

// 2) 点总览条（第 4 个 canvas）左端 3% → seek 到曲首
const g = await ev(`(() => { const r = document.querySelectorAll('canvas')[3].getBoundingClientRect(); return { x: Math.round(r.left + r.width * 0.03), y: Math.round(r.top + r.height / 2) }; })()`);
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: g.x, y: g.y, button: 'left', buttons: 1, clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: g.x, y: g.y, button: 'left', buttons: 0 });
await sleep(500);
console.log('seek 后时间码:', await ev(`[...document.querySelectorAll('span')].map(s=>s.textContent).find(t=>/^\\d+:\\d\\d\\.\\d \\//.test(t))`));

// 3) 确保跟随 ON 并播放
await ev(`(() => { const b = [...document.querySelectorAll('button')].find(x => (x.title||'').includes('跟随播放')); if (b && !(b.title||'').includes('ON')) b.click(); return 1; })()`);
await ev(`document.querySelector('button .lucide-play')?.closest('button')?.click()`);
await sleep(1500);

const r = await ev(`(async () => {
  const el = [...document.querySelectorAll('div')].find(d => d.style && d.style.willChange === 'transform' && d.style.zIndex === '5');
  const out = [];
  const t0 = performance.now();
  await new Promise(resolve => {
    const tick = () => {
      const m = /translate3d\\((-?[\\d.]+)px/.exec(el.style.transform || '');
      out.push({ x: m ? +m[1] : null, op: el.style.opacity });
      if (performance.now() - t0 < 12000) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  return { w: el.parentElement.getBoundingClientRect().width, out };
})()`);
const xs = r.out.filter(s => s.x !== null);
let backs = 0;
for (let i = 1; i < xs.length; i++) if (xs[i].x - xs[i - 1].x < -12) backs++;
console.log('视口宽', Math.round(r.w), '帧数', xs.length, 'x 范围', Math.round(Math.min(...xs.map(s=>s.x))), '~', Math.round(Math.max(...xs.map(s=>s.x))), '回退帧', backs, '可见率', (xs.filter(s=>s.op==='1').length/xs.length*100).toFixed(0)+'%');
ws.close();
