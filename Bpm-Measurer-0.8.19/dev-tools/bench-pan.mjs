// 拖动（平移）性能实测：真实鼠标事件驱动，统计帧间隔 / 长动画帧 / canvas 调用耗时
// 用法: node dev-tools/bench-pan.mjs [dragPx] [steps] [--spec]
const PORT = 9222;
const dragPx = Number(process.argv[2] || 420);
const steps = Number(process.argv[3] || 48);

async function getTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有找到页面目标');
  return page;
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = e => reject(new Error('WS 连接失败: ' + (e?.message || 'unknown')));
  });
}
let idSeq = 0;
function send(ws, method, params = {}) {
  const id = ++idSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时: ' + method)), 180000);
    const onMsg = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalJs(ws, expression) {
  const res = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
  if (res.exceptionDetails) throw new Error('页面异常: ' + JSON.stringify(res.exceptionDetails.exception?.description || res.exceptionDetails));
  return res.result.value;
}

const target = await getTarget();
const ws = await connect(target.webSocketDebuggerUrl);
await send(ws, 'Page.enable');
await send(ws, 'Page.bringToFront');
await send(ws, 'Runtime.enable');
await new Promise(r => setTimeout(r, 300));

// ---- 1. 安装探针：rAF 间隔 + 长动画帧 + canvas 调用计时 ----
await evalJs(ws, `
(() => {
  if (window.__probe) window.__probe.stop();
  const st = { gaps: [], laf: [], ops: {} };
  let last = performance.now(), stop = false;
  const loop = () => { const n = performance.now(); st.gaps.push(n - last); last = n; if (!stop) requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  try {
    const po = new PerformanceObserver(list => { for (const e of list.getEntries()) st.laf.push({ d: +e.duration.toFixed(1), block: +(e.blockingDuration||0).toFixed(1), style: +(e.styleAndLayoutStart? 0:0) }); });
    po.observe({ type: 'long-animation-frame', buffered: false });
    st.po = po;
  } catch (e) { st.po = null; }
  // canvas 调用计时（只统计 2D ctx 的重操作）
  const proto = CanvasRenderingContext2D.prototype;
  const names = ['drawImage', 'putImageData', 'clearRect', 'fillRect', 'stroke'];
  st.orig = {};
  for (const nm of names) {
    const orig = proto[nm];
    st.orig[nm] = orig;
    proto[nm] = function (...a) {
      const t0 = performance.now();
      const r = orig.apply(this, a);
      const dt = performance.now() - t0;
      const o = st.ops[nm] || (st.ops[nm] = { n: 0, ms: 0, max: 0 });
      o.n++; o.ms += dt; if (dt > o.max) o.max = dt;
      return r;
    };
  }
  window.__probe = { st, stop() { stop = true; for (const nm of names) proto[nm] = st.orig[nm]; st.po && st.po.disconnect(); } };
  return true;
})()`);

// ---- 2. 计算拖动起点（频谱区中部、窗口内）----
const geo = await evalJs(ws, `(() => {
  const cs = [...document.querySelectorAll('canvas')].map(c => c.getBoundingClientRect());
  const spec = cs[1] || cs[0];
  return { x: Math.round(spec.x + spec.width * 0.75), y: Math.round(spec.y + spec.height * 0.5), w: Math.round(spec.width) };
})()`);

const y = geo.y;
let x = geo.x;
await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
await new Promise(r => setTimeout(r, 60));

const t0 = Date.now();
const total = dragPx;
for (let i = 1; i <= steps; i++) {
  const nx = geo.x - Math.round(total * i / steps);
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: nx, y, button: 'left', buttons: 1 });
  await new Promise(r => setTimeout(r, 16));
}
const dragMs = Date.now() - t0;
await new Promise(r => setTimeout(r, 500));
await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x - total, y, button: 'left', buttons: 0, clickCount: 1 });
await new Promise(r => setTimeout(r, 800));

const out = await evalJs(ws, `(() => {
  const p = window.__probe; if (!p) return null;
  const st = p.st; p.stop();
  const gaps = st.gaps.slice(2);
  const s = [...gaps].sort((a,b)=>a-b);
  const q = f => s.length ? +s[Math.min(s.length-1, Math.floor(s.length*f))].toFixed(1) : 0;
  const sum = gaps.reduce((a,b)=>a+b,0);
  return {
    frames: gaps.length,
    avgFps: +(1000/(sum/gaps.length)).toFixed(1),
    p50: q(.5), p90: q(.9), p99: q(.99), max: +(s[s.length-1]||0).toFixed(1),
    slow60: gaps.filter(g=>g>20).length,
    slow100: gaps.filter(g=>g>100).length,
    lafCount: st.laf.length,
    laf: st.laf.slice(0, 12),
    ops: Object.fromEntries(Object.entries(st.ops).map(([k,v])=>[k,{n:v.n,ms:+v.ms.toFixed(1),max:+v.max.toFixed(2)}])),
    opsTotalMs: +Object.values(st.ops).reduce((a,v)=>a+v.ms,0).toFixed(1),
  };
})()`);

console.log(JSON.stringify({ dragPx, steps, dragMs, from: { x: geo.x, y }, result: out }, null, 2));
ws.close();
