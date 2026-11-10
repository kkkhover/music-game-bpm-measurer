// 用 screencast 统计「实际呈现帧率」：只统计真正被合成/推送到屏幕的帧
// 用法：node dev-tools/probe-present.mjs [seconds]
const PORT = 9222;
const SEC = Number(process.argv[2] || 3);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const send = (m, p = {}) => new Promise((res, rej) => {
  const my = ++id;
  const on = ev => { const d = JSON.parse(ev.data); if (d.id !== my) return; ws.removeEventListener('message', on); d.error ? rej(new Error(JSON.stringify(d.error))) : res(d.result); };
  ws.addEventListener('message', on); ws.send(JSON.stringify({ id: my, method: m, params: p }));
});
let frames = 0;
const stamps = [];
ws.addEventListener('message', ev => {
  const d = JSON.parse(ev.data);
  if (d.method === 'Page.screencastFrame') {
    frames++;
    stamps.push(Date.now());
    ws.send(JSON.stringify({ id: ++id, method: 'Page.screencastFrameAck', params: { sessionId: d.params.sessionId } }));
  }
});
await send('Page.enable'); await send('Page.bringToFront'); await send('Runtime.enable');

const key = async (k, code, vk) => {
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, windowsVirtualKeyCode: vk });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, windowsVirtualKeyCode: vk });
};

async function run(label, playing) {
  frames = 0; stamps.length = 0;
  if (playing) await key(' ', 'Space', 32);
  await send('Page.startScreencast', { format: 'jpeg', quality: 20, maxWidth: 480, maxHeight: 300, everyNthFrame: 1 });
  await new Promise(r => setTimeout(r, SEC * 1000));
  await send('Page.stopScreencast');
  if (playing) await key(' ', 'Space', 32);
  const n = frames;
  const gaps = stamps.slice(1).map((v, i) => v - stamps[i]).sort((a, b) => a - b);
  return {
    label, frames: n, fps: +(n / SEC).toFixed(1),
    gapP50: gaps.length ? +gaps[Math.floor(gaps.length / 2)].toFixed(1) : null,
    gapMax: gaps.length ? gaps[gaps.length - 1] : null,
  };
}
const out = [await run('静止', false), await run('播放中', true)];
console.log(JSON.stringify(out, null, 2));
ws.close();
