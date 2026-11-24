// 验收：播放中点击频谱/白条 → 立即停在点击位置（不继续播、界面不冻死）
// 用法: node dev-tools/verify-pause-on-click.mjs
const PORT = 9222;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find(t => t.type === 'page');
  if (!page) throw new Error('没有找到页面目标（应用是否带 --remote-debugging-port 启动？）');
  return page;
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    ws.onopen = () => resolve(ws);
    ws.onerror = e => reject(new Error('WS 连接失败: ' + (e?.message || 'unknown')));
  });
}

let seq = 1;
function send(ws, method, params = {}) {
  const id = seq++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('CDP 超时: ' + method)), 30000);
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

const evalJs = async (ws, expression) => {
  const r = await send(ws, 'Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

const state = `(() => {
  const tc = [...document.querySelectorAll('span')].find(s => /^\\d+:\\d+\\.\\d+ \\//.test(s.textContent || ''))?.textContent.trim();
  const head = [...document.querySelectorAll('div')].find(d => d.style && d.style.willChange === 'transform');
  const m = /translate3d\\((-?[\\d.]+)px/.exec(head?.style.transform || '');
  return { tc, x: m ? Math.round(+m[1]) : null, playing: !!document.querySelector('.lucide-pause') };
})()`;

const target = await getTarget();
const ws = await connect(target.webSocketDebuggerUrl);
await send(ws, 'Runtime.enable');
await send(ws, 'Input.enable').catch(() => {});

// 1) 确保处于播放状态
const before = await evalJs(ws, state);
if (!before.playing) {
  await evalJs(ws, `(() => { document.querySelector('button .lucide-play')?.closest('button')?.click(); return true; })()`);
  await sleep(1200);
}
const playing = await evalJs(ws, state);
console.log('点击前:', JSON.stringify(playing));

// 2) 取频谱区域几何，在 60% 处真实点击
const geo = await evalJs(ws, `(() => {
  const c = [...document.querySelectorAll('canvas')].find(c => c.width > 800)?.parentElement?.getBoundingClientRect();
  return c ? { left: c.left, top: c.top, width: c.width, height: c.height } : null;
})()`);
if (!geo) throw new Error('找不到频谱区域');
const x = Math.round(geo.left + geo.width * 0.6);
const y = Math.round(geo.top + geo.height * 0.5);
for (const type of ['mousePressed', 'mouseReleased']) {
  await send(ws, 'Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}
await sleep(200);
const after = await evalJs(ws, state);
console.log('点击后 200ms:', JSON.stringify(after));

// 3) 再等 1.2s，时间码与播放头必须一动不动
await sleep(1200);
const later = await evalJs(ws, state);
console.log('再等 1.2s:', JSON.stringify(later));

const paused = after.playing === false && later.playing === false;
const frozen = after.tc === later.tc && after.x === later.x;
const moved = before.tc !== after.tc;
console.log('→ 已暂停:', paused);
console.log('→ 停在点击位置（时间码/播放头 1.2s 未变）:', frozen);
console.log('→ 位置确实变了（不是原地暂停）:', moved);
console.log(paused && frozen && moved ? 'PASS' : 'FAIL');
ws.close();
