// 载入真实 .osu 的 timing 后测呈现帧率 + 覆盖层重绘次数
// 用法：node dev-tools/bench-timing.mjs "<osu 路径>" [seconds]
const PORT = 9222;
const OSU = process.argv[2];
const SEC = Number(process.argv[3] || 3);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
let frames = 0; const stamps = [];
const send = (m, p = {}) => new Promise((res, rej) => {
  const my = ++id;
  const on = ev => { const d = JSON.parse(ev.data); if (d.id !== my) return; ws.removeEventListener('message', on); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); };
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id: my, method: m, params: p }));
});
ws.addEventListener('message', ev => {
  const d = JSON.parse(ev.data);
  if (d.method === 'Page.screencastFrame') {
    frames++; stamps.push(Date.now());
    ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: d.params.sessionId } }));
  }
});
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};
await send('Page.enable'); await send('Page.bringToFront'); await send('Runtime.enable');

// 1) 通过隐藏 input 注入 .osu（React onChange 走 change 事件）
const injected = await ev(`(async () => {
  const path = ${JSON.stringify(OSU)};
  const data = await window.electronAPI.readAudioFile(path);
  if (!data) return 'read-failed';
  const name = path.split(/[\\\\/]/).pop();
  const file = new File([data], name, { type: 'text/plain' });
  const input = document.querySelector('input[accept*=".osu"]');
  if (!input) return 'input-not-found';
  const dt = new DataTransfer();
  dt.items.add(file);
  input.files = dt.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  return 'ok:' + name;
})()`);
await new Promise(r => setTimeout(r, 2500));
const cardCount = await ev(`document.querySelectorAll('input[type="number"], input[inputmode="decimal"]').length`);

// 2) 计覆盖层重绘次数
await ev(`(() => {
  if (window.__probeOn) window.__probeRestore();
  const proto = CanvasRenderingContext2D.prototype;
  const names = ['clearRect','stroke','fill','fillText'];
  const orig = {};
  window.__cnt = {}; window.__resetCnt = () => { window.__cnt = {}; };
  const nameOf = (ctx) => { const cs=[...document.querySelectorAll('canvas')]; const i=cs.indexOf(ctx.canvas); return ['wave','spec','overlay','ov-wave','ov-top','playhead'][i]||('c'+i); };
  for (const n of names) { orig[n] = proto[n]; proto[n] = function(...a){ const k=nameOf(this)+'.'+n; window.__cnt[k]=(window.__cnt[k]||0)+1; return orig[n].apply(this,a); }; }
  window.__probeRestore = () => { for (const n of names) proto[n]=orig[n]; window.__probeOn=false; };
  window.__probeOn = true;
  return 1;
})()`);

const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};

frames = 0; stamps.length = 0;
await ev('window.__resetCnt();');
await key(' ', 'Space', 32);
await send('Page.startScreencast', { format: 'jpeg', quality: 20, maxWidth: 480, maxHeight: 300, everyNthFrame: 1 });
await new Promise(r => setTimeout(r, SEC * 1000));
await send('Page.stopScreencast');
await key(' ', 'Space', 32);
const cnt = await ev('(() => { const c = window.__cnt; window.__probeRestore && window.__probeRestore(); return c; })()');

const gaps = stamps.slice(1).map((v, i) => v - stamps[i]).sort((a, b) => a - b);
console.log(JSON.stringify({
  injected, timingInputs: cardCount, sec: SEC,
  presentedFps: +(frames / SEC).toFixed(1),
  frameP50: gaps.length ? +gaps[Math.floor(gaps.length / 2)].toFixed(1) : null,
  frameMax: gaps.length ? gaps[gaps.length - 1] : null,
  drawCalls: cnt,
}, null, 2));
ws.close();
