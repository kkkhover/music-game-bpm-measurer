// 验证：①点击跳转后按播放应从点击位置继续 ②Alt+→ 切段时保持播放不中断
const PORT = 9222;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result ?? m.error); pend.delete(m.id); }
};
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async e => (await cmd('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.value;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const snap = async () => await ev(`(() => {
  const el = [...document.querySelectorAll('div')].find(d => d.style && d.style.willChange === 'transform' && d.style.zIndex === '5');
  const m = el ? /translate3d\\((-?[\\d.]+)px/.exec(el.style.transform || '') : null;
  const tc = [...document.querySelectorAll('span')].find(s => /^\\d+:\\d+\\.\\d+ \\//.test(s.textContent || ''));
  return { tc: tc ? tc.textContent.slice(0, 7) : null, x: m ? Math.round(+m[1]) : null, playing: !!document.querySelector('.lucide-pause') };
})()`);

const before = await snap();
await ev(`document.querySelector('button .lucide-play')?.closest('button')?.click()`);
await sleep(700);
const afterPlay = await snap();

// Alt+→ 切到下一段（应继续播放）
await cmd('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight', modifiers: 1 });
await cmd('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight', modifiers: 1 });
await sleep(700);
const afterStep = await snap();
await sleep(600);
const afterStep2 = await snap();

console.log('点击后静止:', JSON.stringify(before));
console.log('按播放 0.7s:', JSON.stringify(afterPlay));
console.log('Alt+→ 后 0.7s:', JSON.stringify(afterStep));
console.log('再 0.6s:', JSON.stringify(afterStep2));
console.log('→ 从点击位置续播:', afterPlay.playing && afterPlay.x !== null && afterPlay.x >= before.x - 2);
console.log('→ 切段后仍在播放:', afterStep.playing && afterStep2.playing && afterStep2.x > afterStep.x);
ws.close();
