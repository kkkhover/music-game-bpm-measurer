// 把应用窗口提到前台（Electron 窗口在后台时 rAF 会被冻结/降到 60Hz，测帧率必须在前后台一致状态）
const PORT = 9222;
const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
const list = await res.json();
const page = list.find(t => t.type === 'page');
if (!page) throw new Error('没有找到页面目标');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
let id = 1;
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const myId = id++;
  const onMsg = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.id !== myId) return;
    ws.removeEventListener('message', onMsg);
    if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result);
  };
  ws.addEventListener('message', onMsg);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
await send('Page.enable');
await send('Page.bringToFront');
// 检查可见性状态
const r = await send('Runtime.evaluate', { expression: `({ hidden: document.hidden, vis: document.visibilityState, focus: document.hasFocus() })`, returnByValue: true });
console.log(JSON.stringify(r.result.value));
ws.close();
