// 播放/静止状态下的帧率与画布重绘次数探针
// 用法：node dev-tools/probe-fps.mjs [seconds]
const PORT = 9222;
const SEC = Number(process.argv[2] || 3);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('未找到页面目标');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const send = (m, p = {}) => new Promise((res, rej) => {
  const my = ++id;
  const on = ev => { const d = JSON.parse(ev.data); if (d.id !== my) return; ws.removeEventListener('message', on); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); };
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id: my, method: m, params: p }));
});
const ev = async e => {
  const r = await send('Runtime.evaluate', { expression: e, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval error');
  return r.result.value;
};
await send('Page.enable'); await send('Page.bringToFront'); await send('Runtime.enable');

// 安装计数器（幂等）
await ev(`(() => {
  if (window.__probeOn) return 'already';
  window.__probeOn = true;
  const proto = CanvasRenderingContext2D.prototype;
  const names = ['clearRect','drawImage','putImageData','fillRect','stroke','fill','fillText'];
  const orig = {};
  const nameOf = (ctx) => {
    const cs = [...document.querySelectorAll('canvas')];
    const i = cs.indexOf(ctx.canvas);
    return ['wave','spec','overlay','playhead','ov-wave','ov-top'][i] || ('c'+i);
  };
  window.__cnt = {};
  window.__resetCnt = () => { window.__cnt = {}; };
  for (const n of names) {
    orig[n] = proto[n];
    proto[n] = function (...a) {
      const k = nameOf(this) + '.' + n;
      window.__cnt[k] = (window.__cnt[k] || 0) + 1;
      return orig[n].apply(this, a);
    };
  }
  window.__probeRestore = () => { for (const n of names) proto[n] = orig[n]; window.__probeOn = false; };
  return 'installed';
})()`);

const canvasInfo = await ev(`JSON.stringify([...document.querySelectorAll('canvas')].map(c=>{const r=c.getBoundingClientRect();return {w:c.width,h:c.height,cw:Math.round(r.width),ch:Math.round(r.height),mb:+(c.width*c.height*4/1048576).toFixed(1)};}))`);

async function measure(label, action) {
  await ev(`(() => { window.__f=[]; let last=performance.now(), stop=false; const loop=()=>{const n=performance.now(); window.__f.push(n-last); last=n; if(!stop) requestAnimationFrame(loop);}; requestAnimationFrame(loop); window.__fstop=()=>{stop=true;}; return 1; })()`);
  await ev('window.__resetCnt();');
  if (action === 'play') { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); }
  await new Promise(r => setTimeout(r, SEC * 1000));
  const res = await ev(`(() => { window.__fstop(); const s=window.__f.slice(2).sort((a,b)=>a-b); const avg=s.reduce((a,b)=>a+b,0)/s.length; return {n:s.length, fps:+(1000/avg).toFixed(1), p50:+s[Math.floor(s.length/2)].toFixed(1), p95:+s[Math.floor(s.length*0.95)].toFixed(1), max:+s[s.length-1].toFixed(1), cnt: window.__cnt}; })()`);
  if (action === 'play') { await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }); }
  return { label, ...res };
}

const idle = await measure('静止', null);
const play = await measure('播放中', 'play');
await ev('window.__probeRestore && window.__probeRestore();');
console.log(JSON.stringify({ sec: SEC, canvases: JSON.parse(canvasInfo), idle, play }, null, 2));
ws.close();
