// 截取当前窗口画面，用于人工确认 UI
const PORT = 9222;
const OUT = process.argv[2] || 'D:/aiwork/workbuddy/music-game-bpm-measurer/Bpm-Measurer-Util-release-v0.1.0/Bpm-Measurer-Util-release-v0.1.0/.tmp/shot.png';
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => { ws.onopen = r; });
let id = 0; const pend = new Map();
ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id); } };
const cmd = (method, params = {}) => new Promise(res => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
await cmd('Page.enable');
await cmd('Page.bringToFront');
const r = await cmd('Page.captureScreenshot', { format: 'png' });
const fs = await import('node:fs');
fs.writeFileSync(OUT, Buffer.from(r.data, 'base64'));
console.log('saved', OUT);
ws.close();
