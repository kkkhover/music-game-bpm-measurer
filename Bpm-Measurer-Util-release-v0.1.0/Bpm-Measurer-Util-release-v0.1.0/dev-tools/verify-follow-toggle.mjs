// 验证「手动拖动视口 → 自动关闭跟随」「重新开启 → 立刻对齐到播放头」
const PORT = 9222;

async function getTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const list = await res.json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有找到页面目标');
  return page;
}
function connect(wsUrl) {
  return new Promise((resolve, reject) => { const ws = new WebSocket(wsUrl); ws.onopen = () => resolve(ws); ws.onerror = reject; });
}
let seq = 1;
function send(ws, method, params = {}) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时: ' + method)), 60000);
    const onMsg = ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      clearTimeout(timer); ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
const evalJs = async (ws, expression) => {
  const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, allowUnsafeEvalBlockedByCSP: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails.exception?.description || r.exceptionDetails));
  return r.result.value;
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const target = await getTarget();
const ws = await connect(target.webSocketDebuggerUrl);
await send(ws, 'Page.enable');
await send(ws, 'Page.bringToFront');
await send(ws, 'Runtime.enable');
await sleep(300);

const readFollow = () => evalJs(ws, `(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('跟随播放'));
  return b ? ((b.title || '').includes('ON') ? 'ON' : 'OFF') : 'MISSING';
})()`);

const headX = () => evalJs(ws, `(() => {
  const el = [...document.querySelectorAll('div')].find(d => d.style && d.style.willChange === 'transform' && d.style.zIndex === '5');
  if (!el) return null;
  const m = /translate3d\\((-?[\\d.]+)px/.exec(el.style.transform || '');
  return m ? Math.round(+m[1]) : null;
})()`);

const clickFollow = () => evalJs(ws, `(() => {
  const b = [...document.querySelectorAll('button')].find(x => (x.title || '').includes('跟随播放'));
  if (!b) return false; b.click(); return true;
})()`);

const play = () => evalJs(ws, `(() => {
  const b = document.querySelector('button .lucide-play')?.closest('button');
  if (!b) return false; b.click(); return true;
})()`);

console.log('初始跟随状态:', await readFollow());
if ((await readFollow()) === 'OFF') await clickFollow();

// 开始播放
await play();
await sleep(1200);
console.log('播放中 x =', await headX(), '状态:', await readFollow());

// 真实拖拽频谱区 260px（平移视口）
const geo = await evalJs(ws, `(() => {
  const cs = [...document.querySelectorAll('canvas')].map(c => c.getBoundingClientRect());
  const spec = cs[1] || cs[0];
  return { x: Math.round(spec.x + spec.width * 0.7), y: Math.round(spec.y + spec.height * 0.5) };
})()`);
await send(ws, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', buttons: 1, clickCount: 1 });
await sleep(50);
for (let i = 1; i <= 12; i++) {
  await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x - i * 22, y: geo.y, button: 'left', buttons: 1 });
  await sleep(16);
}
await send(ws, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x - 264, y: geo.y, button: 'left', buttons: 0 });
await sleep(400);
console.log('拖拽后跟随状态:', await readFollow());

// 播放 6 秒：跟随已关，不应翻页（x 单调增长直到出视口）
const offSample = await evalJs(ws, `(async () => {
  const el = [...document.querySelectorAll('div')].find(d => d.style && d.style.willChange === 'transform' && d.style.zIndex === '5');
  const out = [];
  const t0 = performance.now();
  await new Promise(resolve => {
    const tick = () => {
      const m = /translate3d\\((-?[\\d.]+)px/.exec(el.style.transform || '');
      out.push(m ? +m[1] : null);
      if (performance.now() - t0 < 6000) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  return out;
})()`);
const offJumps = offSample.filter((x, i) => i > 0 && x - offSample[i - 1] < -50).length;
console.log('关闭跟随后 6s：采样', offSample.length, '翻页次数', offJumps, '末值', offSample[offSample.length - 1]);

// 重新开启跟随：应立刻把播放头拉回左侧
await clickFollow();
await sleep(600);
const xAfter = await headX();
console.log('重新开启后跟随状态:', await readFollow(), 'x =', xAfter);

ws.close();
