// 通过 Chrome DevTools Protocol 驱动已启动的 Electron 实例做性能实测
// 用法: node dev-tools/cdp.mjs eval "<js表达式>"   |  node dev-tools/cdp.mjs file <script.js>
const PORT = 9222;

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

function send(ws, id, method, params = {}) {
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

const [, , mode, arg] = process.argv;
const fs = await import('node:fs');
const expr = mode === 'file' ? fs.readFileSync(arg, 'utf8') : arg;

const target = await getTarget();
const ws = await connect(target.webSocketDebuggerUrl);
await send(ws, 1, 'Runtime.enable');
const res = await send(ws, 2, 'Runtime.evaluate', {
  expression: expr,
  awaitPromise: true,
  returnByValue: true,
  allowUnsafeEvalBlockedByCSP: true,
});
if (res.exceptionDetails) {
  console.error('异常:', JSON.stringify(res.exceptionDetails, null, 2));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify(res.result.value ?? res.result, null, 2));
}
ws.close();
